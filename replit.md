# Keepsake Cloud Storage

Keepsake is a responsive personal archive workspace for browsing cloud files and monitoring transparent transfers.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/cloud-storage/` — responsive web application shell and file-browser experience
- `artifacts/api-server/` — shared API service, currently retained for the later IAS3 integration phase
- `lib/api-spec/openapi.yaml` — shared API contract source of truth
- `lib/db/` — shared Drizzle/PostgreSQL library, reserved for server metadata when backend work begins

## Architecture decisions

- The first milestone is intentionally honest and disconnected: the UI does not invent file records or transfer progress before IAS3 is connected.
- The frontend is provider-agnostic; IAS3-specific behavior and transfer scheduling belong outside React components.
- The shell is desktop-first but collapses into touch-friendly mobile navigation without relying on heavy media or continuous animation.
- The transfer center is shaped around typed engine events so speed, ETA, percentage, retry, and cancellation remain engine-owned values.

## Product

Keepsake provides a fast personal archive shell with folder navigation, search, recent files, settings/account surfaces, storage status, file actions, preview/detail states, and a transparent transfer center. IAS3-backed file operations are the next implementation phase.

## User preferences

- Keep this provider-agnostic and do not fake backend data, transfer progress, or unsupported capabilities.
- Prioritize low-memory behavior, responsive browsing, and clear operational status over decorative effects.

## Gotchas

- S3/IAS3 credentials must come from Replit Secrets/runtime configuration only; never place them in source, bundles, logs, or docs.
- The shared logical chunk limit is 52,428,800 bytes; actual streaming buffers must remain smaller and bounded.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
