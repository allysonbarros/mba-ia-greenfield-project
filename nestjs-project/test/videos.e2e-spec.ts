import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { getQueueToken } from '@nestjs/bullmq';
import { Job, Queue, QueueEvents, Worker } from 'bullmq';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import queueConfig from '../src/config/queue.config';
import storageConfig from '../src/config/storage.config';
import { VIDEO_QUEUE } from '../src/queue/queue.constants';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { FfmpegService } from '../src/worker/ffmpeg.service';
import { VideoProcessor } from '../src/worker/video.processor';
import {
  drainQueue,
  emptyBucket,
  waitForStatus,
} from './helpers/video-pipeline.helpers';

const TINY_MP4 = readFileSync(join(__dirname, 'fixtures', 'tiny.mp4'));

// End-to-end of the full pipeline over real MinIO + Redis + Postgres. The
// processor runs in-process against a real BullMQ Worker; ffmpeg is stubbed
// because the API image has no ffmpeg (the real binaries are proven by the
// worker-container integration suite and the compose-level smoke script — TD-08).
describe('videos (full pipeline e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepo: Repository<Video>;
  let storage: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let queue: Queue;
  let queueEvents: QueueEvents;
  let worker: Worker;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    videoRepo = dataSource.getRepository(Video);
    storage = app.get(StorageService);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    queue = moduleFixture.get<Queue>(getQueueToken(VIDEO_QUEUE), {
      strict: false,
    });

    const stubFfmpeg = {
      probe: async () => ({
        durationSeconds: 1,
        width: 128,
        height: 72,
        codecName: 'h264',
        metadata: { format_name: 'mp4' },
      }),
      generateThumbnail: async (_input: string, outPath: string) => {
        await writeFile(outPath, Buffer.from('stub-jpeg-bytes'));
      },
    } as unknown as FfmpegService;

    const processor = new VideoProcessor(
      videoRepo,
      storage,
      stubFfmpeg,
      storageConfig(),
    );
    const connection = {
      host: queueConfig().redisHost,
      port: queueConfig().redisPort,
      maxRetriesPerRequest: null,
    };
    worker = new Worker(VIDEO_QUEUE, (job: Job) => processor.process(job), {
      connection,
    });
    queueEvents = new QueueEvents(VIDEO_QUEUE, { connection });
    await queueEvents.waitUntilReady();
  }, 30000);

  afterAll(async () => {
    await worker.close();
    await queueEvents.close();
    await drainQueue(queue).catch(() => undefined);
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await emptyBucket(storage);
    await drainQueue(queue);
    throttlerStorage.storage.clear();
  });

  const server = () => app.getHttpServer();

  async function registerConfirmAndLogin(email: string): Promise<string> {
    const authService = app.get(AuthService);
    const mailService = (authService as any).mailService;
    let confirmationToken = '';
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        confirmationToken = t;
      });
    await request(server())
      .post('/auth/register')
      .send({ email, password: 'password123' });
    await request(server())
      .get('/auth/confirm-email')
      .query({ token: confirmationToken });
    const res = await request(server())
      .post('/auth/login')
      .send({ email, password: 'password123' });
    return res.body.access_token as string;
  }

  it('runs initiate → upload → complete → ready → stream → download', async () => {
    const token = await registerConfirmAndLogin('fullflow@example.com');

    const initiate = await request(server())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Full Flow',
        file_name: 'clip.mp4',
        file_size: TINY_MP4.length,
        content_type: 'video/mp4',
      })
      .expect(201);

    const publicId = initiate.body.public_id as string;
    expect(initiate.body.upload.urls).toHaveLength(1);

    const putRes = await fetch(initiate.body.upload.urls[0].url, {
      method: 'PUT',
      body: TINY_MP4,
    });
    expect(putRes.ok).toBe(true);
    const etag = putRes.headers.get('etag') ?? '';

    await request(server())
      .post(`/videos/${publicId}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parts: [{ part_number: 1, etag }] })
      .expect(200);

    const enqueued = await videoRepo.findOneByOrFail({ public_id: publicId });
    const ready = await waitForStatus(
      { queue, queueEvents, videoRepo },
      enqueued.id,
      VideoStatus.READY,
    );
    expect(ready.thumbnail_key).toBe(`videos/${enqueued.id}/thumbnail.jpg`);

    const get = await request(server()).get(`/videos/${publicId}`).expect(200);
    expect(get.body.status).toBe('ready');
    expect(get.body.duration_seconds).toBe(1);
    expect(get.body.width).toBe(128);
    expect(get.body.height).toBe(72);
    expect(get.body.thumbnail_url).toContain('X-Amz-Signature');

    const stream = await request(server())
      .get(`/videos/${publicId}/stream`)
      .expect(302);
    const streamRes = await fetch(stream.headers.location, {
      headers: { Range: 'bytes=0-1023' },
    });
    expect(streamRes.status).toBe(206);

    const download = await request(server())
      .get(`/videos/${publicId}/download`)
      .expect(302);
    expect(download.headers.location).toContain(
      'response-content-disposition=attachment',
    );
  }, 45000);
});
