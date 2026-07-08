---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.8
target_file: test/videos-get.e2e-spec.ts
---

# GET /videos/:publicId Test Plan

## Application Overview

Consulta pública de metadados e status do vídeo pela URL única, com a regra de visibilidade da fase: vídeos `ready` são visíveis para qualquer caller (inclusive anônimo); `draft`/`processing`/`failed` são visíveis apenas ao dono do canal — os demais recebem 404 sem vazamento de existência.

## Test Scenarios

### 1. Consulta por publicId

**Setup:** `beforeEach` truncate test DB; bootstrap NestJS test module com config global do `main.ts` (guard JWT global com rota `@Public` + optional-auth); vídeos semeados diretamente no banco nos estados necessários (`ready` com metadados completos, `processing`, `failed` com error_code).

#### 1.1. video-ready-visivel-anonimo

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-08T16:00:00Z

**Steps:**
  1. GET /videos/{publicId} de vídeo `ready`, sem header Authorization
    - expect: status 200
    - expect: body contém public_id, title, status "ready", duration_seconds, thumbnail_url e channel { id, name, nickname }
    - expect: body NÃO contém error_code

#### 1.2. video-processing-anonimo-404

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-08T16:00:00Z

**Steps:**
  1. GET /videos/{publicId} de vídeo `processing`, sem token
    - expect: status 404
    - expect: body.errorCode === "VIDEO_NOT_FOUND"

#### 1.3. video-processing-dono-ve-status

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-08T16:00:00Z

**Steps:**
  1. GET /videos/{publicId} de vídeo `processing` com Authorization do dono do canal
    - expect: status 200
    - expect: body.status === "processing"
  2. GET do mesmo vídeo com token de OUTRO usuário autenticado
    - expect: status 404 (não-dono não vê não-ready)

#### 1.4. publicid-invalido-400

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-07-08T16:00:00Z

**Steps:**
  1. GET /videos/abc (formato fora de `[A-Za-z0-9_-]{11}`)
    - expect: status 400 (validação do param)
