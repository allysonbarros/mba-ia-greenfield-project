import { registerAs } from '@nestjs/config';

export default registerAs('queue', () => ({
  redisHost: process.env.REDIS_HOST!,
  redisPort: parseInt(process.env.REDIS_PORT || '6379', 10),
  videoProcessingAttempts: parseInt(
    process.env.VIDEO_PROCESSING_ATTEMPTS || '3',
    10,
  ),
  processingStuckCeilingHours: parseInt(
    process.env.PROCESSING_STUCK_CEILING_HOURS || '2',
    10,
  ),
}));
