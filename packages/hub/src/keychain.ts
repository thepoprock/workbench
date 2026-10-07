import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Secrets live in the macOS login Keychain, never in the database.
const run = promisify(execFile);
const SERVICE = 'Workbench Claude token';

export async function keychainSet(account: string, secret: string): Promise<void> {
  await run('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', account, '-w', secret], { timeout: 10_000 });
}

export async function keychainGet(account: string): Promise<string | null> {
  try {
    const { stdout } = await run('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w'], { timeout: 10_000 });
    return stdout.trim() || null;
  } catch {
    return null; // not found
  }
}

export async function keychainDelete(account: string): Promise<void> {
  try {
    await run('security', ['delete-generic-password', '-s', SERVICE, '-a', account], { timeout: 10_000 });
  } catch {
    // already gone
  }
}
