---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-07-08T12:23:13-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-07-08T12:26:14-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-08T12:20:04-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-07-08T10:44:24-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar o ciclo completo de vídeo do StreamTube: upload direto ao object storage (MinIO/S3) de arquivos de até 10GB via multipart presigned sem passar pela API, com pré-cadastro automático como rascunho, processamento assíncrono via fila BullMQ/Redis por um worker FFmpeg em container dedicado (extração de duração/metadados + thumbnail), URL pública única por vídeo, e reprodução via streaming + download por presigned GET — com storage, fila e worker subindo via Docker Compose.

---

## Step Implementations

### SI-03.1 — Provisionar MinIO e Redis no Compose

**Description:** Sobe a infraestrutura nova da fase (object storage e broker da fila) no `nestjs-project/compose.yaml`, com imagens pinadas, healthchecks e volumes — pré-requisito de todo o resto.

**Technical actions:**

1. Adicionar serviço `minio` em `nestjs-project/compose.yaml` — imagem pinada `minio/minio:RELEASE.2025-04-22T22-12-26Z`, `command: server /data --console-address ":9001"`, ports `9000`/`9001`, named volume `minio_data`, healthcheck `curl -f http://localhost:9000/minio/health/live` (per `phase-03-videos/TD-07`; CVE-2025-62506 documentada como aceitável dev-only)
2. Adicionar serviço `redis` — imagem `redis:7.4-alpine`, `command: redis-server --appendonly yes`, named volume `redis_data`, healthcheck `redis-cli ping` (per `phase-03-videos/TD-01`)
3. Gatear `nestjs-api` com `depends_on: minio: service_healthy` + `redis: service_healthy`
4. Estender `nestjs-project/.env.example` com as chaves novas — `STORAGE_ENDPOINT`, `STORAGE_PUBLIC_ENDPOINT`, `STORAGE_REGION`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`, `STORAGE_BUCKET`, `STORAGE_FORCE_PATH_STYLE`, `STORAGE_AUTO_CREATE_BUCKET`, `REDIS_HOST`, `REDIS_PORT`, `UPLOAD_PART_SIZE_MB`, `UPLOAD_URL_EXPIRES_IN`, `PLAYBACK_URL_EXPIRES_IN`, `DOWNLOAD_URL_EXPIRES_IN`, `UPLOAD_STALE_TTL_HOURS`, `VIDEO_PROCESSING_ATTEMPTS`, `PROCESSING_STUCK_CEILING_HOURS` (per `phase-03-videos/TD-07`; hosts = nomes de serviço do Compose; valores com caracteres especiais entre aspas per convenção de env do `nestjs-project/CLAUDE.md`)

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` sobe `minio`, `redis`, `db`, `mailpit` e `nestjs-api`, todos `running`/`healthy`
- `curl http://localhost:9000/minio/health/live` do host responde 200
- `docker compose exec redis redis-cli ping` responde `PONG` e `CONFIG GET appendonly` retorna `yes`
- `.env.example` parseia sem erro pelo Docker Compose (sem caracteres shell-especiais fora de aspas)

---

### SI-03.2 — Configurar namespaces storage e queue com validação de env

**Description:** Cria os namespaces de configuração da fase seguindo o padrão `registerAs` + Joi herdado da Fase 01, cobrindo todas as chaves novas de storage, upload, entrega e fila.

**Technical actions:**

1. Criar `src/config/storage.config.ts` — `registerAs('storage', ...)` expondo endpoint interno/público, região, credenciais, bucket, `forcePathStyle`, `autoCreateBucket`, `uploadPartSizeMb`, `uploadUrlExpiresIn`, `playbackUrlExpiresIn`, `downloadUrlExpiresIn`, `uploadStaleTtlHours` (per `phase-03-videos/TD-07`, convenção `phase-01-configuracao-base/TD-03`)
2. Criar `src/config/queue.config.ts` — `registerAs('queue', ...)` expondo `redisHost`, `redisPort`, `videoProcessingAttempts`, `processingStuckCeilingHours` (per `phase-03-videos/TD-01` + `TD-06`)
3. Estender o schema Joi em `src/config/env.validation.ts` com todas as chaves novas (required onde sem default; defaults conforme `### API Contracts`) (per convenção `phase-01-configuracao-base/TD-02`)
4. Registrar os dois namespaces no `ConfigModule.forRoot({ load: [...] })` em `app.module.ts`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `env.validation` | Unit: schema aceita env completo; rejeita `STORAGE_ENDPOINT` ausente e `REDIS_PORT` não-numérico | `src/config/env.validation.spec.ts` |

**Dependencies:** SI-03.1 — as chaves espelham o compose/.env.example

**Acceptance criteria:**

- boot da aplicação falha com mensagem de validação Joi quando `STORAGE_ENDPOINT` está ausente
- os factories `storage`/`queue` expõem valores tipados coerentes com o `.env` (verificável por teste que injeta env controlado)

---

### SI-03.3 — StorageModule: dual S3 clients e StorageService

**Description:** Camada de acesso ao MinIO/S3 com dois clients (ops interno + presign público) e as operações de multipart, presign e provisão de bucket que o restante da fase consome.

**Technical actions:**

