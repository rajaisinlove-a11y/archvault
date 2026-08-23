/**
 * ArchVault — connected cloud-drive shell.
 *
 * Real data only (per the project trust model): the browse surface, transfer
 * center, and previews are driven entirely by the live IAS3 API. Nothing is
 * simulated; platform constraints (eventual listing consistency, no HTTP
 * range seeking on IA) are surfaced honestly in the Settings page.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type ReactNode } from "react";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Route, Switch, useLocation } from "wouter";
import {
  Archive,
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Cloud,
  Database,
  Download,
  EllipsisVertical,
  ExternalLink,
  File,
  FileArchive,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  FolderOpen,
  FolderPlus,
  Globe,
  HardDrive,
  Info,
  KeyRound,
  LayoutGrid,
  Link2,
  List,
  LoaderCircle,
  Music,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  Trash2,
  TriangleAlert,
  Upload,
  X,
} from "lucide-react";

import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { toast } from "@/hooks/use-toast";
import * as api from "@/lib/storage-api";

const queryClient = new QueryClient();

// ---------------------------------------------------------------------------
// Formatting + file-kind helpers
// ---------------------------------------------------------------------------

function fmtBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function fmtEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

type KindKey = "image" | "video" | "audio" | "pdf" | "text" | "archive" | "app" | "other";

const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "json", "csv", "log", "xml", "yaml", "yml", "js", "jsx", "ts", "tsx", "css", "html", "py", "sh", "ini", "conf", "toml", "env", "sql", "svg"]);
const ARCHIVE_EXTENSIONS = new Set(["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "tgz"]);
const APP_EXTENSIONS = new Set(["apk", "exe", "msi", "dmg", "appimage", "deb", "rpm", "ipa"]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function kindOf(mime: string, name: string): KindKey {
  const ext = extensionOf(name);
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.includes("pdf")) return "pdf";
  if (ARCHIVE_EXTENSIONS.has(ext) || mime.includes("zip") || mime.includes("tar") || mime.includes("7z") || mime.includes("rar")) return "archive";
  if (APP_EXTENSIONS.has(ext)) return "app";
  if (mime.startsWith("text/") || TEXT_EXTENSIONS.has(ext) || mime.includes("json") || mime.includes("xml")) return "text";
  return "other";
}

const KIND_META: Record<KindKey, { label: string; cls: string; Icon: typeof File }> = {
  image: { label: "Image", cls: "kind-image", Icon: FileImage },
  video: { label: "Video", cls: "kind-video", Icon: FileVideo },
  audio: { label: "Audio", cls: "kind-audio", Icon: FileAudio },
  pdf: { label: "PDF", cls: "kind-doc", Icon: FileText },
  text: { label: "Text", cls: "kind-text", Icon: FileText },
  archive: { label: "Archive", cls: "kind-zip", Icon: FileArchive },
  app: { label: "App", cls: "kind-app", Icon: File },
  other: { label: "File", cls: "kind-file", Icon: File },
};

const PREVIEWABLE: ReadonlySet<KindKey> = new Set(["image", "video", "audio", "pdf", "text"]);
const THUMB_MAX_BYTES = 30 * 1024 * 1024;
const TEXT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
const PROGRESSIVE_DOWNLOAD_MAX = 300 * 1024 * 1024;

function KindBadge({ kind }: { kind: KindKey }) {
  const meta = KIND_META[kind];
  return (
    <span className={`kind ${meta.cls}`} title={meta.label}>
      <meta.Icon />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Transfer center store (module-level pub/sub, consumed via useSyncExternalStore)
// ---------------------------------------------------------------------------

export type TransferState = "running" | "done" | "error" | "cancelled";

export type Transfer = {
  id: string;
  direction: "up" | "down";
  name: string;
  item: string;
  key: string;
  size: number;
  loaded: number;
  state: TransferState;
  error?: string;
  note?: string;
  startedAt: number;
  cancel: () => void;
  retry: (() => void) | null;
};

type Listener = () => void;

class TransferStore {
  private transfers: Transfer[] = [];
  private listeners = new Set<Listener>();

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): Transfer[] => this.transfers;

  private emit() {
    for (const listener of this.listeners) listener();
  }

  add(transfer: Transfer) {
    this.transfers = [transfer, ...this.transfers];
    this.emit();
  }

  update(id: string, patch: Partial<Transfer>) {
    this.transfers = this.transfers.map((t) => (t.id === id ? { ...t, ...patch } : t));
    this.emit();
  }

  remove(id: string) {
    this.transfers = this.transfers.filter((t) => t.id !== id);
    this.emit();
  }

  clearFinished() {
    this.transfers = this.transfers.filter((t) => t.state === "running");
    this.emit();
  }
}

const transferStore = new TransferStore();

function useTransfers(): Transfer[] {
  return useSyncExternalStore(transferStore.subscribe, transferStore.snapshot);
}

/** Refetch listings twice after writes — IA listings are eventually consistent. */
function scheduleListingRefetch(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: ["items"] });
  window.setTimeout(() => qc.invalidateQueries({ queryKey: ["browse"] }), 2_500);
  window.setTimeout(() => qc.invalidateQueries({ queryKey: ["browse"] }), 8_000);
}

function startUpload(qc: QueryClient, item: string, key: string, file: File) {
  const id = crypto.randomUUID();
  const startedAt = Date.now();

  const run = () => {
    const handle = api.uploadFile(item, key, file, (loaded, total) => {
      transferStore.update(id, { loaded, size: total });
    });
    transferStore.update(id, {
      state: "running",
      error: undefined,
      loaded: 0,
      startedAt: Date.now(),
      cancel: () => {
        handle.cancel();
        transferStore.update(id, { state: "cancelled" });
      },
    });
    handle.promise
      .then((result) => {
        transferStore.update(id, { state: "done", loaded: result.size ?? file.size, size: result.size ?? file.size });
        scheduleListingRefetch(qc);
        toast({ title: "Upload complete", description: key });
      })
      .catch((error: unknown) => {
        if (error instanceof api.StorageApiError && error.code === "Cancelled") return;
        const message = error instanceof Error ? error.message : "Upload failed.";
        transferStore.update(id, { state: "error", error: message });
      });
  };

  transferStore.add({
    id,
    direction: "up",
    name: key.split("/").pop() ?? key,
    item,
    key,
    size: file.size,
    loaded: 0,
    state: "running",
    startedAt,
    cancel: () => {},
    retry: run,
  });
  run();
}

