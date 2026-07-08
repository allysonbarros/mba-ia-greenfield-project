import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { ConfigType } from '@nestjs/config';
import { QueryFailedError, Repository } from 'typeorm';
import storageConfig from '../config/storage.config';
import {
  VideoFileTooLargeException,
  VideoInvalidContentTypeException,
  VideoNotFoundException,
  VideoUploadIncompleteException,
  VideoUploadNotCompletableException,
  VideoUploadSizeMismatchException,
} from '../common/exceptions/domain.exception';
import { ChannelsService } from '../channels/channels.service';
import { StorageService } from '../storage/storage.service';
import { VideoQueueProducer } from '../queue/video-queue.producer';
import { CompleteUploadDto } from './dto/complete-upload.dto';
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

export interface CompleteUploadResult {
  public_id: string;
  status: VideoStatus;
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
    private readonly producer: VideoQueueProducer,
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

  /**
   * Closes the multipart upload, verifies the real object and transitions
   * draft→processing via compare-and-swap, then enqueues the processing job.
   * Idempotent: a repeated complete on a video already past `draft` returns the
   * current status without re-enqueuing (phase-03-videos/TD-02 + TD-06).
   */
  async completeUpload(
    userId: string,
    publicId: string,
    dto: CompleteUploadDto,
  ): Promise<CompleteUploadResult> {
    const channel = await this.channels.findByUserId(userId);
    if (!channel) {
      throw new Error(`No channel found for user ${userId}`);
    }

    const video = await this.videos.findOne({
      where: { public_id: publicId },
    });
    // 404 without existence leak: unknown id OR another channel's video.
    if (!video || video.channel_id !== channel.id) {
      throw new VideoNotFoundException();
    }

    // Short-circuit before touching storage: idempotent for already-advanced
    // videos, terminal for failed ones.
    if (
      video.status === VideoStatus.PROCESSING ||
      video.status === VideoStatus.READY
    ) {
      return { public_id: video.public_id, status: video.status };
    }
    if (video.status === VideoStatus.FAILED) {
      throw new VideoUploadNotCompletableException();
    }

    const uploadId = video.upload_id!;
    const parts = dto.parts.map((p) => ({
      partNumber: p.part_number,
      etag: p.etag,
    }));

    try {
      await this.storage.completeMultipartUpload(
        video.original_key,
        uploadId,
        parts,
      );
    } catch {
      throw new VideoUploadIncompleteException();
    }

    const head = await this.storage.headObject(video.original_key);
    if (
      head.contentLength > MAX_VIDEO_FILE_SIZE_BYTES ||
      head.contentLength !== video.file_size
    ) {
      await this.storage
        .abortMultipartUpload(video.original_key, uploadId)
        .catch(() => undefined);
      await this.videos.update(
        { id: video.id, status: VideoStatus.DRAFT },
        {
          status: VideoStatus.FAILED,
          error_code: 'VIDEO_UPLOAD_SIZE_MISMATCH',
          error_message: `Real size ${head.contentLength} != declared ${video.file_size}`,
          upload_id: null,
          processed_at: new Date(),
        },
      );
      throw new VideoUploadSizeMismatchException();
    }

    const cas = await this.videos.update(
      { id: video.id, status: VideoStatus.DRAFT },
      {
        status: VideoStatus.PROCESSING,
        uploaded_at: new Date(),
        upload_id: null,
      },
    );
    if (cas.affected === 0) {
      // A concurrent writer advanced the row — report its current state.
      const current = await this.videos.findOneByOrFail({ id: video.id });
      if (current.status === VideoStatus.FAILED) {
        throw new VideoUploadNotCompletableException();
      }
      return { public_id: current.public_id, status: current.status };
    }

    await this.producer.enqueueProcessing(
      video.id,
      this.config.bucket,
      video.original_key,
    );

    return { public_id: video.public_id, status: VideoStatus.PROCESSING };
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
