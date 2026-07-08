---
libs:
  "bullmq":
    version: "^5.79.x"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-07-08T12:24:53-03:00"
  "@nestjs/bullmq":
    version: "^11.0.x"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-07-08T12:24:53-03:00"
  "@nestjs/schedule":
    version: "^6.1.x"
    context7_id: "/nestjs/schedule"
    fetched_at: "2026-07-08T12:24:53-03:00"
  "@aws-sdk/client-s3":
    version: "^3.x"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-07-08T12:24:53-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.x"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-07-08T12:24:53-03:00"
  "@aws-sdk/lib-storage":
    version: "^3.x"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-07-08T12:24:53-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-08T12:20:04-0300"
---

# phase-03-videos — Library References

Distilled docs for libraries decided in this slice. Pulled via Context7. Re-fetch when the underlying TD changes (resolve refreshes this file when the lib set in `## Decisions Index` drifts from the cached set here). Each section covers only the usage surfaces the Phase 03 backend actually touches: queue producer/consumer, the cron sweep, and the S3/MinIO storage path.

## bullmq

**Source:** `/taskforcesh/bullmq` (Context7) — High reputation, 1397 snippets, benchmark 77.24. Maps to `phase-03-videos/TD-01` Decision A. Docs are from the `master` branch (version-agnostic); the API below matches the pinned `^5.79.x` (TD-01 references 5.79.3, published 2026-07-07). No discrepancy — `jobId`, `attempts`/`backoff`, `Worker` lock semantics, `QueueEvents`, and `queue.drain` are all stable in v5.

### Idempotent enqueue + retry/backoff (producer, TD-01 + TD-06)

`jobId = videoId` makes the enqueue idempotent: a second `add` with the same id is a no-op while the job exists, collapsing the crash-between-DB-commit-and-enqueue dual-write window and any double-`complete` call.

```typescript
await videoQueue.add(
  'process-video',
  { videoId, objectKey },          // job payload
  {
    jobId: videoId,                // idempotent: dedupes duplicate enqueues
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 }, // 1s, 2s, 4s between retries
    removeOnComplete: true,        // keep Redis lean; set a number to retain N
    removeOnFail: false,           // retain failed jobs for inspection
  },
);
```

Defaults may also be set queue-wide via `defaultJobOptions` on the queue registration (see `@nestjs/bullmq` below).

### Worker locks for long (minutes-long) jobs (consumer, TD-01 + TD-03)

BullMQ is **at-least-once**: a job whose lock expires becomes _stalled_ and is re-run (double-processed). Lock renews automatically on `lockDuration/2` **only if the event loop is free** — which is why TD-03 spawns FFmpeg as a child process instead of blocking Node.

```typescript
// WorkerOptions (defaults):
//   lockDuration:   30000  // ms a job stays locked; auto-renewed at lockDuration/2
//   stalledInterval:30000  // ms between stalled-checks
//   maxStalledCount:1      // times a stalled job is recovered before → failed
const worker = new Worker('video', processor, {
  connection,
  lockDuration: 60_000,  // give long encodes more slack before stalled-detection
  concurrency: 1,
});
worker.on('stalled', (jobId) => logger.error({ jobId }, 'job stalled — likely double-processed'));
```

Always listen for `stalled` and log it — it signals the event loop was blocked or the process died mid-job. `maxStalledCount` (default 1) caps infinite restart of a crash-looping job before it lands in `failed`.

### Test synchronization + cleanup (TD-08)

Never `setTimeout`-poll. `QueueEvents` streams job lifecycle over Redis; `job.waitUntilFinished(queueEvents)` resolves on completion/failure. `queue.drain()` removes waiting/delayed jobs (not active/completed/failed) for `beforeEach` cleanup.

```typescript
import { Queue, QueueEvents } from 'bullmq';
const queueEvents = new QueueEvents('video', { connection });
await queueEvents.waitUntilReady();

const job = await queue.add('process-video', { videoId }, { jobId: videoId });
const result = await job.waitUntilFinished(queueEvents); // resolves on complete, throws on fail

await queue.drain();          // cleanup: drop waiting/delayed jobs
await queue.drain(true);      // also drop delayed
```

## @nestjs/bullmq

**Source:** `/nestjs/bull` (Context7) — High reputation. Maps to `phase-03-videos/TD-01` Decision A. **Version note:** the `/nestjs/bull` repo hosts BOTH the legacy `@nestjs/bull` (Bull) and the current `@nestjs/bullmq` (BullMQ) packages; the pinned `^11.0.x` is `@nestjs/bullmq`. **Discrepancy to avoid:** use the `@nestjs/bullmq` API — `WorkerHost` class + `@Processor` + `@OnWorkerEvent`. Do NOT use the legacy `@nestjs/bull` `@Process()` **method** decorator (a different package that shares the repo and surfaces in Context7 results).

