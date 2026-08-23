# ArchVault — Internet Archive Drive

ArchVault is a connected, Google-Drive-style cloud drive on top of Internet
Archive IAS3 (S3-compatible) storage. One archive.org item = one "drive".
Works on any device via the responsive web app: browse folders, stream and
preview media, upload/download through a real transfer center, rename/move,
delete recursively, and mount public archive.org items read-only.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- Required env (API server only): secrets below. `DATABASE_URL` is **not**
  needed for the storage experience (the shared `lib/db` remains reserved for
  future metadata).

### Required runtime secrets (server-side only — never in the repo)

| Secret            | Purpose                                             |
|-------------------|-----------------------------------------------------|
| `IAS3_ENDPOINT`   | S3 endpoint; default `https://s3.us.archive.org`    |
| `IAS3_ACCESS_KEY` | IA S3 access key (archive.org → Account → S3 keys)  |
| `IAS3_SECRET_KEY` | IA S3 secret key                                    |
| `IAS3_REGION`     | SigV4 presigning region; default `us-east-1`        |

Set them in Replit Secrets. The browser never sees these values; clients
only call the JSON API under `/api/storage`.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5, zero-dependency IAS3 client (LOW auth for server-side S3
  calls, manual SigV4 for browser-direct presigned GET URLs)
- Web: React 19, Vite 7, Tailwind v4 design system, TanStack Query, wouter
- API contract: `lib/api-spec/openapi.yaml` (keep it in sync with routes)

## Where things live

- `artifacts/api-server/src/storage-provider.ts` — IAS3 client: bucket/object
  ops, virtual-folder-safe listings, presigning, discovery.
- `artifacts/api-server/src/routes/storage.ts` — REST API (browse, stream,
  upload proxy, rename, delete incl. folder recursion, search, discover).
- `artifacts/cloud-storage/src/App.tsx` — connected drive UI (browse grid/list,
  preview modal, transfer center, settings).
- `artifacts/cloud-storage/src/lib/storage-api.ts` — typed API client with
  XHR-progress uploads and streamed downloads.
- `lib/api-spec/openapi.yaml` — API contract source of truth.

## Architecture decisions

- **No fake data, ever.** Listings, transfers, speeds, and ETAs come from
  live wire events only (trust model in `.agents/memory/`).
- Uploads and downloads stream through the API with bounded memory
  (`duplex: "half"` fetch), so arbitrarily large files never hit RAM.
- Browser-direct media uses 15-minute SigV4 presigned URLs; in-app preview
  uses the same-origin `/stream` proxy, which is CORS-proof and ignores
  nothing the client needs for progressive playback.
- Keys with `/` act as folders; IA's S3 ignores `delimiter`, so folder views
  are grouped server-side from flat prefix listings.

## Internet Archive platform constraints (surfaced in Settings)

- Listings are **eventually consistent** (seconds; on dark items possibly
  minutes). Direct GET/HEAD is consistent immediately after upload. The UI
  auto-refreshes listings after writes.
- The S3 endpoint **ignores HTTP Range** requests — media streams
  progressively from the start; seeking restarts the stream.
- Item identifiers live in a **global namespace**; creation can 409.
- Folder listings are capped at 8,000 scanned keys per view.

## User preferences

- Keep everything provider-agnostic at the UI layer; IAS3 specifics stay in
  `storage-provider.ts`.
- Prioritize low-memory behavior, honest operational status, and responsive
  browsing over decorative effects.
