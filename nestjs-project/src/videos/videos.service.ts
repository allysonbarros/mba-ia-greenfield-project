import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { ConfigType } from '@nestjs/config';
import { QueryFailedError, Repository } from 'typeorm';
import storageConfig from '../config/storage.config';
import {
  VideoFileTooLargeException,
  VideoInvalidContentTypeException,
} from '../common/exceptions/domain.exception';
import { ChannelsService } from '../channels/channels.service';
import { StorageService } from '../storage/storage.service';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { generatePublicId } from './public-id.util';
import {
  MAX_VIDEO_FILE_SIZE_BYTES,
  PG_UNIQUE_VIOLATION,
  VIDEO_CONTENT_TYPE_PATTERN,
} from './videos.constants';

export interface InitiateUploadResult {
  public_id: string;
  status: VideoStatus;
  upload: {
    part_size: number;
    part_count: number;
    urls: { part_number: number; url: string }[];
    expires_at: string;
  };
}

function isUniqueViolationOnColumn(error: unknown, column: string): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const err = error as QueryFailedError & { code?: string; detail?: string };
  return (
    err.code === PG_UNIQUE_VIOLATION &&
    typeof err.detail === 'string' &&
    err.detail.includes(column)
  );
}

function extractExtension(fileName: string): string {
  return fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase();
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video) private readonly videos: Repository<Video>,
    private readonly storage: StorageService,
    private readonly channels: ChannelsService,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  /**
   * Pre-registers the video as a draft, opens the multipart upload against the
   * object store and returns presigned part URLs. No video bytes touch the API
   * (phase-03-videos/TD-02 + TD-05 + TD-07).
   */
  async initiateUpload(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<InitiateUploadResult> {
    if (dto.file_size > MAX_VIDEO_FILE_SIZE_BYTES) {
      throw new VideoFileTooLargeException();
    }
    if (!VIDEO_CONTENT_TYPE_PATTERN.test(dto.content_type)) {
      throw new VideoInvalidContentTypeException();
    }

    const channel = await this.channels.findByUserId(userId);
    if (!channel) {
      // user↔channel is 1:1 and created at registration; absence is a broken
      // invariant, not a normal request outcome.
      throw new Error(`No channel found for user ${userId}`);
    }

    const id = randomUUID();
    const originalKey = `videos/${id}/original.${extractExtension(dto.file_name)}`;

    const { uploadId } = await this.storage.createMultipartUpload(
      originalKey,
      dto.content_type,
    );

    const partSize = this.config.uploadPartSizeMb * 1024 * 1024;
    const partCount = Math.ceil(dto.file_size / partSize);
    const urls = await this.storage.presignUploadPartUrls(
      originalKey,
      uploadId,
      partCount,
      this.config.uploadUrlExpiresIn,
    );

    const publicId = await this.insertDraft(
      id,
      channel.id,
      originalKey,
      uploadId,
      dto,
    );

    const expiresAt = new Date(
      Date.now() + this.config.uploadUrlExpiresIn * 1000,
    ).toISOString();

    return {
      public_id: publicId,
      status: VideoStatus.DRAFT,
      upload: {
        part_size: partSize,
        part_count: partCount,
        urls: urls.map((u) => ({ part_number: u.partNumber, url: u.url })),
        expires_at: expiresAt,
      },
    };
  }

  // Inserts the draft row, regenerating public_id and retrying once on a
  // public_id unique violation (Postgres 23505 — TD-05).
  private async insertDraft(
    id: string,
    channelId: string,
    originalKey: string,
    uploadId: string,
    dto: CreateVideoDto,
  ): Promise<string> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const publicId = generatePublicId();
      try {
        await this.videos.insert({
          id,
          public_id: publicId,
          channel_id: channelId,
          title: dto.title,
          description: dto.description ?? null,
          status: VideoStatus.DRAFT,
          original_key: originalKey,
          upload_id: uploadId,
          file_size: dto.file_size,
          content_type: dto.content_type,
        });
        return publicId;
      } catch (error) {
        if (attempt === 0 && isUniqueViolationOnColumn(error, 'public_id')) {
          continue;
        }
        throw error;
      }
    }
    // Unreachable: attempt 1 either returns or throws above.
    throw new Error('Failed to insert video draft');
  }
}
