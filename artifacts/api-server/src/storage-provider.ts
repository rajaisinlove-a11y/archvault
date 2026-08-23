/**
 * IAS3 storage provider — Internet Archive S3-compatible storage client.
 *
 * Two auth mechanisms are used:
 *  - Server-to-S3 calls use IA's native `LOW <access>:<secret>` auth header,
 *    which supports every S3 operation without payload hashing (so request
 *    bodies can be streamed with bounded memory).
 *  - Browser-direct links use standard AWS Signature Version 4 *presigned*
 *    GET URLs (query-string auth, UNSIGNED-PAYLOAD) so media files can be
 *    streamed/previewed/downloaded straight from IA with Range support.
 *
 * Secrets always come from the runtime environment — never from source:
 *   IAS3_ENDPOINT    (default https://s3.us.archive.org)
 *   IAS3_ACCESS_KEY  (required for storage operations)
 *   IAS3_SECRET_KEY  (required for storage operations)
 *   IAS3_REGION      (default us-east-1, used for SigV4 presigning)
 */

import { createHash, createHmac } from "node:crypto";

const DEFAULT_ENDPOINT = "https://s3.us.archive.org";
const DEFAULT_REGION = "us-east-1";
const DEFAULT_TIMEOUT_MS = 20_000;
const ADVANCED_SEARCH_URL = "https://archive.org/advancedsearch.php";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConnectionTestResult = {
  ok: boolean;
  status: "connected" | "not_configured" | "unauthorized" | "not_found" | "unreachable" | "error";
  message: string;
  endpoint: string | null;
  item: string | null;
};

export type Ias3Config = {
  endpoint: string;
  region: string;
  accessKey: string | null;
  secretKey: string | null;
};

export class Ias3ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "Ias3ApiError";
    this.status = status;
    this.code = code;
  }
}

export type StorageItemSummary = {
  name: string;
  createdAt: string | null;
};

export type StorageObjectEntry = {
  key: string;
  size: number;
  lastModified: string | null;
  etag: string | null;
};

export type ListObjectsResult = {
  prefixes: string[];
  objects: StorageObjectEntry[];
  isTruncated: boolean;
  nextToken: string | null;
};