1. Criar `src/storage/storage.module.ts` com providers `S3_CLIENT` (endpoint `STORAGE_ENDPOINT`) e `S3_PRESIGN_CLIENT` (endpoint `STORAGE_PUBLIC_ENDPOINT`), `useFactory` sobre `storage.config`, `forcePathStyle` configurável (per `phase-03-videos/TD-07`; assinaturas conforme `library-refs.md → @aws-sdk/client-s3`)
2. Criar `src/storage/storage.service.ts` — `createMultipartUpload`, `presignUploadPartUrls(uploadId, partCount, expiresIn)`, `completeMultipartUpload(parts)`, `abortMultipartUpload`, `headObject`, `presignGetUrl(key, { disposition, expiresIn })`, `putObject`, `listObjects`/`deleteObjects` (per `phase-03-videos/TD-02` + `TD-04`; presign via `S3_PRESIGN_CLIENT`, ops via `S3_CLIENT`)
3. Implementar `ensureBucket()` (`HeadBucket` → `CreateBucket` em 404) em `onModuleInit`, gated por `STORAGE_AUTO_CREATE_BUCKET` (per `phase-03-videos/TD-07`)
4. Exportar `StorageService` e registrar `StorageModule` no `AppModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageModule` | Unit: compilation test | `src/storage/storage.module.spec.ts` |
| `StorageService` | Integration (MinIO real): ensureBucket idempotente; ciclo multipart completo via URLs presigned (última parte < 5 MiB); presigned GET com `Range` → 206 | `src/storage/storage.service.integration-spec.ts` |

**Dependencies:** SI-03.1, SI-03.2

**Acceptance criteria:**

- upload multipart de arquivo pequeno via URLs presigned resulta em objeto íntegro no bucket (`HeadObject` com o tamanho esperado)
- GET presigned com `Range: bytes=0-99` retorna 206 com `Content-Range`
- URLs presigned carregam o host de `STORAGE_PUBLIC_ENDPOINT` (não o host interno de ops)
- com `STORAGE_AUTO_CREATE_BUCKET=true` o bucket ausente é criado no boot; com `false`, não

---

### SI-03.4 — Criar entidade Video, migration CreateVideos e gerador de public_id

