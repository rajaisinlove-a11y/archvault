/**
 * Storage REST routes — /api/storage.
 *
 * All IAS3 credentials live exclusively in the server runtime environment;
 * clients only ever talk to this JSON API. Uploads/downloads stream through
 * with bounded memory (no request buffering), and browser-direct links are
 * short-lived SigV4 presigned URLs.
 *
 * IA quirks handled here:
 *  - ListObjectsV2 ignores `delimiter`, so folder views are grouped
 *    server-side from flat prefix listings.
 *  - Listings are eventually consistent; mutating responses echo the change
 *    so clients can reconcile immediately.
 *  - The S3 endpoint ignores Range headers; media still streams progressively
 *    while downloading.
 */

import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { Readable } from "node:stream";
import {
  Ias3ApiError,
  copyObject,
  createItem,
  deleteObject,
  discoverItems,
  getIas3Config,
  guessMime,
  headObject,
  isIas3Configured,
  listItems,
  listObjects,
  openObjectStream,
  presignGetUrl,
  putFolder,
  putObject,
  testIas3Connection,
  type StorageObjectEntry,
} from "../storage-provider";

const storageRouter: IRouter = Router();

/** Safety caps */
const MAX_BROWSE_KEYS = 8_000;
const MAX_DELETE_BATCH = 100;
const MAX_KEY_LENGTH = 900;
const ITEM_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,82}$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function qstr(value: unknown): string {
  if (typeof value !== "string") return "";
  return value;
}

function requireItem(name: string): string {
  if (!ITEM_PATTERN.test(name)) {
    throw new Ias3ApiError(400, "InvalidItem", `Invalid item identifier "${name}".`);
  }
  return name;
}

/** Validate an object key: non-empty, no traversal, sane length. */
function requireKey(key: unknown, name = "key"): string {
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY_LENGTH) {
    throw new Ias3ApiError(400, "InvalidKey", `Missing or oversized ${name}.`);
  }
  if (key.startsWith("/") || key.includes("\\") || key.split("/").includes("..") || key.includes("\0")) {
    throw new Ias3ApiError(400, "InvalidKey", `Unsafe ${name} "${key}".`);
  }
  return key;
}

/** Normalize a browsing prefix: either "" or ends with "/". */
function normalizePrefix(prefix: string): string {
  if (prefix === "") return "";
  if (!prefix.endsWith("/")) return `${prefix}/`;
  if (prefix.split("/").includes("..") || prefix.startsWith("/")) {
    throw new Ias3ApiError(400, "InvalidPrefix", "Unsafe prefix.");
  }
  return prefix;
}

export type BrowseFolder = {
  name: string;
  prefix: string;
  fileCount: number;
  sizeBytes: number;
  lastModified: string | null;
};

export type BrowseFile = StorageObjectEntry & {
  name: string;
  mime: string;
};

export type BrowseResult = {
  item: string;
  prefix: string;
  folders: BrowseFolder[];
  files: BrowseFile[];
  truncated: boolean;
  scannedKeys: number;
};

/**
 * Server-side folder view: IA ignores `delimiter`, so we page the flat
 * listing under `prefix` and group keys by their next path segment.
 */
async function browseItem(item: string, rawPrefix: string): Promise<BrowseResult> {
  const prefix = normalizePrefix(rawPrefix);
  const folders = new Map<string, BrowseFolder>();
  const files: BrowseFile[] = [];

  let token: string | undefined;
  let scanned = 0;
  let truncated = false;

  do {
    const page = await listObjects(item, {
      prefix: prefix === "" ? undefined : prefix,
      continuationToken: token,
      maxKeys: 1000,
    });

    for (const obj of page.objects) {
      scanned += 1;
      const rel = obj.key.slice(prefix.length);
      if (rel === "" ) continue;
      const slashAt = rel.indexOf("/");

      if (slashAt === -1) {
        // A file at exactly this level.
        files.push({
          ...obj,
          name: rel,
          mime: guessMime(rel),
        });
        continue;
      }

      // A key deeper in the tree — contributes to a virtual folder.
      const folderName = rel.slice(0, slashAt);
      // Zero-byte folder markers are visible as folders, but not counted as files.
      const isFolderMarker = rel.endsWith("/") && slashAt === rel.length - 1;
      const existing = folders.get(folderName);
      if (existing) {
        if (!isFolderMarker) {
          existing.fileCount += 1;
          existing.sizeBytes += obj.size;
        }
        if (obj.lastModified && (!existing.lastModified || obj.lastModified > existing.lastModified)) {
          existing.lastModified = obj.lastModified;
        }
      } else {
        folders.set(folderName, {
          name: folderName,
          prefix: `${prefix}${folderName}/`,
          fileCount: isFolderMarker ? 0 : 1,
          sizeBytes: isFolderMarker ? 0 : obj.size,
          lastModified: obj.lastModified,
        });
      }
    }

    token = page.isTruncated ? (page.nextToken ?? undefined) : undefined;
    if (!token && page.isTruncated) truncated = true;
    if (scanned >= MAX_BROWSE_KEYS) {
      truncated = true;
      break;
    }
  } while (token);

  return {
    item,
    prefix,
    folders: Array.from(folders.values()).sort((a, b) => a.name.localeCompare(b.name)),
    files,
    truncated,
    scannedKeys: scanned,
  };
}