### Root + queue registration with @nestjs/config

```typescript
// app.module.ts
BullModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    connection: { host: config.get('REDIS_HOST'), port: config.get('REDIS_PORT') }, // host = 'redis' (Compose)
  }),
}),
BullModule.registerQueue({
  name: 'video',
  defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 1000 } },
}),
```

### Producer via @InjectQueue

```typescript
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

constructor(@InjectQueue('video') private readonly videoQueue: Queue) {}
// this.videoQueue.add('process-video', { videoId }, { jobId: videoId });
```

### Consumer via WorkerHost (the correct v11 pattern)

```typescript
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';

@Processor('video', { concurrency: 1 })      // 2nd arg = WorkerOptions (lockDuration, concurrency…)
export class VideoProcessor extends WorkerHost {
  async process(job: Job): Promise<void> {   // called per job; throw to trigger retry/backoff
    /* ffprobe + ffmpeg + storage writes + CAS status update */
  }
  @OnWorkerEvent('completed') onCompleted(job: Job) { /* … */ }
  @OnWorkerEvent('failed')    onFailed(job: Job)    { /* … */ }
}
```

### Standalone worker context (TD-03)

The worker container bootstraps `NestFactory.createApplicationContext(WorkerModule)` (no HTTP listener). `WorkerModule` imports `BullModule.forRootAsync` + `BullModule.registerQueue({ name: 'video' })` and provides `VideoProcessor`. Registering the `@Processor` provider is what instantiates the underlying BullMQ `Worker` and starts consuming — no explicit `new Worker(...)`. Enable `app.enableShutdownHooks()` so SIGTERM drains the worker gracefully.

## @nestjs/schedule

**Source:** `/nestjs/schedule` (Context7) — High reputation, 525 snippets, benchmark 90.55. Maps to `phase-03-videos/TD-06` (abandoned-draft / stuck-`processing` sweep). Pinned `^6.1.x` — API below matches.

### Enable the scheduler + declare a periodic sweep

```typescript
// app.module.ts (or the module owning the sweep)
import { ScheduleModule } from '@nestjs/schedule';
@Module({ imports: [ScheduleModule.forRoot()] })   // global; all schedulers enabled by default
export class AppModule {}
```

```typescript
import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

@Injectable()
export class VideoSweepService {
  @Cron(CronExpression.EVERY_HOUR, { name: 'video-reconciliation-sweep' })
  async sweep(): Promise<void> {
    // abort stale multipart uploads; expire old drafts; CAS stuck `processing` → `failed` past ceiling
  }
}
```

- `@Cron` accepts a `CronExpression` enum, a raw cron string (`'0 * * * *'`), or a `Date`; async handlers are awaited to completion.
- Options object supports `{ name, timeZone, disabled }`; a `name` lets `SchedulerRegistry` reference/toggle the job.
- `ScheduleModule.forRoot({ cronJobs, intervals, timeouts })` can disable scheduler kinds; the sweep only needs the defaults.

## @aws-sdk/client-s3

**Source:** `/aws/aws-sdk-js-v3` (Context7) — High reputation, 24388 snippets. Maps to `phase-03-videos/TD-02`, `TD-04`, `TD-07`. Pinned `^3.x` (TD-07 references 3.1081.0) — command shapes below are stable across v3.

### Dual-client config for MinIO (TD-07)

```typescript
import { S3Client } from '@aws-sdk/client-s3';

// Ops client — internal Compose endpoint, path-style for MinIO
const opsClient = new S3Client({
  region: process.env.STORAGE_REGION,          // any value; MinIO ignores but SDK requires it
  endpoint: 'http://minio:9000',               // Compose service name (TD-07)
  forcePathStyle: true,                         // MinIO needs path-style, not vhost-style
  credentials: { accessKeyId, secretAccessKey },
  requestChecksumCalculation: 'WHEN_REQUIRED',  // since v3.729 SDK sends CRC32 by default; MinIO may reject → set WHEN_REQUIRED
});

// Presign-only client — externally reachable endpoint (SigV4 signs the Host header, so the
// presigned URL must already carry the browser-reachable host). This client never connects.
const presignClient = new S3Client({ ...sameConfig, endpoint: process.env.STORAGE_PUBLIC_ENDPOINT });
```

### Multipart commands (TD-02) + provisioning/validation (TD-07)

