import { statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, shell, type IpcMainInvokeEvent } from 'electron';
import { ensureHub } from './hub.ts';

const RENDERER_FILE = join(__dirname, '../renderer/index.html');

// The only page allowed to run in our windows and talk to the main process:
// the dev server origin, or the bundled index.html. Anything else (a clicked
// link, a redirect) would inherit the preload bridge — and with it the hub.
function isAppUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    if (process.env.ELECTRON_RENDERER_URL) return new URL(url).origin === new URL(process.env.ELECTRON_RENDERER_URL).origin;
    const u = new URL(url);
    return u.protocol === 'file:' && u.pathname === pathToFileURL(RENDERER_FILE).pathname;
  } catch {
    return false;
  }
}

function openExternally(url: string): void {
  try {
    const { protocol } = new URL(url);
    if (protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:') void shell.openExternal(url);
  } catch {
    // not a URL: ignore
  }
}

// The Remote pane embeds claude.ai (Remote Control sessions) in a <webview>:
// its own persistent partition, no preload, no Node, and it may only browse
// claude.ai plus the sign-in providers claude.ai hands off to.
const REMOTE_PARTITION = 'persist:claude-remote';
const REMOTE_HOSTS = [/^claude\.ai$/, /\.claude\.ai$/, /^accounts\.google\.com$/, /^appleid\.apple\.com$/];
function isRemoteUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && REMOTE_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

// Applies to every webContents the app ever creates.
app.on('web-contents-created', (_e, contents) => {
  const isRemote = contents.getType() === 'webview';
  const allowed = isRemote ? isRemoteUrl : isAppUrl;
  contents.on('will-navigate', (e, url) => {
    if (allowed(url)) return;
    e.preventDefault();
    openExternally(url);
  });
  contents.on('will-redirect', (e, url) => {
    if (!allowed(url)) e.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    // claude.ai / sign-in popups stay in the pane; everything else goes to the browser.
    if (isRemote && isRemoteUrl(url)) void contents.loadURL(url);
    else openExternally(url);
    return { action: 'deny' };
  });
  // Only our page may embed, only claude.ai, and never with privileges.
  contents.on('will-attach-webview', (e, prefs, params) => {
    if (isRemote || !isAppUrl(contents.getURL()) || !isRemoteUrl(params.src)) {
      e.preventDefault();
      return;
    }
    delete prefs.preload;
    prefs.nodeIntegration = false;
    prefs.nodeIntegrationInSubFrames = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    prefs.webSecurity = true;
    prefs.partition = REMOTE_PARTITION;
  });
});

// IPC is only answered for our own page.
function handle<A extends unknown[], R>(channel: string, fn: (e: IpcMainInvokeEvent, ...args: A) => R): void {
  ipcMain.handle(channel, (e, ...args) => {
    if (!isAppUrl(e.senderFrame?.url)) throw new Error(`refused ${channel} from ${e.senderFrame?.url ?? 'unknown'}`);
    return fn(e, ...(args as A));
  });
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      webviewTag: true, // only for the Remote pane; locked down in will-attach-webview
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(RENDERER_FILE);
}

handle('hub:connect', () => ensureHub());
handle('dialog:pickFolder', async (e, defaultPath?: string) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const opts = {
    defaultPath,
    properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[],
  };
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  return r.canceled ? null : r.filePaths[0];
});

// Native context menu; resolves with the chosen item id, or null if dismissed.
type MenuItem = { id: string; label: string; enabled?: boolean } | { type: 'separator' };
handle('menu:popup', (e, items: MenuItem[]) => {
  const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
  return new Promise<string | null>((resolve) => {
    // Whichever comes first wins: a click resolves with its id; the close
    // callback (which can fire before the click on macOS) resolves null shortly after.
    const menu = Menu.buildFromTemplate(
      items.map((it) =>
        'type' in it ? { type: 'separator' as const } : { label: it.label, enabled: it.enabled ?? true, click: () => resolve(it.id) },
      ),
    );
    menu.popup({ window: win, callback: () => setTimeout(() => resolve(null), 150) });
  });
});

handle('app:notify', (e, title: string, body: string) => {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body: body.slice(0, 240) });
  n.on('click', () => {
    const win = BrowserWindow.fromWebContents(e.sender);
    win?.show();
    win?.focus();
  });
  n.show();
});
handle('app:badge', (_e, count: number) => app.dock?.setBadge(count > 0 ? String(count) : ''));

// Reveal a folder in Finder. Never "open" a file: that would launch it.
handle('shell:reveal', (_e, path: string) => {
  try {
    if (statSync(path).isDirectory()) return shell.openPath(path);
  } catch {
    return 'not found';
  }
  shell.showItemInFolder(path);
  return '';
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
