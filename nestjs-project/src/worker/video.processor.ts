import { randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Inject, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Job, UnrecoverableError } from 'bullmq';
import { Repository } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { VIDEO_QUEUE } from '../queue/queue.constants';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { FfmpegService, MediaProcessingError } from './ffmpeg.service';

interface VideoProcessJob {
  videoId: string;
  bucket: string;
  key: string;
}

const ERROR_MESSAGE_MAX = 1000;

// The BullMQ Worker is instantiated by registering this @Processor in the
// WorkerModule — only in the worker container, never in the API (TD-03).
@Processor(VIDEO_QUEUE, { concurrency: 1, lockDuration: 60_000 })
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    @InjectRepository(Video) private readonly videos: Repository<Video>,
    private readonly storage: StorageService,
    private readonly ffmpeg: FfmpegService,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    super();
  }

  async process(job: Job<VideoProcessJob>): Promise<void> {
    const { videoId } = job.data;
    const video = await this.videos.findOneBy({ id: videoId });

    if (!video) {
      // The row was swept/deleted — retrying will never find it.
      throw new UnrecoverableError(`Video ${videoId} not found`);
    }
    if (video.status !== VideoStatus.PROCESSING) {
      // At-least-once delivery of an already-finished job — no-op.
      this.logger.warn(
        `Video ${videoId} is "${video.status}", skipping duplicate delivery`,
      );
      return;
    }

    await this.videos.update(
      { id: videoId },
      {
        processing_started_at: video.processing_started_at ?? new Date(),
        attempt_count: job.attemptsMade + 1,
      },
    );

    const thumbPath = join(tmpdir(), `thumb-${randomUUID()}.jpg`);
    try {
      const inputUrl = await this.storage.presignInternalGetUrl(
        video.original_key,
        { expiresIn: this.config.playbackUrlExpiresIn },
      );

      const probe = await this.ffmpeg.probe(inputUrl);
      // Cast: the jsonb `metadata` is stored verbatim, but TypeORM's deep-partial
      // update type does not accept a bare object for a jsonb column.
      await this.videos.update({ id: videoId }, {
        duration_seconds: probe.durationSeconds,
        width: probe.width,
        height: probe.height,
        metadata: probe.metadata,
      } as QueryDeepPartialEntity<Video>);

      const atSecond = Math.min(1, (probe.durationSeconds ?? 10) * 0.1);
      await this.ffmpeg.generateThumbnail(inputUrl, thumbPath, atSecond);
      const thumbnailKey = `videos/${videoId}/thumbnail.jpg`;
      await this.storage.putObject(
        thumbnailKey,
        await readFile(thumbPath),
        'image/jpeg',
      );

      // CAS is the idempotency guard: a concurrent/duplicate delivery that
      // already flipped the row to ready lands here with affected=0 and the
      // deterministic keys make the overwrite harmless.
      const cas = await this.videos.update(
        { id: videoId, status: VideoStatus.PROCESSING },
        {
          status: VideoStatus.READY,
          thumbnail_key: thumbnailKey,
          processed_at: new Date(),
          error_code: null,
          error_message: null,
        },
      );
      if (cas.affected === 0) {
        this.logger.warn(
          `Video ${videoId} already advanced past processing (duplicate delivery)`,
        );
      }
    } catch (error) {
      await this.handleFailure(job, videoId, error);
      throw error;
    } finally {
      await unlink(thumbPath).catch(() => undefined);
    }
  }

  // Invalid media is unrecoverable → fail the row now and stop retries. Transient
  // errors ride BullMQ's retry/backoff and are only persisted as failed once the
  // attempts are exhausted (phase-03-videos/TD-01 + TD-06).
  private async handleFailure(
    job: Job<VideoProcessJob>,
    videoId: string,
    error: unknown,
  ): Promise<void> {
    if (error instanceof MediaProcessingError) {
      await this.failVideo(videoId, error.code, error.message);
      throw new UnrecoverableError(error.message);
    }

    const attempts = job.opts.attempts ?? 1;
    const exhausted = job.attemptsMade + 1 >= attempts;
    if (exhausted) {
      const message = error instanceof Error ? error.message : String(error);
      await this.failVideo(videoId, 'STORAGE_IO', message);
    }
  }

  private async failVideo(
    videoId: string,
    code: string,
    message: string,
  ): Promise<void> {
    await this.videos.update(
      { id: videoId, status: VideoStatus.PROCESSING },
      {
        status: VideoStatus.FAILED,
        error_code: code,
        error_message: message.slice(0, ERROR_MESSAGE_MAX),
        processed_at: new Date(),
      },
    );
  }
}
