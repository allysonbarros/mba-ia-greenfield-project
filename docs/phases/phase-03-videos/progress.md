# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 4/14 completed

### SI-03.1 — Provisionar MinIO e Redis no Compose
- **Status:** completed
- **Tests:** no tests (Infra)
- **Observations:**
  - Corrigido no `.env.example` a linha `MAIL_FROM` pré-existente (só o display name estava entre aspas; `<...>` ficava fora, quebrando `docker compose config`). Alinhada ao formato do `.env` (valor inteiro entre aspas) para satisfazer o AC "`.env.example` parseia sem erro pelo Docker Compose" que este SI possui.
  - Todos os 5 serviços (db, mailpit, minio, redis, nestjs-api) `healthy`; MinIO `/minio/health/live` responde 200 do host; Redis `PING`→`PONG` e `CONFIG GET appendonly`→`yes`.

### SI-03.2 — Configurar namespaces storage e queue com validação de env
- **Status:** completed
- **Tests:** 7 passing (env.validation.spec.ts 3 novos + env.validation.integration-spec.ts 4 existentes)
- **Observations:**
  - Adicionar chaves `required` ao schema Joi quebraria o `env.validation.integration-spec.ts` existente (o `requiredEnv` dele não tinha as chaves novas); estendi esse `requiredEnv` com as chaves storage/queue obrigatórias — consequência direta e necessária da ação 3, mantendo a suíte verde.
  - `env.validation.integration-spec.ts` é, na prática, um teste unitário (só valida o schema Joi, sem DB) apesar do sufixo `.integration-spec`; renomeá-lo está fora de escopo — mantido como está.

### SI-03.3 — StorageModule: dual S3 clients e StorageService
- **Status:** completed
- **Tests:** 5 passing (storage.module.spec.ts 1 compilação + storage.service.integration-spec.ts 4 contra MinIO real)
- **Observations:**
  - SPEC_DEVIATION: as assinaturas do plano (`presignUploadPartUrls(uploadId, partCount, expiresIn)`, `completeMultipartUpload(parts)`, `abortMultipartUpload`, `createMultipartUpload`) omitem o `key`, mas todo comando S3 multipart exige `Key`; adicionei `key` como primeiro parâmetro em cada uma. Bucket vem da config injetada (não é parâmetro). Sem isso é impossível presignar/completar.
  - Clients criados com `requestChecksumCalculation: 'WHEN_REQUIRED'` (per library-refs) para o SDK v3.729+ não embutir header CRC32 na URL presigned de UploadPart, que quebraria um PUT simples do cliente.
  - Instalados `@aws-sdk/client-s3@^3.1081.0`, `@aws-sdk/s3-request-presigner@^3.1081.0`, `@aws-sdk/lib-storage@^3.1081.0` no container.

### SI-03.4 — Criar entidade Video, migration CreateVideos e gerador de public_id
- **Status:** completed
- **Tests:** 11 passing (public-id.util.spec 4, video.entity.integration-spec 4, videos.module.spec 1, migrations.integration-spec 2)
- **Observations:**
  - Migration `1783526745739-CreateVideos.ts` gerada via CLI (typeorm migration:generate), com enum `video_status`, tabela `videos`, unique `public_id`, índices `(status, created_at)` e `(channel_id)` e FK `channel_id`→`channels`. `migration:run`/`revert` verificados.
  - Estendido `migrations.integration-spec.ts` (per instrução do orquestrador): 3 migrations / 5 tabelas, drop de `video_status` no setup e o teste de revert agora afere a remoção da tabela `videos` (último migration).
  - `cleanAllTables` (helper compartilhado) passou a deletar `videos` antes de `channels` — consequência necessária da nova FK `videos.channel_id`→`channels`; sem isso, qualquer teste com vídeos quebraria o `DELETE FROM channels`.
  - Relação Video→Channel definida só no lado dono (`@ManyToOne` + `channel_id`), sem o inverso `@OneToMany` no `Channel`, para não acoplar o módulo channels ao videos (Single Responsibility). ManyToOne sem inverso é válido no TypeORM.
  - `bigint`/`numeric` recebem transformers para expor `number` limpo no código (file_size ≤ 10 GiB e duration cabem em Number seguro).
  - Colunas de timestamp usam `timestamptz` (byte-verbatim do Data Model), diferente do `TIMESTAMP` das tabelas herdadas da fase 01.

### SI-03.5 — Configurar QueueModule (BullMQ) e producer de jobs
- **Status:** pending
- **Tests:** _(not run)_
- **Observations:** none

### SI-03.6 — Implementar initiate upload (POST /videos)
- **Status:** pending
- **Tests:** _(not run)_
- **Observations:** none

### SI-03.7 — Implementar complete upload e enfileiramento (POST /videos/:publicId/complete)
- **Status:** pending
- **Tests:** _(not run)_
- **Observations:** none

### SI-03.8 — Implementar consulta de vídeo (GET /videos/:publicId)
- **Status:** pending
- **Tests:** _(not run)_
- **Observations:** none

### SI-03.9 — Infra do worker: imagem com FFmpeg e serviço video-worker no Compose
- **Status:** pending
- **Tests:** _(not run)_
- **Observations:** none

### SI-03.10 — Implementar streaming e download (302 → presigned GET)
- **Status:** pending
- **Tests:** _(not run)_
- **Observations:** none

### SI-03.11 — Implementar FfmpegService (probe e thumbnail)
- **Status:** pending
- **Tests:** _(not run)_
- **Observations:** none

### SI-03.12 — Implementar VideoProcessor (consumo, transições e falhas)
- **Status:** pending
- **Tests:** _(not run)_
- **Observations:** none

### SI-03.13 — Implementar varredura de limpeza (drafts abandonados e processing travado)
- **Status:** pending
- **Tests:** _(not run)_
- **Observations:** none

### SI-03.14 — E2E do fluxo completo, smoke cross-container e export OpenAPI
- **Status:** pending
- **Tests:** _(not run)_
- **Observations:** none
