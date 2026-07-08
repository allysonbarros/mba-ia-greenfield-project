---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.10
target_file: test/videos-delivery.e2e-spec.ts
---

# GET /videos/:publicId/stream + /download Test Plan

## Application Overview

Entrega de reprodução via streaming e download sem bytes de vídeo atravessarem a API: os endpoints públicos validam o estado `ready` e respondem `302` com presigned GET no MinIO — inline para playback (Range/206 servido pelo storage) e attachment com filename para download.

## Test Scenarios

### 1. Streaming e Download

**Setup:** `beforeEach` truncate test DB + `emptyBucket()`; bootstrap NestJS test module com config global do `main.ts`; vídeo `ready` semeado no banco com objeto real (`test/fixtures/tiny.mp4`) gravado em `videos/{id}/original.mp4` no MinIO do Compose.

#### 1.1. stream-ready-302-presigned

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-08T16:00:00Z

**Steps:**
  1. GET /videos/{publicId}/stream sem token
    - expect: status 302
    - expect: header Location contém `X-Amz-Signature` e o host do endpoint público do storage
    - expect: Location NÃO contém `response-content-disposition=attachment`

#### 1.2. seguir-location-com-range-retorna-206

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-08T16:00:00Z

**Steps:**
  1. GET /videos/{publicId}/stream e capturar o Location
  2. GET direto no Location com header `Range: bytes=0-1023`
    - expect: status 206 Partial Content
    - expect: header Content-Range presente (`bytes 0-1023/...`)
    - expect: corpo com exatamente 1024 bytes

#### 1.3. download-302-attachment-com-filename

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-08T16:00:00Z

**Steps:**
  1. GET /videos/{publicId}/download sem token
    - expect: status 302
    - expect: Location contém `response-content-disposition=attachment` com filename derivado do título
  2. GET direto no Location
    - expect: status 200 com header `Content-Disposition: attachment`

#### 1.4. nao-ready-404-em-stream-e-download

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-07-08T16:00:00Z

**Steps:**
  1. GET /videos/{publicId}/stream de vídeo `processing`
    - expect: status 404 com errorCode "VIDEO_NOT_FOUND"
  2. GET /videos/{publicId}/download do mesmo vídeo
    - expect: status 404 com errorCode "VIDEO_NOT_FOUND"