function startDownload(_qc: QueryClient, item: string, entry: api.FileEntry) {
  const id = crypto.randomUUID();
  const name = entry.name;

  const run = () => {
    if (entry.size > PROGRESSIVE_DOWNLOAD_MAX) {
      // Large files: hand to the browser's native downloader via our stream.
      const anchor = document.createElement("a");
      anchor.href = api.streamUrl(item, entry.key, true);
      anchor.download = name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      transferStore.update(id, {
        state: "done",
        loaded: entry.size,
        note: "Large file — handed to the browser downloader.",
      });
      return;
    }
    const handle = api.downloadFile(item, entry.key, entry.size, (loaded) => {
      transferStore.update(id, { loaded });
    });
    transferStore.update(id, {
      state: "running",
      error: undefined,
      loaded: 0,
      startedAt: Date.now(),
      cancel: () => {
        handle.cancel();
        transferStore.update(id, { state: "cancelled" });
      },
    });
    handle.promise
      .then(() => transferStore.update(id, { state: "done", loaded: entry.size }))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        const message = error instanceof Error ? error.message : "Download failed.";
        transferStore.update(id, { state: "error", error: message });
      });
  };

  transferStore.add({
    id,
    direction: "down",
    name,
    item,
    key: entry.key,
    size: entry.size,
    loaded: 0,
    state: "running",
    startedAt: Date.now(),
    cancel: () => {},
    retry: run,
  });
  run();
}

// ---------------------------------------------------------------------------
// Small UI primitives
// ---------------------------------------------------------------------------

function Spinner({ label }: { label?: string }) {
  return (
    <span className="row muted tiny" role="status">
      <LoaderCircle className="lucide spin" size={14} style={{ animation: "spin 1s linear infinite" }} />
      {label ?? "Working…"}
    </span>
  );
}

function Modal({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3 className="modal-title">{title}</h3>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <X size={15} />
          </button>
        </div>
        <div className="modal-copy">{children}</div>
        {footer ? <div className="modal-actions">{footer}</div> : null}
      </div>
    </div>
  );
}

function PromptDialog({
  title,
  label,
  initial,
  submitLabel,
  onSubmit,
  onClose,
  note,
}: {
  title: string;
  label: string;
  initial: string;
  submitLabel: string;
  onSubmit: (value: string) => Promise<void>;
  onClose: () => void;
  note?: string;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = async () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(trimmed);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed.");
      setBusy(false);
    }
  };

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="button ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="button primary" onClick={() => void submit()} disabled={busy || !value.trim()}>
            {busy ? "Working…" : submitLabel}
          </button>
        </>
      }
    >
      <label className="stack">
        <span className="tiny muted">{label}</span>
        <input
          ref={inputRef}
          className="search-box"
          style={{ width: "100%", height: 38 }}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
        />
      </label>
      {note ? <p className="tiny-note muted tiny">{note}</p> : null}
      {error ? (
        <p className="notice-inline">
          <CircleAlert /> {error}
        </p>
      ) : null}
    </Modal>
  );
}

function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="button ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="button danger"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              onConfirm()
                .then(onClose)
                .catch((err: unknown) => {
                  setError(err instanceof Error ? err.message : "Delete failed.");
                  setBusy(false);
                });
            }}
          >
            {busy ? "Deleting…" : confirmLabel}
          </button>
        </>
      }
    >
      {body}
      {error ? (
        <p className="notice-inline">
          <CircleAlert /> {error}
        </p>
      ) : null}
    </Modal>
  );
}

