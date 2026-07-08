import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import queueConfig from '../config/queue.config';
import { VIDEO_QUEUE } from './queue.constants';
import { QueueModule } from './queue.module';
import { VideoQueueProducer } from './video-queue.producer';

describe('QueueModule', () => {
  it('should compile with the video-processing queue and producer', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();

    expect(moduleRef.get(VideoQueueProducer)).toBeInstanceOf(VideoQueueProducer);
    expect(moduleRef.get(getQueueToken(VIDEO_QUEUE))).toBeDefined();

    await moduleRef.close();
  }, 30000);
});
