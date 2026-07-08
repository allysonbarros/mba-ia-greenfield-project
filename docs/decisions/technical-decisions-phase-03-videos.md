---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-07-08
scope_description: "Backend foundation for video upload and processing: queue technology, 10GB direct-to-storage upload strategy, worker topology + FFmpeg integration, streaming/download delivery, unique public URL, video status lifecycle, S3/MinIO usage, and real-infra testing strategy."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — receives the videos module, the storage/queue infrastructure in `compose.yaml`, the `CreateVideos` migration, and the video worker; every TD below covers it.
- `next-frontend/` — no open decision: the video UI is explicitly out of scope for Phase 03 (backend-only phase per the project plan); Cross-layer TDs below record the contracts a future frontend phase will consume.

---

## TD-01: Queue technology for background video processing

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The project plan leaves the message queue explicitly TBD — this is the main open stack decision of the phase. The upload flow ends by enqueuing a processing job and the FFmpeg worker exists only as a consumer of that queue. Jobs run for minutes (10GB files), must survive restarts, retry with backoff, and drive the `draft → processing → ready/failed` status machine. The choice also decides whether Compose gains a new stateful service (Redis/RabbitMQ) or reuses PostgreSQL 17.

**Options:**

### Option A: BullMQ + @nestjs/bullmq (adds Redis to Compose)

