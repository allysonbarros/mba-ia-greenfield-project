import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { S3Client } from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { S3_CLIENT, S3_PRESIGN_CLIENT } from './storage.constants';
import { StorageService } from './storage.service';

// Presigning is offline SigV4 computation (the presign client never connects),
// so it can point at STORAGE_PUBLIC_ENDPOINT — the host the browser/player will
// actually hit — while ops go through the internal STORAGE_ENDPOINT.
// requestChecksumCalculation=WHEN_REQUIRED keeps the SDK from baking a CRC32
// header into presigned PUT URLs that a plain client PUT would not send
// (phase-03-videos/TD-07, library-refs → @aws-sdk/client-s3).
function buildClient(
  endpoint: string,
  config: ConfigType<typeof storageConfig>,
): S3Client {
  return new S3Client({
    region: config.region,
    endpoint,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });
}

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: S3_CLIENT,
      inject: [storageConfig.KEY],
      useFactory: (config: ConfigType<typeof storageConfig>) =>
        buildClient(config.endpoint, config),
    },
    {
      provide: S3_PRESIGN_CLIENT,
      inject: [storageConfig.KEY],
      useFactory: (config: ConfigType<typeof storageConfig>) =>
        buildClient(config.publicEndpoint, config),
    },
    StorageService,
  ],
  exports: [StorageService],
})
export class StorageModule {}
