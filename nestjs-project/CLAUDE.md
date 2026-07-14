# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **MinIO:** `curl -f http://localhost:9000/minio/health/live` (from the host) — expect HTTP 200
- **Redis:** `docker compose exec redis redis-cli ping` — expect `PONG`

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — SMTP capture, ports `1025` (SMTP) / `8025` (UI)
- `minio` — S3-compatible object storage, ports `9000` (API) / `9001` (console), credentials `minioadmin`/`minioadmin`, bucket auto-created in dev (`STORAGE_AUTO_CREATE_BUCKET=true`)
- `redis` — BullMQ broker (AOF persistence), port `6379`
- `video-worker` — video processing worker (same codebase, ffmpeg-enabled image via `Dockerfile.worker`, no HTTP listener); idles by default — tests and the smoke script control when it consumes the queue

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database, so they **must** run serialized. The `test`, `test:integration`, `test:worker` and `test:e2e` scripts already bake `--runInBand` in — run them as-is:

```bash
docker compose exec nestjs-api npm test
docker compose exec nestjs-api npm run test:e2e
```

**Worker integration suites run inside the `video-worker` container** — `src/worker/*.integration-spec.ts` shells out to real `ffprobe`/`ffmpeg`, which only exist in the worker image. The API jest config ignores those files (`testPathIgnorePatterns`); they have their own config (`test/jest-worker.json`):

```bash
docker compose exec video-worker npm run test:worker -- --forceExit
```

Worker *unit* specs (`src/worker/*.spec.ts`, ffmpeg mocked) still run with the regular API suite.

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.

## Videos Module (Fase 03)

Video upload and processing pipeline. Plan and per-SI history: `docs/phases/phase-03-videos/`.

**Modules:**
- `src/videos/` — `VideosController`/`VideosService` (initiate/complete/consulta/stream/download), `Video` entity (`videos` table, FK `channel_id`, enum `video_status`: `draft | processing | ready | failed`), `public-id.util.ts` (11-char base64url id, zero-dep), `video-sweep.service.ts` (`@Cron` sweep: aborta multipart de drafts além de `UPLOAD_STALE_TTL_HOURS` e derruba `processing` travado para `failed` após `PROCESSING_STUCK_CEILING_HOURS`)
- `src/storage/` — `StorageModule`/`StorageService`: dois S3 clients (`STORAGE_ENDPOINT` interno p/ ops; `STORAGE_PUBLIC_ENDPOINT` só p/ presign — SigV4 assina o Host), multipart, presigned GET (inline/attachment), ensure-bucket no boot
- `src/queue/` — `QueueModule` (BullMQ via `@nestjs/bullmq`) + `VideoQueueProducer` (fila `video-processing`, `jobId = videoId` p/ enqueue idempotente, retries com backoff exponencial)
- `src/worker/` — `WorkerModule` (standalone application context, sem HTTP; entrypoint `src/worker.ts`), `FfmpegService` (ffprobe metadata + thumbnail via `node:child_process`, input seekable por presigned URL), `VideoProcessor` (`WorkerHost`: transições CAS `processing → ready/failed`, `error_code` em falha)

**Endpoints** (contratos completos em `docs/phases/phase-03-videos/phase-03-videos.md` → API Contracts, e no `openapi.json`):
- `POST /videos` (auth) — pré-cadastro `draft` + URLs presigned de multipart (arquivo até 10 GiB; bytes nunca passam pela API)
- `POST /videos/:publicId/complete` (auth, dono) — fecha multipart, valida tamanho via HeadObject, CAS `draft→processing`, enfileira `video.process` (idempotente)
- `GET /videos/:publicId` (público c/ optional-auth) — metadados/status; vídeos não-`ready` só o dono vê (demais recebem 404)
- `GET /videos/:publicId/stream` (público) — `302` p/ presigned GET inline (Range/206 servido pelo storage)
- `GET /videos/:publicId/download` (público) — `302` p/ presigned GET com `content-disposition: attachment`

**Env:** chaves `STORAGE_*`, `UPLOAD_*`, `PLAYBACK_URL_EXPIRES_IN`, `DOWNLOAD_URL_EXPIRES_IN`, `REDIS_*`, `VIDEO_PROCESSING_ATTEMPTS`, `PROCESSING_STUCK_CEILING_HOURS` — ver `.env.example` (validadas por Joi em `src/config/env.validation.ts`; namespaces `storage.config.ts` / `queue.config.ts`).

**Worker (dev):** `npm run start:worker:dev` (watch) ou `node dist/worker` no container `video-worker`. O container fica ocioso por padrão; o smoke script `scripts/smoke-video-pipeline.sh` exercita o fluxo completo cross-container (upload real → worker consome → `ready`).

**Fixture de teste:** `test/fixtures/tiny.mp4` (<100KB, gerada com ffmpeg `testsrc`; ver `test/fixtures/README.md`) — exercita o caminho multipart real (última parte não tem mínimo de 5 MiB). Helpers de pipeline em `test/helpers/video-pipeline.helpers.ts` (`emptyBucket`, `drainQueue`, `waitForStatus` orientado a eventos).
