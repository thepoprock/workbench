// macOS uses ⌘ shortcuts and Finder; Windows/Linux use Ctrl+Shift and the file manager.
export const isMac = navigator.userAgent.includes('Macintosh');
const isWindows = navigator.userAgent.includes('Windows');

// Shortcuts are written the macOS way (⌘T, ⌘⇧E). Elsewhere every one is
// Ctrl+Shift+key, so a terminal keeps Ctrl+T, Ctrl+E and the rest.
export const keys = (mac: string): string => (isMac ? mac : `Ctrl+Shift+${mac.replace(/[⌘⇧]/g, '')}`);

// The app shortcut modifier held? (⌘ on macOS; Ctrl+Shift elsewhere.)
export const isAppShortcut = (e: KeyboardEvent): boolean =>
  !e.altKey && (isMac ? e.metaKey : e.ctrlKey && e.shiftKey && !e.metaKey);

export const revealLabel = isMac ? 'Show in Finder' : isWindows ? 'Show in Explorer' : 'Show in Folder';
export const secretStore = isMac ? 'Keychain' : isWindows ? 'Windows credential store' : 'system keyring';

export const basename = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p;

document.documentElement.dataset.platform = isMac ? 'mac' : isWindows ? 'windows' : 'linux';
