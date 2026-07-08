# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 13/14 completed

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
- **Status:** completed
- **Tests:** 3 passing (queue.module.spec 1 + video-queue.producer.integration-spec 2 contra Redis real)
- **Observations:**
  - Fila registrada via `BullModule.registerQueueAsync` (não `registerQueue`) porque `attempts` vem da config (`VIDEO_PROCESSING_ATTEMPTS`); backoff exponencial + `removeOnComplete: 1000` / `removeOnFail: false`.
  - `queue.module.spec.ts` é `.spec.ts` por nome do plano, mas a `Queue` do BullMQ abre conexão Redis ao ser instanciada — então tecnicamente toca infra real. Mantido o nome do plano; roda contra o Redis do Compose (TD-08). `--forceExit` evita hang por handles abertos.
  - Instalados `bullmq@^5.79.3` e `@nestjs/bullmq@^11.0.4` no container.

### SI-03.6 — Implementar initiate upload (POST /videos)
- **Status:** completed
- **Tests:** 9 passing (videos.service.spec 3 unit + videos.module.spec 1 + videos-initiate.e2e-spec 5)
- **Observations:**
  - Teto 10 GiB e regra `content_type video/*` são aplicados no SERVICE (não no DTO) para carregarem os errorCodes de domínio `VIDEO_FILE_TOO_LARGE`/`VIDEO_INVALID_CONTENT_TYPE`; o DTO valida só formato genérico (int ≥1, string) — senão o ValidationPipe rejeitaria antes com `VALIDATION_ERROR` genérico e os testes 1.2/1.3 falhariam.
  - Interpretação do spec: os cenários dizem `body.errorCode`, mas o filtro de domínio do projeto (herdado da fase 02) emite `{ statusCode, error, message }`; então o e2e afere `res.body.error` (campo real), consistente com os e2e de auth.
  - Adicionado `ChannelsService.findByUserId` (resolução do canal do usuário logado é domínio de channels, não de videos — Single Responsibility). VideosModule passou a importar ChannelsModule + StorageModule.
  - `videos.module.spec.ts` (criado no SI-03.4) atualizado para injetar `ConfigModule` com `storageConfig` — consequência de VideosModule agora importar StorageModule.
  - Exceções de domínio de vídeo adicionadas ao arquivo compartilhado `common/exceptions/domain.exception.ts` (mesma convenção das exceções de auth).

### SI-03.7 — Implementar complete upload e enfileiramento (POST /videos/:publicId/complete)
- **Status:** completed
- **Tests:** 15 passing (videos.service.spec 8 unit [3 initiate + 5 complete], videos.module.spec 1, videos-upload.integration-spec 1, videos-complete.e2e-spec 5)
- **Observations:**
  - SPEC_DEVIATION: os testes (integration + e2e) sobem um Buffer inline em vez de `test/fixtures/tiny.mp4`. Essa fixture é deliverable do SI-03.11 (exige ffmpeg, ausente no container da API) e o complete só valida ETags/tamanho — bytes crus dão a mesma cobertura. Idem para os helpers `emptyBucket()`/`drainQueue()` (deliverable do SI-03.14): inlinei a limpeza (`queue.obliterate`, `deleteObjects`).
  - Nuance de semântica S3: na divergência de tamanho o `CompleteMultipartUpload` já teve sucesso (o objeto materializa só após o Complete), então o `AbortMultipartUpload` seguinte é no-op (upload já consumido) e é engolido pelo `.catch`. O objeto completo fica órfão no bucket até o sweep (SI-03.13). O plano pede "AbortMultipartUpload"; segui literalmente. A asserção do spec "ListMultipartUploads não lista o upload_id" passa porque uploads completados não são listados como pendentes.
  - Idempotência do complete é resolvida por short-circuit de status (processing/ready→200, failed→409) ANTES de tocar o storage, além do CAS `affected=0` para corrida concorrente.
  - Interpretação de campo: spec diz `body.errorCode`; filtro emite `body.error` (mesma convenção do SI-03.6).
  - VideosModule passou a importar QueueModule; `videos.module.spec.ts` atualizado para carregar `queueConfig`; `videos.service.spec.ts` recebeu o mock do `VideoQueueProducer`.

