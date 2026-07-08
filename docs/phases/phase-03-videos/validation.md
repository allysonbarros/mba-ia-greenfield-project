---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-07-08T12:23:13-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-08T12:20:04-03:00"
issues:
  - id: AMB-1
    status: resolved
    summary: "Visibility/auth of streaming & download unspecified (anonymous allowed?)"
    resolved_by: clarification
  - id: AMB-2
    status: resolved
    summary: "Draft pre-registration metadata unspecified (title required at initiate?)"
    resolved_by: clarification
  - id: AMB-3
    status: resolved
    summary: "10GB limit enforcement point unspecified (declared size? complete check?)"
    resolved_by: clarification
  - id: AMB-4
    status: resolved
    summary: "Phase 03/04 boundary for video read endpoints unspecified"
    resolved_by: clarification
  - id: OQ-1
    status: resolved
    summary: "TD-01 pending — queue technology"
    resolved_by: phase-03-videos/TD-01
  - id: OQ-2
    status: resolved
    summary: "TD-02 pending — 10GB upload strategy"
    resolved_by: phase-03-videos/TD-02
  - id: OQ-3
    status: resolved
    summary: "TD-03 pending — worker topology + FFmpeg integration"
    resolved_by: phase-03-videos/TD-03
  - id: OQ-4
    status: resolved
    summary: "TD-04 pending — streaming + download delivery"
    resolved_by: phase-03-videos/TD-04
  - id: OQ-5
    status: resolved
    summary: "TD-05 pending — unique public URL strategy"
    resolved_by: phase-03-videos/TD-05
  - id: OQ-6
    status: resolved
    summary: "TD-06 pending — status lifecycle + failure handling"
    resolved_by: phase-03-videos/TD-06
  - id: OQ-7
    status: resolved
    summary: "TD-07 pending — object storage usage"
    resolved_by: phase-03-videos/TD-07
  - id: OQ-8
    status: resolved
    summary: "TD-08 pending — testing strategy for new infra"
    resolved_by: phase-03-videos/TD-08
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._ (All 8 decided TDs are mutually consistent: TD-02's presigned multipart consumes TD-07's dual-endpoint clients; TD-04 reuses the same presigner; TD-06's CAS protocol matches TD-01's retry/stalled semantics; every TD `Capability:` field cites a literal scope bullet.)

### Ambiguities

_None._

### Missing Decisions

_None._ (All 9 capability bullets covered per `## Capability Coverage`; error response format inherited from `phase-02-auth/TD-07`.)

### Dependency Gaps

_None._ (Auth guard, channels 1:1, config pattern, migrations, OpenAPI tooling inherited from phases 01–02; within-phase ordering captured by TD interaction notes → Dependency Map at build.)

### Inherited Constraint Conflicts

_None._ (Decided TDs align with inherited conventions: new env keys go through `registerAs` + Joi; storage/queue integrations use thin custom providers consistent with the no-glue-libs precedent; TypeORM migrations remain the schema mechanism.)

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._ (No UI scope in this phase.)

## Resolved Issues

- **AMB-1** _(resolved_by clarification)_ — Access model fixed: stream, download and metadata are public (anonymous allowed) for `ready` videos via the unique URL; `draft`/`processing`/`failed` videos are visible only to the owning channel's user (authenticated); anonymous/non-owner requests for non-ready videos receive 404. _Resolved with the recommended default (user AFK at resolve time — flagged for review at the plan checkpoint)._
- **AMB-2** _(resolved_by clarification)_ — Initiate contract fixed: `title` required (1–100 chars), `description` optional; metadata editing is Phase 04 scope. _Resolved with the recommended default (user AFK — review at plan checkpoint)._
- **AMB-3** _(resolved_by clarification)_ — 10GB enforcement fixed: client declares `file_size` at initiate (rejected when > 10 GiB; drives part count/size arithmetic); at complete, `HeadObject` verifies the real object size — mismatch beyond tolerance or size over cap aborts the multipart upload and surfaces a domain error. _Resolved with the recommended default (user AFK — review at plan checkpoint)._
- **AMB-4** _(resolved_by clarification)_ — Phase 03 endpoint set fixed: initiate upload, complete upload, GET video by publicId (metadata + status), stream (302), download (302). Channel video listing, editing, deletion and publication/visibility management belong to Phase 04. _Resolved with the recommended default (user AFK — review at plan checkpoint)._
- **OQ-1** _(resolved_by phase-03-videos/TD-01)_ — Decision A: BullMQ + @nestjs/bullmq, Redis added to Compose (user-approved at research checkpoint).
- **OQ-2** _(resolved_by phase-03-videos/TD-02)_ — Decision A: presigned multipart upload, client-called complete endpoint (user-approved).
- **OQ-3** _(resolved_by phase-03-videos/TD-03)_ — Decision A: standalone application-context worker container + child_process ffprobe/ffmpeg via apt (user-approved).
- **OQ-4** _(resolved_by phase-03-videos/TD-04)_ — Decision A: 302 → presigned GET for playback and download (user-approved).
- **OQ-5** _(resolved_by phase-03-videos/TD-05)_ — Decision A: zero-dep 11-char base64url public_id (user-approved).
- **OQ-6** _(resolved_by phase-03-videos/TD-06)_ — Decision A: 4-state enum + CAS transition map (user-approved).
- **OQ-7** _(resolved_by phase-03-videos/TD-07)_ — Decision A: AWS SDK v3 dual-client, single bucket, pinned MinIO image (user-approved).
- **OQ-8** _(resolved_by phase-03-videos/TD-08)_ — Decision A: real Compose services, fixed test bucket + cleanup, event-driven waits (user-approved).
