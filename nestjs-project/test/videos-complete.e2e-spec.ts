import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  ListMultipartUploadsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import storageConfig from '../src/config/storage.config';
import { VIDEO_QUEUE } from '../src/queue/queue.constants';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video } from '../src/videos/entities/video.entity';

// SPEC_DEVIATION: uploads an inline Buffer rather than test/fixtures/tiny.mp4
// (SI-03.11's deliverable, requires ffmpeg absent from this container). The
// complete flow validates ETags/size only, so raw bytes give the same coverage.
describe('videos-complete', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let throttlerStorage: ThrottlerStorageService;
  let queue: Queue;
  const s3 = new S3Client({
    region: storageConfig().region,
    endpoint: storageConfig().endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: storageConfig().accessKeyId,
      secretAccessKey: storageConfig().secretAccessKey,
    },
  });

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
    videoRepository = dataSource.getRepository(Video);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    queue = moduleFixture.get<Queue>(getQueueToken(VIDEO_QUEUE), {
      strict: false,
    });
  });

  afterAll(async () => {
    await queue.obliterate({ force: true }).catch(() => undefined);
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
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

  async function initiateAndUpload(
    token: string,
    declaredSize?: number,
  ): Promise<{ publicId: string; etag: string }> {
    const body = Buffer.alloc(1024, 0x61);
    const res = await request(server())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Video',
        file_name: 'clip.mp4',
        file_size: declaredSize ?? body.length,
        content_type: 'video/mp4',
      })
      .expect(201);
    const putRes = await fetch(res.body.upload.urls[0].url, {
      method: 'PUT',
      body,
    });
    return {
      publicId: res.body.public_id,
      etag: putRes.headers.get('etag') ?? '',
    };
  }

  it('1.1 completes the upload, transitioning to processing and enqueuing the job', async () => {
    const token = await registerConfirmAndLogin('complete1@example.com');
    const { publicId, etag } = await initiateAndUpload(token);

    const res = await request(server())
      .post(`/videos/${publicId}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parts: [{ part_number: 1, etag }] })
      .expect(200);

    expect(res.body.status).toBe('processing');

    const video = await videoRepository.findOneByOrFail({ public_id: publicId });
    const job = await queue.getJob(video.id);
    expect(job).toBeDefined();
    expect(job!.data).toEqual({
      videoId: video.id,
      bucket: storageConfig().bucket,
      key: video.original_key,
    });
  });

  it('1.2 is idempotent on a repeated complete (no duplicate job)', async () => {
    const token = await registerConfirmAndLogin('complete2@example.com');
    const { publicId, etag } = await initiateAndUpload(token);

    await request(server())
      .post(`/videos/${publicId}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parts: [{ part_number: 1, etag }] })
      .expect(200);

    const second = await request(server())
      .post(`/videos/${publicId}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parts: [{ part_number: 1, etag }] })
      .expect(200);

    expect(second.body.status).toBe('processing');
    const counts = await queue.getJobCounts();
    expect(counts.waiting).toBe(1);
  });

  it('1.3 keeps the video draft on invalid parts (VIDEO_UPLOAD_INCOMPLETE)', async () => {
    const token = await registerConfirmAndLogin('complete3@example.com');
    const { publicId } = await initiateAndUpload(token);

    const res = await request(server())
      .post(`/videos/${publicId}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parts: [{ part_number: 1, etag: 'etag-invalido' }] })
      .expect(400);

    expect(res.body.error).toBe('VIDEO_UPLOAD_INCOMPLETE');
    const video = await videoRepository.findOneByOrFail({ public_id: publicId });
    expect(video.status).toBe('draft');
    const counts = await queue.getJobCounts();
    expect(counts.waiting).toBe(0);
  });

  it("1.4 returns 404 when completing another user's video", async () => {
    const owner = await registerConfirmAndLogin('complete4owner@example.com');
    const { publicId, etag } = await initiateAndUpload(owner);
    const other = await registerConfirmAndLogin('complete4other@example.com');

    const res = await request(server())
      .post(`/videos/${publicId}/complete`)
      .set('Authorization', `Bearer ${other}`)
      .send({ parts: [{ part_number: 1, etag }] })
      .expect(404);

    expect(res.body.error).toBe('VIDEO_NOT_FOUND');
  });

  it('1.5 fails and aborts on a declared/real size mismatch', async () => {
    const token = await registerConfirmAndLogin('complete5@example.com');
    // declare 512 bytes but upload 1024 → real object exceeds the declaration
    const { publicId, etag } = await initiateAndUpload(token, 512);

    const res = await request(server())
      .post(`/videos/${publicId}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parts: [{ part_number: 1, etag }] })
      .expect(400);

    expect(res.body.error).toBe('VIDEO_UPLOAD_SIZE_MISMATCH');

    const video = await videoRepository.findOneByOrFail({ public_id: publicId });
    expect(video.status).toBe('failed');

    const list = await s3.send(
      new ListMultipartUploadsCommand({ Bucket: storageConfig().bucket }),
    );
    const dangling = (list.Uploads ?? []).some(
      (u) => u.Key === video.original_key,
    );
    expect(dangling).toBe(false);
  });
});
