---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.6
target_file: test/videos-initiate.e2e-spec.ts
---

# POST /videos (initiate upload) Test Plan

## Application Overview

Pré-cadastro automático do vídeo como rascunho ao iniciar o upload: o endpoint autenticado cria a linha `draft` com `public_id` único, abre o multipart upload no MinIO e devolve as URLs presigned das partes — nenhum byte de vídeo passa pela API.

## Test Scenarios

### 1. Initiate Upload

**Setup:** `beforeEach` truncate test DB (`DELETE FROM videos`, users/channels via helpers); bootstrap NestJS test module reproduzindo config global do `main.ts` (ValidationPipe, exception filter, guard JWT global); usuário registrado + logado (access token válido); MinIO real do Compose.

#### 1.1. initiate-valido-cria-draft-com-urls-presigned

**Covers AC:** #1, #5
**Source:** auto
**Last sync:** 2026-07-08T16:00:00Z

**Steps:**
  1. POST /videos com Authorization Bearer válido e body `{ title: "Meu vídeo", file_name: "video.mp4", file_size: 5242880, content_type: "video/mp4" }`
    - expect: status 201
    - expect: body.public_id com formato `[A-Za-z0-9_-]{11}`
    - expect: body.status === "draft"
    - expect: body.upload.part_size > 0 e body.upload.urls.length === ceil(file_size / part_size)
    - expect: cada urls[i].url contém assinatura SigV4 (`X-Amz-Signature`) e o host do endpoint público
  2. Consultar a tabela videos pelo public_id retornado
    - expect: linha com status "draft", original_key = `videos/{id}/original.mp4`, upload_id não-nulo e channel_id do canal do usuário

#### 1.2. initiate-acima-de-10gib-rejeitado

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-08T16:00:00Z

**Steps:**
  1. POST /videos autenticado com body válido exceto `file_size: 10737418241` (10 GiB + 1)
    - expect: status 400
    - expect: body.errorCode === "VIDEO_FILE_TOO_LARGE"
    - expect: nenhuma linha criada na tabela videos

#### 1.3. initiate-content-type-nao-video-rejeitado

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-08T16:00:00Z

**Steps:**
  1. POST /videos autenticado com `content_type: "image/png"`
    - expect: status 400
    - expect: body.errorCode === "VIDEO_INVALID_CONTENT_TYPE"

#### 1.4. initiate-sem-token-retorna-401

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-07-08T16:00:00Z

**Steps:**
  1. POST /videos sem header Authorization com body válido
    - expect: status 401

#### 1.5. initiate-validation-wiring

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-08T16:00:00Z

**Steps:**
  1. POST /videos autenticado com body sem `title`
    - expect: status 400 (ValidationPipe ativo — wiring de DTO)
  2. POST /videos autenticado com `title` de 101 caracteres
    - expect: status 400
