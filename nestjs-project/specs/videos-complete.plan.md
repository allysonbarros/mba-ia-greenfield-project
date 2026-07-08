---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.7
target_file: test/videos-complete.e2e-spec.ts
---

# POST /videos/:publicId/complete Test Plan

## Application Overview

Fecha o multipart upload no storage com os ETags coletados pelo cliente, verifica o objeto real via HeadObject, transiciona `draft→processing` por compare-and-swap e publica o job `video.process` na fila — idempotente sob repetição.

## Test Scenarios

### 1. Complete Upload

**Setup:** `beforeEach` truncate test DB + `emptyBucket()` + `drainQueue()`; bootstrap NestJS test module com config global do `main.ts`; usuário logado; vídeo iniciado via POST /videos e fixture `test/fixtures/tiny.mp4` enviada por PUT direto nas URLs presigned (última parte única < 5 MiB); MinIO + Redis reais do Compose.

#### 1.1. complete-valido-transiciona-e-enfileira

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-08T16:00:00Z

**Steps:**
  1. POST /videos/{publicId}/complete autenticado com body `{ parts: [{ part_number: 1, etag: "<etag do PUT>" }] }`
    - expect: status 200
    - expect: body.status === "processing"
  2. Inspecionar a fila video-processing
    - expect: job waiting/active com jobId igual ao id interno do vídeo e payload `{videoId, bucket, key}`

#### 1.2. complete-repetido-e-idempotente

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-08T16:00:00Z

**Steps:**
  1. POST /videos/{publicId}/complete com ETags válidos (primeira vez)
    - expect: status 200, body.status === "processing"
  2. POST /videos/{publicId}/complete novamente com o mesmo body
    - expect: status 200, body.status === "processing"
    - expect: a fila contém exatamente 1 job para o videoId (sem duplicata)

#### 1.3. complete-com-parts-invalidos-mantem-draft

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-08T16:00:00Z

**Steps:**
  1. POST /videos/{publicId}/complete com `parts: [{ part_number: 1, etag: "etag-invalido" }]`
    - expect: status 400
    - expect: body.errorCode === "VIDEO_UPLOAD_INCOMPLETE"
  2. Consultar o vídeo no banco
    - expect: status permanece "draft" e nenhum job na fila

#### 1.4. complete-de-video-de-outro-usuario-404

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-07-08T16:00:00Z

**Steps:**
  1. Registrar segundo usuário e obter seu token
  2. POST /videos/{publicId}/complete com o token do segundo usuário (vídeo pertence ao primeiro)
    - expect: status 404
    - expect: body.errorCode === "VIDEO_NOT_FOUND" (sem vazamento de existência)

#### 1.5. complete-com-tamanho-divergente-falha-e-aborta

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-07-08T16:00:00Z

**Steps:**
  1. Iniciar upload declarando `file_size` diferente do tamanho real da fixture enviada
  2. POST /videos/{publicId}/complete com ETags válidos
    - expect: status 400
    - expect: body.errorCode === "VIDEO_UPLOAD_SIZE_MISMATCH"
  3. Consultar o vídeo no banco e o storage
    - expect: status === "failed"
    - expect: multipart upload abortado (ListMultipartUploads não lista o upload_id)
