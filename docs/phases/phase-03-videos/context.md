---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-07-08T10:44:24-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-08T11:24:17-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-07-08T10:44:24-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-07-08T10:44:24-03:00"
  docs/phases/phase-02-auth/context.md: "2026-07-08T10:44:24-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-07-08T10:44:24-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-07-08T10:44:24-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified in project-plan.md._ Boundary notes from research: HLS/ABR transcoding is out (only duration/metadata extraction + thumbnail); video UI screens belong to later frontend phases.

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/` (videos module, storage/queue/worker infra, migration). `next-frontend/` untouched this phase.

**Deferred subprojects:** _None._

**Sequencing notes:** Depende de: Fase 01, Fase 02.

**Neighbors (for boundary detection only):**

- **Phase 02:** Fase 02 — Cadastro, Login e Gerenciamento de Conta (Depende de: Fase 01)
- **Phase 04:** Fase 04 — Gerenciamento de Vídeos e Canal (Depende de: Fase 02, Fase 03)

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Queue technology for background video processing | pending | — | — |
| phase-03-videos/TD-02 | phase | Cross-layer | Upload strategy for 10GB files (direct-to-storage) | pending | — | — |
| phase-03-videos/TD-03 | phase | Backend | Worker topology and FFmpeg integration | pending | — | — |
| phase-03-videos/TD-04 | phase | Cross-layer | Streaming playback and download delivery | pending | — | — |
| phase-03-videos/TD-05 | phase | Backend | Unique public URL strategy | pending | — | — |
| phase-03-videos/TD-06 | phase | Backend | Video status lifecycle and failure handling | pending | — | — |
| phase-03-videos/TD-07 | phase | Backend | Object storage usage (SDK, bucket/key layout, MinIO in Compose) | pending | — | — |
| phase-03-videos/TD-08 | phase | Backend | Testing strategy for the new infrastructure | pending | — | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-07, phase-03-videos/TD-08 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-06, phase-03-videos/TD-08 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02, phase-03-videos/TD-08 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-02, phase-03-videos/TD-06 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-03, phase-03-videos/TD-06, phase-03-videos/TD-08 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-03 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-05 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-04, phase-03-videos/TD-08 |
| Download do vídeo pelo usuário | phase-03-videos/TD-04 |

## Decisions Detail

_No decided TDs yet — all 8 TDs are `pending` (research recommendations recorded; awaiting /plan-resolve)._

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. OWASP minimum: 19MiB memory, 2 iterations.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — plugin architecture costs little and future phases may add social login.

**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. PostgreSQL is already in the stack, so no new infrastructure needed.

**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. Keeps email tokens decoupled from the JWT auth system.

**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP, works with Mailpit for local development. Template engine support (Handlebars).

**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI).

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes the frontend can switch on. Single-consumer project: a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: guard system allows scoping rate limiting with `@SkipThrottle()` exemptions. Single-instance: in-memory storage sufficient.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value.

**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size for a single token format across the codebase.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — strict `[a-z0-9_]` allowlist for channel nicknames with `user_<random>` fallback; simplest and most portable choice.

**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Cookie-based session via a ~50-LOC session helper over the strict-BFF Route Handler model (no Auth.js) — architectural fit with the BFF as sole NestJS caller, smaller blast radius, no Next 16/React 19 compatibility lag.

**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Encrypted single session cookie (`iron-session`) — defense in depth on cookie content, single cookie simplifies logout, carries minimal user metadata for RSC chrome rendering.

**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** Server-side refresh with single-flight dedup in the BFF helper — RSC needs server-side refresh regardless; client-driven and pre-emptive-timer patterns rejected.

**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** react-hook-form + Zod resolvers — decoupled from mutation transport, aligned with shadcn's canonical form primitive, schemas-as-source-of-truth carries from env validation to forms.

**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Route Handlers as the single mutation surface (`app/api/**`) — strict-BFF alignment, existing MSW test scaffold reuse, uniform precedent for Phases 03–07.

**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Session delivered via RSC read of the cookie + Client Provider hydration — no first-render flicker, no extra BFF endpoint; `router.refresh()` after mid-session mutations.

**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** RSC owns the email-link token, Client Component owns the input — first-paint-correct confirmation/reset flows; single integration pattern across both flows.

**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** Option A (`@nestjs/swagger`) — é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo.

**Libraries:** @nestjs/swagger

### openapi-docs-nestjs/TD-02

**Recommendation:** Option C (Runtime UI + `openapi.json` exportado) — o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam.

**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** Option B (Swagger UI apenas em dev/staging via env flag) — alinha com a postura defensiva já estabelecida em phase 02; o `openapi.json` commitado cumpre o papel de "spec consultável fora da UI".

**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, ... })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function. _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory`. _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). POST `/api/auth/logout` BFF contract is ready. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — reset-password destination screen absent from Figma; link destination remains 404 until a later phase delivers the screen. Documented known gap. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | umbrella bullet deferred to the phase that lands the missing confirmação/reset screens; the 3 shipped telas are covered by their own verbs. |

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|-----------|--------|-----------|---------|
| (empty on first assembly — plan-resolve appends rows as user marks capabilities) | | | |

## Testing Requirements

### nestjs-project

| Artifact created | Required tests |
|---|---|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache) | Unit: real lib with test config |
| Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) or local adapter |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic |
| Guard (simple, delegates to framework) | E2E only |
| Pipe (custom transformation/validation) | Unit |
| Interceptor (response transform, logging) | Unit and/or E2E |
| Exception Filter | Unit + E2E |
| Middleware | E2E |

_Additional locked execution conventions (from `nestjs-project/CLAUDE.md` + testing guide): suffixes `*.spec.ts` (unit, no I/O) / `*.integration-spec.ts` (real DB/services, next to source) / `*.e2e-spec.ts` (supertest, in `test/`); integration + e2e run `--runInBand` against shared Compose services; all test commands run inside the `nestjs-api` container; cleanup via `dataSource.query('DELETE FROM ...')`; E2E must reproduce `main.ts` global config (pipes, filters, guards)._
