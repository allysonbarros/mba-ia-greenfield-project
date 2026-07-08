import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video } from '../src/videos/entities/video.entity';

const validBody = {
  title: 'Meu vídeo',
  file_name: 'video.mp4',
  file_size: 5242880,
  content_type: 'video/mp4',
};

describe('videos-initiate', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channelRepository: Repository<Channel>;
  let throttlerStorage: ThrottlerStorageService;

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
    channelRepository = dataSource.getRepository(Channel);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  async function registerConfirmAndLogin(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const authService = app.get(AuthService);
    const mailService = (authService as any).mailService;
    let confirmationToken = '';
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        confirmationToken = t;
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: confirmationToken });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    return res.body.access_token as string;
  }

  it('1.1 creates a draft with presigned part URLs and persists the row', async () => {
    const token = await registerConfirmAndLogin('initiate1@example.com');

    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send(validBody)
      .expect(201);

    expect(res.body.public_id).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(res.body.status).toBe('draft');
    expect(res.body.upload.part_size).toBeGreaterThan(0);
    expect(res.body.upload.urls).toHaveLength(
      Math.ceil(validBody.file_size / res.body.upload.part_size),
    );
    for (const part of res.body.upload.urls) {
      expect(part.url).toContain('X-Amz-Signature');
      expect(part.url).toContain('minio:9000');
    }

    const video = await videoRepository.findOneByOrFail({
      public_id: res.body.public_id,
    });
    // one user + one channel exist per test, so the draft must attach to it
    const channels = await channelRepository.find();
    expect(channels).toHaveLength(1);
    expect(video.status).toBe('draft');
    expect(video.original_key).toBe(`videos/${video.id}/original.mp4`);
    expect(video.upload_id).not.toBeNull();
    expect(video.channel_id).toBe(channels[0].id);
  });

  it('1.2 rejects a file above 10 GiB with VIDEO_FILE_TOO_LARGE', async () => {
    const token = await registerConfirmAndLogin('initiate2@example.com');

    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...validBody, file_size: 10737418241 })
      .expect(400);

    expect(res.body.error).toBe('VIDEO_FILE_TOO_LARGE');
    await expect(videoRepository.count()).resolves.toBe(0);
  });

  it('1.3 rejects a non-video content_type with VIDEO_INVALID_CONTENT_TYPE', async () => {
    const token = await registerConfirmAndLogin('initiate3@example.com');

    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...validBody, content_type: 'image/png' })
      .expect(400);

    expect(res.body.error).toBe('VIDEO_INVALID_CONTENT_TYPE');
  });

  it('1.4 returns 401 without an Authorization header', async () => {
    await request(app.getHttpServer())
      .post('/videos')
      .send(validBody)
      .expect(401);
  });

  it('1.5 rejects invalid bodies (ValidationPipe wiring)', async () => {
    const token = await registerConfirmAndLogin('initiate5@example.com');

    const { title, ...withoutTitle } = validBody;
    void title;
    await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send(withoutTitle)
      .expect(400);

    await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...validBody, title: 'a'.repeat(101) })
      .expect(400);
  });
});