### SI-03.8 — Implementar consulta de vídeo (GET /videos/:publicId)
- **Status:** completed
- **Tests:** 15 passing (videos.service.spec 11 unit [3 initiate + 5 complete + 3 findByPublicId], videos-get.e2e-spec 4)
- **Observations:**
  - Optional-auth implementado no `JwtAuthGuard`: rota `@Public` nunca rejeita, mas se um Bearer válido estiver presente anexa `request.user` (token inválido em rota pública → tratado como anônimo). Habilita a visão de dono sem duplicar guard. Mudança é benigna para as rotas `@Public` herdadas (login/register) — sem Authorization, `hasBearer=false`, comportamento inalterado.
  - `findByPublicId(publicId, requestingUserId?)` aplica a regra AMB-1: `ready` visível a qualquer caller; `draft`/`processing`/`failed` só ao dono (senão `VIDEO_NOT_FOUND`, sem vazamento de existência). `thumbnail_url` presigned só quando `ready`+`thumbnail_key`; `error_code` incluído no payload apenas para o dono (spread condicional — campo ausente para não-donos).
  - `PublicIdParamDto` com `@Matches(/^[A-Za-z0-9_-]{11}$/)` valida o param via ValidationPipe global → 400 em formato inválido.
  - Interpretação de campo (consistente com SI-03.6/03.7): o plano/spec escreve `body.errorCode`, mas o filtro de domínio emite `{ statusCode, error, message }`; o e2e afere `res.body.error`.
  - E2E semeia vídeos direto no banco (`videoRepository.save`) nos estados necessários; canal do usuário resolvido decodificando o `sub` do access token e buscando por `user_id` (helper retorna `{ token, channel }`). `public_id` limitado a varchar(11) — fixtures usam exatamente 11 chars.

### SI-03.9 — Infra do worker: imagem com FFmpeg e serviço video-worker no Compose
- **Status:** completed
- **Tests:** no tests (Infra)
- **Observations:**
  - SPEC_DEVIATION (base image tag): o plano/env-note dizem `node:25.6.0-slim` assumindo Debian trixie, mas a tag `-slim` ainda resolve para bookworm, cujo apt entrega ffmpeg 5.1.x. A AC exige ffprobe 7.x, então pinei `node:25.6.0-trixie-slim` explicitamente (Debian 13 → ffmpeg 7.1.5-0+deb13u1). Validado: `docker compose exec -T video-worker ffprobe -version` → `7.1.5`.
  - `WorkerModule` (standalone app context) importa só infra — ConfigModule (load database/storage/queue + validationSchema), TypeOrmModule.forRootAsync + forFeature([Video, Channel, User]) (fecho de relação alcançável a partir de Video, senão o TypeORM falha ao montar metadata), StorageModule e BullMQ (forRootAsync connection + registerQueue). Sem controllers/guards/módulos HTTP (regra anti-acoplamento TD-03). O @Processor entra só no SI-03.12.
  - `src/worker.ts` = `NestFactory.createApplicationContext(WorkerModule)` + `enableShutdownHooks()` + log de prontidão. Sem HTTP listener; a conexão BullMQ mantém o processo vivo (validado: `node dist/worker` roda até o `timeout` matá-lo, EXIT=124, sem log de "listening").
  - Serviço `video-worker` no compose: build `Dockerfile.worker`, mesmo volume de código `.:/home/node/app`, `depends_on` db/minio/redis healthy. Comando idle (`tail -f /dev/null` herdado do Dockerfile) por design — mantém o container vivo para os testes integration via `docker compose exec` (SI-03.11/03.12) e para o smoke script (SI-03.14) sem auto-consumir a fila e roubar jobs dos testes que controlam o processamento in-process. Env vem do `.env` montado (mesmo padrão do nestjs-api, sem env_file no compose).
  - Scripts npm: `start:worker` (`node dist/worker`) e `start:worker:dev` (`nest start --watch --entryFile worker`). `nest build` emite `dist/worker.js` (validado).

