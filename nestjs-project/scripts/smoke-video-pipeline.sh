#!/usr/bin/env bash
#
# Compose-level smoke test for the video pipeline (phase-03-videos/TD-08).
# Proves the CROSS-CONTAINER flow with the REAL video-worker container (ffmpeg),
# not an in-process processor: register → confirm → login → initiate → PUT part →
# complete → the worker container consumes the job and transcodes → the video
# reaches `ready`, asserted via the API. Exits 0 on success.
#
# Run from the host: bash scripts/smoke-video-pipeline.sh
set -euo pipefail
cd "$(dirname "$0")/.."

API_SVC=nestjs-api
WORKER_SVC=video-worker

log() { printf '[smoke] %s\n' "$*"; }

cleanup() {
  log "stopping dev servers (returning containers to idle)"
  # `nest start --watch` spawns a child runner; kill both the watcher and the
  # orphaned dist entrypoint so no worker keeps consuming the queue.
  docker compose exec -T "$API_SVC" sh -c "pkill -f 'nest start'; pkill -f 'dist/main'" 2>/dev/null || true
  docker compose exec -T "$WORKER_SVC" sh -c "pkill -f 'nest start'; pkill -f 'dist/worker'" 2>/dev/null || true
}
trap cleanup EXIT

log "bringing up the stack"
docker compose up -d db minio redis mailpit "$API_SVC" "$WORKER_SVC"

log "starting the API server"
docker compose exec -d "$API_SVC" sh -c 'npm run start:dev > /tmp/api.log 2>&1'

log "starting the REAL video worker"
docker compose exec -d "$WORKER_SVC" sh -c 'npm run start:worker:dev > /tmp/worker.log 2>&1'

log "waiting for the API to accept connections"
for _ in $(seq 1 90); do
  if docker compose exec -T "$API_SVC" sh -c 'curl -sf http://localhost:3000 >/dev/null 2>&1'; then
    break
  fi
  sleep 2
done

log "waiting for the worker to be ready to consume"
for _ in $(seq 1 90); do
  if docker compose exec -T "$WORKER_SVC" sh -c 'grep -q "application context ready" /tmp/worker.log 2>/dev/null'; then
    break
  fi
  sleep 2
done

log "running the pipeline flow inside the API container"
docker compose exec -T "$API_SVC" node --input-type=module - <<'NODE'
import { readFileSync } from 'node:fs';

const API = 'http://localhost:3000';
const MAILPIT = 'http://mailpit:8025';
const email = `smoke_${Date.now()}@example.com`;
const password = 'password123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function jsonOf(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// 1. register
let res = await fetch(`${API}/auth/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password }),
});
if (!res.ok) throw new Error(`register failed: ${res.status}`);

// 2. pull the confirmation token from Mailpit
let token;
for (let i = 0; i < 20; i++) {
  const list = await jsonOf(
    await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent('to:' + email)}`),
  );
  const msg = (list.messages || [])[0];
  if (msg) {
    const full = await jsonOf(await fetch(`${MAILPIT}/api/v1/message/${msg.ID}`));
    const body = full.HTML || full.Text || '';
    const m = body.match(/confirm-email\?token=([^"&<\s]+)/);
    if (m) {
      token = m[1];
      break;
    }
  }
  await sleep(1000);
}
if (!token) throw new Error('confirmation token not found in Mailpit');

// 3. confirm + 4. login
res = await fetch(`${API}/auth/confirm-email?token=${token}`);
if (!res.ok) throw new Error(`confirm-email failed: ${res.status}`);
res = await fetch(`${API}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password }),
});
const login = await jsonOf(res);
const access = login.access_token;
if (!access) throw new Error('login returned no access_token');

// 5. initiate the upload
const bytes = readFileSync('/home/node/app/test/fixtures/tiny.mp4');
res = await fetch(`${API}/videos`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${access}` },
  body: JSON.stringify({
    title: 'Smoke Clip',
    file_name: 'clip.mp4',
    file_size: bytes.length,
    content_type: 'video/mp4',
  }),
});
const initiate = await jsonOf(res);
const publicId = initiate.public_id;

// 6. PUT the single part directly to storage (bytes never touch the API)
const put = await fetch(initiate.upload.urls[0].url, { method: 'PUT', body: bytes });
if (!put.ok) throw new Error(`part PUT failed: ${put.status}`);
const etag = put.headers.get('etag');

// 7. complete → enqueues the job for the worker container
res = await fetch(`${API}/videos/${publicId}/complete`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${access}` },
  body: JSON.stringify({ parts: [{ part_number: 1, etag }] }),
});
if (!res.ok) throw new Error(`complete failed: ${res.status}`);

// 8. the REAL worker consumes + transcodes — poll the API for `ready`
let status;
for (let i = 0; i < 4; i++) {
  await sleep(2000);
  const body = await jsonOf(await fetch(`${API}/videos/${publicId}`));
  status = body.status;
  if (status === 'ready') {
    console.log(`SMOKE_OK publicId=${publicId} status=ready`);
    process.exit(0);
  }
}
throw new Error(`video did not reach ready (last status=${status})`);
NODE

log "PASS — pipeline reached ready via the real worker container"