- API registers a queue via `BullModule` and adds a job (`videoId` + object key) when an upload completes; the worker container runs a `@Processor` that pulls jobs from Redis. Job locks auto-renew while the process is alive; FFmpeg runs as a spawned child process so the event loop stays free.
- **Pros:** official NestJS-team integration (`@nestjs/bullmq@11.0.4`, peer range matches NestJS 11 exactly — consistent with the project's Nest-ecosystem preference); complete job-queue semantics out of the box (attempts + exponential backoff, failed-job retention, delayed jobs, concurrency control); native progress API; very actively maintained (bullmq 5.79.3, published 2026-07-07); Redis is a small, prod-portable addition reusable later (throttler storage, caching).
- **Cons:** second stateful service in Compose (needs AOF persistence + volume); dual-write Postgres↔Redis (crash between DB commit and `queue.add` can strand a video — mitigated with `jobId = videoId` idempotent enqueue + reconciliation sweep); stalled-job semantics require the worker to never block the event loop.

### Option B: pg-boss 12 (PostgreSQL-backed, zero new infra)

- pg-boss creates its own `pgboss` schema inside the existing PostgreSQL 17. API calls `boss.send()`; worker runs `boss.work()` with polling + LISTEN/NOTIFY. Retry/backoff, dead-letter queues and heartbeats for long jobs are built in.
- **Pros:** zero new infrastructure (worker only needs the existing DB config); transactional consistency — `status=processing` + enqueue can be one ACID transaction, eliminating the dual-write failure mode; actively maintained (12.25.1, 2026-07-03, PG 17 + Node 25 OK); jobs are plain SQL rows (inspectable with existing tooling, first-class test spies API).
- **Cons:** no official NestJS module (hand-written provider ~50 lines); no dashboard UI; no native progress API; queue churn shares the primary DB's connection pool and write load.

### Option C: RabbitMQ + @golevelup/nestjs-rabbitmq (dedicated broker)

- API publishes persistent messages to a durable exchange; worker subscribes with `@RabbitSubscribe` and manual ack, DLX for terminal failures.
- **Pros:** true broker with the best routing/fan-out semantics; language-agnostic consumers; management UI included.
- **Cons:** it is a broker, not a job queue — retries/backoff/job-state must be hand-built (DLX + TTL topology); default consumer ack timeout is 30 min, which actively fights minutes-long encodes (channel closed + redelivery mid-job); heaviest Compose addition (Erlang, hundreds of MB) for a single-consumer first-party API; its flexibility solves problems this project does not have.

**Recommendation:** **Option A (BullMQ + @nestjs/bullmq)** — RabbitMQ is eliminated (no job semantics, 30-min ack timeout vs long encodes, heaviest footprint). BullMQ and pg-boss are honestly near-equivalent at this throughput and pg-boss is a close second (transactional enqueue, zero new infra); BullMQ wins on the criteria the phase names: official NestJS 11 integration consistent with prior Nest-ecosystem picks, built-in progress/observability, a clean documented separate-worker story, and a small prod-portable Redis whose cost is amortized by future reuse. Mitigations adopted: `jobId = videoId` idempotent enqueue, reconciliation sweep, Redis with `appendonly yes` + named volume, hosts via Compose service name (`redis`).

**Decision:** A (BullMQ + @nestjs/bullmq, Redis in Compose)
**Libraries:** `bullmq@^5.79.x`, `@nestjs/bullmq@^11.0.x`

---

## TD-02: Upload strategy for 10GB files (direct-to-storage)

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance; Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** Uploads of up to 10GB must not pass through or block the API, and the video must be pre-registered as draft when the upload starts. A hard physical constraint eliminates naive designs: S3 (and MinIO) caps a single PUT at 5 GiB, so 10GB is impossible without multipart. The handshake defined here is the contract a future frontend consumes (Cross-layer), the entry point of the status machine, and the point where the processing job is enqueued.

**Options:**

### Option A: API-orchestrated S3 presigned multipart upload

- API creates the draft video row, calls `CreateMultipartUpload`, and returns presigned `UploadPart` URLs; the client PUTs parts directly to MinIO (bytes never touch the API) and calls a first-party `complete` endpoint with the part ETags; the API runs `CompleteMultipartUpload`, flips `draft → processing`, and enqueues the job.
- **Pros:** zero video bytes through the API (presigning is local HMAC computation); verified limits fit (parts 5 MiB–5 GiB, max 10,000 parts → 10 GiB at ~100 MiB parts ≈ 103 parts); parallel part upload + per-part retry (partial resumability free); same AWS SDK v3 code path on MinIO dev and S3 prod; draft pre-registration falls out naturally — the initiate endpoint IS the pre-cadastro; completion + enqueue stay in one testable API handler.
- **Cons:** client orchestrates parts/ETags (well-trodden pattern — Uppy's aws-s3 plugin implements exactly this contract); SigV4 signs the Host header → needs a second presign-only S3 client with the externally reachable endpoint; abandoned parts need cleanup (see TD-06/TD-07 — MinIO does not honor the `AbortIncompleteMultipartUpload` ILM action but auto-purges stale uploads after 24h; an API-side sweep is the portable mechanism).

### Option B: Single presigned PUT

- API generates one presigned `PutObject` URL; client PUTs the whole file.
- **Pros:** simplest flow; remains the right tool for small assets (thumbnails).
- **Cons:** eliminated for videos — S3/MinIO cap a single PUT at 5 GiB, so the 10GB requirement is physically unsatisfiable; no resume, no parallelism.

### Option C: tus resumable protocol (@tus/server + @tus/s3-store sidecar)

- A tus container speaks the resumable-upload protocol with the client and relays chunks to MinIO as multipart parts; completion signaled via hooks calling back into the API.
- **Pros:** best-in-class resumability semantics, standardized protocol; actively maintained (`@tus/server` 2.4.1); keeps load off the NestJS API.
- **Cons:** bytes DO pass through a first-party Node process — just a different one; auth/pré-cadastro/completion wired through hooks makes a second service participate in domain state transitions (violates single-responsibility instinct); multi-instance needs a Redis KvStore; its expiration cleanup relies on S3 object tagging + lifecycle rules that clash with MinIO's ILM gaps.

### Option D: API streaming passthrough (busboy → lib-storage) — rejected baseline

- Client POSTs `multipart/form-data` to a Nest endpoint that pipes to S3 from inside the API process.
- **Pros:** simplest client contract; no presigned-URL concerns.
- **Cons:** exactly what the challenge forbids — every byte of 10GB traverses the API's network and event loop; long-lived requests fight Express timeouts and the throttler; no resume. Anti-pattern baseline only.

**Recommendation:** **Option A (presigned multipart, client-called complete endpoint)** — the only option satisfying all constraints simultaneously. Within the choice: parts of 64–128 MiB presigned upfront with hours-long `expiresIn`; completion signaled by the client calling `POST .../complete` (not MinIO bucket notifications — admin-config, non-portable to S3's SNS/SQS event surface, and the API must own the state transition anyway); `HeadObject` validation before transitioning; dual-endpoint S3 client config per TD-07.

**Decision:** A (presigned multipart upload, client-called complete endpoint)
**Libraries:** —

---

## TD-03: Worker topology and FFmpeg integration

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** Processing must run outside the API (separate process/container). How the worker shares entities/config with the API determines the Dockerfile and compose topology; how it invokes FFmpeg determines reliability on 10GB files. The previously-standard `fluent-ffmpeg` wrapper was archived in May 2025, so the integration approach must be decided from currently-maintained options.

**Options:**

### Option A: Separate container, same NestJS codebase, standalone application context

- Second entrypoint `src/worker.ts` calling `NestFactory.createApplicationContext(WorkerModule)` — no HTTP listener, just the IoC container (official NestJS standalone-application pattern). A `video-worker` Compose service reuses the same build context with an ffmpeg-installing Dockerfile variant and a different command.
- **Pros:** zero repo restructuring; entities, migrations, config schemas and enums shared natively (no drift); queue-agnostic (works with BullMQ processor or any consumer); one npm install/one image lineage; graceful SIGTERM via `enableShutdownHooks`.
- **Cons:** same image lineage couples API/worker builds; worker image carries unused HTTP deps (dead weight, not runtime cost); module boundary is by convention (WorkerModule must import only infra modules — enforced by review).

### Option B: Nest CLI monorepo mode (apps/api + apps/worker + libs/shared)

- Convert to Nest CLI workspace mode with explicit shared libs.
- **Pros:** enforced compile-time boundary; leaner per-app artifacts; scales to more apps.
- **Cons:** large mid-project restructuring (every import path, jest config, TypeORM CLI data-source, Docker mount and script changes) for zero new capability this phase; monorepo-inside-a-monorepo confusion.

### Option C: @nestjs/microservices transport consumer

- Bootstrap with `createMicroservice` and handle jobs via `@EventPattern`.
- **Pros:** framework-native consumer with DI and ack context.
- **Cons:** hard-couples this TD to the queue TD (BullMQ is NOT a Nest microservices transport); the RMQ transport is RPC/event-oriented and fights long-running jobs (prefetch, manual ack, retries); no benefit over Option A for a single job type.

**Recommendation:** **Option A + direct `ffprobe`/`ffmpeg` invocation via `node:child_process` (promisified `execFile`), binaries from Debian apt (ffmpeg 7.1.5 on the node:25.6.0-slim/trixie base)** — Option A delivers mandatory process isolation with zero restructuring and shares entities/config by construction. FFmpeg wrapper libs are ruled out on facts: `fluent-ffmpeg` archived 2025-05-22; `execa` 9.x is ESM-only and fails `tsc --noEmit` (TS1479) under this CJS TS 5.7 build. The two needed commands are static-argv and trivial (`ffprobe -print_format json -show_format -show_streams`; `ffmpeg -ss <t> -i <input> -frames:v 1 -vf scale=640:-2`). Large-file pattern: never pipe MP4 into ffprobe via stdin (trailing moov atom fails on non-seekable input) — pass a presigned GET URL as seekable input (ffmpeg's HTTP reader issues Range requests), avoiding a 10GB copy to worker disk; fall back to tmp-file download if URL seeking proves unreliable.

**Decision:** A (standalone application-context worker container + `node:child_process` ffprobe/ffmpeg from Debian apt)
**Libraries:** —

---

## TD-04: Streaming playback and download delivery

**Scope:** Cross-layer

**Capability:** Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** Playback must stream (HTTP Range / partial content) and users must be able to download; videos up to 10GB live in MinIO. The no-bytes-through-the-API constraint applies symmetrically to delivery. Anonymous playback of public videos is allowed, so the media request itself cannot require a JWT. The architecture diagram already draws `Frontend → Object Storage (Streams, HTTPS)`.

**Options:**

### Option A: API issues 302 redirect to presigned GET URL on MinIO

- `GET /videos/:publicId/stream` validates status/visibility and replies `302 Location: <presigned URL>`; MinIO serves bytes natively with `Accept-Ranges`/206. Seeking re-requests the same URL with Range headers (works — SigV4 signs the host, Range is an unsigned header). Download presigns with `ResponseContentDisposition: attachment` — same object, two URLs.
- **Pros:** zero video bytes through Node (mirrors the upload constraint); MinIO implements Range/206/Content-Type natively (no hand-rolled protocol code); auth enforced at URL issuance (public route via `@Public` under the global JWT guard); trivially portable to S3/CloudFront; `<video src>` follows redirects transparently and media playback is not CORS-blocked.
- **Cons:** presigned-host wrinkle in Docker dev (needs the TD-07 dual-endpoint client); URL expiry vs long sessions needs a deliberate policy (hours for playback, not the 900s SDK default; player re-requests on error); issued URLs are bearer-shareable until expiry (acceptable — YouTube-style URLs are shareable anyway).

### Option B: API proxies the stream (manual 206 Partial Content)

- Controller parses Range, calls `GetObject` with Range, pipes Body to Express, hand-sets 206/Content-Range headers (NestJS `StreamableFile` implements none of the Range protocol).
- **Pros:** per-request auth on every byte; no presigned-host or expiry concerns; easy per-user throttling/analytics.
- **Cons:** violates the phase's own constraint rationale — 10GB streams and every seek traverse the single Node container, degrading the whole API; hand-rolled RFC 9110 Range parsing (open-ended/suffix/416/multi-range) is protocol code to write and test; incompatible with CDN offload later.

### Option C: Hybrid — presigned redirect for playback, API proxy for download

- Playback per Option A; download through an authenticated API pipe with `Content-Disposition`.
- **Pros:** playback gets native Range handling; exact download audit.
- **Cons:** inherits Option B's worst case anyway (a 10GB download occupies an API connection for its full duration); two delivery paths to build and test; the audit benefit is achievable by logging at URL issuance.

**Recommendation:** **Option A (302 → presigned GET for both playback inline and download attachment)** — the same physics that forbids upload passthrough eliminates the proxy paths. Sub-decisions: playback URL expiry ~6h, download ~15min; both presigned by the public-endpoint client from TD-07. Boundary statement: HLS/ABR transcoding is explicitly OUT of scope (the plan asks only duration/metadata/thumbnail); delivery is progressive MP4 over HTTP Range, and a future `-movflags +faststart` remux is the natural extension point, not part of this phase.

**Decision:** A (302 → presigned GET for playback inline and download attachment)
**Libraries:** —

---

## TD-05: Unique public URL strategy

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** The public identifier must exist at draft pre-registration time (the API returns the video's canonical identity before the upload starts) and fixes the videos migration and public route shape. Codebase facts: PKs are already random UUIDs (nothing sequential to leak), and the build is CommonJS emit under `module: nodenext` with TypeScript ^5.7.3 — ESM-only ID libraries are a real compile/test constraint. Sqids/hashids was dropped as clearly inadequate (encodes integer serials this schema doesn't have; own docs warn IDs are decodable).

**Options:**

### Option A: Dedicated `public_id`: 11-char base64url from `node:crypto` (zero-dep)

- `public_id varchar(11) UNIQUE NOT NULL`, filled at draft creation by a ~10-line pure function (`crypto.randomBytes(11)` mapped through the 64-symbol alphabet `A-Za-z0-9_-` via `byte & 63` — bias-free since 64 divides 256). On Postgres `23505` the service regenerates and retries once. Internal FKs, job payloads and storage keys keep using the UUID PK.
- **Pros:** YouTube-identical aesthetics and entropy (64^11 = 2^66; collision probability ≈ 6.8e-9 at 1M videos, and UNIQUE+retry makes residual risk zero); zero dependencies, CJS-safe, trivially unit-testable; decouples public identifier from internal PK (URL rotation possible without touching objects/FKs); validates at DTO boundary with `@Matches(/^[A-Za-z0-9_-]{11}$/)`.
- **Cons:** ~10 lines of owned crypto code instead of a library; two identifiers per video (one extra column + unique index); the retry branch must be written and tested although it statistically never fires.

### Option B: nanoid library (v5, customAlphabet/size 11)

- `nanoid(11)` at draft creation, same column/constraint/retry design.
- **Pros:** battle-tested reference implementation of exactly this ID style; identical output shape and math.
- **Cons:** ESM-only since v4 — under this project's CJS emit + TS 5.7, importing it fails `npx tsc --noEmit` with TS1479 (require(esm) typecheck lands only in TS 5.8), breaking the locked Definition of Done; Jest require(esm) machinery is recent and fragile; the escape hatch is pinning legacy nanoid@3 — adopting a legacy major on day one for ~10 lines of code.

### Option C: Full UUID in the URL

- Expose the UUIDv4 PK directly (`/videos/9f3c2a1e-…`), or add time-ordered UUIDv7 via the `uuid` package.
- **Pros:** zero collision handling, zero new columns if PK reused, zero deps for v4; consistent with users/channels exposing UUIDs.
- **Cons:** 36-char URLs are hostile for a video platform where links are shared; couples public identifier to internal PK permanently; UUIDv7 leaks creation timestamp, the `uuid` package is ESM-only since v12 (same TS1479 problem), and PG 17 has no native `uuidv7()`.

### Option D: Title slug + random suffix (`/watch/my-video-x7Kp2q`)

- `slugify(title) + '-' + 6-8 random chars` at draft creation.
- **Pros:** human-readable, SEO-friendly URLs.
- **Cons:** the title is mutable and typically empty at draft pre-registration — forces placeholder slugs or URL changes on rename (breaking shared links); needs slugify dependency + i18n/profanity/length policy for zero uniqueness benefit; SEO is irrelevant this phase (no frontend). Deferrable: a cosmetic slug can later be added in front of the same immutable `public_id` without schema change.

**Recommendation:** **Option A (zero-dep 11-char base64url `public_id`, UNIQUE + single retry on 23505)** — Options A and B produce byte-identical IDs; the decision is purely dependency mechanics, and there the stack is decisive: nanoid v5 breaks the `tsc --noEmit` DoD gate under TS 5.7/CJS. Owning a 10-line bias-free generator beats upgrading TypeScript as a side effect of an ID choice or pinning a legacy major.

**Decision:** A (zero-dep 11-char base64url `public_id`, UNIQUE + single retry on 23505)
**Libraries:** —

---

## TD-06: Video status lifecycle and failure handling

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Serviço de processamento em segundo plano (filas)"

**Context:** The challenge requires `rascunho → processando → pronto/erro` persisted in the videos table. Two independent writers (API and worker) plus at-least-once queue delivery mean transition rules, idempotency and permanent-failure semantics must be fixed before the entity/migration and job contract are written.

**Options:**

### Option A: Minimal 4-state enum + service-layer transition map enforced by atomic compare-and-swap UPDATE

- Postgres enum `draft | processing | ready | failed`; a typed map defines legal transitions; every transition is a conditional `UPDATE … WHERE status = expectedFrom` (`UpdateResult.affected === 0` → domain exception). API owns `create→draft` and `draft→processing` (after `HeadObject` verifies the file); worker owns `processing→ready/failed`.
- **Pros:** the CAS UPDATE is guard + concurrency control + idempotency in one primitive (duplicate complete calls and duplicate deliveries collapse to `affected=0`); zero new dependencies, unit- and integration-testable with the existing setup; matches the challenge's exact four statuses; retry-transparent (transient failures ride the queue's retry/backoff and never touch the DB).
- **Cons:** `processing` conflates queued-waiting and actively-transcoding — auxiliary timestamp/attempt columns cover observability; invariant lives in app code only (acceptable: both writers are first-party); stuck `processing` rows need a compensating sweep.

### Option B: Richer 6-state machine (draft → uploading → uploaded → processing → ready/failed)

- Client signals upload start/completion; worker CAS-updates `uploaded→processing` on pickup.
- **Pros:** distinguishes queue-wait from active transcoding; finer stuck-detection.
- **Cons:** `uploading` is a fiction under presigned direct-to-MinIO upload (the API cannot observe upload progress — the state would be client-asserted and unreliable); more transitions → more idempotency edge cases; extra states leak into API contracts for no user-facing benefit.

### Option C: XState v5 machine as transition authority

- `createMachine()` definition; services validate transitions statelessly and persist the result.
- **Pros:** declarative, visualizable machine; stateless backend usage officially supported.
- **Cons:** heavy ceremony for a 4-state linear DAG (the typed map is ~10 lines); not idiomatic in NestJS; does not remove the CAS UPDATE — it validates in memory only, duplicating rather than replacing the cross-process mechanism.

### Option D: DB-enforced transitions (Postgres enum + BEFORE UPDATE trigger)

- A trigger RAISEs when `(OLD.status, NEW.status)` is not allowlisted.
- **Pros:** invariant holds against every writer including manual SQL.
- **Cons:** splits domain logic into SQL invisible to TypeScript; violations surface as opaque `QueryFailedError` needing translation to domain-exception codes; every lifecycle test needs live Postgres; CAS is still needed for concurrent-writer ordering — the guard ends up implemented twice.

**Recommendation:** **Option A (4-state enum + CAS transition map)** — both writers are first-party, so app-layer enforcement suffices, and TypeORM's `update()` + `affected` already provides the CAS primitive. Protocol: (1) API creates `draft` when issuing the presigned upload; (2) on complete, `HeadObject` → CAS `draft→processing` → enqueue with `jobId = videoId` (double-enqueue dedupes; double-complete returns idempotent response); (3) worker CAS `processing→ready` on success and `processing→failed` only on attempts-exhausted or unrecoverable errors (persisting `error_code`/`error_message`); (4) worker-crash recovery delegated to the queue's stalled-job mechanism; (5) abandoned drafts: scheduled sweep (`@nestjs/schedule`) aborts stale multipart uploads and expires old drafts; the same sweep nets stuck `processing` rows to `failed` past a hard ceiling.

**Decision:** A (4-state enum draft/processing/ready/failed + CAS transition map)
**Libraries:** `@nestjs/schedule@^6.1.x`

---

## TD-07: Object storage usage (SDK, bucket/key layout, MinIO in Compose)

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The storage itself is given (S3-compatible; MinIO in dev, S3 in prod) — what is open is HOW to use it: client SDK, bucket/key organization, endpoint strategy for presigning inside Docker, and provisioning. A 2025 fact forces an explicit position: MinIO stopped publishing community Docker images in Oct 2025, so the image tag and bucket-provisioning strategy must be pinned and documented rather than assuming `minio/minio:latest` + `mc` init container.

**Options:**

### Option A: @aws-sdk/client-s3 v3 + s3-request-presigner (+ lib-storage), custom NestJS provider, dual-client

- A `StorageModule` exposes `S3Client` instances via `useFactory` providers from a `registerAs('storage')` namespace: an ops client on the internal endpoint (`http://minio:9000`, `forcePathStyle: true`) and a presign-only client on `STORAGE_PUBLIC_ENDPOINT` (presigning is offline SigV4 — the client never connects; it only bakes the reachable host into the signature).
- **Pros:** first-party AWS SDK (3.1081.0) — zero MinIO→S3 portability risk, which is the point of choosing MinIO; the only clean path to presigned multipart (per-part presigned `UploadPartCommand`) that TD-02 requires; `lib-storage` gives the worker streaming uploads; `GetObject` supports Range + `response-content-disposition` overrides covering TD-04; ~20-line custom provider matches the project's no-glue-libs pattern (cf. custom guards over passport); trivially mockable in unit tests.
- **Cons:** verbose command-object API and a large @smithy dependency tree; since v3.729 the SDK sends CRC32 flexible checksums by default (set `WHEN_REQUIRED` if the pinned MinIO rejects them); the dual-client pattern needs an explanatory comment.

### Option B: minio-js 8.x (official MinIO client)

- `new Minio.Client(...)` in the same custom-provider pattern; high-level `presignedGetObject`/`fPutObject` helpers.
- **Pros:** actively maintained (8.0.7), smaller footprint, friendlier high-level API; always path-style.
- **Cons:** no public presigned-multipart API — the 10GB direct upload becomes hand-built multipart XML; second-party S3 compatibility weakens prod portability; the dual-endpoint presign problem exists anyway with fewer docs; the only NestJS wrapper is dead (last publish 2023).

### Option C: nestjs-s3 wrapper module over the AWS SDK

- Community `S3Module.forRootAsync` + `@InjectS3()`.
- **Pros:** saves ~20 lines of provider boilerplate; underlying calls are plain AWS SDK.
- **Cons:** maintenance red flag (last publish 2025-06, single maintainer); ships one client instance by default, fighting the required dual-client setup; contradicts the project's thin-custom-provider preference.

**Recommendation:** **Option A** — the 10GB requirement decides the SDK (presigned multipart), and prod portability decides against minio-js. Layout: ONE bucket (`STORAGE_BUCKET`) with keys `videos/{videoId}/original.{ext}` and `videos/{videoId}/thumbnail.jpg` — keys (never URLs) stored in DB columns; UUID key-cardinality makes per-prefix rate limits a non-issue; separate buckets would double provisioning/env surface for nothing. Compose: pin the last community image (`minio/minio:RELEASE.2025-04-22T22-12-26Z`, documenting that it carries unpatched CVE-2025-62506 — acceptable dev-only since exploitation requires an authenticated IAM user and prod uses real S3); healthcheck `curl -f http://localhost:9000/minio/health/live` (localhost is correct inside a healthcheck — documented exception to the service-name rule); named volume. Provisioning: app-side ensure-bucket (`HeadBucket` → `CreateBucket`) in `StorageModule.onModuleInit` gated by `STORAGE_AUTO_CREATE_BUCKET` (true in dev/test, false in prod where IaC owns buckets) — preferred over an `mc` init container frozen by the same image discontinuation. Env keys under `registerAs('storage')` + Joi: `STORAGE_ENDPOINT`, `STORAGE_PUBLIC_ENDPOINT`, `STORAGE_REGION`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`, `STORAGE_BUCKET`, `STORAGE_FORCE_PATH_STYLE`, `STORAGE_AUTO_CREATE_BUCKET`.

**Decision:** A (AWS SDK v3 dual-client custom provider, single bucket `videos/{videoId}/...`, pinned MinIO image + app-side ensure-bucket)
**Libraries:** `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`, `@aws-sdk/lib-storage@^3.x`

---

## TD-08: Testing strategy for the new infrastructure

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Serviço de processamento em segundo plano (filas)", "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Reprodução via streaming (sem necessidade de download completo)"

**Context:** The challenge mandates exercising the new infra for real ("Não mocke o que dá para testar de verdade com a infra do Compose"). Locked conventions constrain the design: suffixes `*.spec.ts` / `*.integration-spec.ts` / `*.e2e-spec.ts`, `--runInBand` against shared Compose services, all test commands inside the `nestjs-api` container, DB cleanup via `DELETE FROM`. Isolation, synchronization (no sleep-based waits) and the video-fixture approach must be fixed before the first Phase 03 test is written.

**Options:**

### Option A: Shared Compose services + fixed test bucket with cleanup + in-process processors + event-driven waits

- Tests connect from inside the `nestjs-api` container to `minio`/broker service hosts exactly as they do to `db`/`mailpit` today; a dedicated test bucket is ensured in `beforeAll` and emptied in `beforeEach` (`ListObjectsV2` + `DeleteObjects` — the S3 mirror of the `DELETE FROM` pattern); queue processors register in-process in the test module and completion is awaited through the broker's event API (BullMQ `job.waitUntilFinished(queueEvents)`; pg-boss test spies) — never `setTimeout` polling.
- **Pros:** zero divergence from locked conventions (same shared-services + `--runInBand` + cleanup model as db/Mailpit); no Docker-in-Docker; fast (no per-run container startup; KB-sized fixtures); directly satisfies the real-infra mandate — presign, upload, GET, publish and consume all hit real MinIO/broker.
- **Cons:** shared mutable state keeps `--runInBand` mandatory (already accepted for the DB); needs cleanup discipline via shared helpers (`emptyBucket()`, `drainQueue()`); an in-process processor proves pipeline logic but not the worker container image — the FFmpeg pipeline gets its own integration suite executed inside the worker container (the only image with ffmpeg/ffprobe).

### Option B: Bucket-per-test-run + queue-per-run (random suffix)

- `globalSetup` creates uniquely named bucket/queues; teardown deletes them.
- **Pros:** perfect cross-run isolation; would enable parallel Jest workers someday.
- **Cons:** the payoff is unrealizable (`--runInBand` is mandated by the shared DB anyway); crashed runs skip teardown and orphan buckets/queues; resource names become injectable everywhere, leaking test concerns into module wiring.

### Option C: Testcontainers-node (ephemeral MinIO/Redis per run)

- `globalSetup` boots throwaway containers and injects mapped ports.
- **Pros:** strongest isolation, no cleanup code.
- **Cons:** conflicts with the locked execution model (tests run INSIDE `nestjs-api` — would need docker.sock mounted + host-port gymnastics, breaking the service-name rule); contradicts the challenge's direction to test against the Compose infra; duplicates infra definitions that can drift; slower.

**Recommendation:** **Option A** — the only option that simultaneously satisfies the challenge mandate, the locked execution model, and the documented external-systems strategy. Key sub-decisions: (1) e2e without 10GB files — commit a tiny real MP4 fixture (`test/fixtures/tiny.mp4`, <100KB, regenerable via `ffmpeg -f lavfi -i testsrc=duration=1:size=128x72:rate=10 -pix_fmt yuv420p`; committed because ffmpeg is absent from the API image); S3's 5 MiB minimum part size applies to every part EXCEPT the last, so a 100KB file legally drives the exact multipart code path (CreateMultipartUpload → UploadPart #1 → Complete). (2) Presigned URLs are integration-tested by actually PUT/GETting through them against MinIO — `getSignedUrl` is purely local computation, so only MinIO validates endpoint/path-style/signature bugs. (3) Worker FFmpeg pipeline: own `*.integration-spec.ts` suite run inside the worker container, invoking the processor function directly with the fixture and asserting DB status + MinIO objects; the cross-container API→queue→worker flow is a compose-level smoke script, not a Jest suite. (4) Legitimately unit/mocked: service branch logic against storage/queue ports, ffprobe JSON parsing against a committed fixture, presign option math.

**Decision:** A (shared Compose services, fixed test bucket + cleanup, in-process processors, event-driven waits)
**Libraries:** —

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Queue technology | A (BullMQ + @nestjs/bullmq, Redis in Compose) | A |
| TD-02 | Cross-layer | 10GB upload strategy | A (presigned multipart, client-called complete) | A |
| TD-03 | Backend | Worker topology + FFmpeg | A (standalone app context container + child_process ffprobe/ffmpeg via apt) | A |
| TD-04 | Cross-layer | Streaming + download delivery | A (302 → presigned GET, inline + attachment) | A |
| TD-05 | Backend | Unique public URL | A (zero-dep 11-char base64url public_id) | A |
| TD-06 | Backend | Status lifecycle + failure | A (4-state enum + CAS transition map) | A |
| TD-07 | Backend | Storage usage (SDK/layout/MinIO) | A (AWS SDK v3 dual-client, single bucket, pinned MinIO image) | A |
| TD-08 | Backend | Testing strategy for new infra | A (shared Compose services, fixed test bucket, event-driven waits) | A |
