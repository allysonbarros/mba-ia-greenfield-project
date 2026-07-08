import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue, QueueEvents } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { Channel } from '../channels/entities/channel.entity';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { VIDEO_PROCESS_JOB, VIDEO_QUEUE } from '../queue/queue.constants';
import { WorkerModule } from './worker.module';

// Full pipeline against real MinIO + Redis + Postgres, with the @Processor
// consuming in-process. Run inside the video-worker container (real ffmpeg):
// docker compose exec -T video-worker npx jest --runInBand --forceExit src/worker
const TINY_MP4 = readFileSync(
  join(__dirname, '..', '..', 'test', 'fixtures', 'tiny.mp4'),
);

describe('VideoProcessor (integration — real pipeline)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let videoRepo: Repository<Video>;
  let userRepo: Repository<User>;
  let channelRepo: Repository<Channel>;
  let storage: StorageService;
  let queue: Queue;
  let queueEvents: QueueEvents;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    await moduleRef.init();

    dataSource = moduleRef.get(DataSource, { strict: false });
    videoRepo = dataSource.getRepository(Video);
    userRepo = dataSource.getRepository(User);
    channelRepo = dataSource.getRepository(Channel);
    storage = moduleRef.get(StorageService, { strict: false });
    queue = moduleRef.get<Queue>(getQueueToken(VIDEO_QUEUE), { strict: false });

    const cfg = queueConfig();
    queueEvents = new QueueEvents(VIDEO_QUEUE, {
      connection: { host: cfg.redisHost, port: cfg.redisPort },
    });
    await queueEvents.waitUntilReady();
  }, 30000);

  afterAll(async () => {
    await queueEvents.close();
    await queue.obliterate({ force: true }).catch(() => undefined);
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await storage.deleteObjects(await storage.listObjects());
    await queue.obliterate({ force: true });
  });

  async function seed(
    objectBytes: Buffer,
  ): Promise<{ videoId: string; key: string }> {
    const user = await userRepo.save(
      userRepo.create({
        email: `proc_${randomUUID()}@example.com`,
        password: 'h',
      }),
    );
    const channel = await channelRepo.save(
      channelRepo.create({
        name: 'Chan',
        nickname: `procchan_${randomUUID().slice(0, 8)}`,
        user_id: user.id,
      }),
    );
    const videoId = randomUUID();
    const key = `videos/${videoId}/original.mp4`;
    await storage.putObject(key, objectBytes, 'video/mp4');
    await videoRepo.insert({
      id: videoId,
      public_id: randomUUID().replace(/-/g, '').slice(0, 11),
      channel_id: channel.id,
      title: 'Proc Clip',
      status: VideoStatus.PROCESSING,
      original_key: key,
      file_size: objectBytes.length,
      content_type: 'video/mp4',
      processing_started_at: new Date(),
    });
    return { videoId, key };
  }

  it('drives a valid job to ready with metadata, dimensions and a thumbnail object', async () => {
    const { videoId, key } = await seed(TINY_MP4);

    const job = await queue.add(
      VIDEO_PROCESS_JOB,
      { videoId, bucket: storageConfig().bucket, key },
      { jobId: videoId },
    );
    await job.waitUntilFinished(queueEvents);

    const video = await videoRepo.findOneByOrFail({ id: videoId });
    expect(video.status).toBe(VideoStatus.READY);
    expect(video.duration_seconds).toBeCloseTo(1, 0);
    expect(video.width).toBe(128);
    expect(video.height).toBe(72);
    expect(video.thumbnail_key).toBe(`videos/${videoId}/thumbnail.jpg`);

    const keys = await storage.listObjects(`videos/${videoId}/`);
    expect(keys).toContain(`videos/${videoId}/thumbnail.jpg`);
  }, 30000);

  it('fails a corrupted video with error_code PROBE_FAILED (no retries)', async () => {
    const { videoId, key } = await seed(
      Buffer.from('this is not a video file'),
    );

    const job = await queue.add(
      VIDEO_PROCESS_JOB,
      { videoId, bucket: storageConfig().bucket, key },
      { jobId: videoId },
    );
    await expect(job.waitUntilFinished(queueEvents)).rejects.toThrow();

    const video = await videoRepo.findOneByOrFail({ id: videoId });
    expect(video.status).toBe(VideoStatus.FAILED);
    expect(video.error_code).toBe('PROBE_FAILED');
  }, 30000);
});
