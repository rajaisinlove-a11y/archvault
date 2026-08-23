/**
 * Typed client for the ArchVault storage API (/api/storage).
 * The browser never sees IAS3 credentials — all calls hit our own API.
 */

const API_BASE = "/api/storage";

// ---------------------------------------------------------------------------
// Types (mirror lib/api-spec/openapi.yaml)
// ---------------------------------------------------------------------------

export type StorageStatus = {
  configured: boolean;
  endpoint: string;
  region: string;
};

export type ConnectionTestResult = {
  ok: boolean;
  status: "connected" | "not_configured" | "unauthorized" | "not_found" | "unreachable" | "error";
  message: string;
  endpoint: string | null;
  item: string | null;
};

export type ItemSummary = {
  name: string;
  createdAt: string | null;
};

export type BrowseFolder = {
  name: string;
  prefix: string;
  fileCount: number;
  sizeBytes: number;
  lastModified: string | null;
};

export type FileEntry = {
  key: string;
  name: string;
  size: number;
  lastModified: string | null;
  etag: string | null;
  mime: string;
};

export type BrowseResult = {
  item: string;
  prefix: string;
  folders: BrowseFolder[];
  files: FileEntry[];
  truncated: boolean;
  scannedKeys: number;
};

export type SearchFile = FileEntry & { folder: string };

export type SearchResult = {
  item: string;
  query: string;
  files: SearchFile[];
  scannedKeys: number;
};

export type ObjectStat = {
  key: string;
  size: number;
  contentType: string;
  lastModified: string | null;
  etag: string | null;
  mime: string;
};

export type PresignResult = {
  url: string;
  expiresAt: string;
};

export type UploadResult = {
  uploaded: boolean;
  item: string;
  key: string;
  size: number | null;
  etag: string | null;
  mime: string;
};

export type DeleteResult = {
  deleted: number;
  failures: Array<{ key: string; message: string }>;
};

export type DiscoveredItem = {
  identifier: string;
  title: string | null;
  mediatype: string | null;
  itemSize: number | null;
  downloads: number | null;
};

// ---------------------------------------------------------------------------
// Error type + low level request helper
// ---------------------------------------------------------------------------

export class StorageApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "StorageApiError";
    this.status = status;
    this.code = code;
  }
}

function qs(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    search.set(name, String(value));
  }
  const out = search.toString();
  return out ? `?${out}` : "";
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      headers: { accept: "application/json", ...init?.headers },
      ...init,
    });
  } catch {
    throw new StorageApiError(0, "NetworkError", "The storage API could not be reached.");
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      /* non-JSON error body */
    }
  }

  if (!response.ok) {
    const err = (payload as { error?: { code?: string; message?: string } } | null)?.error;
    throw new StorageApiError(
      response.status,
      err?.code ?? `HTTP${response.status}`,
      err?.message ?? `Request failed with HTTP ${response.status}.`,
    );
  }

  return payload as T;
}

