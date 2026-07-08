import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
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
import { Video, VideoStatus } from '../src/videos/entities/video.entity';

describe('videos-get', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channelRepository: Repository<Channel>;
  let jwtService: JwtService;
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
    jwtService = moduleFixture.get(JwtService);
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

  const server = () => app.getHttpServer();

  // Registers, confirms and logs in a user (which also creates its 1:1 channel),
  // returning the access token and the resolved channel of that user.
  async function registerConfirmAndLogin(
    email: string,
    password = 'password123',
  ): Promise<{ token: string; channel: Channel }> {
    const authService = app.get(AuthService);
    const mailService = (authService as any).mailService;
    let confirmationToken = '';
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        confirmationToken = t;
      });
    await request(server()).post('/auth/register').send({ email, password });
    await request(server())
      .get('/auth/confirm-email')
      .query({ token: confirmationToken });
    const res = await request(server())
      .post('/auth/login')
      .send({ email, password });
    const token = res.body.access_token as string;
    const { sub } = jwtService.decode<{ sub: string }>(token);
    const channel = await channelRepository.findOneByOrFail({ user_id: sub });
    return { token, channel };
  }

  async function seedVideo(
    channelId: string,
    overrides: Partial<Video>,
  ): Promise<Video> {
    const publicId = overrides.public_id ?? 'aaaaaaaaaaa';
    return videoRepository.save(
      videoRepository.create({
        public_id: publicId,
        channel_id: channelId,
        title: 'Seed Video',
        status: VideoStatus.DRAFT,
        original_key: `videos/${publicId}/original.mp4`,
        file_size: 1024,
        content_type: 'video/mp4',
        ...overrides,
      }),
    );
  }

  it('1.1 shows a ready video to an anonymous caller (no error_code exposed)', async () => {
    const { channel } = await registerConfirmAndLogin('get1@example.com');
    const video = await seedVideo(channel.id, {
      public_id: 'readyvideo1',
      title: 'Ready Video',
      status: VideoStatus.READY,
      duration_seconds: 12.5,
      width: 128,
      height: 72,
      thumbnail_key: 'videos/readyvideo1/thumbnail.jpg',
    });

    const res = await request(server())
      .get(`/videos/${video.public_id}`)
      .expect(200);

    expect(res.body.public_id).toBe(video.public_id);
    expect(res.body.title).toBe('Ready Video');
    expect(res.body.status).toBe('ready');
    expect(res.body.duration_seconds).toBe(12.5);
    expect(res.body.thumbnail_url).toContain('X-Amz-Signature');
    expect(res.body.channel).toEqual({
      id: channel.id,
      name: channel.name,
      nickname: channel.nickname,
    });
    expect(res.body).not.toHaveProperty('error_code');
  });

  it('1.2 hides a processing video from an anonymous caller (404 VIDEO_NOT_FOUND)', async () => {
    const { channel } = await registerConfirmAndLogin('get2@example.com');
    const video = await seedVideo(channel.id, {
      public_id: 'processing1',
      status: VideoStatus.PROCESSING,
    });

    const res = await request(server())
      .get(`/videos/${video.public_id}`)
      .expect(404);

    expect(res.body.error).toBe('VIDEO_NOT_FOUND');
  });

  it('1.3 lets the owner see a processing video but hides it from other users', async () => {
    const { token, channel } =
      await registerConfirmAndLogin('get3@example.com');
    const video = await seedVideo(channel.id, {
      public_id: 'processing2',
      status: VideoStatus.PROCESSING,
    });

    const ownerRes = await request(server())
      .get(`/videos/${video.public_id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(ownerRes.body.status).toBe('processing');

    const { token: otherToken } = await registerConfirmAndLogin(
      'get3other@example.com',
    );
    await request(server())
      .get(`/videos/${video.public_id}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);
  });

  it('1.4 rejects a publicId outside the [A-Za-z0-9_-]{11} format', async () => {
    await request(server()).get('/videos/abc').expect(400);
  });
});