### SI-03.10 — Implementar streaming e download (302 → presigned GET)
- **Status:** completed
- **Tests:** 23 passing (videos.service.spec 16 unit [+5 delivery], videos-delivery.integration-spec 3 contra MinIO real, videos-delivery.e2e-spec 4)
- **Observations:**
  - `getStreamUrl`/`getDownloadUrl` só entregam vídeos `ready` (senão `VIDEO_NOT_FOUND` via helper `findReadyOrThrow`, sem vazamento de existência). Stream = presign GET inline com `PLAYBACK_URL_EXPIRES_IN`; download = presign GET com `disposition: attachment; filename="{title}.{ext}"` e `DOWNLOAD_URL_EXPIRES_IN`. Extensão derivada do `original_key`; filename saneado (`buildDownloadFilename`) removendo aspas/barras/controle que quebrariam o quoted-string do Content-Disposition.
  - Endpoints `@Public` `GET :publicId/stream` e `:publicId/download` usam `@Redirect()` retornando `{ url, statusCode: 302 }`. Reusam `PublicIdParamDto` (validação de formato → 400). Swagger documenta o 302 com header `Location`.
  - SPEC_DEVIATION: os testes integration/e2e semeiam um Buffer inline como objeto em vez de `test/fixtures/tiny.mp4` (deliverable do SI-03.11, exige ffmpeg). Delivery só presigna+streama bytes — MinIO serve Range/206 sobre qualquer objeto. `emptyBucket()` inlinado (`listObjects`+`deleteObjects`) por ser deliverable do SI-03.14.
  - No ambiente de teste `STORAGE_PUBLIC_ENDPOINT=http://minio:9000` (mesmo host interno, pois os testes rodam dentro da rede Docker), então seguir o `Location` a partir do container funciona; o e2e afere `minio:9000` + `X-Amz-Signature` no `Location`.

### SI-03.11 — Implementar FfmpegService (probe e thumbnail)
- **Status:** completed
- **Tests:** 6 passing (ffmpeg.service.spec 3 unit [parseProbeOutput] + ffmpeg.service.integration-spec 3 contra ffmpeg real DENTRO do video-worker)
- **Observations:**
  - `FfmpegService.probe` = `execFile('ffprobe', ['-v','error','-print_format','json','-show_format','-show_streams', inputUrl])` promisificado com `maxBuffer` 16 MiB. `generateThumbnail(inputUrl, outPath, atSecond)` = `execFile('ffmpeg', ['-ss', t, '-i', inputUrl, '-frames:v','1','-vf','scale=640:-2','-q:v','3','-y', outPath])`. Input sempre URL/caminho seekable (nunca stdin — moov atom no fim do MP4). O cálculo `t = min(1s, 10% duração)` fica no chamador (processor, SI-03.12); o helper recebe `atSecond`.
  - Parse extraído em função pura `parseProbeOutput(stdout)` (unit-testável sem invocar ffprobe). Falhas classificadas em `MediaProcessingError` com códigos do Error Catalog: exec de ffprobe falha ou JSON inválido → `PROBE_FAILED` (stderr embutido na mensagem); ausência de stream de vídeo → `UNSUPPORTED_MEDIA`; falha do thumbnail → `THUMBNAIL_FAILED`.
  - Fixtures commitadas: `test/fixtures/tiny.mp4` (3.7 KB, h264 128x72 1s, gerado DENTRO do video-worker) + `src/worker/__fixtures__/ffprobe-tiny.output.json` (saída real do ffprobe para o unit test parsear). Nota de regeneração em `test/fixtures/README.md`.
  - Testes integration do src/worker rodam DENTRO do container video-worker (única imagem com ffmpeg): `docker compose exec -T video-worker npx jest --runInBand --forceExit src/worker`. FfmpegService ainda não é registrado em módulo — instanciado direto nos testes; registro no WorkerModule vem no SI-03.12.