function Dropdown({ trigger, items, align = "right" }: { trigger: ReactNode; items: ReactNode; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className="menu-wrap" ref={wrapRef}>
      <span onClick={() => setOpen((v) => !v)} style={{ display: "inline-flex" }}>
        {trigger}
      </span>
      {open ? (
        <div className={`menu ${align === "left" ? "left" : ""}`} onClick={() => setOpen(false)}>
          {items}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preview modal
// ---------------------------------------------------------------------------

function PreviewBody({ item, file }: { item: string; file: api.FileEntry }) {
  const [text, setText] = useState<string | null>(null);
  const [textError, setTextError] = useState<string | null>(null);
  const kind = kindOf(file.mime, file.name);
  const src = api.streamUrl(item, file.key);

  useEffect(() => {
    setText(null);
    setTextError(null);
    if (kind !== "text") return;
    if (file.size > TEXT_PREVIEW_MAX_BYTES) {
      setTextError(`File is ${fmtBytes(file.size)} — text preview is limited to ${fmtBytes(TEXT_PREVIEW_MAX_BYTES)}.`);
      return;
    }
    const controller = new AbortController();
    fetch(src, { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then(setText)
      .catch((err: unknown) => {
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          setTextError(err instanceof Error ? err.message : "Preview failed.");
        }
      });
    return () => controller.abort();
  }, [item, file.key, kind, file.size, src]);

  switch (kind) {
    case "image":
      return <img src={src} alt={file.name} />;
    case "video":
      return <video src={src} controls autoPlay playsInline />;
    case "audio":
      return (
        <div className="preview-audio-wrap">
          <span className="kind kind-audio">
            <Music />
          </span>
          <strong>{file.name}</strong>
          <audio src={src} controls autoPlay />
        </div>
      );
    case "pdf":
      return <iframe src={src} title={file.name} />;
    case "text":
      if (textError) {
        return (
          <div className="preview-fallback">
            <CircleAlert />
            <p>{textError}</p>
          </div>
        );
      }
      if (text === null) {
        return (
          <div className="preview-fallback">
            <LoaderCircle size={26} style={{ animation: "spin 1s linear infinite" }} />
            <p>Loading preview…</p>
          </div>
        );
      }
      return <pre className="preview-text">{text}</pre>;
    default:
      return (
        <div className="preview-fallback">
          <File />
          <p>No inline preview for this file type.</p>
          <p className="tiny">Download it or open it directly.</p>
        </div>
      );
  }
}

function PreviewModal({
  item,
  files,
  index,
  onIndex,
  onClose,
  onDownload,
}: {
  item: string;
  files: api.FileEntry[];
  index: number;
  onIndex: (next: number) => void;
  onClose: () => void;
  onDownload: (file: api.FileEntry) => void;
}) {
  const file = files[index];

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft" && index > 0) onIndex(index - 1);
      if (event.key === "ArrowRight" && index < files.length - 1) onIndex(index + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, files.length, onClose, onIndex]);

  if (!file) return null;
  const kind = kindOf(file.mime, file.name);

  const openDirect = async () => {
    try {
      const signed = await api.presignObject(item, file.key, { expires: 600 });
      window.open(signed.url, "_blank", "noopener");
    } catch (err) {
      toast({ title: "Could not open file", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    }
  };

  const copyLink = async () => {
    try {
      const signed = await api.presignObject(item, file.key, { expires: 3600 });
      await navigator.clipboard.writeText(signed.url);
      toast({ title: "Temporary link copied", description: "Valid for 1 hour." });
    } catch {
      toast({ title: "Could not create link", variant: "destructive" });
    }
  };

  return (
    <div className="preview-scrim" onMouseDown={onClose}>
      <div className="preview" onMouseDown={(e) => e.stopPropagation()}>
        <div className="preview-bar">
          <button className="icon-button" disabled={index <= 0} onClick={() => onIndex(index - 1)} aria-label="Previous file">
            <ChevronLeft size={16} />
          </button>
          <button className="icon-button" disabled={index >= files.length - 1} onClick={() => onIndex(index + 1)} aria-label="Next file">
            <ChevronRight size={16} />
          </button>
          <span className="preview-title" title={file.key}>
            {file.name}
          </span>
          <span className="pill">{KIND_META[kind].label}</span>
          <button className="icon-button" onClick={() => void copyLink()} title="Copy temporary link (1 h)">
            <Link2 size={15} />
          </button>
          <button className="icon-button" onClick={() => void openDirect()} title="Open direct in new tab">
            <ExternalLink size={15} />
          </button>
          <button className="icon-button" onClick={() => onDownload(file)} title="Download">
            <Download size={15} />
          </button>
          <button className="icon-button" onClick={onClose} aria-label="Close preview">
            <X size={15} />
          </button>
        </div>
        <div className="preview-media">
          {PREVIEWABLE.has(kind) ? <PreviewBody item={item} file={file} /> : (
            <div className="preview-fallback">
              <File size={44} />
              <p>No inline preview for this file type.</p>
              <div className="row">
                <button className="button primary" onClick={() => onDownload(file)}>
                  <Download /> Download
                </button>
                <button className="button ghost" onClick={() => void openDirect()}>
                  <ExternalLink /> Open direct
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="preview-foot">
          <span>{fmtBytes(file.size)}</span>
          <span>·</span>
          <span>{fmtDate(file.lastModified)}</span>
          <span>·</span>
          <span>{file.mime}</span>
          <span className="grow" />
          <span>{index + 1} / {files.length}</span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Browse page
// ---------------------------------------------------------------------------

type SortKey = "name" | "size" | "date";

function crumbsFor(prefix: string): Array<{ label: string; prefix: string }> {
  const parts = prefix.split("/").filter(Boolean);
  const crumbs: Array<{ label: string; prefix: string }> = [];
  let acc = "";
  for (const part of parts) {
    acc += `${part}/`;
    crumbs.push({ label: part, prefix: acc });
  }
  return crumbs;
}

function matchesFilter(name: string, filter: string): boolean {
  return filter.trim() === "" || name.toLowerCase().includes(filter.trim().toLowerCase());
}

function sortFiles(files: api.FileEntry[], key: SortKey, dir: 1 | -1): api.FileEntry[] {
  const copy = [...files];
  copy.sort((a, b) => {
    if (key === "size") return (a.size - b.size) * dir;
    if (key === "date") return (String(a.lastModified ?? "")).localeCompare(String(b.lastModified ?? "")) * dir;
    return a.name.localeCompare(b.name) * dir;
  });
  return copy;
}

function sortFolders(folders: api.BrowseFolder[], key: SortKey, dir: 1 | -1): api.BrowseFolder[] {
  const copy = [...folders];
  copy.sort((a, b) => {
    if (key === "size") return (a.sizeBytes - b.sizeBytes) * dir;
    if (key === "date") return (String(a.lastModified ?? "")).localeCompare(String(b.lastModified ?? "")) * dir;
    return a.name.localeCompare(b.name) * dir;
  });
  return copy;
}

function BrowsePage({
  item,
  prefix,
  onNavigate,
  filter,
  onUploadPaths,
  onDownload,
}: {
  item: string;
  prefix: string;
  onNavigate: (prefix: string) => void;
  filter: string;
  onUploadPaths: (files: Array<{ key: string; file: File }>) => void;
  onDownload: (file: api.FileEntry) => void;
}) {
  const qc = useQueryClient();
  const [view, setView] = useState<"grid" | "list">(() => (localStorage.getItem("archvault.view") === "list" ? "list" : "grid"));
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<api.FileEntry | null>(null);
  const [deleting, setDeleting] = useState<{ files: api.FileEntry[]; folders: api.BrowseFolder[] } | null>(null);
  const [dragDepth, setDragDepth] = useState(0);

  const browseQuery = useQuery({
    queryKey: ["browse", item, prefix],
    queryFn: () => api.browseItem(item, prefix),
    enabled: item !== "",
    staleTime: 10_000,
    placeholderData: (prev) => prev,
  });

  const folders = useMemo(() => {
    const data = browseQuery.data?.folders ?? [];
    return sortFolders(data.filter((f) => matchesFilter(f.name, filter)), sortKey, sortDir);
  }, [browseQuery.data, filter, sortKey, sortDir]);

  const files = useMemo(() => {
    const data = browseQuery.data?.files ?? [];
    return sortFiles(data.filter((f) => matchesFilter(f.name, filter)), sortKey, sortDir);
  }, [browseQuery.data, filter, sortKey, sortDir]);

  const toggleView = (next: "grid" | "list") => {
    setView(next);
    localStorage.setItem("archvault.view", next);
  };

  const toggleSelect = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const selectedFiles = files.filter((f) => selected.has(f.key));
  const selectedFolders = folders.filter((f) => selected.has(f.prefix));

  const onDropFiles = (event: DragEvent) => {
    event.preventDefault();
    setDragDepth(0);
    const dropped = Array.from(event.dataTransfer?.files ?? []);
    if (dropped.length === 0) return;
    onUploadPaths(
      dropped.map((file) => {
        const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        return { key: `${prefix}${rel.replace(/\\/g, "/").replace(/^\/+/, "")}`, file };
      }),
    );
  };

  const doDelete = async () => {
    if (!deleting) return;
    for (const folder of deleting.folders) {
      await api.deletePrefix(item, folder.prefix);
    }
    if (deleting.files.length > 0) {
      const result = await api.deleteObjects(item, deleting.files.map((f) => f.key));
      if (result.failures.length > 0) {
        toast({ title: `${result.failures.length} file(s) could not be deleted`, variant: "destructive" });
      }
    }
    toast({ title: "Deleted", description: `${deleting.files.length + deleting.folders.length} item(s) removed.` });
    setSelected(new Set());
    scheduleListingRefetch(qc);
  };

  const doRename = async (nextName: string) => {
    if (!renaming) return;
    const parent = renaming.key.slice(0, renaming.key.length - renaming.name.length);
    await api.renameObject(item, renaming.key, `${parent}${nextName}`);
    toast({ title: "Renamed", description: nextName });
    scheduleListingRefetch(qc);
  };

  const downloadSelected = () => {
    for (const file of selectedFiles) onDownload(file);
    setSelected(new Set());
  };

  const openFile = (file: api.FileEntry) => {
    const idx = files.findIndex((f) => f.key === file.key);
    setPreviewIndex(idx >= 0 ? idx : null);
  };

  const isEmpty = !browseQuery.isPending && folders.length === 0 && files.length === 0;

  return (
    <div
      onDragEnter={(e) => {
        e.preventDefault();
        if (e.dataTransfer.types.includes("Files")) setDragDepth((d) => d + 1);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        setDragDepth((d) => Math.max(0, d - 1));
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDropFiles}
    >
      {dragDepth > 0 ? (
        <div className="dropveil">
          <div className="dropveil-inner">
            <Upload />
            Drop files to upload to <span className="mono">/{prefix}</span>
          </div>
        </div>
      ) : null}

      <div className="browser-toolbar">
        <nav className="crumbs" aria-label="Location">
          <button className={`crumb ${prefix === "" ? "current" : ""}`} onClick={() => onNavigate("")}>
            <HardDrive size={13} /> {item}
          </button>
          {crumbsFor(prefix).map((crumb, i) => (
            <span key={crumb.prefix} className="row" style={{ gap: 2 }}>
              <ChevronRight size={13} className="crumb-sep" />
              <button className={`crumb ${i === crumbsFor(prefix).length - 1 ? "current" : ""}`} onClick={() => onNavigate(crumb.prefix)}>
                {crumb.label}
              </button>
            </span>
          ))}
        </nav>
        <div className="toolbar-right">
          <span className="pill" title={browseQuery.data ? `${browseQuery.data.scannedKeys} keys scanned` : undefined}>
            {browseQuery.data ? `${folders.length + files.length} items` : "…"}
          </span>
          {browseQuery.data?.truncated ? <span className="pill warn">listing capped</span> : null}
          <Dropdown
            align="right"
            trigger={
              <button className="button ghost" title="Sort">
                <List /> {sortKey === "name" ? "Name" : sortKey === "size" ? "Size" : "Modified"} {sortDir === 1 ? "↑" : "↓"}
              </button>
            }
            items={
              <>
                {(["name", "size", "date"] as SortKey[]).map((key) => (
                  <button key={key} className="menu-item" onClick={() => (sortKey === key ? setSortDir((d) => (d === 1 ? -1 : 1)) : (setSortKey(key), setSortDir(1)))}>
                    {sortKey === key ? <Check /> : <span style={{ width: 14 }} />} {key === "name" ? "Name" : key === "size" ? "Size" : "Date modified"}
                  </button>
                ))}
              </>
            }
          />
          <div className="row" style={{ gap: 4 }}>
            <button className={`icon-button ${view === "grid" ? "active" : ""}`} onClick={() => toggleView("grid")} title="Grid view">
              <LayoutGrid size={15} />
            </button>
            <button className={`icon-button ${view === "list" ? "active" : ""}`} onClick={() => toggleView("list")} title="List view">
              <List size={15} />
            </button>
          </div>
          <button className="icon-button" onClick={() => void browseQuery.refetch()} title="Refresh listing">
            <RefreshCw size={15} style={browseQuery.isFetching ? { animation: "spin 1s linear infinite" } : undefined} />
          </button>
        </div>
      </div>

      <div className="browser-card">
        {browseQuery.isPending ? (
          <div className="stack" style={{ padding: 18 }}>
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="skeleton" style={{ height: 42, animationDelay: `${i * 80}ms` }} />
            ))}
          </div>
        ) : browseQuery.isError ? (
          <div className="empty-browser">
            <div className="empty-inner">
              <div className="archive-emblem">
                <CircleAlert size={26} />
              </div>
              <h2 className="empty-title">Couldn't load this folder</h2>
              <p className="empty-copy">{browseQuery.error instanceof Error ? browseQuery.error.message : "Unknown error."}</p>
              <button className="button soft" onClick={() => void browseQuery.refetch()}>
                <RotateCcw /> Retry
              </button>
            </div>
          </div>
        ) : isEmpty ? (
          <div className="empty-browser">
            <div className="empty-inner">
              <div className="archive-emblem">
                <FolderOpen size={26} />
              </div>
              <h2 className="empty-title">{filter ? "Nothing matches your filter" : "This folder is empty"}</h2>
              <p className="empty-copy">{filter ? "Try a different filter, or clear it to see everything here." : "Upload files or create folders — everything lands inside your archive item."}</p>
            </div>
          </div>
        ) : view === "grid" ? (
          <div className="file-grid">
            {folders.map((folder) => (
              <div key={folder.prefix} className={`file-card ${selected.has(folder.prefix) ? "sel" : ""}`} onDoubleClick={() => onNavigate(folder.prefix)} onClick={() => onNavigate(folder.prefix)} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onNavigate(folder.prefix)}>
                <span className={`file-check ${selected.has(folder.prefix) ? "on" : ""}`} onClick={(e) => { e.stopPropagation(); toggleSelect(folder.prefix); }}>
                  <Check />
                </span>
                <div className="file-card-top">
                  <span className="kind kind-folder">
                    <Folder />
                  </span>
                </div>
                <span className="file-name">{folder.name}</span>
                <span className="file-meta">
                  {folder.fileCount} file{folder.fileCount === 1 ? "" : "s"} · {fmtBytes(folder.sizeBytes)}
                </span>
              </div>
            ))}
            {files.map((file) => {
              const kind = kindOf(file.mime, file.name);
              const showThumb = kind === "image" && file.size > 0 && file.size <= THUMB_MAX_BYTES;
              return (
                <div key={file.key} className={`file-card ${selected.has(file.key) ? "sel" : ""}`} onClick={() => openFile(file)} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && openFile(file)}>
                  <span className={`file-check ${selected.has(file.key) ? "on" : ""}`} onClick={(e) => { e.stopPropagation(); toggleSelect(file.key); }}>
                    <Check />
                  </span>
                  <div className="file-card-top">
                    {showThumb ? (
                      <img className="file-thumb" src={api.streamUrl(item, file.key)} alt="" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                    ) : (
                      <KindBadge kind={kind} />
                    )}
                    <Dropdown
                      trigger={
                        <button className="icon-button" onClick={(e) => e.stopPropagation()} aria-label="File actions">
                          <EllipsisVertical size={14} />
                        </button>
                      }
                      items={
                        <>
                          <button className="menu-item" onClick={() => openFile(file)}>
                            <FolderOpen /> {PREVIEWABLE.has(kind) ? "Preview" : "Open"}
                          </button>
                          <button className="menu-item" onClick={() => onDownload(file)}>
                            <Download /> Download
                          </button>
                          <button className="menu-item" onClick={() => setRenaming(file)}>
                            <Pencil /> Rename / move
                          </button>
                          <div className="menu-sep" />
                          <button className="menu-item danger" onClick={() => setDeleting({ files: [file], folders: [] })}>
                            <Trash2 /> Delete
                          </button>
                        </>
                      }
                    />
                  </div>
                  <span className="file-name" title={file.name}>
                    {file.name}
                  </span>
                  <span className="file-meta">
                    {fmtBytes(file.size)} · {fmtDate(file.lastModified)}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <table className="file-table">
            <thead>
              <tr>
                <th style={{ width: 34 }}></th>
                <th>Name</th>
                <th style={{ width: 110 }}>Size</th>
                <th style={{ width: 130 }}>Modified</th>
                <th style={{ width: 150 }}></th>
              </tr>
            </thead>
            <tbody>
              {folders.map((folder) => (
                <tr key={folder.prefix} className={`file-row ${selected.has(folder.prefix) ? "sel" : ""}`} onDoubleClick={() => onNavigate(folder.prefix)} onClick={() => onNavigate(folder.prefix)}>
                  <td onClick={(e) => e.stopPropagation()}>
                    <span className={`tick ${selected.has(folder.prefix) ? "on" : ""}`} onClick={() => toggleSelect(folder.prefix)}>
                      <Check />
                    </span>
                  </td>
                  <td className="fname">
                    <span className="kind kind-folder" style={{ width: 28, height: 28 }}>
                      <Folder size={14} />
                    </span>
                    <span>{folder.name}</span>
                  </td>
                  <td className="fmeta">{folder.fileCount} files</td>
                  <td className="fmeta">{fmtDate(folder.lastModified)}</td>
                  <td></td>
                </tr>
              ))}
              {files.map((file) => {
                const kind = kindOf(file.mime, file.name);
                return (
                  <tr key={file.key} className={`file-row ${selected.has(file.key) ? "sel" : ""}`} onClick={() => openFile(file)}>
                    <td onClick={(e) => e.stopPropagation()}>
                      <span className={`tick ${selected.has(file.key) ? "on" : ""}`} onClick={() => toggleSelect(file.key)}>
                        <Check />
                      </span>
                    </td>
                    <td className="fname">
                      <span className={`kind ${KIND_META[kind].cls}`} style={{ width: 28, height: 28 }}>
                        {(() => {
                          const K = KIND_META[kind].Icon;
                          return <K size={14} />;
                        })()}
                      </span>
                      <span title={file.key}>{file.name}</span>
                    </td>
                    <td className="fmeta">{fmtBytes(file.size)}</td>
                    <td className="fmeta">{fmtDate(file.lastModified)}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <span className="row-actions">
                        <button className="icon-button" onClick={() => onDownload(file)} title="Download">
                          <Download size={13} />
                        </button>
                        <button className="icon-button" onClick={() => setRenaming(file)} title="Rename / move">
                          <Pencil size={13} />
                        </button>
                        <button className="icon-button" onClick={() => setDeleting({ files: [file], folders: [] })} title="Delete">
                          <Trash2 size={13} />
                        </button>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {selected.size > 0 ? (
        <div className="selbar">
          <span>{selected.size} selected</span>
          {selectedFiles.length > 0 ? (
            <button className="button soft" onClick={downloadSelected}>
              <Download /> Download
            </button>
          ) : null}
          <button className="button danger" onClick={() => setDeleting({ files: selectedFiles, folders: selectedFolders })}>
            <Trash2 /> Delete
          </button>
          <button className="button ghost" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      ) : null}

      {previewIndex !== null && files[previewIndex] ? (
        <PreviewModal
          item={item}
          files={files}
          index={previewIndex}
          onIndex={setPreviewIndex}
          onClose={() => setPreviewIndex(null)}
          onDownload={onDownload}
        />
      ) : null}

      {renaming ? (
        <PromptDialog
          title="Rename / move"
          label="New name (edit the folder part of the key to move it)"
          initial={renaming.name}
          submitLabel="Save"
          note={`Current location: /${renaming.key.slice(0, renaming.key.length - renaming.name.length) || "root"}`}
          onClose={() => setRenaming(null)}
          onSubmit={doRename}
        />
      ) : null}

      {deleting ? (
        <ConfirmDialog
          title="Delete permanently"
          body={
            <p>
              Permanently delete{" "}
              <strong>
                {deleting.files.length + deleting.folders.length} item{deleting.files.length + deleting.folders.length === 1 ? "" : "s"}
              </strong>
              {deleting.folders.length > 0 ? " (folders are removed recursively)" : ""} from <span className="mono">{item}</span>? This cannot be undone.
            </p>
          }
          confirmLabel="Delete"
          onClose={() => setDeleting(null)}
          onConfirm={doDelete}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Transfers page
// ---------------------------------------------------------------------------

function TransferRow({ transfer }: { transfer: Transfer }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (transfer.state !== "running") return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [transfer.state]);

  const pct = transfer.size > 0 ? Math.min(100, (transfer.loaded / transfer.size) * 100) : transfer.state === "done" ? 100 : 0;
  const elapsed = (now - transfer.startedAt) / 1000;
  const speed = transfer.state === "running" && elapsed > 0.8 ? transfer.loaded / elapsed : null;
  const eta = speed && speed > 1 ? (transfer.size - transfer.loaded) / speed : null;

  const icon =
    transfer.state === "done" ? (
      <span className="t-icon done">
        <Check />
      </span>
    ) : transfer.state === "error" ? (
      <span className="t-icon fail">
        <TriangleAlert />
      </span>
    ) : transfer.direction === "up" ? (
      <span className="t-icon up">
        <ArrowUpFromLine />
      </span>
    ) : (
      <span className="t-icon down">
        <ArrowDownToLine />
      </span>
    );

  return (
    <div className="t-row">
      <div className="t-head">
        {icon}
        <span className="t-name" title={transfer.key}>
          {transfer.name}
        </span>
        <span className={`t-state ${transfer.state}`}>{transfer.state === "running" ? `${Math.floor(pct)}%` : transfer.state}</span>
        <span className="t-actions">
          {transfer.state === "running" ? (
            <button className="icon-button" onClick={transfer.cancel} title="Cancel">
              <X size={13} />
            </button>
          ) : null}
          {transfer.state === "error" && transfer.retry ? (
            <button className="icon-button" onClick={transfer.retry} title="Retry">
              <RotateCcw size={13} />
            </button>
          ) : null}
          {transfer.state !== "running" ? (
            <button className="icon-button" onClick={() => transferStore.remove(transfer.id)} title="Remove">
              <Trash2 size={13} />
            </button>
          ) : null}
        </span>
      </div>
      <div className="progress-track">
        <div
          className={`progress-fill ${transfer.state === "done" ? "done" : ""} ${transfer.state === "error" || transfer.state === "cancelled" ? "error" : ""}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="t-meta">
        <span>
          {fmtBytes(transfer.loaded)} / {fmtBytes(transfer.size)}
          {transfer.direction === "up" ? " uploaded" : " downloaded"}
        </span>
        <span className="mono">{transfer.item}</span>
        {transfer.state === "running" ? (
          <span>
            {speed ? `${fmtBytes(speed)}/s` : "—"} · ETA {fmtEta(eta)}
          </span>
        ) : transfer.state === "error" ? (
          <span style={{ color: "hsl(var(--danger))" }}>{transfer.error}</span>
        ) : transfer.note ? (
          <span>{transfer.note}</span>
        ) : null}
      </div>
    </div>
  );
}

function TransfersPage() {
  const transfers = useTransfers();
  const active = transfers.filter((t) => t.state === "running").length;

  return (
    <>
      <header className="page-heading">
        <div>
          <p className="eyebrow">Transfer center</p>
          <h1 className="page-title">{active > 0 ? `${active} transfer${active === 1 ? "" : "s"} in flight` : "Transfers"}</h1>
          <p className="page-subtitle">Every byte accounted for — uploads and downloads report real progress from the wire.</p>
        </div>
        <div className="actions">
          <button className="button ghost" onClick={() => transferStore.clearFinished()} disabled={transfers.every((t) => t.state === "running")}>
            Clear finished
          </button>
        </div>
      </header>
      {transfers.length === 0 ? (
        <div className="empty-browser">
          <div className="empty-inner">
            <div className="archive-emblem">
              <ArrowUpFromLine size={26} />
            </div>
            <h2 className="empty-title">No transfers yet</h2>
            <p className="empty-copy">Upload or download something from your archive and progress appears here in real time.</p>
          </div>
        </div>
      ) : (
        <section className="t-list">
          {transfers.map((t) => (
            <TransferRow key={t.id} transfer={t} />
          ))}
        </section>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Settings page
// ---------------------------------------------------------------------------

function SettingsPage() {
  const statusQuery = useQuery({ queryKey: ["storage-status"], queryFn: api.storageStatus, staleTime: 30_000 });
  const [testResult, setTestResult] = useState<api.ConnectionTestResult | null>(null);
  const [testing, setTesting] = useState(false);

  const runTest = async () => {
    setTesting(true);
    try {
      setTestResult(await api.testStorageConnection());
    } finally {
      setTesting(false);
    }
  };

  const status = statusQuery.data;

  return (
    <>
      <header className="page-heading">
        <div>
          <p className="eyebrow">Settings</p>
          <h1 className="page-title">Storage configuration</h1>
          <p className="page-subtitle">Connection state, runtime secrets model, and platform constraints.</p>
        </div>
        <div className="actions">
          <button className="button soft" onClick={() => void runTest()} disabled={testing}>
            {testing ? <LoaderCircle size={14} style={{ animation: "spin 1s linear infinite" }} /> : <RefreshCw size={14} />} Test connection
          </button>
        </div>
      </header>

      <div className="info-grid">
        <div className="info-card highlight">
          <h3 className="section-title">Connection</h3>
          <div className="info-detail">
            <div>
              <span className="info-label">Status</span>
              <span className="info-value row">
                <span className={`status-dot ${status?.configured ? "ready" : ""}`} />
                {statusQuery.isPending ? "Checking…" : status?.configured ? "Configured" : "Not configured"}
              </span>
            </div>
            <div>
              <span className="info-label">Endpoint</span>
              <span className="info-value mono">{status?.endpoint ?? "—"}</span>
            </div>
            <div>
              <span className="info-label">Region</span>
              <span className="info-value mono">{status?.region ?? "—"}</span>
            </div>
          </div>
          {testResult ? (
            <div className="connection-result" style={{ marginTop: 12 }}>
              <span className={`status-dot ${testResult.ok ? "ready" : ""}`} />
              <span className="tiny">{testResult.message}</span>
            </div>
          ) : null}
        </div>

        <div className="info-card">
          <h3 className="section-title row">
            <KeyRound size={15} /> Secrets stay server-side
          </h3>
          <p className="tiny muted" style={{ margin: "6px 0 10px" }}>
            Credentials are read by the API server from its runtime environment only — never shipped to the browser, never stored in this repository.
          </p>
          <div className="settings-list">
            {["IAS3_ENDPOINT", "IAS3_ACCESS_KEY", "IAS3_SECRET_KEY", "IAS3_REGION"].map((name) => (
              <div className="setting-row" key={name}>
                <span className="setting-label mono">{name}</span>
                <span className="setting-help tiny">{name === "IAS3_ENDPOINT" ? "S3 endpoint (default s3.us.archive.org)" : name === "IAS3_REGION" ? "Presigning region (default us-east-1)" : "Set via Replit Secrets / env"}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="info-card highlight">
          <h3 className="section-title row">
            <Info size={15} /> Internet Archive platform notes
          </h3>
          <ul className="tiny muted" style={{ margin: "8px 0 0", paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6, lineHeight: 1.5 }}>
            <li>Listings are <strong>eventually consistent</strong> — fresh uploads can take a few seconds to appear; the app auto-refreshes after transfers.</li>
            <li>IA's S3 ignores HTTP Range requests, so media <strong>streams progressively</strong>; seeking restarts the stream. Playback from the start works while downloading.</li>
            <li>Items are IAS3 "buckets" on a <strong>global namespace</strong> — names must be unique across all of archive.org.</li>
            <li>Folder listings are grouped server-side (IA ignores the S3 delimiter), capped at 8,000 keys per listing.</li>
          </ul>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Discover dialog — mount any public archive.org item as a drive
// ---------------------------------------------------------------------------

function DiscoverDialog({ onMount, onClose }: { onMount: (identifier: string) => void; onClose: () => void }) {
  const [term, setTerm] = useState("");
  const [submitted, setSubmitted] = useState("");
  const discoverQuery = useQuery({
    queryKey: ["discover", submitted],
    queryFn: () => api.discoverItems(submitted, 24),
    enabled: submitted.length >= 2,
  });

  return (
    <Modal title="Add a public archive.org item" onClose={onClose}>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (term.trim().length >= 2) setSubmitted(term.trim());
        }}
      >
        <input className="search-box grow" style={{ height: 38 }} placeholder='Try "meditation audio" or an exact identifier…' value={term} onChange={(e) => setTerm(e.target.value)} />
        <button className="button primary" type="submit">
          <Search /> Search
        </button>
      </form>
      <p className="tiny-note muted tiny" style={{ marginTop: 8 }}>
        Public items are read-only here unless your IAS3 credentials own them. Mounting just pins the item to your sidebar.
      </p>
      <div className="stack" style={{ marginTop: 12, maxHeight: "46vh", overflow: "auto" }}>
        {discoverQuery.isPending ? (
          <Spinner label="Searching archive.org…" />
        ) : discoverQuery.isError ? (
          <p className="notice-inline">
            <CircleAlert /> {discoverQuery.error instanceof Error ? discoverQuery.error.message : "Search failed."}
          </p>
        ) : (
          (discoverQuery.data?.items ?? []).map((doc) => (
            <div key={doc.identifier} className="section-row" style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span className="kind kind-doc">
                <Globe />
              </span>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="tiny" style={{ fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {doc.title ?? doc.identifier}
                </div>
                <div className="tiny muted mono" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {doc.identifier} · {doc.mediatype ?? "item"} {doc.itemSize ? `· ${fmtBytes(doc.itemSize)}` : ""}
                </div>
              </div>
              <button className="button soft" onClick={() => onMount(doc.identifier)}>
                <Plus /> Mount
              </button>
            </div>
          ))
        )}
        {submitted && discoverQuery.data?.items.length === 0 ? <p className="tiny muted">Nothing found for “{submitted}”.</p> : null}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Workspace shell
// ---------------------------------------------------------------------------

type Section = "browse" | "transfers" | "settings";

function sectionForPath(path: string): Section {
  if (path.startsWith("/transfers")) return "transfers";
  if (path.startsWith("/settings")) return "settings";
  return "browse";
}

const PINNED_KEY = "archvault.pinnedDrives";
const LAST_ITEM_KEY = "archvault.lastItem";

function loadPinned(): string[] {
  try {
    const raw = localStorage.getItem(PINNED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function Workspace() {
  const qc = useQueryClient();
  const [location] = useLocation();
  const section = sectionForPath(location);

  const [item, setItem] = useState<string>(() => localStorage.getItem(LAST_ITEM_KEY) ?? "");
  const [prefix, setPrefix] = useState("");
  const [filter, setFilter] = useState("");
  const [pinned, setPinned] = useState<string[]>(loadPinned);
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newItemOpen, setNewItemOpen] = useState(false);

  const itemsQuery = useQuery({ queryKey: ["items"], queryFn: api.listItems, staleTime: 60_000 });

  const drives = useMemo(() => {
    const names = new Set<string>();
    for (const entry of itemsQuery.data?.items ?? []) names.add(entry.name);
    for (const p of pinned) names.add(p);
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [itemsQuery.data, pinned]);

  // Pick the first drive once known.
  useEffect(() => {
    if (item === "" && drives.length > 0) {
      setItem(drives[0] ?? "");
    }
  }, [drives, item]);

  useEffect(() => {
    if (item) localStorage.setItem(LAST_ITEM_KEY, item);
  }, [item]);

  const selectDrive = (name: string) => {
    setItem(name);
    setPrefix("");
    setFilter("");
  };

  const mountPinned = (name: string) => {
    const next = Array.from(new Set([...pinned, name]));
    setPinned(next);
    localStorage.setItem(PINNED_KEY, JSON.stringify(next));
    setDiscoverOpen(false);
    selectDrive(name);
    toast({ title: "Item mounted", description: name });
  };

  const unpin = (name: string) => {
    const next = pinned.filter((p) => p !== name);
    setPinned(next);
    localStorage.setItem(PINNED_KEY, JSON.stringify(next));
    if (item === name) setItem(drives.find((d) => d !== name) ?? "");
  };

  const itemRef = useRef(item);
  itemRef.current = item;
  const onDownload = useCallback(
    (file: api.FileEntry) => {
      startDownload(qc, itemRef.current, file);
    },
    [qc],
  );

  const enqueueUploads = useCallback(
    (jobs: Array<{ key: string; file: File }>) => {
      for (const job of jobs) startUpload(qc, itemRef.current, job.key, job.file);
      if (jobs.length > 0) toast({ title: `Uploading ${jobs.length} file${jobs.length === 1 ? "" : "s"}`, description: "Progress lives in the transfer center." });
    },
    [qc],
  );

  const pickFiles = (directory: boolean) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    if (directory) {
      (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
    }
    input.onchange = () => {
      const files = Array.from(input.files ?? []);
      enqueueUploads(
        files.map((file) => {
          const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
          const clean = rel.replace(/\\/g, "/").replace(/^\/+/, "");
          return { key: `${prefix}${clean}`, file };
        }),
      );
    };
    input.click();
  };

  const createFolder = async (name: string) => {
    const clean = name.replace(/^\/+|\/+$/g, "");
    if (!clean) return;
    await api.createFolder(item, `${prefix}${clean}/`);
    toast({ title: "Folder created", description: `${prefix}${clean}/` });
    scheduleListingRefetch(qc);
  };

  const createDrive = async (name: string) => {
    await api.createItem(name);
    toast({ title: "Item created", description: name });
    scheduleListingRefetch(qc);
    selectDrive(name);
  };

  const transfers = useTransfers();
  const runningCount = transfers.filter((t) => t.state === "running").length;

  const nav = [
    { key: "browse" as Section, href: "/", label: "My Vault", icon: Archive },
    { key: "transfers" as Section, href: "/transfers", label: `Transfer center${runningCount > 0 ? ` (${runningCount})` : ""}`, icon: ArrowUpFromLine },
    { key: "settings" as Section, href: "/settings", label: "Settings", icon: Settings2 },
  ];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Cloud size={16} />
          </span>
          <div>
            <span className="brand-name">ArchVault</span>
            <span className="brand-caption">Internet Archive Drive</span>
          </div>
        </div>

        <p className="nav-label">Workspace</p>
        <nav className="nav-list">
          {nav.map((entry) => (
            <Link key={entry.key} href={entry.href} className={`nav-item ${section === entry.key ? "active" : ""}`}>
              <entry.icon className="nav-icon" />
              <span>{entry.label}</span>
            </Link>
          ))}
        </nav>

        <p className="nav-label" style={{ marginTop: 18 }}>
          Drives
        </p>
        <div className="drive-list">
          {drives.map((name) => (
            <div key={name} style={{ position: "relative" }}>
              <button className={`drive ${item === name ? "active" : ""}`} onClick={() => selectDrive(name)} title={name}>
                <Database size={15} />
                <span className="drive-name">{name}</span>
                {pinned.includes(name) && !(itemsQuery.data?.items ?? []).some((s) => s.name === name) ? (
                  <span
                    className="drive-extra"
                    role="button"
                    title="Unpin"
                    onClick={(e) => {
                      e.stopPropagation();
                      unpin(name);
                    }}
                  >
                    ×
                  </span>
                ) : null}
              </button>
            </div>
          ))}
          {itemsQuery.isPending ? <Spinner label="Loading drives…" /> : null}
          {itemsQuery.isError ? (
            <p className="tiny muted" style={{ padding: "0 10px" }}>
              Drive list unavailable — check Settings → connection.
            </p>
          ) : null}
        </div>
        <button className="text-button" style={{ margin: "8px 12px 0", textAlign: "left" }} onClick={() => setDiscoverOpen(true)}>
          + Add public archive item
        </button>

        <div className="sidebar-footer">
          <div className="connection-card">
            <div className="connection-status">
              <span className="status-dot ready" /> Connected storage
            </div>
            <p className="connection-copy">IAS3 · Internet Archive — credentials live on the server only.</p>
          </div>
        </div>
      </aside>

      <main className="main-area">
        <div className="topbar">
          <div className="topbar-context">
            <span className="pill mono">{item || "no drive"}</span>
            {prefix ? <span className="mono tiny muted">/{prefix}</span> : null}
          </div>
          <div className="topbar-actions">
            {section === "browse" ? (
              <label className="search-box">
                <Search size={13} className="muted" />
                <input placeholder="Filter this folder…" value={filter} onChange={(e) => setFilter(e.target.value)} />
                {filter ? (
                  <button className="icon-button" style={{ width: 22, height: 22 }} onClick={() => setFilter("")} aria-label="Clear filter">
                    <X size={11} />
                  </button>
                ) : null}
              </label>
            ) : null}
            <Dropdown
              trigger={
                <button className="button primary">
                  <Plus /> New
                </button>
              }
              items={
                <>
                  <button className="menu-item" onClick={() => pickFiles(false)} disabled={!item}>
                    <Upload /> Upload files
                  </button>
                  <button className="menu-item" onClick={() => pickFiles(true)} disabled={!item}>
                    <FolderOpen /> Upload folder
                  </button>
                  <div className="menu-sep" />
                  <button className="menu-item" onClick={() => setNewFolderOpen(true)} disabled={!item}>
                    <FolderPlus /> New folder
                  </button>
                  <button className="menu-item" onClick={() => setNewItemOpen(true)}>
                    <Database /> New archive item
                  </button>
                  <button className="menu-item" onClick={() => setDiscoverOpen(true)}>
                    <Globe /> Add public item…
                  </button>
                </>
              }
            />
          </div>
        </div>

        <div className="content">
          <Switch>
            <Route path="/">
              {section === "browse" && item ? (
                <>
                  <header className="page-heading">
                    <div>
                      <p className="eyebrow">My Vault</p>
                      <h1 className="page-title">{item}</h1>
                      <p className="page-subtitle">Stream, preview, open, upload and organize — straight from your archive item.</p>
                    </div>
                  </header>
                  <BrowsePage
                    item={item}
                    prefix={prefix}
                    onNavigate={(next) => {
                      setPrefix(next);
                      setFilter("");
                    }}
                    filter={filter}
                    onUploadPaths={enqueueUploads}
                    onDownload={onDownload}
                  />
                </>
              ) : (
                <div className="empty-browser">
                  <div className="empty-inner">
                    <div className="archive-emblem">
                      <HardDrive size={26} />
                    </div>
                    <h2 className="empty-title">No drives yet</h2>
                    <p className="empty-copy">Create an archive item or mount a public one to start storing.</p>
                    <div className="row">
                      <button className="button primary" onClick={() => setNewItemOpen(true)}>
                        <Database /> New archive item
                      </button>
                      <button className="button ghost" onClick={() => setDiscoverOpen(true)}>
                        <Globe /> Add public item
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </Route>
            <Route path="/transfers">
              <TransfersPage />
            </Route>
            <Route path="/settings">
              <SettingsPage />
            </Route>
            <Route>
              <NotFound />
            </Route>
          </Switch>
        </div>
      </main>

      {discoverOpen ? <DiscoverDialog onClose={() => setDiscoverOpen(false)} onMount={mountPinned} /> : null}
      {newFolderOpen ? (
        <PromptDialog
          title="New folder"
          label="Folder name (use / for nested folders)"
          initial=""
          submitLabel="Create"
          note={`Will be created in: /${prefix || "root"}`}
          onClose={() => setNewFolderOpen(false)}
          onSubmit={createFolder}
        />
      ) : null}
      {newItemOpen ? (
        <PromptDialog
          title="New archive item"
          label="Item identifier — 3-83 chars; letters, numbers, dot, dash, underscore"
          initial="archvault-"
          submitLabel="Create item"
          note="Item names are global across archive.org. Something unique like archvault-media-2026 works best. New items are private until you publish metadata on archive.org."
          onClose={() => setNewItemOpen(false)}
          onSubmit={createDrive}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connection gate + root
// ---------------------------------------------------------------------------

function ConnectionGate({ children }: { children: ReactNode }) {
  const statusQuery = useQuery({
    queryKey: ["storage-status"],
    queryFn: api.storageStatus,
    refetchInterval: 30_000,
    retry: 1,
  });

  if (statusQuery.isPending) {
    return (
      <div className="status-page">
        <div className="archive-emblem">
          <Cloud size={26} />
        </div>
        <h1 className="empty-title">Opening your vault…</h1>
        <Spinner label="Contacting storage API" />
      </div>
    );
  }

  const status = statusQuery.data;
  if (statusQuery.isError || !status?.configured) {
    return (
      <div className="status-page">
        <div className="archive-emblem">
          <TriangleAlert size={26} />
        </div>
        <h1 className="empty-title">Storage is not configured</h1>
        <p className="empty-copy" style={{ maxWidth: 480 }}>
          ArchVault needs IAS3 credentials in the API server's environment. Add the secrets below, restart the API, and this page unlocks automatically
          — credentials are never asked for in the browser.
        </p>
        <div className="panel" style={{ textAlign: "left", width: "min(520px, 92vw)" }}>
          <div className="panel-head">
            <span className="panel-title">Required environment secrets</span>
            <span className="section-meta">server only</span>
          </div>
          <p className="panel-copy mono tiny" style={{ lineHeight: 1.9 }}>
            IAS3_ENDPOINT = https://s3.us.archive.org
            <br />
            IAS3_ACCESS_KEY = &lt;your IA S3 access key&gt;
            <br />
            IAS3_SECRET_KEY = &lt;your IA S3 secret key&gt;
            <br />
            IAS3_REGION = us-east-1 <span className="muted">(optional)</span>
          </p>
          <p className="tiny-note muted tiny" style={{ marginTop: 10 }}>
            On Replit: Tools → Secrets. Keys come from archive.org → Account → S3 keys. Status:{" "}
            {statusQuery.isError ? "API unreachable" : "credentials missing"}.
          </p>
        </div>
        <button className="button soft" onClick={() => void statusQuery.refetch()}>
          <RotateCcw /> Check again
        </button>
      </div>
    );
  }

  return <>{children}</>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        {/* Micro keyframes for inline spinner animation (avoids touching the shared stylesheet). */}
        <style>{"@keyframes spin { to { transform: rotate(360deg); } }"}</style>
        <ConnectionGate>
          <Workspace />
        </ConnectionGate>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
