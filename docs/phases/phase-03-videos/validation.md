---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 12
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-07-08T12:15:00-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-08T11:24:17-03:00"
issues:
  - id: AMB-1
    status: open
    summary: "Visibility/auth of streaming & download unspecified (anonymous allowed?)"
  - id: AMB-2
    status: open
    summary: "Draft pre-registration metadata unspecified (title required at initiate?)"
  - id: AMB-3
    status: open
    summary: "10GB limit enforcement point unspecified (declared size? complete check?)"
  - id: AMB-4
    status: open
    summary: "Phase 03/04 boundary for video read endpoints unspecified"
  - id: OQ-1
    status: open
    summary: "TD-01 pending — queue technology"
  - id: OQ-2
    status: open
    summary: "TD-02 pending — 10GB upload strategy"
  - id: OQ-3
    status: open
    summary: "TD-03 pending — worker topology + FFmpeg integration"
  - id: OQ-4
    status: open
    summary: "TD-04 pending — streaming + download delivery"
  - id: OQ-5
    status: open
    summary: "TD-05 pending — unique public URL strategy"
  - id: OQ-6
    status: open
    summary: "TD-06 pending — status lifecycle + failure handling"
  - id: OQ-7
    status: open
    summary: "TD-07 pending — object storage usage"
  - id: OQ-8
    status: open
    summary: "TD-08 pending — testing strategy for new infra"
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

- **AMB-1** — Capabilities "Reprodução via streaming (sem necessidade de download completo)" and "Download do vídeo pelo usuário" do not state the authorization/visibility model: the project overview says anonymous users watch freely, but Phase 03 introduces no visibility field — may an anonymous user stream AND download any `ready` video via its public URL, and who may see a `draft`/`processing`/`failed` video's status? Explicit choice: define the access rule per endpoint (stream, download, status) so the plan's Authorization Matrix is unambiguous.
- **AMB-2** — "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload": the entity requires a `title`, but the bullet does not state which metadata is required at initiate time (title mandatory in the initiate request? description optional? editable later is Phase 04 territory). Explicit choice: fix the initiate request contract (required vs optional fields).
- **AMB-3** — "Upload de vídeos com suporte a arquivos de até 10GB": the 10GB ceiling has no stated enforcement point — presigned multipart parts cannot enforce a total-size cap by themselves. Explicit choice: define where the limit is enforced (declared size validated at initiate + part-count/part-size arithmetic + `HeadObject` size check at complete, rejecting >10GB) and what error the violation returns.
- **AMB-4** — Boundary with Phase 04 ("Gerenciamento de Vídeos e Canal"): which video read endpoints belong to Phase 03? Status/stream/download are implied by Phase 03 capabilities, but listing a channel's videos and editing/deleting are plausibly Phase 04. Explicit choice: enumerate the exact endpoint set Phase 03 ships (e.g., initiate, complete, status by id, stream, download — and nothing else).

### Missing Decisions

_None._ (All 9 capability bullets have ≥1 covering TD per `## Capability Coverage`; error response format is covered by inherited `phase-02-auth/TD-07`.)

### Dependency Gaps

_None._ (Auth guard, channels 1:1, config pattern, migrations and OpenAPI tooling all inherited from phases 01–02; within-phase ordering — storage before upload, queue before worker — is documented in the TDs' interaction notes and will be captured by the Dependency Map.)

### Inherited Constraint Conflicts

_None._ (No decided current-scope TDs yet; all recommendations align with inherited conventions — registerAs config namespaces, Joi env validation, custom providers, domain exception filter.)

### Unresolved Open Questions

- **OQ-1** — TD-01 pending — queue technology. Resolution: fill the **Decision:** field of TD-01 in `docs/decisions/technical-decisions-phase-03-videos.md` via /plan-resolve, then re-run /plan-validate.
- **OQ-2** — TD-02 pending — upload strategy for 10GB files. Resolution: same path via /plan-resolve.
- **OQ-3** — TD-03 pending — worker topology and FFmpeg integration. Resolution: same path via /plan-resolve.
- **OQ-4** — TD-04 pending — streaming playback and download delivery. Resolution: same path via /plan-resolve.
- **OQ-5** — TD-05 pending — unique public URL strategy. Resolution: same path via /plan-resolve.
- **OQ-6** — TD-06 pending — video status lifecycle and failure handling. Resolution: same path via /plan-resolve.
- **OQ-7** — TD-07 pending — object storage usage (SDK, bucket/key layout, MinIO in Compose). Resolution: same path via /plan-resolve.
- **OQ-8** — TD-08 pending — testing strategy for the new infrastructure. Resolution: same path via /plan-resolve.

### UI Coverage Gaps

_None._ (No UI scope in this phase — `## UI Inventory` not emitted in context.md.)

## Resolved Issues

_No issues resolved yet._
