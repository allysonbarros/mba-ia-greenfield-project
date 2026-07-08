import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { S3_CLIENT, S3_PRESIGN_CLIENT } from './storage.constants';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

describe('StorageService (integration)', () => {
  let moduleRef: TestingModule;
  let service: StorageService;
  let opsClient: S3Client;
  let presignClient: S3Client;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    // init() runs onModuleInit → ensureBucket against real MinIO.
    await moduleRef.init();
    service = moduleRef.get(StorageService);
    opsClient = moduleRef.get(S3_CLIENT);
    presignClient = moduleRef.get(S3_PRESIGN_CLIENT);
  }, 30000);

  afterAll(async () => {
    await moduleRef.close();
  });

  describe('ensureBucket', () => {
    it('is idempotent — a second call on the existing bucket does not throw', async () => {
      await expect(service.ensureBucket()).resolves.toBeUndefined();
    });

    it('does not create the bucket when autoCreateBucket is false', async () => {
      const config = {
        ...storageConfig(),
        bucket: `absent-${randomUUID()}`,
        autoCreateBucket: false,
      };
      const gated = new StorageService(opsClient, presignClient, config);

      await gated.ensureBucket();

      await expect(
        opsClient.send(new HeadBucketCommand({ Bucket: config.bucket })),
      ).rejects.toBeDefined();
    });
  });

  describe('multipart upload via presigned URLs', () => {
    it('completes a single last part (< 5 MiB) and yields an intact object', async () => {
      const key = `test/${randomUUID()}/small.bin`;
      const { uploadId } = await service.createMultipartUpload(
        key,
        'application/octet-stream',
      );
      const body = Buffer.alloc(1024, 0x61);
      const [part] = await service.presignUploadPartUrls(
        key,
        uploadId,
        1,
        3600,
      );

      // presigned URL must carry the public endpoint host, not an ops-only host
      expect(part.url).toContain('minio:9000');

      const putRes = await fetch(part.url, { method: 'PUT', body });
      expect(putRes.ok).toBe(true);
      const etag = putRes.headers.get('etag');
      expect(etag).toBeTruthy();

      await service.completeMultipartUpload(key, uploadId, [
        { partNumber: 1, etag: etag! },
      ]);

      const head = await service.headObject(key);
      expect(head.contentLength).toBe(1024);

      await service.deleteObjects([key]);
    }, 30000);
  });

  describe('presigned GET with Range', () => {
    it('serves 206 Partial Content with a Content-Range header', async () => {
      const key = `test/${randomUUID()}/range.bin`;
      await service.putObject(
        key,
        Buffer.alloc(200, 0x62),
        'application/octet-stream',
      );

      const url = await service.presignGetUrl(key, { expiresIn: 3600 });
      const res = await fetch(url, { headers: { Range: 'bytes=0-99' } });

      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBeTruthy();

      await service.deleteObjects([key]);
    }, 30000);
  });
});