### SI-03.12 — Implementar VideoProcessor (consumo, transições e falhas)
- **Status:** completed
- **Tests:** 9 passing (video.processor.spec 7 unit + video.processor.integration-spec 2 pipeline real DENTRO do video-worker)
- **Observations:**
  - `VideoProcessor` = `@Processor('video-processing', { concurrency: 1, lockDuration: 60_000 })` estendendo `WorkerHost`, registrado APENAS no `WorkerModule` (a API nunca consome). Carrega o vídeo por `videoId`, marca `processing_started_at`/`attempt_count`, gera presigned GET INTERNO do `original_key` como input seekable, pipeline probe → persiste duration/width/height/metadata → thumbnail → putObject em `videos/{id}/thumbnail.jpg` → CAS `processing→ready` com `processed_at`.
  - Adicionado `StorageService.presignInternalGetUrl` (assina com o client interno `s3`, não o público) — o worker alcança o storage pela rede Compose e não deve depender do endpoint público (CDN/host externo em prod). `t` do thumbnail = `min(1, 0.1*duração)` calculado no processor.
  - Falhas: `MediaProcessingError` (mídia inválida — PROBE_FAILED/UNSUPPORTED_MEDIA/THUMBNAIL_FAILED) → CAS `→failed` imediato + `throw UnrecoverableError` (sem retry). Erro transitório → re-throw para a política de retry do BullMQ; só persiste `→failed` (STORAGE_IO) quando esgotado. Confirmado na fonte do bullmq v5: `attemptsMade` é 0-based durante o processing e o retry ocorre enquanto `attemptsMade + 1 < attempts`; logo "esgotado" = `attemptsMade + 1 >= attempts` (o plano diz "attemptsMade === attempts", que assume 1-based — usei a semântica real verificada).
  - Idempotência sob entrega at-least-once por duas defesas: short-circuit quando `status !== processing` na entrega sequencial, e CAS final `affected=0` na corrida concorrente (chaves determinísticas tornam overwrite seguro).
  - `metadata` (jsonb) precisa de cast `as QueryDeepPartialEntity<Video>` no `update` — o tipo deep-partial do TypeORM não aceita objeto puro para coluna jsonb; o valor é gravado verbatim.
  - Testes de pipeline com o processor in-process (`Test.createTestingModule({ imports: [WorkerModule] })`), esperas orientadas a evento via `job.waitUntilFinished(queueEvents)` (sem sleeps). Rodam DENTRO do video-worker (ffmpeg real). O container video-worker permanece idle (tail) — não compete pelos jobs.

### SI-03.13 — Implementar varredura de limpeza (drafts abandonados e processing travado)
- **Status:** completed
- **Tests:** 8 passing (video-sweep.service.spec 5 unit + video-sweep.integration-spec 3 contra DB+MinIO reais)
- **Observations:**
  - `VideoSweepService` com `@Cron(CronExpression.EVERY_HOUR, { name: 'video-reconciliation-sweep' })`. `expireStaleDrafts`: drafts com `created_at` além de `UPLOAD_STALE_TTL_HOURS` → `abortMultipartUpload` (se `upload_id`) + `delete` da linha. `failStuckProcessing`: `processing` com `processing_started_at` além de `PROCESSING_STUCK_CEILING_HOURS` → CAS `→failed` com `error_code: STUCK_TIMEOUT`. Ready/failed nunca são consultados (queries filtram por status DRAFT/PROCESSING).
  - Instalado `@nestjs/schedule@^6.1.3` DENTRO do container. `ScheduleModule.forRoot()` registrado no `AppModule` (o sweep é concern da API, não do worker — WorkerModule não importa ScheduleModule/VideosModule); `VideoSweepService` provido no `VideosModule`. Boot da app com ScheduleModule validado (videos-get e2e verde).
  - Nota sobre `processing_started_at`: keyado literalmente no plano/AC. Um vídeo em `processing` nunca coletado pelo worker teria `processing_started_at` null e não seria pego pelo sweep — segui o contrato do plano (o worker seta esse campo ao iniciar; testes semeiam com o campo no passado).
  - Integration semeia um multipart real via `createMultipartUpload`, ajusta `created_at` por SQL raw (é `@CreateDateColumn`), e afere que `ListMultipartUploads` não lista mais o upload após o sweep.

### SI-03.14 — E2E do fluxo completo, smoke cross-container e export OpenAPI
- **Status:** pending
- **Tests:** _(not run)_
- **Observations:** none
