# Alexandria — project instructions

Multi-tenant knowledge-base SaaS with a production-grade RAG pipeline. Portfolio
project built incrementally, mentor-style, phase by phase.

## Session start

- Read `workflow/notes.md` (last entry = current state) and the phase checklist
  in `workflow/00-project-overview.md` before doing anything.
- `workflow/` is a **private engineering journal** — gitignored, never commit it.
  Update it (notes.md entry + relevant numbered doc) at the end of every phase.

## How we work

- Incremental phases; every step explains why / alternatives / trade-offs /
  what changes at production scale. Don't oversimplify — the audience is a
  senior backend engineer learning AI engineering.
- Architecture decisions get recorded in `workflow/02-architecture.md` (or the
  relevant numbered doc) and the decisions table in `workflow/00-project-overview.md`.
- Interview-relevant lessons go to `workflow/19-things-you-must-know.md`.

## Stack & conventions

- Node ≥22, **pnpm** (not npm/yarn). Build-script allowlist lives in
  `pnpm-workspace.yaml` (`allowBuilds`).
- NestJS 11, one codebase, two entrypoints: `src/main.ts` (API) and
  `src/worker.ts` (BullMQ worker). Keep HTTP concerns out of worker modules.
- TypeScript 6: `module: nodenext`, no `incremental` (tsbuildinfo conflicts
  with Nest's deleteOutDir), `tsconfig.build.json` for app builds.
- **Drizzle** ORM over pg Pool; inject `DRIZZLE` / `PG_POOL` tokens. Vector
  search SQL stays visible — don't hide retrieval queries behind abstractions.
- ESLint: do NOT enable `consistent-type-imports` — `import type` erases
  decorator metadata and silently breaks Nest DI.
- Env vars: add to `src/config/env.schema.ts` (zod, fail-fast) AND `.env.example`.
- LLM providers: Ollama (dev), Gemini (demos) behind a provider interface —
  never call a vendor SDK directly from business logic.
- Postgres + pgvector is the only datastore for relational + vector + FTS;
  Redis for queues/cache/rate-limits; MinIO (S3 API) for files.

## Commands

- `pnpm infra:up` / `infra:down` — dev infra (postgres, redis, minio);
  `pnpm infra:llm` adds Ollama (heavy, profile-gated)
- `pnpm start:dev` / `start:worker:dev` — run API / worker locally
- `pnpm build && pnpm lint && pnpm typecheck` — must pass before any commit
- `pnpm db:generate` / `db:migrate` — Drizzle migrations

## Guardrails

- Never commit: `workflow/`, `.env` (only `.env.example`).
- Multi-tenancy is sacred: every tenant-scoped query filters by workspace and
  RLS stays enabled (from Phase 2). Retrieval must be tenant-scoped *before*
  any LLM call.
- Commit only when Shyam asks; suggest a commit at each phase boundary.
