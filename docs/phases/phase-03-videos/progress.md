# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 2/14 completed

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
- **Status:** pending
- **Tests:** _(not run)_
- **Observations:** none

### SI-03.4 — Criar entidade Video, migration CreateVideos e gerador de public_id
- **Status:** pending
- **Tests:** _(not run)_
- **Observations:** none

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