export type DiscoveredItem = {
  identifier: string;
  title: string | null;
  mediatype: string | null;
  itemSize: number | null;
  downloads: number | null;
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export function getIas3Config(): Ias3Config {
  const endpoint = (process.env.IAS3_ENDPOINT ?? DEFAULT_ENDPOINT).replace(/\/+$/, "");
  return {
    endpoint,
    region: process.env.IAS3_REGION ?? DEFAULT_REGION,
    accessKey: process.env.IAS3_ACCESS_KEY ?? null,
    secretKey: process.env.IAS3_SECRET_KEY ?? null,
  };
}

export function isIas3Configured(): boolean {
  const { accessKey, secretKey } = getIas3Config();
  return Boolean(accessKey && secretKey);
}

function requireConfig(): Required<Pick<Ias3Config, "accessKey" | "secretKey">> & Ias3Config {
  const config = getIas3Config();
  if (!config.accessKey || !config.secretKey) {
    throw new Ias3ApiError(
      503,
      "NotConfigured",
      "IAS3 credentials are not configured. Set IAS3_ACCESS_KEY and IAS3_SECRET_KEY in the server runtime environment (e.g. Replit Secrets).",
    );
  }
  return config as Required<Pick<Ias3Config, "accessKey" | "secretKey">> & Ias3Config;
}

// ---------------------------------------------------------------------------
// Small helpers: XML, paths, MIME
// ---------------------------------------------------------------------------

function xmlUnescape(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

function decodeKey(rawXmlText: string): string {
  const unescaped = xmlUnescape(rawXmlText);
  try {
    return decodeURIComponent(unescaped);
  } catch {
    return unescaped;
  }
}

function matchAll(xml: string, pattern: RegExp): RegExpMatchArray[] {
  return Array.from(xml.matchAll(pattern));
}

/** Encode one S3 key segment (never encode the "/" separators). */
function encodeS3Path(key: string): string {
  return key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

const MIME_BY_EXTENSION: Record<string, string> = {
  avif: "image/avif", bmp: "image/bmp", gif: "image/gif", ico: "image/x-icon",
  jpeg: "image/jpeg", jpg: "image/jpeg", png: "image/png", svg: "image/svg+xml",
  tif: "image/tiff", tiff: "image/tiff", webp: "image/webp",
  aac: "audio/aac", flac: "audio/flac", m4a: "audio/mp4", mid: "audio/midi",
  mp3: "audio/mpeg", oga: "audio/ogg", ogg: "audio/ogg", opus: "audio/ogg",
  wav: "audio/wav", weba: "audio/webm",
  "3gp": "video/3gpp", avi: "video/x-msvideo", m4v: "video/mp4", mkv: "video/x-matroska",
  mov: "video/quicktime", mp4: "video/mp4", mpeg: "video/mpeg", mpg: "video/mpeg",
  ogv: "video/ogg", webm: "video/webm",
  pdf: "application/pdf",
  css: "text/css", csv: "text/csv", htm: "text/html", html: "text/html",
  js: "text/javascript", json: "application/json", log: "text/plain",
  md: "text/markdown", mjs: "text/javascript", ts: "text/plain",
  txt: "text/plain", xml: "application/xml", yaml: "text/yaml", yml: "text/yaml",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "7z": "application/x-7z-compressed", apk: "application/vnd.android.package-archive",
  gz: "application/gzip", rar: "application/vnd.rar", tar: "application/x-tar",
  zip: "application/zip", epub: "application/epub+zip",
  ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2",
  wasm: "application/wasm",
};

export function guessMime(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return "application/octet-stream";
  const ext = name.slice(dot + 1).toLowerCase();
  return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}

// ---------------------------------------------------------------------------
// Core server-side fetch using LOW auth (supports streaming request bodies)
// ---------------------------------------------------------------------------

type Ias3FetchOptions = {
  method?: string;
  query?: URLSearchParams;
  headers?: Record<string, string>;
  /** Buffer, Uint8Array, or a web ReadableStream (uses duplex streaming). */
  body?: BodyInit | null;
  /** Set to 0 to disable the timeout (streaming proxies). */
  timeoutMs?: number;
};

async function ias3Fetch(path: string, options: Ias3FetchOptions = {}): Promise<Response> {
  const { endpoint, accessKey, secretKey } = requireConfig();
  const { method = "GET", query, headers = {}, body = null, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  const url = `${endpoint}${path}${query && query.size > 0 ? `?${query.toString()}` : ""}`;

  const controller = new AbortController();
  const timeout = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const init: RequestInit & { duplex?: "half" } = {
      method,
      headers: {
        authorization: `LOW ${accessKey}:${secretKey}`,
        ...headers,
      },
      body,
      signal: controller.signal,
    };
    if (body !== null) init.duplex = "half";

    const response = await fetch(url, init);

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const code = /<Code>([^<]*)<\/Code>/.exec(text)?.[1];
      const message = /<Message>([\s\S]*?)<\/Message>/.exec(text)?.[1];
      throw new Ias3ApiError(
        response.status,
        code ?? `HTTP${response.status}`,
        (message ?? `${response.status} ${response.statusText}`).trim(),
      );
    }

    return response;
  } catch (error) {
    if (error instanceof Ias3ApiError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Ias3ApiError(504, "Timeout", "IAS3 did not respond before the request timed out.");
    }
    throw new Ias3ApiError(
      502,
      "Unreachable",
      error instanceof Error ? error.message : "The IAS3 endpoint could not be reached.",
    );
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Bucket (archive.org "item") operations
// ---------------------------------------------------------------------------

export async function listItems(): Promise<StorageItemSummary[]> {
  const response = await ias3Fetch("/", { method: "GET" });
  const xml = await response.text();

  const items: StorageItemSummary[] = [];
  for (const bucket of matchAll(xml, /<Bucket>([\s\S]*?)<\/Bucket>/g)) {
    const block = bucket[1];
    if (!block) continue;
    const name = /<Name>([\s\S]*?)<\/Name>/.exec(block)?.[1];
    if (!name) continue;
    const created = /<CreationDate>([\s\S]*?)<\/CreationDate>/.exec(block)?.[1] ?? null;
    items.push({ name: xmlUnescape(name), createdAt: created });
  }
  return items;
}

export async function createItem(name: string): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,82}$/.test(name)) {
    throw new Ias3ApiError(
      400,
      "InvalidItemName",
      "Item identifiers must be 3-83 characters of letters, numbers, dot, dash or underscore.",
    );
  }
  await ias3Fetch(`/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: {
      "x-archive-auto-make-bucket": "1",
      "content-length": "0",
    },
  });
}

// ---------------------------------------------------------------------------
// Object operations
// ---------------------------------------------------------------------------

export type ListObjectsParams = {
  prefix?: string;
  maxKeys?: number;
  continuationToken?: string;
};

/**
 * NOTE: IA's S3 ignores the `delimiter` parameter (no CommonPrefixes support),
 * so folder grouping is derived from flat prefix listings by the caller.
 * Listings are also eventually consistent — freshly uploaded keys can take a
 * few seconds to appear (direct GET/HEAD works immediately).
 */
export async function listObjects(item: string, params: ListObjectsParams = {}): Promise<ListObjectsResult> {
  const query = new URLSearchParams({
    "list-type": "2",
    "encoding-type": "url",
    "max-keys": String(Math.min(Math.max(params.maxKeys ?? 1000, 1), 1000)),
  });
  if (params.prefix) query.set("prefix", params.prefix);
  if (params.continuationToken) query.set("continuation-token", params.continuationToken);

  const response = await ias3Fetch(`/${encodeURIComponent(item)}`, { query });
  const xml = await response.text();

  const prefixes: string[] = [];
  for (const cp of matchAll(xml, /<CommonPrefixes>([\s\S]*?)<\/CommonPrefixes>/g)) {
    const prefix = /<Prefix>([\s\S]*?)<\/Prefix>/.exec(cp[1] ?? "")?.[1];
    if (prefix) prefixes.push(decodeKey(prefix));
  }

  const objects: StorageObjectEntry[] = [];
  for (const contents of matchAll(xml, /<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = contents[1];
    if (!block) continue;
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(block)?.[1];
    if (key === undefined) continue;
    const size = Number(/<Size>(\d+)<\/Size>/.exec(block)?.[1] ?? "0");
    const lastModified = /<LastModified>([^<]*)<\/LastModified>/.exec(block)?.[1] ?? null;
    const etag = /<ETag>"?([^"<]*)"?<\/ETag>/.exec(block)?.[1] ?? null;
    objects.push({ key: decodeKey(key), size, lastModified, etag });
  }

  const isTruncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const nextToken =
    /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] ??
    (isTruncated ? (/<NextMarker>([\s\S]*?)<\/NextMarker>/.exec(xml)?.[1] ?? null) : null);

  return { prefixes, objects, isTruncated, nextToken };
}

export type ObjectStat = {
  size: number;
  contentType: string;
  lastModified: string | null;
  etag: string | null;
};

export async function headObject(item: string, key: string): Promise<ObjectStat> {
  const response = await ias3Fetch(`/${encodeURIComponent(item)}/${encodeS3Path(key)}`, {
    method: "HEAD",
  });
  return {
    size: Number(response.headers.get("content-length") ?? "0"),
    contentType: response.headers.get("content-type") ?? "application/octet-stream",
    lastModified: response.headers.get("last-modified"),
    etag: response.headers.get("etag"),
  };
}

export type PutObjectOptions = {
  contentType?: string;
  contentLength?: number;
  metadata?: Record<string, string>;
  /** Asked IA to place a copy in the item's derived formats, etc. */
  queueDerive?: boolean;
};

export async function putObject(
  item: string,
  key: string,
  body: BodyInit,
  options: PutObjectOptions = {},
): Promise<{ etag: string | null }> {
  const headers: Record<string, string> = {
    "content-type": options.contentType ?? guessMime(key),
  };
  if (typeof options.contentLength === "number") {
    headers["content-length"] = String(options.contentLength);
  }
  if (options.queueDerive !== false) {
    headers["x-archive-queue-derive"] = "0";
  }
  for (const [name, value] of Object.entries(options.metadata ?? {})) {
    headers[`x-archive-meta-${name}`] = value;
  }

  const response = await ias3Fetch(`/${encodeURIComponent(item)}/${encodeS3Path(key)}`, {
    method: "PUT",
    headers,
    body,
    timeoutMs: 0,
  });

  return { etag: response.headers.get("etag") };
}

/** Create a "folder" — a zero-byte marker object whose key ends with "/". */
export async function putFolder(item: string, prefix: string): Promise<void> {
  const normalized = prefix.endsWith("/") ? prefix : `${prefix}/`;
  await ias3Fetch(`/${encodeURIComponent(item)}/${encodeS3Path(normalized)}`, {
    method: "PUT",
    headers: { "content-length": "0", "content-type": "application/x-directory" },
    body: new Uint8Array(0),
  });
}

/** Server-side copy — used to implement rename without re-uploading bytes. */
export async function copyObject(item: string, fromKey: string, toKey: string): Promise<void> {
  await ias3Fetch(`/${encodeURIComponent(item)}/${encodeS3Path(toKey)}`, {
    method: "PUT",
    headers: {
      "content-length": "0",
      "x-amz-copy-source": `/${encodeURIComponent(item)}/${encodeS3Path(fromKey)}`,
      "x-amz-metadata-directive": "COPY",
    },
    body: new Uint8Array(0),
  });
}

export async function deleteObject(item: string, key: string): Promise<void> {
  await ias3Fetch(`/${encodeURIComponent(item)}/${encodeS3Path(key)}`, { method: "DELETE" });
}

/** Streaming GET proxy — forwards the IA response (incl. 206 ranges) to the caller. */
export async function openObjectStream(
  item: string,
  key: string,
  rangeHeader: string | null,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (rangeHeader) headers["range"] = rangeHeader;
  return ias3Fetch(`/${encodeURIComponent(item)}/${encodeS3Path(key)}`, {
    method: "GET",
    headers,
    timeoutMs: 0,
  });
}

// ---------------------------------------------------------------------------
// SigV4 presigned GET URLs — browser-direct streaming/download with Range.
// ---------------------------------------------------------------------------

function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: string | Uint8Array, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** RFC 3986 encoding for presign query values. */
function qsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export type PresignedGet = {
  url: string;
  expiresAt: string;
};

export function presignGetUrl(
  item: string,
  key: string,
  options: { expiresInSeconds?: number; downloadName?: string; inline?: boolean } = {},
): PresignedGet {
  const { endpoint, region, accessKey, secretKey } = requireConfig();

  const expiresIn = Math.min(Math.max(options.expiresInSeconds ?? 900, 60), 604800);
  const now = new Date();
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;

  const host = new URL(endpoint).host;
  const canonicalUri = `/${qsEncode(item)}/${encodeS3Path(key)}`;

  const queryParams: Array<[string, string]> = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${accessKey}/${credentialScope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(expiresIn)],
    ["X-Amz-SignedHeaders", "host"],
  ];

  if (options.downloadName) {
    const disposition = options.inline
      ? `inline; filename*=UTF-8''${encodeURIComponent(options.downloadName)}`
      : `attachment; filename*=UTF-8''${encodeURIComponent(options.downloadName)}`;
    queryParams.push(["response-content-disposition", disposition]);
    queryParams.push(["response-content-type", guessMime(options.downloadName)]);
  }

  const canonicalQuery = queryParams
    .map(([name, value]) => `${qsEncode(name)}=${qsEncode(value)}`)
    .sort()
    .join("&");

  const canonicalRequest = [
    "GET",
    canonicalUri,
    canonicalQuery,
    `host:${host}`,
    "",
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  return {
    url: `${endpoint}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`,
    expiresAt: new Date(now.getTime() + expiresIn * 1000).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Public archive discovery (no auth required)
// ---------------------------------------------------------------------------

export async function discoverItems(query: string, rows = 24): Promise<DiscoveredItem[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const params = new URLSearchParams();
  params.set("q", trimmed);
  for (const field of ["identifier", "title", "mediatype", "item_size", "downloads"]) {
    params.append("fl[]", field);
  }
  params.set("rows", String(Math.min(Math.max(rows, 1), 50)));
  params.set("output", "json");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(`${ADVANCED_SEARCH_URL}?${params.toString()}`, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Ias3ApiError(response.status, "SearchFailed", `archive.org search returned HTTP ${response.status}.`);
    }
    const json = (await response.json()) as {
      response?: { docs?: Array<Record<string, unknown>> };
    };
    const docs = json.response?.docs ?? [];
    return docs.map((doc) => ({
      identifier: String(doc["identifier"] ?? ""),
      title: typeof doc["title"] === "string" ? doc["title"] : null,
      mediatype: typeof doc["mediatype"] === "string" ? doc["mediatype"] : null,
      itemSize: typeof doc["item_size"] === "number" ? doc["item_size"] : null,
      downloads: typeof doc["downloads"] === "number" ? doc["downloads"] : null,
    })).filter((doc) => doc.identifier !== "");
  } catch (error) {
    if (error instanceof Ias3ApiError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Ias3ApiError(504, "Timeout", "archive.org search did not respond in time.");
    }
    throw new Ias3ApiError(502, "Unreachable", "archive.org search could not be reached.");
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Connection test (kept backwards-compatible with the existing UI contract)
// ---------------------------------------------------------------------------

export async function testIas3Connection(): Promise<ConnectionTestResult> {
  const { endpoint, accessKey, secretKey } = getIas3Config();
  const item = process.env.IAS3_ITEM_IDENTIFIER ?? null;

  if (!accessKey || !secretKey) {
    return {
      ok: false,
      status: "not_configured",
      message:
        "Add IAS3_ACCESS_KEY and IAS3_SECRET_KEY to the server runtime environment (Replit Secrets) to connect storage.",
      endpoint,
      item,
    };
  }

  try {
    const items = await listItems();
    return {
      ok: true,
      status: "connected",
      message: `Connected to Internet Archive S3 — ${items.length} item${items.length === 1 ? "" : "s"} accessible on this account.`,
      endpoint,
      item,
    };
  } catch (error) {
    if (error instanceof Ias3ApiError) {
      if (error.status === 401 || error.status === 403) {
        return {
          ok: false,
          status: "unauthorized",
          message: "IAS3 rejected the credentials or their permissions.",
          endpoint,
          item,
        };
      }
      if (error.code === "Timeout") {
        return {
          ok: false,
          status: "unreachable",
          message: "IAS3 did not respond before the connection test timed out.",
          endpoint,
          item,
        };
      }
      return { ok: false, status: "error", message: error.message, endpoint, item };
    }
    return {
      ok: false,
      status: "unreachable",
      message: "The IAS3 endpoint could not be reached.",
      endpoint,
      item,
    };
  }
}
