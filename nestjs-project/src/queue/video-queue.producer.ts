import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { VIDEO_PROCESS_JOB, VIDEO_QUEUE } from './queue.constants';

export interface VideoProcessJobData {
  videoId: string;
  bucket: string;
  key: string;
}

@Injectable()
export class VideoQueueProducer {
  constructor(
    @InjectQueue(VIDEO_QUEUE)
    private readonly queue: Queue<VideoProcessJobData>,
  ) {}

  /**
   * Enqueue a video for processing. `jobId = videoId` makes the enqueue
   * idempotent: a second add for the same video while the job exists is a
   * no-op, collapsing the crash-between-commit-and-enqueue window and any
   * double-complete call (phase-03-videos/TD-01 + TD-06).
   */
  async enqueueProcessing(
    videoId: string,
    bucket: string,
    key: string,
  ): Promise<void> {
    await this.queue.add(
      VIDEO_PROCESS_JOB,
      { videoId, bucket, key },
      { jobId: videoId },
    );
  }
}
