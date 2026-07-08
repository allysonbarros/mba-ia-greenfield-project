import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import { VIDEO_QUEUE } from '../queue/queue.constants';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

// SPEC_DEVIATION: writes an inline Buffer to original.mp4 rather than
// test/fixtures/tiny.mp4 (SI-03.11's deliverable, needs ffmpeg absent from this
// container). Delivery only presigns and streams bytes — MinIO serves Range/206
// off any object regardless of media validity, so raw bytes suffice.
describe('Video delivery (integration)', () => {
  let moduleRef: TestingModule;
  let service: VideosService;
  let storage: StorageService;
  let dataSource: DataSource;
  let videoRepo: Repository<Video>;
  let userRepo: Repository<User>;
  let channelRepo: Repository<Channel>;
  let queue: Queue;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(
          createTestDataSource(ALL_ENTITIES, { synchronize: false }).options,
        ),
        VideosModule,
      ],
    }).compile();
    await moduleRef.init();

    service = moduleRef.get(VideosService, { strict: false });
    storage = moduleRef.get(StorageService, { strict: false });
    dataSource = moduleRef.get(DataSource, { strict: false });
    videoRepo = moduleRef.get(getRepositoryToken(Video), { strict: false });
    userRepo = dataSource.getRepository(User);
    channelRepo = dataSource.getRepository(Channel);
    queue = moduleRef.get<Queue>(getQueueToken(VIDEO_QUEUE), { strict: false });
  }, 30000);

  afterAll(async () => {
    await queue.obliterate({ force: true }).catch(() => undefined);
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await storage.deleteObjects(await storage.listObjects());
  });

  async function seedVideo(
    status: VideoStatus,
    publicId: string,
  ): Promise<string> {
    const user = await userRepo.save(
      userRepo.create({ email: `del_${randomUUID()}@example.com`, password: 'h' }),
    );
    const channel = await channelRepo.save(
      channelRepo.create({
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
    await videoRepo.insert({
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

  it('serves Range/206 off the presigned playback URL', async () => {
    const publicId = await seedVideo(VideoStatus.READY, 'readydeliv1');

    const url = await service.getStreamUrl(publicId);
    const res = await fetch(url, { headers: { Range: 'bytes=0-1023' } });

    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toMatch(/^bytes 0-1023\//);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBe(1024);
  }, 30000);

  it('serves the download URL with an attachment content-disposition', async () => {
    const publicId = await seedVideo(VideoStatus.READY, 'readydeliv2');

    const url = await service.getDownloadUrl(publicId);
    const res = await fetch(url);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.headers.get('content-disposition')).toContain('My Clip.mp4');
  }, 30000);

  it('refuses to presign delivery for a non-ready video', async () => {
    const publicId = await seedVideo(VideoStatus.PROCESSING, 'procdeliv12');

    await expect(service.getStreamUrl(publicId)).rejects.toThrow();
    await expect(service.getDownloadUrl(publicId)).rejects.toThrow();
  }, 30000);
});
