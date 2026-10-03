import { join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, shell } from 'electron';
import { ensureHub } from './hub.ts';

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
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(join(__dirname, '../renderer/index.html'));
}

ipcMain.handle('hub:connect', () => ensureHub());
ipcMain.handle('dialog:pickFolder', async (e, defaultPath?: string) => {
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
ipcMain.handle('menu:popup', (e, items: MenuItem[]) => {
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

ipcMain.handle('app:notify', (e, title: string, body: string) => {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body: body.slice(0, 240) });
  n.on('click', () => {
    const win = BrowserWindow.fromWebContents(e.sender);
    win?.show();
    win?.focus();
  });
  n.show();
});
ipcMain.handle('app:badge', (_e, count: number) => app.dock?.setBadge(count > 0 ? String(count) : ''));

ipcMain.handle('shell:reveal', (_e, path: string) => shell.openPath(path));

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
