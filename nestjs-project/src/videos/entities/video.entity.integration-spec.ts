import { randomUUID } from 'node:crypto';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { generatePublicId } from '../public-id.util';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

function pgErrorCode(error: unknown): string | undefined {
  const err = error as QueryFailedError & {
    code?: string;
    driverError?: { code?: string };
  };
  return err?.code ?? err?.driverError?.code;
}

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    // synchronize:false — the videos table already exists from the CreateVideos
    // migration; recreating its enum via synchronize would clash.
    dataSource = createTestDataSource(ALL_ENTITIES, { synchronize: false });
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `vid_user_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: 'Channel',
        nickname: `vidchan${counter}`,
        user_id: user.id,
      }),
    );
  }

  function buildVideo(
    channelId: string,
    overrides: Partial<Video> = {},
  ): Video {
    return videoRepository.create({
      public_id: generatePublicId(),
      channel_id: channelId,
      title: 'Test Video',
      original_key: `videos/${randomUUID()}/original.mp4`,
      file_size: 1024,
      content_type: 'video/mp4',
      ...overrides,
    });
  }

  it('defaults status to draft when not provided', async () => {
    const channel = await createChannel();
    const saved = await videoRepository.save(buildVideo(channel.id));

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.status).toBe(VideoStatus.DRAFT);
  });

  it('enforces the unique public_id constraint (Postgres 23505)', async () => {
    const channel = await createChannel();
    const publicId = generatePublicId();
    await videoRepository.save(buildVideo(channel.id, { public_id: publicId }));

    let code: string | undefined;
    try {
      await videoRepository.save(
        buildVideo(channel.id, { public_id: publicId }),
      );
    } catch (error) {
      code = pgErrorCode(error);
    }
    expect(code).toBe('23505');
  });

  it('rejects a video whose channel_id has no matching channel (FK violation)', async () => {
    let code: string | undefined;
    try {
      await videoRepository.save(buildVideo(randomUUID()));
    } catch (error) {
      code = pgErrorCode(error);
    }
    expect(code).toBe('23503');
  });

  it('populates created_at and updated_at timestamps', async () => {
    const channel = await createChannel();
    const saved = await videoRepository.save(buildVideo(channel.id));

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.created_at).toBeInstanceOf(Date);
    expect(found.updated_at).toBeInstanceOf(Date);
  });
});
