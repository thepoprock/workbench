import { execFile, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { dataDir } from './paths.ts';
import { isMac, isWindows, which } from './platform.ts';

// Secrets never go in the database. macOS: the login Keychain. Windows: DPAPI
// (encrypted to the Windows user) in <data>/secrets. Linux: the Secret Service
// (secret-tool), or a 0600 file in <data>/secrets when that isn't installed.
const run = promisify(execFile);
const SERVICE = 'Workbench Claude token';
const secretsDir = join(dataDir, 'secrets');
const secretFile = (account: string, ext: string) => join(secretsDir, `${account.replace(/[^a-zA-Z0-9_-]/g, '_')}.${ext}`);

// Runs a program with `input` on stdin (keeps secrets out of argv); resolves stdout.
function pipe(file: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(file, args, { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => p.kill(), 15_000);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `${file} exited ${code}`));
    });
    p.stdin.end(input);
  });
}

const PS = ['-NoProfile', '-NonInteractive', '-Command'];
const DPAPI_PROTECT = '$s = [Console]::In.ReadToEnd(); ConvertTo-SecureString $s -AsPlainText -Force | ConvertFrom-SecureString';
const DPAPI_UNPROTECT =
  '$e = [Console]::In.ReadToEnd().Trim(); $ss = ConvertTo-SecureString $e; ' +
  '[Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss))';

let secretTool: string | null | undefined;
const hasSecretTool = () => (secretTool ??= which('secret-tool')) !== null;

export async function keychainSet(account: string, secret: string): Promise<void> {
  if (isMac) {
    await run('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', account, '-w', secret], { timeout: 10_000 });
    return;
  }
  if (!isWindows && hasSecretTool()) {
    await pipe('secret-tool', ['store', `--label=${SERVICE}`, 'service', SERVICE, 'account', account], secret);
    return;
  }
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  if (isWindows) writeFileSync(secretFile(account, 'dpapi'), (await pipe('powershell.exe', [...PS, DPAPI_PROTECT], secret)).trim());
  else writeFileSync(secretFile(account, 'secret'), secret, { mode: 0o600 });
}

export async function keychainGet(account: string): Promise<string | null> {
  try {
    if (isMac) {
      const { stdout } = await run('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w'], { timeout: 10_000 });
      return stdout.trim() || null;
    }
    if (!isWindows && hasSecretTool()) {
      return (await pipe('secret-tool', ['lookup', 'service', SERVICE, 'account', account], '')).trim() || null;
    }
    if (isWindows) {
      const blob = readFileSync(secretFile(account, 'dpapi'), 'utf8');
      return (await pipe('powershell.exe', [...PS, DPAPI_UNPROTECT], blob)).trim() || null;
    }
    return readFileSync(secretFile(account, 'secret'), 'utf8').trim() || null;
  } catch {
    return null; // not found
  }
}

export async function keychainDelete(account: string): Promise<void> {
  try {
    if (isMac) await run('security', ['delete-generic-password', '-s', SERVICE, '-a', account], { timeout: 10_000 });
    else if (!isWindows && hasSecretTool()) await pipe('secret-tool', ['clear', 'service', SERVICE, 'account', account], '');
    else rmSync(secretFile(account, isWindows ? 'dpapi' : 'secret'), { force: true });
  } catch {
    // already gone
  }
}
