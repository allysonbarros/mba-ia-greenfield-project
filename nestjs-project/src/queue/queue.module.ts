import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigType } from '@nestjs/config';
import queueConfig from '../config/queue.config';
import { VIDEO_QUEUE } from './queue.constants';
import { VideoQueueProducer } from './video-queue.producer';

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [queueConfig.KEY],
      useFactory: (config: ConfigType<typeof queueConfig>) => ({
        connection: {
          host: config.redisHost,
          port: config.redisPort,
          // BullMQ requires the blocking connection to have retries disabled
          // (library-refs → @nestjs/bullmq).
          maxRetriesPerRequest: null,
        },
      }),
    }),
    BullModule.registerQueueAsync({
      name: VIDEO_QUEUE,
      imports: [ConfigModule],
      inject: [queueConfig.KEY],
      useFactory: (config: ConfigType<typeof queueConfig>) => ({
        defaultJobOptions: {
          attempts: config.videoProcessingAttempts,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: 1000, // keep Redis lean, retain recent for inspection
          removeOnFail: false, // retain failed jobs for diagnosis
        },
      }),
    }),
  ],
  providers: [VideoQueueProducer],
  exports: [VideoQueueProducer, BullModule],
})
export class QueueModule {}
