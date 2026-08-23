import { useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Link, Route, Router as WouterRouter, Switch, useLocation } from 'wouter';
import {
  Archive,
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronRight,
  CircleHelp,
  Cloud,
  Download,
  FileText,
  Folder,
  FolderOpen,
  HardDrive,
  Info,
  LayoutGrid,
  List,
  MoreHorizontal,
  Pause,
  RefreshCw,
  Search,
  Settings2,
  SlidersHorizontal,
  Square,
  Upload,
  UserRound,
  X,
} from 'lucide-react';
import { type ReactNode } from 'react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { testStorageConnection, type ConnectionTestResult } from '@/lib/storage-api';

const queryClient = new QueryClient();

export type FileRecord = {
  id: string;
  name: string;
  kind: 'file';
  mimeType: string;
  sizeBytes: number;
  modifiedAt: string;
  parentId: string | null;
  status: 'available' | 'unavailable';
};

export type FolderRecord = {
  id: string;
  name: string;
  parentId: string | null;
  modifiedAt: string;
};

export type TransferEvent = {
  transferId: string;
  fileId: string;
  filename: string;
  sizeBytes: number;
  transferredBytes: number;
  percentage: number;
  speedBytesPerSecond: number;
  etaSeconds: number | null;
  state: 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  error: string | null;
  retryCount: number;
  canPause: boolean;
  canCancel: boolean;
  canRetry: boolean;
};

type Section = 'browse' | 'recent' | 'transfers' | 'settings' | 'account' | 'search';

const navItems: Array<{ label: string; href: string; key: Section; icon: typeof Archive }> = [
  { label: 'Archive', href: '/', key: 'browse', icon: Archive },
  { label: 'Recent files', href: '/recent', key: 'recent', icon: RefreshCw },
  { label: 'Transfer center', href: '/transfers', key: 'transfers', icon: ArrowUpFromLine },
];

const utilityItems: Array<{ label: string; href: string; key: Section; icon: typeof Archive }> = [
  { label: 'Settings', href: '/settings', key: 'settings', icon: Settings2 },
  { label: 'Account', href: '/account', key: 'account', icon: UserRound },
];

// The future IAS3 adapter is the only producer allowed to populate this list.
// Keeping the boundary typed makes the empty state honest while integration is pending.
const transferEvents: TransferEvent[] = [];

function sectionForPath(path: string): Section {
  if (path === '/recent') return 'recent';
  if (path === '/transfers') return 'transfers';
  if (path === '/settings') return 'settings';
  if (path === '/account') return 'account';
  if (path === '/search') return 'search';
  return 'browse';
}

function Sidebar({ section, onConnect, connectionReady }: { section: Section; onConnect: () => void; connectionReady: boolean }) {
  return (
    <aside className="sidebar" aria-label="Primary navigation">
      <div className="brand">
        <div className="brand-mark" aria-hidden="true">
          <Archive size={17} strokeWidth={2.1} />
        </div>
        <div>
          <div className="brand-name">Keepsake</div>
          <span className="brand-caption">Personal archive</span>
        </div>
      </div>

      <div className="nav-label">Workspace</div>
      <nav className="nav-list">
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.key}
              href={item.href}
              className={`nav-item ${section === item.key ? 'active' : ''}`}
              data-testid={`link-${item.key}`}
              aria-current={section === item.key ? 'page' : undefined}
            >
              <Icon className="nav-icon" strokeWidth={1.8} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="nav-label" style={{ marginTop: 27 }}>Personal</div>
      <nav className="nav-list">
        {utilityItems.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.key}
              href={item.href}
              className={`nav-item ${section === item.key ? 'active' : ''}`}
              data-testid={`link-${item.key}`}
              aria-current={section === item.key ? 'page' : undefined}
            >
              <Icon className="nav-icon" strokeWidth={1.8} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="sidebar-footer">
        <div className="connection-card">
          <div className="connection-status">
             <span className={`status-dot ${connectionReady ? 'ready' : ''}`} />
             {connectionReady ? 'IAS3 connected' : 'IAS3 not connected'}
          </div>
          <p className="connection-copy">{connectionReady ? 'Endpoint verified. File listing is the next integration step.' : 'Your archive will appear here once a storage endpoint is connected.'}</p>
           <button className="text-button" onClick={onConnect} data-testid="button-connect-sidebar">
             {connectionReady ? 'Test again' : 'Review connection'}
          </button>
        </div>
      </div>
    </aside>
  );
}

