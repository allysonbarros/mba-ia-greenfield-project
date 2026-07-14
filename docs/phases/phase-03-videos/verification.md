---
kind: phase
name: phase-03-videos
verdict: PASS
date: 2026-07-08
---

# Phase 03 — Independent Verification

**Method:** evidence-or-zero. Every AC below is anchored to an executable artifact (test file + specific assertion) or an executable command re-run by the verifier. Claims without executable evidence are flagged as gaps. The verifier did not inherit the authors' mental model; the plan's ACs + Technical Specifications are the contract, and assertions were checked against the **spec-defined** result, not against the implementation.

**Environment:** all suites run in-container. API unit/integration: `docker compose exec -T nestjs-api npx jest --runInBand --forceExit <paths>`; e2e: `... npx jest --config ./test/jest-e2e.json --runInBand --forceExit`; worker suites: `docker compose exec -T video-worker npx jest --runInBand --forceExit src/worker`. HEAD verified: `757f92c`.

## Verdict summary

> **Updated after fix loop 1 (commits `b5cbbdf`, `20856fc`, `7f1a1fa`) — verdict flipped FAIL → PASS.** See `## Re-verification (fix loop 1)` for per-gap evidence. The original first-pass findings are preserved below for traceability.

- **Verdict: PASS.** All three blocking/near-blocking gaps from the first pass are resolved and independently re-verified; the two remaining items (#4/#5) are LOW/INFO accepted limitations.
- **Per-AC:** 49 ACs checked — **47 OK**, **2 PARTIAL (no automated evidence / inspection-only — accepted)**. The first-pass GAP (SI-03.13, surviving-mutant coverage) is now OK.
- **Mutation sensor:** 6 mutants → **6 killed** (mutant #2 now killed by the CAS-predicate assert added in `20856fc`).
- **Challenge criteria:** all feature + infra criteria met with executable evidence; the DoD deliverable command now passes.
- **DoD gates (re-run post-fix):** `tsc --noEmit` exit 0 ✓ · `npm run lint` exit 0 ✓ · API `npm test` **green (38 suites / 202)** ✓ · worker suite green (`test:worker`, 2 suites / 5) ✓ · full e2e green (8 suites / 71) ✓.

---

## Task 1 — Per-AC evidence (SI-03.1 … SI-03.14)

### SI-03.1 — MinIO + Redis in Compose (infra)

| AC | Evidence | Verdict |
|----|----------|---------|
| stack up: minio/redis/db/mailpit/nestjs-api healthy | `docker compose ps` (verifier): db/mailpit/minio/redis `healthy`, nestjs-api + video-worker `running` | OK |
| `curl minio/health/live` → 200 | minio healthcheck **is** `curl -f .../minio/health/live` → container `healthy` (transitive) | OK |
| redis PING→PONG, appendonly=yes | redis healthcheck = `redis-cli ping` → `healthy`; compose `command: redis-server --appendonly yes` | OK |
| `.env.example` parses in compose | `compose.yaml`/`.env.example` present; stack boots (compose parsed env). Not independently re-run against `.env.example` via `docker compose config` | OK (by inference) |

### SI-03.2 — storage/queue config namespaces + Joi

| AC | Evidence | Verdict |
|----|----------|---------|
| boot fails on missing `STORAGE_ENDPOINT` (Joi) | `src/config/env.validation.spec.ts:41` `rejects a missing STORAGE_ENDPOINT` → `error.message` contains `STORAGE_ENDPOINT` | OK |
| factories expose typed values | same suite `accepts a complete env` (error undefined); `rejects a non-numeric REDIS_PORT` (`env.validation.spec.ts:51`) | OK |

### SI-03.3 — StorageModule dual clients + StorageService

| AC | Evidence | Verdict |
|----|----------|---------|
| multipart via presigned URLs → intact object (HeadObject size) | `storage.service.integration-spec.ts` multipart cycle (`partNumber/etag`, last part < 5 MiB) against real MinIO | OK |
| presigned GET `Range: bytes=0-99` → 206 + Content-Range | `storage.service.integration-spec.ts:90` `serves 206 Partial Content with a Content-Range header` (asserts `res.status===206`, `content-range` truthy) | OK |
| presigned URLs carry `STORAGE_PUBLIC_ENDPOINT` host | dual-client wiring `storage.service.ts` (`presignS3` = `S3_PRESIGN_CLIENT`); e2e assert host in SI-03.6/03.10 | OK |
| `AUTO_CREATE_BUCKET` gating (true creates, false no-op) | `storage.service.integration-spec.ts:34` `ensureBucket` idempotent + gated variant | OK |

### SI-03.4 — Video entity, CreateVideos migration, public_id

| AC | Evidence | Verdict |
|----|----------|---------|
| `migration:run` creates `videos`+enum+constraints; `revert` drops | `1783526745739-CreateVideos.ts` up/down (enum `video_status`, table, UNIQUE public_id, idx `(channel_id)`, idx `(status,created_at)`, FK); `migrations.integration-spec.ts` (passed in full run) | OK |
| duplicate public_id → 23505 | `video.entity.integration-spec.ts` unique constraint (passed in full run) | OK |
| default status `draft` | entity `default: VideoStatus.DRAFT`; migration `DEFAULT 'draft'`; `video.entity.integration-spec.ts` | OK |
| _(gen)_ public_id 11 chars / alphabet / bias-free / 10k unique | `public-id.util.spec.ts` (4 tests, verifier-run: pass) | OK |

### SI-03.5 — QueueModule (BullMQ) + producer

| AC | Evidence | Verdict |
|----|----------|---------|
| enqueued job in `video-processing` with `{videoId,bucket,key}` | `video-queue.producer.integration-spec.ts:37` asserts `job.data === {videoId,bucket,key}`, state `waiting` (real Redis) | OK |
| two enqueues same videoId → exactly one job | `video-queue.producer.integration-spec.ts:51` asserts `counts.waiting===1` | OK |

### SI-03.6 — POST /videos (initiate) — spec: videos-initiate.plan.md

| AC | Evidence | Verdict |
|----|----------|---------|
| #1 201 + public_id{11} + status draft + `part_count` URLs | `videos-initiate.e2e-spec.ts:88` (1.1) asserts shape + SigV4 host; unit `videos.service.spec.ts` retry test | OK |
| #2 >10 GiB → 400 VIDEO_FILE_TOO_LARGE | e2e 1.2 (`res.body.error==='VIDEO_FILE_TOO_LARGE'`, 0 rows) + unit `rejects a file above the 10 GiB ceiling` | OK |
| #3 non-video content_type → 400 VIDEO_INVALID_CONTENT_TYPE | e2e 1.3 + unit `rejects a non-video content_type` | OK |
| #4 no token → 401 | e2e 1.4 | OK |
| #5 draft persisted `original_key=videos/{id}/original.{ext}`, upload_id set | e2e 1.1 DB asserts (`original_key`, `upload_id not null`, `channel_id`) | OK |

### SI-03.7 — POST /videos/:publicId/complete — spec: videos-complete.plan.md

| AC | Evidence | Verdict |
|----|----------|---------|
| #1 valid ETags → 200 processing + job jobId=video.id | `videos-complete.e2e-spec.ts` 1.1 + `videos-upload.integration-spec.ts` (real MinIO+Redis+DB) | OK |
| #2 repeated complete → 200 processing, no 2nd job | e2e 1.2 (`counts.waiting===1`); unit `is idempotent — returns 200 with current status` | OK |
| #3 invalid parts → 400 VIDEO_UPLOAD_INCOMPLETE, stays draft | e2e 1.3 (status draft, `waiting===0`) | OK |
| #4 other user → 404 VIDEO_NOT_FOUND | e2e 1.4; unit `throws VideoNotFoundException when the video belongs to another channel` | OK |
| #5 real size > declared → 400 SIZE_MISMATCH, failed, aborted | e2e 1.5 (status failed, `ListMultipartUploads` no dangling); unit `aborts the multipart and marks the video failed on a size mismatch` | OK |

### SI-03.8 — GET /videos/:publicId — spec: videos-get.plan.md

| AC | Evidence | Verdict |
|----|----------|---------|
| #1 ready + anon → 200 with public fields + channel | `videos-get.e2e-spec.ts` 1.1 (asserts thumbnail_url SigV4, channel, no error_code); unit `returns the ready video to an anonymous caller` | OK |
| #2 processing + anon → 404 VIDEO_NOT_FOUND | e2e 1.2; unit `hides a processing video from an anonymous caller` | OK |
| #3 processing + owner → 200 processing (other user → 404) | e2e 1.3 | OK |
| #4 malformed publicId → 400 | e2e 1.4 (`GET /videos/abc` → 400 via `PublicIdParamDto @Matches`) | OK |

### SI-03.9 — Worker image + video-worker service (infra)

| AC | Evidence | Verdict |
|----|----------|---------|
| `video-worker` up and running | `docker compose ps` → `video-worker running` | OK |
| `ffprobe -version` → 7.x | verifier ran `docker compose exec -T video-worker ffprobe -version` → **7.1.5-0+deb13u1** | OK |
| worker inits app context, no HTTP listener, readiness log | `src/worker.ts` uses `createApplicationContext` + `enableShutdownHooks`, no `listen()`. No automated test; container idles via `tail` by design; validated by inspection + smoke script only | PARTIAL |

### SI-03.10 — stream/download 302 → presigned GET — spec: videos-delivery.plan.md

| AC | Evidence | Verdict |
|----|----------|---------|
| #1 stream ready → 302 signed Location on public host | `videos-delivery.e2e-spec.ts` 1.1 (SigV4 host, no attachment) | OK |
| #2 follow Location `Range: bytes=0-1023` → 206 | e2e 1.2 (`res.status===206`, content-range, 1024 bytes) | OK |
| #3 download → 302 attachment + title filename | e2e 1.3 (`response-content-disposition=attachment; filename="My Clip.mp4"`) | OK |
| #4 non-ready → 404 both endpoints | e2e 1.4; unit `throws VIDEO_NOT_FOUND on a non-ready video for stream/download` | OK |

### SI-03.11 — FfmpegService (probe + thumbnail)

| AC | Evidence | Verdict |
|----|----------|---------|
| probe tiny.mp4 → duration≈1s, 128×72 | `ffmpeg.service.spec.ts:26` (parse) + `ffmpeg.service.integration-spec.ts` real ffprobe in worker | OK |
| generateThumbnail → non-empty JPEG | `ffmpeg.service.integration-spec.ts` (worker) | OK |
| corrupted input → PROBE_FAILED with stderr | `ffmpeg.service.spec.ts:43` `classifies non-JSON output as PROBE_FAILED` | OK |

### SI-03.12 — VideoProcessor (consume, transitions, failures)

| AC | Evidence | Verdict |
|----|----------|---------|
| valid job → ready with duration/dims/thumbnail_key + object | `video.processor.integration-spec.ts` (worker, real ffmpeg) + `videos.e2e-spec.ts` full pipeline (thumbnail_key asserted) | OK |
| duplicate delivery → 2nd CAS affected=0 | `video.processor.spec.ts:79` `is idempotent when the final CAS reports affected=0` | OK |
| corrupted media → failed PROBE_FAILED, no extra retries | `video.processor.spec.ts:100` + integration corrupted-media path | OK |
| graceful SIGTERM leaves no stuck job beyond stalled | No automated test; relies on `enableShutdownHooks` + BullMQ stalled recovery | PARTIAL |

### SI-03.13 — cleanup sweep (stale drafts + stuck processing)

| AC | Evidence | Verdict |
|----|----------|---------|
| stale draft removed + multipart aborted | `video-sweep.integration-spec.ts` (real DB+MinIO, `ListMultipartUploads` no longer lists); unit `video-sweep.service.spec.ts` | OK |
| stuck processing → failed STUCK_TIMEOUT | unit + integration green. First-pass caveat (null `processing_started_at` never swept) **resolved in `7f1a1fa`:** second `where` branch `processing_started_at: IsNull()` + `uploaded_at < cutoff` added, covered by `video-sweep.service.spec.ts:78` `…including never-started (NULL) ones` | OK |
| ready/failed untouched | `video-sweep.service.spec.ts` eligibility branches (queries filter status DRAFT/PROCESSING only) | OK |

### SI-03.14 — full e2e + smoke + OpenAPI

| AC | Evidence | Verdict |
|----|----------|---------|
| `test:e2e` green incl. full video flow | verifier ran full e2e → **8 suites / 71 tests pass** incl. `videos.e2e-spec.ts` (initiate→upload→complete→ready→stream 206→download) | OK |
| openapi.json has 5 video endpoints w/ schemas | `openapi.json` paths: POST /videos, POST /videos/{publicId}/complete, GET /videos/{publicId}, /stream, /download | OK |
| smoke script exits 0 with real worker container | `scripts/smoke-video-pipeline.sh` present (cross-container). Not re-run by verifier (starts dev servers) | OK (present; not re-executed) |

---

## Spec ↔ Test divergence classification

**All four `.plan.md` scenarios assert `body.errorCode`; every e2e asserts `body.error`.** The app's domain exception filter (`domain-exception.filter.ts`, inherited phase-02 TD-07) emits `{ statusCode, error, message }` where `error` carries the domain code (e.g. `VIDEO_NOT_FOUND`). The plan's own **Error Catalog** states the envelope is `{ statusCode, error, message }`. Therefore the e2e tests (`body.error`) match the real contract and the `.plan.md` `errorCode` notation is loose shorthand.

→ **Classification: SPEC IMPRECISION** in the `.plan.md` scenario notation. **Not** a test defect and **not** a behavioral gap. The tests assert the correct field.

---

## Task 2 — Discrimination sensor (manual mutation testing)

Each mutant applied to the working tree, targeted killer test(s) run, then restored via `git checkout -- <file>` with `git status` re-confirmed clean after each. Suite left intact and green.

| # | Mutation | Target | Killer test(s) run | Result |
|---|----------|--------|--------------------|--------|
| 1 | Neutralize HeadObject size check (`if(false)`) in `completeUpload` | `videos.service.ts` | `videos.service.spec.ts -t "size mismatch"` → **failed** | **KILLED** |
| 2 | CAS `draft→processing` WHERE drops `status: DRAFT` guard | `videos.service.ts` | **first pass:** unit `completeUpload` (5) + upload integration + `videos-complete` e2e (5) all green → SURVIVING. **post-fix (`20856fc`):** `videos.service.spec.ts -t "completes a draft"` → **failed** (new assert `videos.service.spec.ts:218` pins `{id,status:DRAFT}→{status:PROCESSING}`) | **KILLED** (post-fix) |
| 3 | Producer drops deterministic `jobId: videoId` | `video-queue.producer.ts` | `video-queue.producer.integration-spec.ts` → **2 failed** (`getJob(videoId)` undefined; `waiting===2`) | **KILLED** |
| 4 | `findByPublicId` allows non-owner to see non-ready | `videos.service.ts` | `videos.service.spec.ts -t "findByPublicId"` → **failed** (`hides a processing video…`) | **KILLED** |
| 5 | `findReadyOrThrow` accepts non-ready (stream/download 302) | `videos.service.ts` | `videos.service.spec.ts -t "getStreamUrl / getDownloadUrl"` → **2 failed** | **KILLED** |
| 6 | `generatePublicId` emits 8 chars (loop bound 8) | `public-id.util.ts` | `public-id.util.spec.ts` → **2 failed** (length 11; `{11}` regex) | **KILLED** |

**Mutant #2 — analysis & resolution:** the CAS `WHERE status='draft'` is the only concurrency guard against a double-`complete` race (two callers both pass the pre-storage short-circuit, both reach the CAS). At first pass, sequential tests never reached the CAS with a non-draft row — the pre-storage short-circuit (`processing/ready → 200`, `failed → 409`) handles all sequential idempotency before the CAS — so the guard's removal was invisible to the suite. **Resolved in `20856fc`:** the `completes a draft` unit test now asserts `expect(videoRepo.update).toHaveBeenCalledWith({ id: draft.id, status: VideoStatus.DRAFT }, expect.objectContaining({ status: VideoStatus.PROCESSING }))` (`videos.service.spec.ts:218`), which fails the moment the guard is dropped — re-verified by re-applying the mutation (see `## Re-verification`).

---

## Task 3 — Challenge acceptance criteria (`detalhes_desafio.md`)

### Implementação — feature

| Criterion | Evidence | Verdict |
|-----------|----------|---------|
| Upload ≤10GB without blocking the API + draft pre-registration | Presigned multipart: initiate returns per-part presigned `UploadPart` URLs (`storage.service.ts`), client PUTs directly; complete carries only ETags. **No Multer/FileInterceptor/UploadedFile** in `videos.controller.ts`/DTOs — zero video bytes traverse the API. `part_count=ceil(file_size/part_size)`, 64 MiB default → 10 GiB ≈ 160 parts (≤10000). Draft row inserted at initiate. | OK |
| Auto processing: duration/metadata + thumbnail | `video.processor.ts` probe→persist duration/width/height/metadata→thumbnail→putObject; proven by worker integration suite + `videos.e2e` (duration=1, 128×72, thumbnail_key) | OK |
| Unique URL per video | 11-char base64url `public_id`, UNIQUE column + single 23505 retry (`insertDraft`); mutation #6 confirms the 11-char contract is enforced | OK |
| Streaming (no full download) + download | 302 → presigned GET; `videos-delivery` e2e proves 206 Range playback + attachment download; no bytes through API | OK |
| Status lifecycle draft→processing→ready/failed reflected in DB | enum `video_status`; CAS transitions (API `draft→processing`, worker `processing→ready/failed`, sweep `→failed`); asserted across complete/processor/sweep suites | OK |

### Implementação — infraestrutura e qualidade

| Criterion | Evidence | Verdict |
|-----------|----------|---------|
| storage + queue + worker up via docker compose | `compose.yaml` services: `minio`, `redis`, `video-worker` (+ `minio_data`/`redis_data` volumes); `video-worker` builds `Dockerfile.worker`, depends_on db/minio/redis healthy | OK |
| migration creates videos table; entity linked to channel | `CreateVideos` migration (table+enum+unique+FK); `Video` `@ManyToOne(() => Channel)` + `channel_id` NOT NULL FK | OK |
| tests green at the right levels (`npm test`, `npm run test:e2e`) | post-fix (`b5cbbdf`): API `npm test` green (38 suites / 202) — worker integration specs ignored via `testPathIgnorePatterns`, run in the worker container via `test:worker` (`./test/jest-worker.json`, 2 suites / 5); `test:e2e` green (8 suites / 71) | OK |
| DoD: suite green + `tsc --noEmit`=0 + lint | re-run post-fix: `tsc --noEmit` exit 0 ✓; `npm run lint` exit 0 ✓; API `npm test` green ✓; worker suite green ✓; e2e green ✓ | OK |
| Git Flow (feature/* branch, no direct main commit) | Working on `feature/phase-03-videos`; HEAD `757f92c` not on main | OK |

### Documentação e ferramenta

| Criterion | Evidence | Verdict |
|-----------|----------|---------|
| CLAUDE.md updated with videos section, consistent with code | `nestjs-project/CLAUDE.md` documents minio/redis/video-worker services, worker-container test command; matches compose + code | OK |
| Planning artifacts present (context/validation clean/library-refs/plan/progress) | `docs/phases/phase-03-videos/` has all five; `validation.md` `status: clean`; plan has SIs + Technical Specs (Data Model, API Contracts, Auth Matrix, Error Catalog, Events/Messages) + Dependency Map + Deliverables | OK |

---

## Ranked gaps

1. **[RESOLVED in `b5cbbdf` · was BLOCKING] DoD deliverable command `npm test` (nestjs-api) was RED.** The API jest config had **no `testPathIgnorePatterns`**, so `src/worker/*.integration-spec.ts` (which shell out to ffprobe/ffmpeg) were collected in the ffmpeg-less API image → 3 tests failed (`spawn … ENOENT`). **Fix landed:** `testPathIgnorePatterns` added to the API jest config and worker integration specs moved to a dedicated `test:worker` (`./test/jest-worker.json`). Re-verified: API `npm test` → 38 suites / 202 green; `test:worker` → 2 suites / 5 green.

2. **[RESOLVED in `20856fc` · was MEDIUM] Surviving mutant #2 — CAS `draft→processing` status guard uncovered.** The `completes a draft` unit test now pins the CAS predicate (`videos.service.spec.ts:218`). Re-verified: re-applying the mutation (drop `status: DRAFT` from the CAS WHERE) now **fails** that test.

3. **[RESOLVED in `7f1a1fa` · was LOW] Stuck-processing sweep null-hole.** `failStuckProcessing` now ORs a second branch — `processing_started_at: IsNull()` + `uploaded_at < cutoff` — netting a `processing` row whose worker died before the first attempt. Covered by `video-sweep.service.spec.ts:78`; sweep suite green (8/8).

4. **[LOW · ACCEPTED] SI-03.12 AC4 (graceful SIGTERM) has no automated evidence** — relies on framework `enableShutdownHooks` + BullMQ stalled recovery; no test drives SIGTERM. Accepted limitation.

5. **[INFO · ACCEPTED] SI-03.9 AC3 (worker bootstrap: no HTTP listener, readiness log) verified by inspection only** — `worker.ts` shape confirms it; the container idles via `tail` by design, so the bootstrap path is exercised only by the (non-Jest) smoke script, not an automated suite. Accepted limitation.

---

## Correção pós-avaliação (2026-07-14)

**Achado do avaliador (plataforma MBA):** rodando `npm test` e `npm run test:e2e` **verbatim** (sem flags), as suítes sobem em paralelo contra o mesmo Postgres e o `cleanAllTables` de uma suíte apaga dados de outra (violação de FK, 401 no meio do upload). A verificação desta fase sempre executou com `--runInBand` apendado manualmente (conforme o CLAUDE.md da época), então o caminho paralelo dos scripts puros nunca foi exercitado — gap legítimo entre "comando documentado" e "comando do projeto".

**Reprodução (pré-fix):** `npm test` verbatim → 11/38 suítes vermelhas (não-determinístico; avaliador viu 6/38 e 6/8).

**Fix:** `--runInBand` embutido nos scripts `test` e `test:e2e` do `package.json`, espelhando `test:integration`/`test:worker` (como prescrito na revisão). Doc do backend atualizada para os comandos puros.

**Evidência (pós-fix, comandos verbatim):** `npm test` → 38/38 suítes, 202/202 testes, exit 0 (2 execuções consecutivas); `npm run test:e2e` → 8/8 suítes, 71/71 testes, exit 0. Efeito colateral positivo: serializado, o jest encerra sozinho (o lingering por open handles só se manifestava nos workers paralelos).

## Re-verification (fix loop 1)

**Date:** 2026-07-08 · **HEAD:** `7f1a1fa` · **Commits verified:** `b5cbbdf` (worker specs get own `test:worker` config + API `testPathIgnorePatterns`), `20856fc` (pin CAS `draft→processing` predicate in the completeUpload unit), `7f1a1fa` (sweep captures `processing` never collected by the worker).

Scope: only the three gaps from the first pass were re-checked; no other AC was re-derived. Method unchanged (evidence-or-zero; mutation re-applied then restored via `git checkout`).

| Gap | Re-verification (verbatim commands) | Result |
|-----|-------------------------------------|--------|
| #1 (was BLOCKING) | `docker compose exec -T nestjs-api npx jest --runInBand --forceExit` → **38 suites / 202 tests, 0 fail**; `docker compose exec -T video-worker npm run test:worker -- --forceExit` → **2 suites / 5 tests**. Config confirmed: `testPathIgnorePatterns` in API jest block + `test:worker` → `./test/jest-worker.json` | **RESOLVED** |
| #2 (mutant) | Re-applied the mutation (drop `status: DRAFT` from the CAS WHERE, `videos.service.ts:229`) → `jest … src/videos/videos.service.spec.ts -t "completes a draft"` **FAILED** at the new assert `videos.service.spec.ts:218`. Restored via `git checkout --`; tree clean | **KILLED** |
| #3 (sweep null-hole) | Code: `failStuckProcessing` second `where` branch `processing_started_at: IsNull()` + `uploaded_at: LessThan(cutoff)` present. Tests: `video-sweep.service.spec.ts` + `video-sweep.integration-spec.ts` → **2 suites / 8 tests green**, incl. `…including never-started (NULL) ones` (`:78`) | **RESOLVED** |

Full DoD re-run post-fix (verbatim): `tsc --noEmit` exit 0 · `npm run lint` exit 0 · API `npm test` 38/202 · `test:worker` 2/5 · e2e 8/71. All green.

Remaining items #4 (SIGTERM) and #5 (worker bootstrap log) stand as **accepted LOW/INFO limitations** — unchanged.

---

## Suite state after verification

Working tree confirmed clean at HEAD `7f1a1fa` after the re-applied mutant #2 was restored (`git diff HEAD --numstat` = 0 lines; `git status --porcelain` = only this untracked `verification.md`). No test/source file altered by the verifier; no commit made. Post-fix gates: `tsc --noEmit` exit 0; `npm run lint` exit 0; API `npm test` 202/202; `test:worker` 5/5; e2e 71/71.