```typescript
import {
  CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand, HeadObjectCommand, HeadBucketCommand, CreateBucketCommand,
  ListObjectsV2Command, DeleteObjectsCommand,
} from '@aws-sdk/client-s3';

// 1) initiate → returns UploadId
const { UploadId } = await opsClient.send(new CreateMultipartUploadCommand({ Bucket, Key }));
// 2) per part: presign UploadPartCommand (see presigner section); client PUTs bytes, returns ETag
//    input: { Bucket, Key, UploadId, PartNumber }  // PartNumber 1..10000; parts 5MiB..5GiB except last
// 3) complete with collected ETags:
await opsClient.send(new CompleteMultipartUploadCommand({
  Bucket, Key, UploadId,
  MultipartUpload: { Parts: [{ PartNumber: 1, ETag: '"abc..."' }] }, // ascending PartNumber
}));
// 4) cleanup on abandon: AbortMultipartUploadCommand({ Bucket, Key, UploadId })
// validate before draft→processing CAS: HeadObjectCommand({ Bucket, Key }) → Content-Length, ETag
// ensure-bucket (onModuleInit, gated by STORAGE_AUTO_CREATE_BUCKET): HeadBucket → on 404 CreateBucket
// test cleanup (TD-08): ListObjectsV2 → DeleteObjects (the S3 mirror of DELETE FROM)
```

### Delivery reads (TD-04)

`GetObjectCommand` supports `Range` (native 206/partial content from MinIO) and `ResponseContentDisposition` / `ResponseContentType` — the latter map to the `response-content-disposition` / `response-content-type` **query params** so they survive presigning. Same object, two presigned URLs: inline playback vs `attachment` download.

```typescript
import { GetObjectCommand } from '@aws-sdk/client-s3';
new GetObjectCommand({ Bucket, Key, Range: 'bytes=0-1048575' });                     // seek/stream
new GetObjectCommand({ Bucket, Key, ResponseContentDisposition: 'attachment; filename="video.mp4"' }); // download
```

## @aws-sdk/s3-request-presigner

**Source:** `/aws/aws-sdk-js-v3` (Context7, `packages/s3-request-presigner`) — High reputation. Maps to `phase-03-videos/TD-02` (presigned `UploadPart`) and `TD-04` (presigned `GetObject`). Pinned `^3.x`.

### getSignedUrl — presign any command

```typescript
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { UploadPartCommand, GetObjectCommand } from '@aws-sdk/client-s3';

// Upload: one presigned PUT URL per part, signed by the PUBLIC-endpoint client
const partUrl = await getSignedUrl(
  presignClient,
  new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }),
  { expiresIn: 3600 * 6 },   // hours for large 10GB multipart windows (TD-02)
);

// Playback (~6h) vs download (~15min) — presigned GET, public-endpoint client (TD-04)
const playUrl = await getSignedUrl(presignClient, new GetObjectCommand({ Bucket, Key }), { expiresIn: 6 * 3600 });
```

- `expiresIn` is **seconds**; **default 900** (15 min) if omitted — TD-02/TD-04 deliberately override it (hours for upload/playback, 15 min for download).
- `getSignedUrl` is pure local SigV4 computation — the client never connects, which is why the presign client can point at an endpoint (`STORAGE_PUBLIC_ENDPOINT`) unreachable from inside Docker. **Host is signed**, so the presign client's `endpoint` must be the host the browser/player will actually hit; `Range` is an unsigned header, so seeking re-uses the same URL freely.

## @aws-sdk/lib-storage

**Source:** `/aws/aws-sdk-js-v3` (Context7, `lib/lib-storage`) — High reputation. Maps to `phase-03-videos/TD-07` (worker streaming output uploads: thumbnail / future renditions). Pinned `^3.x`. Replaces v2's `ManagedUpload`.

### Upload — streaming multipart from the worker

```typescript
import { Upload } from '@aws-sdk/lib-storage';

const upload = new Upload({
  client: opsClient,                             // internal-endpoint client
  params: { Bucket, Key: `videos/${videoId}/thumbnail.jpg`, Body: ffmpegStdoutStream, ContentType: 'image/jpeg' },
  queueSize: 4,            // (default 4) concurrent part uploads
  partSize: 5 * 1024 * 1024, // (default 5MiB) minimum legal part size; raise for large renditions
  leavePartsOnError: false,  // (default false) auto-AbortMultipartUpload on failure
});
upload.on('httpUploadProgress', (p) => logger.debug(p));
await upload.done();
```

`Upload` handles streams of unknown size by driving `CreateMultipartUpload → UploadPart* → CompleteMultipartUpload` under the hood — the worker pipes an FFmpeg output stream directly without buffering the whole artifact or knowing its size in advance. This is the worker-side write path; the API-side 10GB ingest uses **presigned** multipart (client PUTs parts directly), not `lib-storage`.