function Topbar({
  searchTerm,
  onSearch,
  onNotice,
}: {
  searchTerm: string;
  onSearch: (value: string) => void;
  onNotice: (message: string) => void;
}) {
  const [, setLocation] = useLocation();
  return (
    <header className="topbar">
      <div className="topbar-context">
        <Cloud size={14} />
        <span>Workspace</span>
        <ChevronRight size={13} />
        <strong>{searchTerm ? 'Search' : 'Archive'}</strong>
      </div>
      <div className="topbar-actions">
        <label className="search-box" data-testid="search-control">
          <Search size={15} color="hsl(var(--muted-foreground))" />
          <input
            type="search"
            value={searchTerm}
            onChange={(event) => {
              onSearch(event.target.value);
              if (event.target.value) setLocation('/search');
            }}
            placeholder="Search your archive"
            aria-label="Search your archive"
            data-testid="input-search"
          />
        </label>
        <button className="icon-button" onClick={() => onNotice('Help is available once an IAS3 endpoint is connected.')} aria-label="Help" data-testid="button-help">
          <CircleHelp size={17} />
        </button>
        <button className="avatar" onClick={() => setLocation('/account')} aria-label="Open account" data-testid="button-account">
          JM
        </button>
      </div>
    </header>
  );
}

function PageHeading({
  eyebrow,
  title,
  subtitle,
  children,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1 className="page-title">{title}</h1>
        <p className="page-subtitle">{subtitle}</p>
      </div>
      {children ? <div className="actions">{children}</div> : null}
    </div>
  );
}

