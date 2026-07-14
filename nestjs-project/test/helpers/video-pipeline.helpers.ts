import { Queue, QueueEvents } from 'bullmq';
import { Repository } from 'typeorm';
import { StorageService } from '../../src/storage/storage.service';
import { Video, VideoStatus } from '../../src/videos/entities/video.entity';

// Shared helpers for the video-pipeline e2e (phase-03-videos/TD-08). The bucket
// is the S3 mirror of the DELETE FROM cleanup; the queue drain drops leftover
// jobs; the status wait is event-driven (no sleeps).

export async function emptyBucket(storage: StorageService): Promise<void> {
  await storage.deleteObjects(await storage.listObjects());
}

export async function drainQueue(queue: Queue): Promise<void> {
  await queue.obliterate({ force: true });
}

/**
 * Resolves when the processing job for `videoId` finishes (via QueueEvents, not
 * polling), then asserts the persisted status matches `expected`.
 */
export async function waitForStatus(
  deps: {
    queue: Queue;
    queueEvents: QueueEvents;
    videoRepo: Repository<Video>;
  },
  videoId: string,
  expected: VideoStatus,
): Promise<Video> {
  const job = await deps.queue.getJob(videoId);
  if (job) {
    await job.waitUntilFinished(deps.queueEvents);
  }
  const video = await deps.videoRepo.findOneByOrFail({ id: videoId });
  if (video.status !== expected) {
    throw new Error(
      `Expected video ${videoId} to be "${expected}" but was "${video.status}"`,
    );
  }
  return video;
}
