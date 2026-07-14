import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  // Internal ops endpoint (Compose service name) vs. the host the presigned URL
  // is hit from — see phase-03-videos/TD-07 dual-client rationale.
  endpoint: process.env.STORAGE_ENDPOINT!,
  publicEndpoint: process.env.STORAGE_PUBLIC_ENDPOINT!,
  region: process.env.STORAGE_REGION || 'us-east-1',
  accessKeyId: process.env.STORAGE_ACCESS_KEY_ID!,
  secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY!,
  bucket: process.env.STORAGE_BUCKET!,
  forcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE !== 'false',
  autoCreateBucket: process.env.STORAGE_AUTO_CREATE_BUCKET !== 'false',
  uploadPartSizeMb: parseInt(process.env.UPLOAD_PART_SIZE_MB || '64', 10),
  uploadUrlExpiresIn: parseInt(
    process.env.UPLOAD_URL_EXPIRES_IN || '21600',
    10,
  ),
  playbackUrlExpiresIn: parseInt(
    process.env.PLAYBACK_URL_EXPIRES_IN || '21600',
    10,
  ),
  downloadUrlExpiresIn: parseInt(
    process.env.DOWNLOAD_URL_EXPIRES_IN || '900',
    10,
  ),
  uploadStaleTtlHours: parseInt(process.env.UPLOAD_STALE_TTL_HOURS || '24', 10),
}));
