import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker/worker.module';

// Second entrypoint of the same codebase (phase-03-videos/TD-03): a standalone
// application context with no HTTP listener. The BullMQ connection registered by
// WorkerModule keeps the process alive; SIGTERM drains it via shutdown hooks.
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  Logger.log('Video worker application context ready', 'Worker');
}

void bootstrap();