/** Flat full-item key listing (bounded), for search. */
async function listAllKeys(item: string): Promise<StorageObjectEntry[]> {
  const all: StorageObjectEntry[] = [];
  let token: string | undefined;
  do {
    const page = await listObjects(item, { continuationToken: token, maxKeys: 1000 });
    all.push(...page.objects);
    token = page.isTruncated ? (page.nextToken ?? undefined) : undefined;
    if (!token || all.length >= MAX_BROWSE_KEYS) break;
  } while (token);
  return all;
}

// ---------------------------------------------------------------------------
// Status & connection
// ---------------------------------------------------------------------------

storageRouter.get("/storage/status", (_req, res) => {
  const config = getIas3Config();
  res.json({
    configured: isIas3Configured(),
    endpoint: config.endpoint,
    region: config.region,
  });
});

storageRouter.post("/storage/connection-test", async (_req, res) => {
  const result = await testIas3Connection();
  res.status(result.ok ? 200 : 503).json(result);
});

// ---------------------------------------------------------------------------
// Items (archive.org items == buckets == "drives")
// ---------------------------------------------------------------------------

storageRouter.get("/storage/items", async (_req, res) => {
  const items = await listItems();
  res.json({ items });
});

storageRouter.post("/storage/items", async (req, res) => {
  const name = requireItem(String(req.body?.name ?? ""));
  await createItem(name);
  res.status(201).json({ created: true, item: name });
});

storageRouter.get("/storage/discover", async (req, res) => {
  const q = qstr(req.query["q"]);
  const rows = Number(qstr(req.query["rows"]) || "24");
  const docs = await discoverItems(q, Number.isFinite(rows) ? rows : 24);
  res.json({ items: docs });
});

// ---------------------------------------------------------------------------
// Browsing, folders, search
// ---------------------------------------------------------------------------

storageRouter.get("/storage/items/:item/browse", async (req, res) => {
  const item = requireItem(req.params.item);
  const result = await browseItem(item, qstr(req.query["prefix"]));
  res.json(result);
});

storageRouter.get("/storage/items/:item/search", async (req, res) => {
  const item = requireItem(req.params.item);
  const q = qstr(req.query["q"]).trim().toLowerCase();
  if (q.length < 2) {
    throw new Ias3ApiError(400, "QueryTooShort", "Search requires at least 2 characters.");
  }
  const keys = await listAllKeys(item);
  const matches = keys
    .filter((entry) => entry.key.toLowerCase().includes(q) && !entry.key.endsWith("/"))
    .slice(0, 200)
    .map((entry) => ({
      ...entry,
      name: entry.key.split("/").pop() ?? entry.key,
      folder: entry.key.slice(0, entry.key.length - (entry.key.split("/").pop() ?? "").length),
      mime: guessMime(entry.key),
    }));
  res.json({ item, query: q, files: matches, scannedKeys: keys.length });
});

storageRouter.post("/storage/items/:item/folders", async (req, res) => {
  const item = requireItem(req.params.item);
  const prefix = normalizePrefix(requireKey(String(req.body?.prefix ?? ""), "prefix"));
  await putFolder(item, prefix);
  res.status(201).json({ created: true, prefix });
});

// ---------------------------------------------------------------------------
// Object metadata, open, stream, upload, rename, delete
// ---------------------------------------------------------------------------

storageRouter.get("/storage/items/:item/stat", async (req, res) => {
  const item = requireItem(req.params.item);
  const key = requireKey(qstr(req.query["key"]));
  const stat = await headObject(item, key);
  res.json({ key, ...stat, mime: stat.contentType !== "application/octet-stream" ? stat.contentType : guessMime(key) });
});

