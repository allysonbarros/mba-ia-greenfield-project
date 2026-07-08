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
import { cleanAllTables, createTestDataSource } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

// SPEC_DEVIATION: uploads an inline Buffer rather than test/fixtures/tiny.mp4
// (that fixture is SI-03.11's deliverable and needs ffmpeg, absent from this
// container). The complete flow validates ETags/size only, so bytes suffice.
describe('Video upload flow (integration)', () => {
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
    await queue.obliterate({ force: true });
  });

  async function createUserWithChannel(): Promise<string> {
    const user = await userRepo.save(
      userRepo.create({ email: `upload_${Date.now()}@example.com`, password: 'h' }),
    );
    await channelRepo.save(
      channelRepo.create({
        name: 'Chan',
        nickname: `upchan_${Date.now()}`,
        user_id: user.id,
      }),
    );
    return user.id;
  }

  it('runs initiate → PUT part → complete: transitions to processing and enqueues the job', async () => {
    const userId = await createUserWithChannel();
    const body = Buffer.alloc(1024, 0x61);

    const initiate = await service.initiateUpload(userId, {
      title: 'Integration video',
      file_name: 'clip.mp4',
      file_size: body.length,
      content_type: 'video/mp4',
    });

    const putRes = await fetch(initiate.upload.urls[0].url, {
      method: 'PUT',
      body,
    });
    expect(putRes.ok).toBe(true);
    const etag = putRes.headers.get('etag');
    expect(etag).toBeTruthy();

    const complete = await service.completeUpload(userId, initiate.public_id, {
      parts: [{ part_number: 1, etag: etag! }],
    });
    expect(complete.status).toBe(VideoStatus.PROCESSING);

    const video = await videoRepo.findOneByOrFail({
      public_id: initiate.public_id,
    });
    expect(video.status).toBe(VideoStatus.PROCESSING);
    expect(video.uploaded_at).not.toBeNull();
    expect(video.upload_id).toBeNull();

    const job = await queue.getJob(video.id);
    expect(job).toBeDefined();
    expect(job!.data).toEqual({
      videoId: video.id,
      bucket: storageConfig().bucket,
      key: video.original_key,
    });

    await storage.deleteObjects([video.original_key]);
  }, 30000);
});
