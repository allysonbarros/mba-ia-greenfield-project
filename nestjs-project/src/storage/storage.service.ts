import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import storageConfig from '../config/storage.config';
import { S3_CLIENT, S3_PRESIGN_CLIENT } from './storage.constants';

export interface UploadPartUrl {
  partNumber: number;
  url: string;
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export interface HeadObjectResult {
  contentLength: number;
  contentType?: string;
  etag?: string;
}

export interface PresignGetOptions {
  expiresIn: number;
  disposition?: string;
}

/**
 * Access layer over the S3-compatible object store. Ops (create/complete/abort
 * multipart, head, put, list, delete) go through the internal-endpoint client;
 * presigned URLs are minted by the public-endpoint client so the signed host is
 * the one the caller can actually reach (phase-03-videos/TD-02 + TD-04 + TD-07).
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);

  constructor(
    @Inject(S3_CLIENT) private readonly s3: S3Client,
    @Inject(S3_PRESIGN_CLIENT) private readonly presignS3: S3Client,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureBucket();
  }

  /**
   * HeadBucket → CreateBucket on 404, gated by STORAGE_AUTO_CREATE_BUCKET
   * (true in dev/test, false in prod where IaC owns buckets).
   */
  async ensureBucket(): Promise<void> {
    if (!this.config.autoCreateBucket) {
      return;
    }
    const Bucket = this.config.bucket;
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket }));
    } catch (error) {
      if (!this.isNotFound(error)) {
        throw error;
      }
      await this.s3.send(new CreateBucketCommand({ Bucket }));
      this.logger.log(`Created storage bucket "${Bucket}"`);
    }
  }

  async createMultipartUpload(
    key: string,
    contentType?: string,
  ): Promise<{ uploadId: string }> {
    const result = await this.s3.send(
      new CreateMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!result.UploadId) {
      throw new Error('CreateMultipartUpload returned no UploadId');
    }
    return { uploadId: result.UploadId };
  }

  async presignUploadPartUrls(
    key: string,
    uploadId: string,
    partCount: number,
    expiresIn: number,
  ): Promise<UploadPartUrl[]> {
    const urls: UploadPartUrl[] = [];
    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      const url = await getSignedUrl(
        this.presignS3,
        new UploadPartCommand({
          Bucket: this.config.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
        }),
        { expiresIn },
      );
      urls.push({ partNumber, url });
    }
    return urls;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    await this.s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: [...parts]
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
        },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.s3.send(
      new AbortMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  async headObject(key: string): Promise<HeadObjectResult> {
    const result = await this.s3.send(
      new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
    return {
      contentLength: result.ContentLength ?? 0,
      contentType: result.ContentType,
      etag: result.ETag,
    };
  }

  /**
   * Presigned GET on the public endpoint. `disposition` maps to the
   * `response-content-disposition` query param so it survives signing —
   * inline for playback, `attachment; filename=...` for download (TD-04).
   */
  async presignGetUrl(key: string, opts: PresignGetOptions): Promise<string> {
    return getSignedUrl(
      this.presignS3,
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        ResponseContentDisposition: opts.disposition,
      }),
      { expiresIn: opts.expiresIn },
    );
  }

  async putObject(
    key: string,
    body: Buffer | Uint8Array | string,
    contentType?: string,
  ): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async listObjects(prefix?: string): Promise<string[]> {
    const result = await this.s3.send(
      new ListObjectsV2Command({ Bucket: this.config.bucket, Prefix: prefix }),
    );
    return (result.Contents ?? [])
      .map((o) => o.Key)
      .filter((k): k is string => typeof k === 'string');
  }

  async deleteObjects(keys: string[]): Promise<void> {
    if (keys.length === 0) {
      return;
    }
    await this.s3.send(
      new DeleteObjectsCommand({
        Bucket: this.config.bucket,
        Delete: { Objects: keys.map((Key) => ({ Key })) },
      }),
    );
  }

  private isNotFound(error: unknown): boolean {
    const err = error as {
      name?: string;
      $metadata?: { httpStatusCode?: number };
    };
    return err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404;
  }
}
