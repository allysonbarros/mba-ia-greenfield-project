import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { AppModule } from '../src/app.module';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { VIDEO_QUEUE } from '../src/queue/queue.constants';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { User } from '../src/users/entities/user.entity';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';

// SPEC_DEVIATION: seeds an inline Buffer as the video object rather than
// test/fixtures/tiny.mp4 (SI-03.11's deliverable, needs ffmpeg). Delivery only
// presigns and streams bytes — MinIO serves Range/206 off any object, so raw
// bytes give the same coverage. emptyBucket() is inlined here (its shared helper
// is SI-03.14's deliverable).
describe('videos-delivery', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channelRepository: Repository<Channel>;
  let userRepository: Repository<User>;
  let storage: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let queue: Queue;

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
    userRepository = dataSource.getRepository(User);
    storage = app.get(StorageService);
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
    await storage.deleteObjects(await storage.listObjects());
    throttlerStorage.storage.clear();
  });

  const server = () => app.getHttpServer();

  async function seedVideo(
    status: VideoStatus,
    publicId: string,
  ): Promise<string> {
    const user = await userRepository.save(
      userRepository.create({
        email: `del_${randomUUID()}@example.com`,
        password: 'h',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: 'Chan',
        nickname: `delchan_${randomUUID().slice(0, 8)}`,
        user_id: user.id,
      }),
    );
    const id = randomUUID();
    const key = `videos/${id}/original.mp4`;
    if (status === VideoStatus.READY) {
      await storage.putObject(key, Buffer.alloc(2048, 0x61), 'video/mp4');
    }
    await videoRepository.insert({
      id,
      public_id: publicId,
      channel_id: channel.id,
      title: 'My Clip',
      status,
      original_key: key,
      file_size: 2048,
      content_type: 'video/mp4',
    });
    return publicId;
  }

  it('1.1 redirects stream to a presigned inline URL on the public endpoint', async () => {
    const publicId = await seedVideo(VideoStatus.READY, 'readydeliv1');

    const res = await request(server())
      .get(`/videos/${publicId}/stream`)
      .expect(302);

    const location = res.headers.location;
    expect(location).toContain('X-Amz-Signature');
    expect(location).toContain('minio:9000');
    expect(location).not.toContain('response-content-disposition=attachment');
  });

  it('1.2 serves 206 Partial Content when following the stream Location with Range', async () => {
    const publicId = await seedVideo(VideoStatus.READY, 'readydeliv2');

    const redirect = await request(server())
      .get(`/videos/${publicId}/stream`)
      .expect(302);

    const res = await fetch(redirect.headers.location, {
      headers: { Range: 'bytes=0-1023' },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toMatch(/^bytes 0-1023\//);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBe(1024);
  });

  it('1.3 redirects download to a presigned attachment URL with the title filename', async () => {
    const publicId = await seedVideo(VideoStatus.READY, 'readydeliv3');

    const redirect = await request(server())
      .get(`/videos/${publicId}/download`)
      .expect(302);

    const location = redirect.headers.location;
    expect(location).toContain('response-content-disposition=attachment');
    expect(decodeURIComponent(location)).toContain(
      'attachment; filename="My Clip.mp4"',
    );

    const res = await fetch(location);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('attachment');
  });

  it('1.4 returns 404 VIDEO_NOT_FOUND for stream and download of a non-ready video', async () => {
    const publicId = await seedVideo(VideoStatus.PROCESSING, 'procdeliv12');

    const stream = await request(server())
      .get(`/videos/${publicId}/stream`)
      .expect(404);
    expect(stream.body.error).toBe('VIDEO_NOT_FOUND');

    const download = await request(server())
      .get(`/videos/${publicId}/download`)
      .expect(404);
    expect(download.body.error).toBe('VIDEO_NOT_FOUND');
  });
});
