import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { ListMultipartUploadsCommand, S3Client } from '@aws-sdk/client-s3';
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
import { VideoSweepService } from './video-sweep.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const HOUR_MS = 60 * 60 * 1000;
const rand11 = () => randomUUID().replace(/-/g, '').slice(0, 11);

describe('VideoSweepService (integration)', () => {
  let moduleRef: TestingModule;
  let sweep: VideoSweepService;
  let dataSource: DataSource;
  let videoRepo: Repository<Video>;
  let userRepo: Repository<User>;
  let channelRepo: Repository<Channel>;
  let storage: StorageService;
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

    sweep = moduleRef.get(VideoSweepService, { strict: false });
    dataSource = moduleRef.get(DataSource, { strict: false });
    videoRepo = dataSource.getRepository(Video);
    userRepo = dataSource.getRepository(User);
    channelRepo = dataSource.getRepository(Channel);
    storage = moduleRef.get(StorageService, { strict: false });
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

  async function createChannel(): Promise<string> {
    const user = await userRepo.save(
      userRepo.create({
        email: `sweep_${randomUUID()}@example.com`,
        password: 'h',
      }),
    );
    const channel = await channelRepo.save(
      channelRepo.create({
        name: 'Chan',
        nickname: `sweepchan_${randomUUID().slice(0, 8)}`,
        user_id: user.id,
      }),
    );
    return channel.id;
  }

  it('expires an old draft and aborts its open multipart upload', async () => {
    const channelId = await createChannel();
    const id = randomUUID();
    const key = `videos/${id}/original.mp4`;
    const { uploadId } = await storage.createMultipartUpload(key, 'video/mp4');
    await videoRepo.insert({
      id,
      public_id: rand11(),
      channel_id: channelId,
      title: 'Old Draft',
      status: VideoStatus.DRAFT,
      original_key: key,
      upload_id: uploadId,
      file_size: 1024,
      content_type: 'video/mp4',
    });
    await dataSource.query('UPDATE videos SET created_at = $1 WHERE id = $2', [
      new Date(Date.now() - 48 * HOUR_MS),
      id,
    ]);

    await sweep.sweep();

    expect(await videoRepo.findOneBy({ id })).toBeNull();
    const list = await s3.send(
      new ListMultipartUploadsCommand({ Bucket: storageConfig().bucket }),
    );
    const dangling = (list.Uploads ?? []).some((u) => u.Key === key);
    expect(dangling).toBe(false);
  }, 30000);

  it('fails a processing video stuck past the ceiling with STUCK_TIMEOUT', async () => {
    const channelId = await createChannel();
    const id = randomUUID();
    await videoRepo.insert({
      id,
      public_id: rand11(),
      channel_id: channelId,
      title: 'Stuck',
      status: VideoStatus.PROCESSING,
      original_key: `videos/${id}/original.mp4`,
      file_size: 1024,
      content_type: 'video/mp4',
      processing_started_at: new Date(Date.now() - 5 * HOUR_MS),
    });

    await sweep.sweep();

    const video = await videoRepo.findOneByOrFail({ id });
    expect(video.status).toBe(VideoStatus.FAILED);
    expect(video.error_code).toBe('STUCK_TIMEOUT');
  }, 30000);

  it('leaves ready and failed videos untouched', async () => {
    const channelId = await createChannel();
    const readyId = randomUUID();
    const failedId = randomUUID();
    await videoRepo.insert({
      id: readyId,
      public_id: rand11(),
      channel_id: channelId,
      title: 'Ready',
      status: VideoStatus.READY,
      original_key: `videos/${readyId}/original.mp4`,
      file_size: 1024,
      content_type: 'video/mp4',
    });
    await videoRepo.insert({
      id: failedId,
      public_id: rand11(),
      channel_id: channelId,
      title: 'Failed',
      status: VideoStatus.FAILED,
      error_code: 'PROBE_FAILED',
      original_key: `videos/${failedId}/original.mp4`,
      file_size: 1024,
      content_type: 'video/mp4',
      processing_started_at: new Date(Date.now() - 5 * HOUR_MS),
    });
    await dataSource.query('UPDATE videos SET created_at = $1 WHERE id = $2', [
      new Date(Date.now() - 48 * HOUR_MS),
      readyId,
    ]);

    await sweep.sweep();

    expect((await videoRepo.findOneByOrFail({ id: readyId })).status).toBe(
      VideoStatus.READY,
    );
    const failed = await videoRepo.findOneByOrFail({ id: failedId });
    expect(failed.status).toBe(VideoStatus.FAILED);
    expect(failed.error_code).toBe('PROBE_FAILED');
  }, 30000);
});