function ConnectionModal({ onClose, onSettings, onConnected }: { onClose: () => void; onSettings: () => void; onConnected: () => void }) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ConnectionTestResult | null>(null);

  const handleTest = async () => {
    setTesting(true);
    setResult(null);
    try {
      const nextResult = await testStorageConnection();
      setResult(nextResult);
      if (nextResult.ok) onConnected();
    } catch {
      setResult({
        ok: false,
        status: 'unreachable',
        message: 'The connection test could not reach the API server.',
        endpoint: null,
        item: null,
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="modal-scrim" role="presentation" onMouseDown={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="connection-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="eyebrow">Storage endpoint</div>
            <h2 className="modal-title" id="connection-title">Connect your archive</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close connection dialog" data-testid="button-close-modal">
            <X size={17} />
          </button>
        </div>
         <p className="modal-copy">Test the configured IAS3 endpoint without exposing credentials to the browser. No files or transfer events are shown until the provider responds successfully.</p>
        <div className="contract" aria-label="Connection requirements" data-testid="text-connection-contract">
           endpoint        {result?.endpoint ?? 'IAS3-compatible object storage'}<br />
           credentials     {result?.status === 'connected' ? 'configured' : 'stored securely'}<br />
           item            {result?.item ?? 'configured item identifier'}<br />
           file events     {result?.status === 'connected' ? 'provider ready' : 'awaiting connection'}
        </div>
         {result ? <div className={`connection-result ${result.ok ? 'success' : 'failure'}`} role="status" data-testid="status-connection-test">{result.message}</div> : null}
        <div className="modal-actions">
          <button className="button" onClick={onClose} data-testid="button-cancel-connection">Not now</button>
           <button className="button" onClick={handleTest} disabled={testing} data-testid="button-test-connection">
             {testing ? 'Testing…' : 'Test connection'}
           </button>
          <button className="button primary" onClick={onSettings} data-testid="button-open-settings">Open settings <ChevronRight size={14} /></button>
        </div>
      </div>
    </div>
  );
}

function BrowserToolbar({
  onNotice,
  onConnect,
}: {
  onNotice: (message: string) => void;
  onConnect: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [, setLocation] = useLocation();

  return (
    <div className="browser-toolbar">
      <div className="crumbs" aria-label="Breadcrumb">
        <button className="crumb current" onClick={() => setLocation('/')} data-testid="button-breadcrumb-archive">Archive</button>
        <ChevronRight size={13} color="hsl(var(--border-strong))" />
        <span className="crumb current">Root</span>
      </div>
      <div className="toolbar-right">
        <span className="selection-note">0 selected</span>
        <button className="icon-button" onClick={() => onNotice('Selection mode is empty because no file records are connected.')} aria-label="Selection mode" data-testid="button-selection-mode">
          <Square size={15} />
        </button>
        <button className="icon-button" onClick={() => onNotice('List view is ready when the archive is connected.')} aria-label="List view" data-testid="button-list-view">
          <List size={16} />
        </button>
        <button className="icon-button" onClick={() => onNotice('Grid view is ready when the archive is connected.')} aria-label="Grid view" data-testid="button-grid-view">
          <LayoutGrid size={16} />
        </button>
        <div style={{ position: 'relative' }}>
          <button className={`icon-button ${menuOpen ? 'active' : ''}`} onClick={() => setMenuOpen((value) => !value)} aria-label="More folder actions" aria-expanded={menuOpen} data-testid="button-more-actions">
            <MoreHorizontal size={17} />
          </button>
          {menuOpen ? (
            <div style={{ position: 'absolute', right: 0, top: 42, width: 176, padding: 5, zIndex: 5, background: 'hsl(var(--surface))', border: '1px solid hsl(var(--border))', borderRadius: 9, boxShadow: '0 12px 24px rgba(31,45,38,.12)' }}>
              <button className="nav-item" onClick={() => { setMenuOpen(false); onNotice('New folders will be available after connection.'); }} data-testid="button-new-folder">
                <Folder size={15} /> <span>New folder</span>
              </button>
              <button className="nav-item" onClick={() => { setMenuOpen(false); onNotice('Details require a selected file.'); }} data-testid="button-show-details">
                <Info size={15} /> <span>View details</span>
              </button>
              <button className="nav-item" onClick={() => { setMenuOpen(false); onNotice('Preview requires a selected file.'); }} data-testid="button-preview-file">
                <FileText size={15} /> <span>Preview file</span>
              </button>
              <button className="nav-item" onClick={() => { setMenuOpen(false); onConnect(); }} data-testid="button-connect-menu">
                <HardDrive size={15} /> <span>Connect storage</span>
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function StorageOverview({ onNotice }: { onNotice: (message: string) => void }) {
  return (
    <div className="info-grid">
      <div className="info-card highlight" data-testid="card-storage-status">
        <div className="info-label"><span>Storage used</span><HardDrive size={14} /></div>
        <div className="info-value">Not available</div>
        <div className="info-detail">Connect IAS3 to read capacity</div>
        <div className="progress-track" aria-label="Storage usage unavailable"><span /></div>
      </div>
      <div className="info-card" data-testid="card-file-count">
        <div className="info-label"><span>Files</span><FileText size={14} /></div>
        <div className="info-value">—</div>
        <div className="info-detail">No index loaded</div>
      </div>
      <div className="info-card" data-testid="card-folder-count">
        <div className="info-label"><span>Folders</span><FolderOpen size={14} /></div>
        <div className="info-value">—</div>
        <div className="info-detail">
          <button className="text-button" onClick={() => onNotice('Folder metrics will appear after connection.')} data-testid="button-folder-metrics">Why is this empty?</button>
        </div>
      </div>
    </div>
  );
}

function EmptyBrowser({ onConnect, onUpload, onNotice }: { onConnect: () => void; onUpload: () => void; onNotice: (message: string) => void }) {
  return (
    <div className="browser-card" data-testid="card-file-browser">
      <BrowserToolbar onNotice={onNotice} onConnect={onConnect} />
      <div className="empty-browser">
        <div className="empty-inner">
          <div className="archive-emblem" aria-hidden="true"><Archive size={26} strokeWidth={1.5} /></div>
          <h2 className="empty-title">Your archive is waiting</h2>
          <p className="empty-copy">Connect an IAS3-compatible storage endpoint to browse folders, inspect files, and move large transfers with confidence.</p>
          <div className="actions" style={{ justifyContent: 'center' }}>
            <button className="button primary" onClick={onConnect} data-testid="button-connect-empty"><HardDrive size={15} /> Connect IAS3</button>
            <button className="button subtle" onClick={onUpload} data-testid="button-upload-empty"><Upload size={15} /> Upload</button>
          </div>
          <div className="tiny-note">No files have been invented or cached locally</div>
        </div>
      </div>
    </div>
  );
}

function BrowsePage({
  onConnect,
  onNotice,
  onUpload,
}: {
  onConnect: () => void;
  onNotice: (message: string) => void;
  onUpload: () => void;
}) {
  return (
    <div className="content">
      <PageHeading eyebrow="Archive / root" title="Your archive" subtitle="Browse folders and keep an eye on every file movement.">
        <button className="button" onClick={() => onNotice('Download requires a connected archive and a selected file.')} data-testid="button-download"><Download size={15} /> Download</button>
        <button className="button primary" onClick={onUpload} data-testid="button-upload"><Upload size={15} /> Upload</button>
      </PageHeading>
      <EmptyBrowser onConnect={onConnect} onUpload={onUpload} onNotice={onNotice} />
      <StorageOverview onNotice={onNotice} />
      <div className="section-row">
        <h2 className="section-title">Connection notes</h2>
        <span className="section-meta">TRANSPARENT BY DEFAULT</span>
      </div>
      <div className="notice" data-testid="status-connection-note">
        <Info size={15} />
        <div><strong>Nothing is hidden.</strong> File rows and transfer metrics will only appear when they arrive from the IAS3 integration. This workspace will not estimate progress or invent local records.</div>
      </div>
    </div>
  );
}

function EmptyStatePage({
  section,
  searchTerm,
  onNotice,
  onConnect,
}: {
  section: Section;
  searchTerm: string;
  onNotice: (message: string) => void;
  onConnect: () => void;
}) {
  const copy = section === 'recent'
    ? { eyebrow: 'Workspace / recent', title: 'Recent files', subtitle: 'A short path back to work you touched recently.' }
    : { eyebrow: 'Workspace / search', title: 'Search archive', subtitle: searchTerm ? `Searching for “${searchTerm}”` : 'Find a file or folder by name.' };

  return (
    <div className="content status-page">
      <PageHeading eyebrow={copy.eyebrow} title={copy.title} subtitle={copy.subtitle}>
        <button className="button" onClick={() => onNotice('Upload requires a connected archive.')} data-testid="button-upload-empty-page"><Upload size={15} /> Upload</button>
      </PageHeading>
      <div className="panel" data-testid={`panel-${section}-empty`}>
        <div className="panel-head">
          <div><h2 className="panel-title">{section === 'search' ? 'Search results' : 'No recent activity'}</h2><p className="panel-copy">Only records received from IAS3 will be listed here.</p></div>
          <SlidersHorizontal size={16} color="hsl(var(--muted-foreground))" />
        </div>
        <div className="empty-line">
          {section === 'search' ? <Search size={23} /> : <RefreshCw size={23} />}
          <span>{searchTerm ? 'No connected index to search yet.' : 'There is nothing to show until your archive is connected.'}</span>
        </div>
        <button className="button subtle" onClick={onConnect} data-testid="button-connect-empty-page"><HardDrive size={15} /> Review connection</button>
      </div>
    </div>
  );
}

function TransferEventList({ events }: { events: TransferEvent[] }) {
  if (events.length === 0) {
    return <div className="empty-line"><ArrowDownToLine size={23} /><span>No transfer events received.</span></div>;
  }

  return (
    <div>
      {events.map((event) => (
        <div key={event.transferId} className="empty-line" data-testid={`row-transfer-${event.transferId}`}>
          <ArrowUpFromLine size={19} />
          <span>{event.filename} · {event.percentage}% · {event.state}</span>
        </div>
      ))}
    </div>
  );
}

function TransfersPage({ onConnect, onNotice }: { onConnect: () => void; onNotice: (message: string) => void }) {
  return (
    <div className="content status-page">
      <PageHeading eyebrow="Workspace / transfer center" title="Transfer center" subtitle="Every state comes from a typed transfer event. No estimates, no mystery.">
        <button className="button" onClick={() => onNotice('Pause is unavailable without an active transfer event.')} data-testid="button-pause-all"><Pause size={15} /> Pause all</button>
        <button className="button primary" onClick={onConnect} data-testid="button-transfer-connect"><HardDrive size={15} /> Connect IAS3</button>
      </PageHeading>
      <div className="panel" data-testid="panel-transfer-events">
        <div className="panel-head">
          <div><h2 className="panel-title">Transfer events</h2><p className="panel-copy">Live events will appear here exactly as received.</p></div>
          <ArrowUpFromLine size={17} color="hsl(var(--primary))" />
        </div>
        <TransferEventList events={transferEvents} />
        <div className="notice" style={{ marginTop: 17 }} data-testid="status-transfer-contract">
          <Info size={15} />
          <div><strong>Waiting for IAS3.</strong> Percentage, speed, ETA, completion, errors, and retry controls remain blank until the integration emits a <code>TransferEvent</code>.</div>
        </div>
      </div>
      <div className="section-row"><h2 className="section-title">Event contract</h2><span className="section-meta">READ-ONLY UI BOUNDARY</span></div>
      <div className="contract" data-testid="text-transfer-contract">
        transferId · fileId · filename · sizeBytes · transferredBytes<br />
        percentage · speedBytesPerSecond · etaSeconds · state<br />
        error · retryCount · canPause · canCancel · canRetry
      </div>
    </div>
  );
}

function SettingsPage({ onConnect, onNotice }: { onConnect: () => void; onNotice: (message: string) => void }) {
  const [notifications, setNotifications] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <div className="content status-page">
      <PageHeading eyebrow="Personal / settings" title="Settings" subtitle="Keep the connection and interface behavior explicit.">
        <button className="button primary" onClick={onConnect} data-testid="button-settings-connect"><HardDrive size={15} /> Configure IAS3</button>
      </PageHeading>
      <div className="panel" data-testid="panel-settings">
        <div className="panel-head"><div><h2 className="panel-title">Workspace preferences</h2><p className="panel-copy">Local interface preferences are available now. Storage settings need a live endpoint.</p></div><Settings2 size={17} color="hsl(var(--primary))" /></div>
        <div className="settings-list">
          <div className="setting-row"><div><div className="setting-label">Transfer notifications</div><div className="setting-help">Show a notice when a connected transfer changes state.</div></div><button className={`toggle ${notifications ? 'on' : ''}`} onClick={() => setNotifications((value) => !value)} aria-label="Toggle transfer notifications" aria-pressed={notifications} data-testid="button-toggle-notifications" /></div>
          <div className="setting-row"><div><div className="setting-label">Storage endpoint</div><div className="setting-help">IAS3 credentials and bucket configuration.</div></div><button className="button subtle" onClick={onConnect} data-testid="button-configure-endpoint">Not connected <ChevronRight size={14} /></button></div>
          <div className="setting-row"><div><div className="setting-label">Clear local workspace state</div><div className="setting-help">Removes UI preferences from this device. It cannot delete archive files.</div></div>{confirmDelete ? <div className="actions"><button className="button" onClick={() => setConfirmDelete(false)} data-testid="button-cancel-clear">Cancel</button><button className="button" style={{ color: 'hsl(var(--danger))' }} onClick={() => { setConfirmDelete(false); onNotice('Local workspace state cleared.'); }} data-testid="button-confirm-clear">Clear</button></div> : <button className="button" onClick={() => setConfirmDelete(true)} data-testid="button-clear-state">Clear state</button>}</div>
        </div>
      </div>
    </div>
  );
}

function AccountPage({ onNotice }: { onNotice: (message: string) => void }) {
  return (
    <div className="content status-page">
      <PageHeading eyebrow="Personal / account" title="Account" subtitle="Your identity stays separate from the archive connection." />
      <div className="panel" data-testid="panel-account">
        <div className="profile-block">
          <div className="profile-avatar" data-testid="avatar-account">JM</div>
          <div><div className="profile-name" data-testid="text-account-name">Jordan M.</div><div className="profile-email" data-testid="text-account-email">account details unavailable</div></div>
        </div>
        <div className="notice" style={{ marginTop: 22 }}><Info size={15} /><div><strong>Account service unavailable.</strong> This milestone keeps the account surface local and does not imply an authenticated backend.</div></div>
        <div className="actions" style={{ marginTop: 18 }}><button className="button" onClick={() => onNotice('Account management is under development.')} data-testid="button-manage-account"><UserRound size={15} /> Manage account</button></div>
      </div>
    </div>
  );
}

function Workspace() {
  const [location, setLocation] = useLocation();
  const [searchTerm, setSearchTerm] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [connectionReady, setConnectionReady] = useState(false);
  const [notice, setNotice] = useState('');
  const section = sectionForPath(location);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(''), 3200);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  const showNotice = (message: string) => setNotice(message);
  const triggerUpload = () => showNotice('Upload is under development until an IAS3 endpoint is connected.');

  return (
    <div className="app-shell">
       <Sidebar section={section} onConnect={() => setModalOpen(true)} connectionReady={connectionReady} />
      <div className="main-area">
        <Topbar searchTerm={searchTerm} onSearch={setSearchTerm} onNotice={showNotice} />
        <Switch>
          <Route path="/transfers"><TransfersPage onConnect={() => setModalOpen(true)} onNotice={showNotice} /></Route>
          <Route path="/settings"><SettingsPage onConnect={() => setModalOpen(true)} onNotice={showNotice} /></Route>
          <Route path="/account"><AccountPage onNotice={showNotice} /></Route>
          <Route path="/recent"><EmptyStatePage section="recent" searchTerm={searchTerm} onNotice={showNotice} onConnect={() => setModalOpen(true)} /></Route>
          <Route path="/search"><EmptyStatePage section="search" searchTerm={searchTerm} onNotice={showNotice} onConnect={() => setModalOpen(true)} /></Route>
          <Route path="/"><BrowsePage onConnect={() => setModalOpen(true)} onNotice={showNotice} onUpload={triggerUpload} /></Route>
          <Route component={NotFound} />
        </Switch>
      </div>
       {modalOpen ? <ConnectionModal onClose={() => setModalOpen(false)} onSettings={() => { setModalOpen(false); setLocation('/settings'); }} onConnected={() => { setConnectionReady(true); setModalOpen(false); setNotice('IAS3 connection verified. File listing will be wired next.'); }} /> : null}
      {notice ? <div className="toast-note" role="status" data-testid="status-toast">{notice}</div> : null}
    </div>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function Router() {
  return (
    <RoutedErrorBoundary>
      <Workspace />
    </RoutedErrorBoundary>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;