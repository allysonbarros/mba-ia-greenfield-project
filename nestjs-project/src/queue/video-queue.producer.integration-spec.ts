import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { VIDEO_QUEUE } from './queue.constants';
import { QueueModule } from './queue.module';
import { VideoQueueProducer } from './video-queue.producer';

describe('VideoQueueProducer (integration)', () => {
  let moduleRef: TestingModule;
  let producer: VideoQueueProducer;
  let queue: Queue;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();
    producer = moduleRef.get(VideoQueueProducer);
    queue = moduleRef.get<Queue>(getQueueToken(VIDEO_QUEUE));
  }, 30000);

  afterAll(async () => {
    await queue.obliterate({ force: true }).catch(() => undefined);
    await moduleRef.close();
  });

  beforeEach(async () => {
    // No worker consumes in this suite, so a full obliterate isolates each test.
    await queue.obliterate({ force: true });
  });

  it('enqueues a waiting job keyed by videoId with the video.process payload', async () => {
    const videoId = randomUUID();
    const bucket = 'streamtube-videos';
    const key = `videos/${videoId}/original.mp4`;

    await producer.enqueueProcessing(videoId, bucket, key);

    const job = await queue.getJob(videoId);
    expect(job).toBeDefined();
    expect(job!.id).toBe(videoId);
    expect(job!.data).toEqual({ videoId, bucket, key });
    expect(await job!.getState()).toBe('waiting');
  });

  it('does not duplicate when the same videoId is enqueued twice', async () => {
    const videoId = randomUUID();
    const key = `videos/${videoId}/original.mp4`;

    await producer.enqueueProcessing(videoId, 'streamtube-videos', key);
    await producer.enqueueProcessing(videoId, 'streamtube-videos', key);

    const counts = await queue.getJobCounts();
    expect(counts.waiting).toBe(1);
  });
});