**Description:** Materializa o modelo de dados da fase: entidade `Video` ligada ao canal, enum de status, migration versionada e o gerador zero-dep do identificador público.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` com campos/constraints byte-verbatim do `### Data Model` e enum `VideoStatus` (`draft`/`processing`/`ready`/`failed`) (per `phase-03-videos/TD-06`; padrão de colunas snake_case + FK explícita da entidade `Channel`)
2. Criar `src/videos/public-id.util.ts` — `generatePublicId()`: 11 chars do alfabeto `A-Za-z0-9_-` via `crypto.randomBytes(11)` mapeado por `byte & 63` (per `phase-03-videos/TD-05`)
3. Criar migration `src/database/migrations/<timestamp>-CreateVideos.ts` — tabela `videos` + tipo enum `video_status` + unique em `public_id` + índice `(status, created_at)` + FK `channel_id` (per regra `typeorm-migrations`)
4. Criar esqueleto de `src/videos/videos.module.ts` com `TypeOrmModule.forFeature([Video])` e registrar no `AppModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `generatePublicId` | Unit: comprimento 11, alfabeto correto, ausência de viés (64 divide 256), unicidade em 10k amostras | `src/videos/public-id.util.spec.ts` |
| `Video` entity | Integration: default `draft`, unique `public_id` (23505), FK `channel_id`, timestamps | `src/videos/entities/video.entity.integration-spec.ts` |
| `VideosModule` | Unit: compilation test | `src/videos/videos.module.spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos` com enum e constraints; `npm run migration:revert` remove tudo
- inserir dois vídeos com o mesmo `public_id` viola a unique constraint (Postgres 23505)
- vídeo inserido sem `status` explícito persiste como `draft`

---

### SI-03.5 — Configurar QueueModule (BullMQ) e producer de jobs

**Description:** Conecta a API ao Redis via BullMQ, registra a fila `video-processing` com política de retry e expõe o producer idempotente que o complete do upload usa.

**Technical actions:**

1. Criar `src/queue/queue.module.ts` — `BullModule.forRootAsync` com `queue.config` (connection `redisHost`/`redisPort`; preservar default `maxRetriesPerRequest: null`) (per `phase-03-videos/TD-01`; padrão conforme `library-refs.md → @nestjs/bullmq`)
2. Registrar a fila `video-processing` via `BullModule.registerQueue` com `defaultJobOptions`: `attempts = VIDEO_PROCESSING_ATTEMPTS`, backoff exponencial, retenção de completed/failed (per `phase-03-videos/TD-01`)
3. Criar `src/queue/video-queue.producer.ts` — `enqueueProcessing(videoId, bucket, key)` com `jobId = videoId` e payload conforme `### Events/Messages` (per `phase-03-videos/TD-01` + `TD-06`)
4. Exportar o producer e registrar `QueueModule` no `AppModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `QueueModule` | Unit: compilation test | `src/queue/queue.module.spec.ts` |
| `VideoQueueProducer` | Integration (Redis real): enqueue cria job `waiting` com `jobId = videoId`; segundo enqueue do mesmo id não duplica | `src/queue/video-queue.producer.integration-spec.ts` |

**Dependencies:** SI-03.1, SI-03.2

**Acceptance criteria:**

- job enfileirado aparece na fila `video-processing` com payload `{videoId, bucket, key}`
- dois enqueues consecutivos do mesmo `videoId` resultam em exatamente um job na fila

---

### SI-03.6 — Implementar initiate upload (POST /videos)

**Route:** POST /videos
**Test Specs:** _pending /plan-test-specs_

**Description:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload: cria a linha `draft` com `public_id`, abre o multipart no storage e devolve as URLs presigned das partes.

**Technical actions:**

1. Criar `src/videos/dto/create-video.dto.ts` com validações byte-verbatim de `#### Validation Rules — videos` (per `phase-02-auth/TD-06` class-validator; decorators `@nestjs/swagger` per `openapi-docs-nestjs/TD-01`)
2. Criar `src/videos/videos.service.ts::initiateUpload` — valida teto/`content_type` (`VIDEO_FILE_TOO_LARGE`/`VIDEO_INVALID_CONTENT_TYPE`), gera `id` app-side + `public_id` (retry único em 23505), monta `original_key = videos/{id}/original.{ext}`, `CreateMultipartUpload`, presigna as partes (`part_size`/`part_count` conforme `### API Contracts`), persiste o draft com `upload_id` (per `phase-03-videos/TD-02` + `TD-05` + `TD-07`)
3. Criar `src/videos/videos.controller.ts` — `POST /videos` autenticado (guard JWT global), resolve o canal do usuário logado (relação 1:1) e responde 201 conforme `### API Contracts`
4. Lançar exceções de domínio mapeadas pelo filtro existente com os `errorCode`s do `### Error Catalog` (per `phase-02-auth/TD-07`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.initiateUpload` | Unit: branch logic (mocks de repo/storage/producer) — teto 10 GiB, content_type inválido, retry de `public_id` em 23505 | `src/videos/videos.service.spec.ts` |

**Dependencies:** SI-03.3, SI-03.4

**Acceptance criteria:**

- `POST /videos` com payload válido retorna 201 com `public_id` de 11 chars, `status: "draft"` e `upload.urls` com `part_count` entradas
- `POST /videos` com `file_size` acima de 10 GiB retorna 400 com `errorCode: "VIDEO_FILE_TOO_LARGE"`
- `POST /videos` com `content_type: "image/png"` retorna 400 com `errorCode: "VIDEO_INVALID_CONTENT_TYPE"`
- `POST /videos` sem token retorna 401
- linha `draft` persistida com `original_key = videos/{id}/original.{ext}` e `upload_id` preenchido

---

### SI-03.7 — Implementar complete upload e enfileiramento (POST /videos/:publicId/complete)

**Route:** POST /videos/:publicId/complete
**Test Specs:** _pending /plan-test-specs_

**Description:** Fecha o multipart no storage, verifica o objeto real, transiciona `draft→processing` via CAS e publica o job `video.process` — o ponto de entrada do processamento automático.

**Technical actions:**

1. Criar `src/videos/dto/complete-upload.dto.ts` (`parts[]` conforme `#### Validation Rules — videos`) com decorators swagger
2. Implementar `VideosService.completeUpload` — ownership check com 404 sem vazamento (`VIDEO_NOT_FOUND`), `CompleteMultipartUpload` com ETags (`VIDEO_UPLOAD_INCOMPLETE` em falha), `HeadObject` valida tamanho real (mismatch/teto → `AbortMultipartUpload` + CAS `→failed` + `VIDEO_UPLOAD_SIZE_MISMATCH`), CAS `draft→processing` com `uploaded_at` e limpeza de `upload_id`; `affected=0` → resposta idempotente (200 com status atual) ou 409 `VIDEO_UPLOAD_NOT_COMPLETABLE` quando `failed` (per `phase-03-videos/TD-02` + `TD-06`)
3. Enfileirar `video.process` via `VideoQueueProducer` após o CAS bem-sucedido (`jobId = videoId`) (per `phase-03-videos/TD-01`)
4. Adicionar o endpoint no controller com resposta 200 conforme `### API Contracts`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit: branches — idempotência (`processing`/`ready` → 200), `failed` → 409, size mismatch → abort + `failed` | `src/videos/videos.service.spec.ts` |
| fluxo initiate→PUT→complete | Integration (MinIO+Redis+DB reais): upload da fixture pelas URLs presigned, complete transiciona a `processing` e enfileira o job | `src/videos/videos-upload.integration-spec.ts` |

**Dependencies:** SI-03.5, SI-03.6

**Acceptance criteria:**

- complete com ETags válidos retorna 200 `status: "processing"` e cria job com `jobId` igual ao id interno do vídeo
- complete repetido retorna 200 `processing` sem enfileirar segundo job
- complete com parts inválidos retorna 400 `VIDEO_UPLOAD_INCOMPLETE` e o vídeo permanece `draft`
- complete de vídeo de outro usuário retorna 404 `VIDEO_NOT_FOUND`
- objeto real maior que o declarado → 400 `VIDEO_UPLOAD_SIZE_MISMATCH`, vídeo `failed`, multipart abortado no storage

---

### SI-03.8 — Implementar consulta de vídeo (GET /videos/:publicId)

**Route:** GET /videos/:publicId
**Test Specs:** _pending /plan-test-specs_

**Description:** Expõe metadados e status do vídeo pela URL única, com a regra de visibilidade da fase: `ready` é público; não-`ready` só o dono vê.

**Technical actions:**

1. Implementar `VideosService.findByPublicId(publicId, requestingUserId?)` — regra de visibilidade AMB-1 (`ready` para todos; `draft`/`processing`/`failed` apenas dono; caso contrário `VIDEO_NOT_FOUND`) (per `phase-03-videos/TD-05` + `TD-06`)
2. Adicionar endpoint `GET /videos/:publicId` como rota `@Public` com optional-auth (token presente → visão de dono), validação do param via `@Matches(/^[A-Za-z0-9_-]{11}$/)`, resposta conforme `### API Contracts` (`thumbnail_url` presigned somente quando `ready`; `error_code` somente para o dono) (per `phase-03-videos/TD-04` + `TD-07`)
3. Decorators swagger no endpoint/DTO de resposta (per `openapi-docs-nestjs/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.findByPublicId` | Unit: branches de visibilidade (anon+ready, anon+processing→404, dono+failed→campos de erro presentes) | `src/videos/videos.service.spec.ts` |

**Dependencies:** SI-03.6

**Acceptance criteria:**

- `GET /videos/:publicId` de vídeo `ready` sem token retorna 200 com `public_id`, `title`, `duration_seconds`, `thumbnail_url` e `channel`
- `GET` de vídeo `processing` sem token retorna 404 `VIDEO_NOT_FOUND`
- `GET` de vídeo `processing` com token do dono retorna 200 com `status: "processing"`
- `publicId` fora do formato `[A-Za-z0-9_-]{11}` retorna 400 de validação

---

### SI-03.9 — Infra do worker: imagem com FFmpeg e serviço video-worker no Compose

**Description:** Materializa o worker como container separado da mesma codebase — imagem com ffmpeg/ffprobe, entrypoint standalone e serviço no Compose subindo junto com a stack.

**Technical actions:**

1. Criar `nestjs-project/Dockerfile.worker` — base `node:25.6.0-slim` + `apt-get install -y --no-install-recommends ffmpeg` (per `phase-03-videos/TD-03`; ffmpeg 7.1.x do Debian trixie)
2. Criar `src/worker.ts` — `NestFactory.createApplicationContext(WorkerModule)` + `enableShutdownHooks()`; criar `src/worker/worker.module.ts` esqueleto importando `ConfigModule`, `TypeOrmModule` (mesmas entidades), `StorageModule` e a conexão BullMQ — nunca controllers/guards (per `phase-03-videos/TD-03`, regra anti-acoplamento)
3. Adicionar npm scripts — `start:worker` (`node dist/worker`) e `start:worker:dev` (watch com entryFile worker) — e garantir que `nest build` emita `dist/worker.js`
4. Adicionar serviço `video-worker` no `compose.yaml` — build `Dockerfile.worker`, mesmo volume de código do dev, comando dev, `depends_on` `db`/`minio`/`redis` healthy, mesmo `.env`

**Tests:** _(empty — Infra)_

**Dependencies:** SI-03.3, SI-03.5

**Acceptance criteria:**

- `docker compose up -d` sobe `video-worker` e o container permanece `running`
- `docker compose exec video-worker ffprobe -version` responde com versão 7.x
- o processo do worker inicializa o application context sem HTTP listener e registra log de prontidão

---

### SI-03.10 — Implementar streaming e download (302 → presigned GET)

**Route:** GET /videos/:publicId/stream
**Test Specs:** _pending /plan-test-specs_

**Description:** Entrega reprodução via streaming (Range/206 servido nativamente pelo storage) e download com filename, sem nenhum byte de vídeo atravessar a API.

**Technical actions:**

1. Implementar `VideosService.getStreamUrl(publicId)` e `getDownloadUrl(publicId)` — somente vídeos `ready` (senão `VIDEO_NOT_FOUND`); presign GET inline com `PLAYBACK_URL_EXPIRES_IN` e attachment com `response-content-disposition: attachment; filename="{title}.{ext}"` e `DOWNLOAD_URL_EXPIRES_IN` (per `phase-03-videos/TD-04`)
2. Adicionar endpoints `@Public` `GET /videos/:publicId/stream` e `GET /videos/:publicId/download` respondendo `302 Location` conforme `### API Contracts`
3. Decorators swagger documentando o redirect 302

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getStreamUrl`/`getDownloadUrl` | Unit: branches ready/não-ready; opções de presign (expiry, disposition, filename) | `src/videos/videos.service.spec.ts` |
| stream/download entregues pelo MinIO | Integration (MinIO real): seguir o `Location` dentro da rede — `Range: bytes=0-1023` → 206; download → `content-disposition` attachment | `src/videos/videos-delivery.integration-spec.ts` |

**Dependencies:** SI-03.3, SI-03.8

**Acceptance criteria:**

- `GET /videos/:publicId/stream` de vídeo `ready` retorna 302 com `Location` assinada (`X-Amz-Signature`) no host público
- seguir o `Location` com `Range: bytes=0-1023` retorna 206 Partial Content com `Content-Range`
- `GET /videos/:publicId/download` retorna 302 cujo `Location` contém `response-content-disposition=attachment` com o filename do título
- `GET /stream` e `GET /download` de vídeo não-`ready` retornam 404 `VIDEO_NOT_FOUND`

---

### SI-03.11 — Implementar FfmpegService (probe e thumbnail)

**Description:** Encapsula as duas invocações FFmpeg da fase — extração de metadados via ffprobe e captura de frame para thumbnail — com input seekable e classificação de erros.

**Technical actions:**

1. Criar `src/worker/ffmpeg.service.ts::probe(inputUrl)` — `execFile('ffprobe', ['-v','error','-print_format','json','-show_format','-show_streams', inputUrl])` promisificado com `maxBuffer` ampliado; parse de `format.duration` e `width`/`height`/`codec_name` do stream de vídeo (per `phase-03-videos/TD-03`; input via presigned GET URL — nunca stdin, moov atom)
2. Criar `generateThumbnail(inputUrl, outPath, atSecond)` — `execFile('ffmpeg', ['-ss', t, '-i', inputUrl, '-frames:v','1','-vf','scale=640:-2','-q:v','3', outPath])` com `t = min(1s, 10% da duração)` (per `phase-03-videos/TD-03`)
3. Classificar falhas nos códigos do `### Error Catalog` (`PROBE_FAILED`, `THUMBNAIL_FAILED`, `UNSUPPORTED_MEDIA`) capturando stderr
4. Commitar a fixture `test/fixtures/tiny.mp4` (<100KB; regenerável com `ffmpeg -f lavfi -i testsrc=duration=1:size=128x72:rate=10 -pix_fmt yuv420p`) + nota de regeneração (per `phase-03-videos/TD-08`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| parse do probe | Unit: parsing contra fixture JSON de saída do ffprobe commitada | `src/worker/ffmpeg.service.spec.ts` |
| `FfmpegService` | Integration (container worker, ffmpeg real): probe + thumbnail sobre `test/fixtures/tiny.mp4` | `src/worker/ffmpeg.service.integration-spec.ts` |

**Dependencies:** SI-03.9

**Acceptance criteria:**

- probe de `tiny.mp4` retorna `duration ≈ 1s`, `width 128`, `height 72`
- `generateThumbnail` produz JPEG não-vazio no caminho de saída
- entrada corrompida resulta em erro classificado `PROBE_FAILED` com stderr capturado na mensagem

---

### SI-03.12 — Implementar VideoProcessor (consumo, transições e falhas)

**Description:** O consumidor da fila que executa o processamento automático: probe, persistência de metadados, thumbnail e as transições `processing→ready/failed` — idempotente sob entrega at-least-once.

**Technical actions:**

1. Criar `src/worker/video.processor.ts` — `@Processor('video-processing')` estendendo `WorkerHost` (per `library-refs.md → @nestjs/bullmq`): carrega o vídeo por `videoId`, gera presigned GET interno do `original_key` como input seekable, marca `processing_started_at`/`attempt_count` (per `phase-03-videos/TD-03`)
2. Pipeline: `probe` → persistir `duration_seconds`/`width`/`height`/`metadata` → `generateThumbnail` → `putObject` em `videos/{id}/thumbnail.jpg` (`thumbnail_key`) → CAS `processing→ready` com `processed_at` (per `phase-03-videos/TD-06`; chaves determinísticas tornam reprocessamento overwrite-safe)
3. Falhas: mídia inválida → `UnrecoverableError` (falha imediata); erros transitórios → retry BullMQ; no esgotamento (`attemptsMade === attempts`) ou irrecuperável → CAS `processing→failed` persistindo `error_code`/`error_message` conforme `### Error Catalog` (per `phase-03-videos/TD-01` + `TD-06`)
4. Registrar o processor no `WorkerModule` (somente no worker — a API nunca consome)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessor` | Unit: branches de falha (irrecuperável vs transitório) com storage/ffmpeg/repos mockados | `src/worker/video.processor.spec.ts` |
| pipeline completo | Integration (container worker; MinIO+Redis+DB reais): job da fixture → `ready` com metadados/thumbnail; mídia corrompida → `failed` com `error_code` | `src/worker/video.processor.integration-spec.ts` |

**Dependencies:** SI-03.5, SI-03.7, SI-03.11

**Acceptance criteria:**

- job de vídeo válido leva a linha a `ready` com `duration_seconds`, `width`/`height`, `thumbnail_key` preenchidos e objeto `thumbnail.jpg` existente no bucket
- entrega duplicada do mesmo job não corrompe o estado (segundo CAS retorna `affected = 0`)
- mídia corrompida resulta em `failed` com `error_code: "PROBE_FAILED"` sem retries além da política
- worker em shutdown gracioso (SIGTERM) não deixa job travado além do mecanismo de stalled da fila

---

### SI-03.13 — Implementar varredura de limpeza (drafts abandonados e processing travado)

**Description:** Rede de segurança do ciclo de status: expira uploads abandonados (abortando o multipart no storage) e derruba `processing` travado para `failed` além do teto.

**Technical actions:**

1. Criar `src/videos/video-sweep.service.ts` com `@Cron` — drafts com `created_at` além de `UPLOAD_STALE_TTL_HOURS`: `AbortMultipartUpload` + remoção da linha `draft` (per `phase-03-videos/TD-06` + `TD-02`; MinIO não honra ILM de multipart — o sweep é o mecanismo portável)
2. Na mesma varredura: `processing` com `processing_started_at` além de `PROCESSING_STUCK_CEILING_HOURS` → CAS `processing→failed` com `error_code: "STUCK_TIMEOUT"` (per `phase-03-videos/TD-06`)
3. Registrar `ScheduleModule.forRoot()` no `AppModule` e o service no `VideosModule` (per `library-refs.md → @nestjs/schedule`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoSweepService` | Unit: branches de elegibilidade (TTL de draft, teto de processing, `ready`/`failed` intocados) com repos/storage mockados | `src/videos/video-sweep.service.spec.ts` |
| sweep sobre dados reais | Integration (DB+MinIO reais): draft antigo removido + multipart abortado; processing travado vira `failed` | `src/videos/video-sweep.integration-spec.ts` |

**Dependencies:** SI-03.7

**Acceptance criteria:**

- draft mais antigo que o TTL desaparece do banco e seu multipart é abortado no storage (ListMultipartUploads não o lista mais)
- `processing` além do teto vira `failed` com `error_code: "STUCK_TIMEOUT"`
- vídeos `ready` e `failed` não são alterados pela varredura

---

### SI-03.14 — E2E do fluxo completo, smoke cross-container e export OpenAPI

**Description:** Fecha a fase provando o fluxo inteiro de ponta a ponta com infra real (fixture pequena exercitando o caminho multipart), helpers de teste compartilhados, smoke script com o worker em container e o `openapi.json` atualizado.

**Technical actions:**

1. Criar `test/videos.e2e-spec.ts` — fluxo completo via HTTP: usuário/login → initiate → PUT das partes nas URLs presigned (fixture `tiny.mp4` como última parte única < 5 MiB) → complete → processor executado in-process no app de teste → `waitForStatus(publicId, 'ready')` → GET 200 → stream 302 (seguindo Location → 206) → download 302; reproduz a config global do `main.ts` (pipes/filtro/guard) per regra `nestjs-testing` (per `phase-03-videos/TD-08`)
2. Criar helpers compartilhados em `test/helpers/` — `emptyBucket()` (ListObjectsV2+DeleteObjects), `drainQueue()`, `waitForStatus()` orientado a eventos (`QueueEvents`/`job.waitUntilFinished`, sem sleeps) (per `phase-03-videos/TD-08`)
3. Criar `scripts/smoke-video-pipeline.sh` — smoke compose-level cross-container: stack completa de pé, fluxo real com o container `video-worker` consumindo, assert de `ready` via API (per `phase-03-videos/TD-08`)
4. Rodar `npm run openapi:export` e commitar o `openapi.json` com os 5 endpoints de vídeos (per `openapi-docs-nestjs/TD-02`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| fluxo completo de vídeo | E2E: initiate→upload→complete→ready→stream/download com asserts de status, campos e redirect | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.10, SI-03.12

**Acceptance criteria:**

- `npm run test:e2e` verde incluindo o fluxo completo de vídeo com MinIO/Redis/DB reais
- `openapi.json` exportado contém os 5 endpoints de vídeos com schemas de request/response
- `scripts/smoke-video-pipeline.sh` sai com código 0 exercitando o worker em container real (não in-process)

---

## Technical Specifications

### Data Model

#### Video (`videos`)

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK — generated app-side (`crypto.randomUUID()`) so `original_key` is derivable at insert (per `phase-03-videos/TD-07`) |
| public_id | varchar(11) | unique, not null — 11-char base64url from `node:crypto`, minted at draft creation; retry once on Postgres `23505` (per `phase-03-videos/TD-05`) |
| channel_id | uuid | not null, FK → `channels.id` |
| title | varchar(100) | not null (required at initiate — AMB-2 clarification) |
| description | text | nullable |
| status | enum `video_status` (`draft` \| `processing` \| `ready` \| `failed`) | not null, default `'draft'` (per `phase-03-videos/TD-06`) |
| original_key | text | not null — `videos/{id}/original.{ext}` (per `phase-03-videos/TD-07`; keys, never URLs, in DB) |
| upload_id | text | nullable — S3 multipart `UploadId`; cleared after complete/abort |
| file_size | bigint | not null — declared at initiate (≤ 10 GiB), verified via `HeadObject` at complete (AMB-3 clarification) |
| content_type | varchar(100) | not null — must match `video/*` |
| thumbnail_key | text | nullable — `videos/{id}/thumbnail.jpg`, set by worker (per `phase-03-videos/TD-03`) |
| duration_seconds | numeric(10,3) | nullable — from `ffprobe format.duration` (per `phase-03-videos/TD-03`) |
| width | int | nullable — from ffprobe video stream |
| height | int | nullable — from ffprobe video stream |
| metadata | jsonb | nullable — codec/container extras from ffprobe |
| error_code | varchar(50) | nullable — set by worker on `processing→failed` (per `phase-03-videos/TD-06`) |
| error_message | text | nullable — stderr excerpt / failure detail |
| uploaded_at | timestamptz | nullable — set at complete |
| processing_started_at | timestamptz | nullable — set by worker on job start |
| processed_at | timestamptz | nullable — set on `ready`/`failed` |
| attempt_count | int | not null, default 0 — incremented by worker per attempt |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | auto-update |

**Relations:** `Channel` has many `Video` (one-to-many; `Video.channel` ManyToOne with explicit `channel_id` column, following the `Channel`/`User` pattern).
**Indexes:** unique on `public_id`; index on `(status, created_at)` (sweep queries — per `phase-03-videos/TD-06`); FK index on `channel_id`.
**Enum:** `video_status` created in the same `CreateVideos` migration (values: `draft`, `processing`, `ready`, `failed`).

### API Contracts

#### POST /videos (SI-03.6)

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access_token}

**Request body:**
- title: string, required — min 1, max 100 characters
- description: string, optional
- file_name: string, required — original filename; extension drives `original_key` suffix
- file_size: number, required — bytes; min 1, max 10737418240 (10 GiB) — AMB-3 enforcement point 1
- content_type: string, required — must match `video/*`

**Response 201:**
- public_id: string (11-char base64url)
- status: `"draft"`
- upload:
  - part_size: number (bytes — `UPLOAD_PART_SIZE_MB` config, default 64 MiB)
  - part_count: number (`ceil(file_size / part_size)`; ≤ 10000)
  - urls: array of `{ part_number: number, url: string }` — presigned `UploadPart` URLs against `STORAGE_PUBLIC_ENDPOINT` (per `phase-03-videos/TD-02` + `TD-07`)
  - expires_at: string (ISO-8601 — `UPLOAD_URL_EXPIRES_IN`, default 6h)

**Error responses:**
- 400 VIDEO_FILE_TOO_LARGE: when `file_size` exceeds 10 GiB
- 400 VIDEO_INVALID_CONTENT_TYPE: when `content_type` does not match `video/*`
- 400 validation error: when the request body fails schema validation
- 401: when the request has no valid access token (global JWT guard)

---

#### POST /videos/:publicId/complete (SI-03.7)

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access_token}

**Request body:**
- parts: array, required — `{ part_number: number, etag: string }` collected by the client from each `UploadPart` response

**Response 200:**
- public_id: string
- status: `"processing"` (idempotent: complete on an already-`processing`/`ready` video returns 200 with the current status — per `phase-03-videos/TD-06`)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when `publicId` does not exist OR the video belongs to another channel (no existence leak)
- 400 VIDEO_UPLOAD_INCOMPLETE: when `CompleteMultipartUpload`/`HeadObject` shows the object is absent or parts are invalid
- 400 VIDEO_UPLOAD_SIZE_MISMATCH: when the real object size exceeds 10 GiB or diverges from declared `file_size` — multipart aborted, video transitions to `failed` (AMB-3 enforcement point 2)
- 409 VIDEO_UPLOAD_NOT_COMPLETABLE: when the video is in `failed` status
- 400 validation error: when `parts` is missing/malformed
- 401: without valid access token

---

#### GET /videos/:publicId (SI-03.8)

**Request headers:** _none required (public route via `@Public`; optional Authorization enables owner view — AMB-1 clarification)_

**Response 200:**
- public_id: string
- title: string
- description: string | null
- status: string — anonymous/non-owner callers only ever see `"ready"` videos; the owner sees any status
- duration_seconds: number | null
- width: number | null
- height: number | null
- thumbnail_url: string | null — presigned GET (only when `ready`)
- created_at: string (ISO-8601)
- channel: `{ id: string, name: string, nickname: string }`
- error_code: string | null — owner-only field, present when status = `failed`

**Error responses:**
- 404 VIDEO_NOT_FOUND: when `publicId` does not exist, OR the video is not `ready` and the caller is not the owner (no existence leak — AMB-1)
- 400 validation error: when `publicId` fails the `[A-Za-z0-9_-]{11}` format

---

#### GET /videos/:publicId/stream (SI-03.10)

**Request headers:** _none (public route)_

**Response 302:**
- Location: presigned GET URL on the storage public endpoint, inline disposition, expiry `PLAYBACK_URL_EXPIRES_IN` (default 6h). MinIO serves HTTP Range/206 natively (per `phase-03-videos/TD-04`).

**Error responses:**
- 404 VIDEO_NOT_FOUND: when `publicId` does not exist or the video is not `ready`
- 400 validation error: invalid `publicId` format

---

#### GET /videos/:publicId/download (SI-03.10)

**Request headers:** _none (public route)_

**Response 302:**
- Location: presigned GET URL with `response-content-disposition: attachment; filename="{title}.{ext}"`, expiry `DOWNLOAD_URL_EXPIRES_IN` (default 15min) (per `phase-03-videos/TD-04`).

**Error responses:**
- 404 VIDEO_NOT_FOUND: when `publicId` does not exist or the video is not `ready`
- 400 validation error: invalid `publicId` format

---

#### Validation Rules — videos

- `title`: required, string, 1–100 chars
- `description`: optional, string
- `file_name`: required, string, 1–255 chars, must contain an extension
- `file_size`: required, integer, 1 ≤ n ≤ 10737418240
- `content_type`: required, string matching `^video\/[\w.+-]+$`
- `parts`: required array of `{ part_number: 1–10000, etag: non-empty string }`, min 1 item
- `publicId` route param: `@Matches(/^[A-Za-z0-9_-]{11}$/)` (per `phase-03-videos/TD-05`)

### Authorization Matrix

| Endpoint | Anonymous | Authenticated (non-owner) | Owner (channel do vídeo) |
|----------|-----------|---------------------------|--------------------------|
| POST /videos | ✗ | ✓ (cria no próprio canal — relação user↔channel 1:1) | ✓ |
| POST /videos/:publicId/complete | ✗ | ✗ (404 — sem vazamento de existência) | ✓ |
| GET /videos/:publicId | ✓ (somente `ready`) | ✓ (somente `ready`) | ✓ (qualquer status) |
| GET /videos/:publicId/stream | ✓ (somente `ready`) | ✓ (somente `ready`) | ✓ (somente `ready`) |
| GET /videos/:publicId/download | ✓ (somente `ready`) | ✓ (somente `ready`) | ✓ (somente `ready`) |

_Regras (AMB-1 clarification): rotas GET são `@Public` sob o guard JWT global com optional-auth (o token, quando presente, habilita a visão de dono para vídeos não-`ready`). Vídeos `draft`/`processing`/`failed` respondem 404 para qualquer caller que não seja o dono._

### Error Catalog

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_NOT_FOUND | 404 | `publicId` inexistente; vídeo não-`ready` acessado por não-dono (GET/stream/download); complete de vídeo de outro canal |
| VIDEO_FILE_TOO_LARGE | 400 | `file_size` declarado no initiate acima de 10 GiB |
| VIDEO_INVALID_CONTENT_TYPE | 400 | `content_type` fora de `video/*` no initiate |
| VIDEO_UPLOAD_INCOMPLETE | 400 | complete com objeto ausente no storage ou parts/ETags inválidos (falha no `CompleteMultipartUpload`) |
| VIDEO_UPLOAD_SIZE_MISMATCH | 400 | tamanho real (`HeadObject`) acima do teto ou divergente do declarado — multipart abortado, vídeo → `failed` |
| VIDEO_UPLOAD_NOT_COMPLETABLE | 409 | complete chamado sobre vídeo em `failed` |
| VIDEO_PROCESSING_FAILED | — | _não é resposta HTTP_: `error_code` persistido pelo worker em `processing→failed` (valores: `PROBE_FAILED`, `THUMBNAIL_FAILED`, `UNSUPPORTED_MEDIA`, `STORAGE_IO`, `STUCK_TIMEOUT` — este último gravado pela varredura de limpeza) |

_Formato de erro herdado de `phase-02-auth/TD-07` (custom domain exception filter): `{ statusCode, error, message }` com `errorCode` de domínio — inalterado nesta fase._

### Events/Messages

#### video.process (queue `video-processing`)

**Payload:**

```json
{ "videoId": "uuid", "bucket": "string", "key": "videos/{videoId}/original.{ext}" }
```

**Producer:** `VideosService` (API) — enfileira no complete, após CAS `draft→processing` (per `phase-03-videos/TD-01` + `TD-06`)
**Consumer:** `VideoProcessor` (container `video-worker`, standalone application context) (per `phase-03-videos/TD-03`)
**Trigger:** upload concluído e verificado via `HeadObject` no endpoint complete (per `phase-03-videos/TD-02`)
**Delivery semantics:** at-least-once (BullMQ; `jobId = videoId` deduplica enqueue; `attempts: 3` com backoff exponencial; stalled-job recovery via lock auto-renovado) — consumidor idempotente por CAS + chaves de storage determinísticas (per `phase-03-videos/TD-01` + `TD-06`)
**Failure:** tentativas esgotadas ou erro irrecuperável → worker CAS `processing→failed` persistindo `error_code`/`error_message`; varredura periódica (`@nestjs/schedule`) captura órfãos além do teto (per `phase-03-videos/TD-06`)

---

## Dependency Map

```
SI-03.1 (root — infra Compose: MinIO + Redis)
└── SI-03.2 — depends on SI-03.1 (chaves de env espelham compose/.env.example)
    ├── SI-03.3 — depends on SI-03.1, SI-03.2 (clients S3 consomem storage.config e o MinIO do Compose)
    │   ├── SI-03.6 — depends on SI-03.3, SI-03.4 (initiate usa StorageService + entidade Video)
    │   │   ├── SI-03.7 — depends on SI-03.5, SI-03.6 (complete fecha multipart e enfileira via producer)
    │   │   │   ├── SI-03.12 — depends on SI-03.5, SI-03.7, SI-03.11 (processor consome o job publicado no complete)
    │   │   │   └── SI-03.13 — depends on SI-03.7 (sweep atua sobre drafts com upload_id e processing)
    │   │   └── SI-03.8 — depends on SI-03.6 (consulta reusa service/controller de vídeos)
    │   │       └── SI-03.10 — depends on SI-03.3, SI-03.8 (streaming/download presignam sobre o storage)
    │   └── SI-03.9 — depends on SI-03.3, SI-03.5 (WorkerModule importa StorageModule + conexão BullMQ)
    │       └── SI-03.11 — depends on SI-03.9 (ffmpeg/ffprobe só existem na imagem do worker)
    └── SI-03.5 — depends on SI-03.1, SI-03.2 (BullMQ conecta no redis do Compose)
SI-03.4 (root, independente — entidade + migration + public_id)
SI-03.14 — depends on SI-03.10, SI-03.12 (e2e do fluxo completo exige entrega e processamento prontos)
```

---

## Deliverables

- [ ] SI-03.1 — Provisionar MinIO e Redis no Compose
- [ ] SI-03.2 — Configurar namespaces storage e queue com validação de env
- [ ] SI-03.3 — StorageModule: dual S3 clients e StorageService
- [ ] SI-03.4 — Criar entidade Video, migration CreateVideos e gerador de public_id
- [ ] SI-03.5 — Configurar QueueModule (BullMQ) e producer de jobs
- [ ] SI-03.6 — Implementar initiate upload (POST /videos)
- [ ] SI-03.7 — Implementar complete upload e enfileiramento (POST /videos/:publicId/complete)
- [ ] SI-03.8 — Implementar consulta de vídeo (GET /videos/:publicId)
- [ ] SI-03.9 — Infra do worker: imagem com FFmpeg e serviço video-worker no Compose
- [ ] SI-03.10 — Implementar streaming e download (302 → presigned GET)
- [ ] SI-03.11 — Implementar FfmpegService (probe e thumbnail)
- [ ] SI-03.12 — Implementar VideoProcessor (consumo, transições e falhas)
- [ ] SI-03.13 — Implementar varredura de limpeza (drafts abandonados e processing travado)
- [ ] SI-03.14 — E2E do fluxo completo, smoke cross-container e export OpenAPI

**Full test suites:**

- [ ] Backend tests pass (`cd nestjs-project && docker compose exec -T nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`cd nestjs-project && docker compose exec -T nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`cd nestjs-project && docker compose exec -T nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`cd nestjs-project && docker compose exec -T nestjs-api npm run lint`)