storageRouter.get("/storage/items/:item/presign", async (req, res) => {
  const item = requireItem(req.params.item);
  const key = requireKey(qstr(req.query["key"]));
  const download = qstr(req.query["download"]) === "1";
  const expires = Number(qstr(req.query["expires"]) || "900");
  const name = key.split("/").pop() ?? key;
  const result = presignGetUrl(item, key, {
    expiresInSeconds: Number.isFinite(expires) ? expires : 900,
    downloadName: download ? name : undefined,
    inline: false,
  });
  res.json({ url: result.url, expiresAt: result.expiresAt });
});

/**
 * Through-proxy stream — always works regardless of CORS, streams
 * progressively (IA's S3 ignores Range, so seeking is limited; noted in
 * docs). `download=1` forces an attachment disposition.
 */
storageRouter.get("/storage/items/:item/stream", async (req, res) => {
  const item = requireItem(req.params.item);
  const key = requireKey(qstr(req.query["key"]));
  const asDownload = qstr(req.query["download"]) === "1";

  const upstream = await openObjectStream(item, key, qstr(req.headers["range"]) || null);

  const contentType = upstream.headers.get("content-type") ?? guessMime(key);
  const contentLength = upstream.headers.get("content-length");
  const name = key.split("/").pop() ?? key;

  res.status(upstream.status);
  res.setHeader("content-type", contentType);
  if (contentLength) res.setHeader("content-length", contentLength);
  res.setHeader("accept-ranges", "none");
  res.setHeader("cache-control", "private, max-age=300");
  res.setHeader(
    "content-disposition",
    `${asDownload ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(name)}`,
  );

  if (!upstream.body) {
    res.end();
    return;
  }

  const nodeStream = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream<Uint8Array>);
  nodeStream.pipe(res);
  req.on("close", () => {
    nodeStream.destroy();
  });
  nodeStream.on("error", () => {
    if (!res.headersSent) res.status(502);
    res.end();
  });
});

/**
 * Streaming upload proxy — the request body flows straight through to IA
 * with bounded memory. Client sends the raw file body plus its content-type.
 */
storageRouter.post("/storage/items/:item/upload", async (req, res) => {
  const item = requireItem(req.params.item);
  const key = requireKey(qstr(req.query["key"]));

  const contentType = qstr(req.headers["content-type"]) || guessMime(key);
  const rawLength = qstr(req.headers["content-length"]);
  const contentLength = rawLength ? Number(rawLength) : undefined;

  const webStream = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
  const result = await putObject(item, key, webStream, {
    contentType,
    contentLength: Number.isFinite(contentLength) ? contentLength : undefined,
    queueDerive: false,
  });

  res.status(201).json({
    uploaded: true,
    item,
    key,
    size: contentLength ?? null,
    etag: result.etag,
    mime: contentType,
  });
});

storageRouter.post("/storage/items/:item/rename", async (req, res) => {
  const item = requireItem(req.params.item);
  const from = requireKey(String(req.body?.from ?? ""), "from");
  const to = requireKey(String(req.body?.to ?? ""), "to");
  if (from === to) throw new Ias3ApiError(400, "NoChange", "Source and destination are identical.");
  await copyObject(item, from, to);
  await deleteObject(item, from);
  res.json({ renamed: true, from, to });
});

storageRouter.post("/storage/items/:item/delete", async (req, res) => {
  const item = requireItem(req.params.item);
  const keys = req.body?.keys;
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_DELETE_BATCH) {
    throw new Ias3ApiError(400, "InvalidBatch", `Provide 1-${MAX_DELETE_BATCH} keys to delete.`);
  }
  const validated = keys.map((k) => requireKey(String(k)));

  const failures: Array<{ key: string; message: string }> = [];
  let deleted = 0;
  // IA is sensitive to burst writes; run small serial batches.
  for (const key of validated) {
    try {
      await deleteObject(item, key);
      deleted += 1;
    } catch (error) {
      failures.push({ key, message: error instanceof Error ? error.message : "Delete failed." });
    }
  }
  res.json({ deleted, failures });
});

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

storageRouter.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof Ias3ApiError) {
    res.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  const message = error instanceof Error ? error.message : "Unexpected storage error.";
  res.status(500).json({ error: { code: "InternalError", message } });
});

export default storageRouter;
