import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, Repository } from 'typeorm';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Reconciliation safety net for the status lifecycle (phase-03-videos/TD-06):
 * expires abandoned drafts (aborting their still-open multipart uploads — MinIO
 * does not honor multipart ILM, so the sweep is the portable mechanism) and
 * fails `processing` rows stuck past the ceiling.
 */
@Injectable()
export class VideoSweepService {
  private readonly logger = new Logger(VideoSweepService.name);

  constructor(
    @InjectRepository(Video) private readonly videos: Repository<Video>,
    private readonly storage: StorageService,
    @Inject(storageConfig.KEY)
    private readonly storageConf: ConfigType<typeof storageConfig>,
    @Inject(queueConfig.KEY)
    private readonly queueConf: ConfigType<typeof queueConfig>,
  ) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'video-reconciliation-sweep' })
  async sweep(): Promise<void> {
    await this.expireStaleDrafts();
    await this.failStuckProcessing();
  }

  async expireStaleDrafts(): Promise<void> {
    const cutoff = new Date(
      Date.now() - this.storageConf.uploadStaleTtlHours * HOUR_MS,
    );
    const drafts = await this.videos.find({
      where: { status: VideoStatus.DRAFT, created_at: LessThan(cutoff) },
    });

    for (const draft of drafts) {
      if (draft.upload_id) {
        await this.storage
          .abortMultipartUpload(draft.original_key, draft.upload_id)
          .catch((err: unknown) =>
            this.logger.warn(
              `Failed to abort multipart for ${draft.id}: ${String(err)}`,
            ),
          );
      }
      await this.videos.delete({ id: draft.id });
    }

    if (drafts.length > 0) {
      this.logger.log(`Expired ${drafts.length} stale draft(s)`);
    }
  }

  async failStuckProcessing(): Promise<void> {
    const cutoff = new Date(
      Date.now() - this.queueConf.processingStuckCeilingHours * HOUR_MS,
    );
    const stuck = await this.videos.find({
      where: [
        {
          status: VideoStatus.PROCESSING,
          processing_started_at: LessThan(cutoff),
        },
        // Job enqueued but never picked up (worker down before the first
        // attempt): processing_started_at stays NULL, so anchor the ceiling
        // on uploaded_at (set by the complete endpoint).
        {
          status: VideoStatus.PROCESSING,
          processing_started_at: IsNull(),
          uploaded_at: LessThan(cutoff),
        },
      ],
    });

    for (const video of stuck) {
      // CAS so a worker finishing concurrently wins over the sweep.
      const cas = await this.videos.update(
        { id: video.id, status: VideoStatus.PROCESSING },
        {
          status: VideoStatus.FAILED,
          error_code: 'STUCK_TIMEOUT',
          error_message: 'Processing exceeded the stuck ceiling',
          processed_at: new Date(),
        },
      );
      if (cas.affected) {
        this.logger.warn(`Video ${video.id} failed via STUCK_TIMEOUT sweep`);
      }
    }
  }
}
