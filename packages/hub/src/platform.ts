import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { APP_DIR_NAME } from '@workbench/shared';

// Everything that differs between macOS, Linux and Windows lives here.
export const isWindows = process.platform === 'win32';
export const isMac = process.platform === 'darwin';

// Same folder Electron uses for the app's own userData.
export function defaultDataDir(): string {
  if (isMac) return join(homedir(), 'Library', 'Application Support', APP_DIR_NAME);
  if (isWindows) return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), APP_DIR_NAME);
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), APP_DIR_NAME);
}

export interface Command {
  file: string;
  args: string[];
}

const posixShell = () => process.env.SHELL || (isMac ? '/bin/zsh' : '/bin/bash');

// An interactive shell for a plain terminal pane.
export function loginShell(): Command & { title: string } {
  if (isWindows) {
    const file = process.env.WORKBENCH_SHELL || 'powershell.exe';
    return { file, args: ['-NoLogo'], title: file.split(/[\\/]/).pop()!.replace(/\.exe$/i, '') };
  }
  const file = posixShell();
  return { file, args: ['-l'], title: file.split('/').pop() ?? 'shell' };
}

// Runs a program the way a terminal would find it. On macOS/Linux through a
// login shell, so it and its tools get the same PATH as a terminal; on Windows
// the hub's PATH already is the user's, and .cmd/.bat shims need cmd.exe.
export function viaShell(command: string[]): Command {
  if (!isWindows) return { file: posixShell(), args: ['-l', '-c', 'exec "$0" "$@"', ...command] };
  const [file, ...args] = command;
  if (/\.(cmd|bat)$/i.test(file) || !/[\\/]/.test(file)) return { file: 'cmd.exe', args: ['/d', '/c', file, ...args] };
  return { file, args };
}

// A one-line shell command (custom harnesses).
export function shellCommand(line: string): string[] {
  return isWindows ? ['cmd.exe', '/d', '/c', line] : ['/bin/sh', '-c', line];
}

// Where `name` resolves, as the user's shell would see it.
export function which(name: string): string | null {
  try {
    if (isWindows) {
      const out = execFileSync('where.exe', [name], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
      const hits = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      // Prefer a real executable over an npm .cmd shim.
      return hits.find((h) => /\.exe$/i.test(h)) ?? hits.find((h) => /\.(cmd|bat)$/i.test(h)) ?? null;
    }
    const out = execFileSync(posixShell(), ['-lc', `command -v ${name}`], { encoding: 'utf8', timeout: 10_000 }).trim();
    return out.split('\n').pop() || null;
  } catch {
    return null;
  }
}