function jsonBody(body: unknown): RequestInit {
  return {
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

// ---------------------------------------------------------------------------
// Endpoint helpers
// ---------------------------------------------------------------------------

export function storageStatus(): Promise<StorageStatus> {
  return request("/status");
}

/** Backwards-compatible with the original shell call. */
export async function testStorageConnection(): Promise<ConnectionTestResult> {
  const response = await fetch(`${API_BASE}/connection-test`, {
    method: "POST",
    headers: { accept: "application/json" },
  });
  return (await response.json()) as ConnectionTestResult;
}

export function listItems(): Promise<{ items: ItemSummary[] }> {
  return request("/items");
}

export function createItem(name: string): Promise<{ created: boolean; item: string }> {
  return request("/items", { method: "POST", ...jsonBody({ name }) });
}

export function discoverItems(query: string, rows = 24): Promise<{ items: DiscoveredItem[] }> {
  return request(`/discover${qs({ q: query, rows })}`);
}

export function browseItem(item: string, prefix: string): Promise<BrowseResult> {
  return request(`/items/${encodeURIComponent(item)}/browse${qs({ prefix })}`);
}

export function searchItem(item: string, query: string): Promise<SearchResult> {
  return request(`/items/${encodeURIComponent(item)}/search${qs({ q: query })}`);
}

export function createFolder(item: string, prefix: string): Promise<{ created: boolean; prefix: string }> {
  return request(`/items/${encodeURIComponent(item)}/folders`, {
    method: "POST",
    ...jsonBody({ prefix }),
  });
}

export function statObject(item: string, key: string): Promise<ObjectStat> {
  return request(`/items/${encodeURIComponent(item)}/stat${qs({ key })}`);
}

export function presignObject(
  item: string,
  key: string,
  options: { download?: boolean; expires?: number } = {},
): Promise<PresignResult> {
  return request(
    `/items/${encodeURIComponent(item)}/presign${qs({
      key,
      download: options.download ? "1" : undefined,
      expires: options.expires,
    })}`,
  );
}

/** Through-API stream URL (inline preview). Always same-origin + CORS-free. */
export function streamUrl(item: string, key: string, download = false): string {
  return `${API_BASE}/items/${encodeURIComponent(item)}/stream${qs({ key, download: download ? "1" : undefined })}`;
}

export function renameObject(
  item: string,
  from: string,
  to: string,
): Promise<{ renamed: boolean; from: string; to: string }> {
  return request(`/items/${encodeURIComponent(item)}/rename`, {
    method: "POST",
    ...jsonBody({ from, to }),
  });
}

export function deleteObjects(item: string, keys: string[]): Promise<DeleteResult> {
  return request(`/items/${encodeURIComponent(item)}/delete`, {
    method: "POST",
    ...jsonBody({ keys }),
  });
}

/** Recursive folder delete — removes every key under the prefix. */
export function deletePrefix(item: string, prefix: string): Promise<DeleteResult & { folder: string }> {
  return request(`/items/${encodeURIComponent(item)}/delete`, {
    method: "POST",
    ...jsonBody({ prefix }),
  });
}

// ---------------------------------------------------------------------------
// Upload with progress (XHR — streamed to our API, which pipes it to IA)
// ---------------------------------------------------------------------------

export type UploadHandle = {
  promise: Promise<UploadResult>;
  cancel: () => void;
};

export function uploadFile(
  item: string,
  key: string,
  file: File,
  onProgress: (loadedBytes: number, totalBytes: number) => void,
): UploadHandle {
  let xhr: XMLHttpRequest | null = null;

  const promise = new Promise<UploadResult>((resolve, reject) => {
    xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE}/items/${encodeURIComponent(item)}/upload${qs({ key })}`);
    xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
    xhr.responseType = "text";

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total);
      else onProgress(event.loaded, file.size);
    };

    xhr.onload = () => {
      const status = xhr?.status ?? 0;
      const body = xhr?.responseText ?? "";
      if (status >= 200 && status < 300) {
        try {
          resolve(JSON.parse(body) as UploadResult);
        } catch {
          reject(new StorageApiError(status, "BadResponse", "Upload succeeded but the response was unreadable."));
        }
        return;
      }
      try {
        const parsed = JSON.parse(body) as { error?: { code?: string; message?: string } };
        reject(
          new StorageApiError(
            status,
            parsed.error?.code ?? `HTTP${status}`,
            parsed.error?.message ?? `Upload failed with HTTP ${status}.`,
          ),
        );
      } catch {
        reject(new StorageApiError(status, `HTTP${status}`, `Upload failed with HTTP ${status}.`));
      }
    };

    xhr.onerror = () => reject(new StorageApiError(0, "NetworkError", "The upload connection dropped."));
    xhr.onabort = () => reject(new StorageApiError(0, "Cancelled", "The upload was cancelled."));
    xhr.ontimeout = () => reject(new StorageApiError(0, "Timeout", "The upload timed out."));

    xhr.send(file);
  });

  return {
    promise,
    cancel: () => {
      xhr?.abort();
    },
  };
}

// ---------------------------------------------------------------------------
// Download of small/medium files with progress into a Blob, then save
// ---------------------------------------------------------------------------

export type DownloadHandle = {
  promise: Promise<void>;
  cancel: () => void;
};

export function downloadFile(
  item: string,
  key: string,
  _size: number,
  onProgress: (loadedBytes: number) => void,
): DownloadHandle {
  const controller = new AbortController();
  const name = key.split("/").pop() ?? "download";

  const promise = (async () => {
    const response = await fetch(streamUrl(item, key, true), { signal: controller.signal });
    if (!response.ok || !response.body) {
      throw new StorageApiError(response.status, `HTTP${response.status}`, "Download failed.");
    }
    const total = Number(response.headers.get("content-length") ?? "0");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      onProgress(loaded);
      if (total === 0 || loaded >= total) continue;
    }
    const blobParts = chunks.map((c) => {
      const copy = new Uint8Array(c.byteLength);
      copy.set(c);
      return copy.buffer;
    });
    const blob = new Blob(blobParts);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  })();

  return { promise, cancel: () => controller.abort() };
}
