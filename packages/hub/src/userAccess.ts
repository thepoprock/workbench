// How other users on this Mac find the hub: its port (not its key; each has their own,
// in ~/.workbench-key) in a folder every account can read, and the `wb` command there.
import { chmodSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isWindows, which } from './platform.ts';

export const PUBLIC_DIR = process.env.WORKBENCH_PUBLIC_DIR ?? '/Users/Shared/workbench';
// A stable node path: the hub's own may be a versioned Homebrew folder that an upgrade removes.
const NODE = ['/opt/homebrew/bin/node', '/usr/local/bin/node'].find((p) => existsSync(p)) ?? process.execPath;
const WB = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'wb.mjs');

export function publishForUsers(port: number): void {
  if (isWindows || process.env.WORKBENCH_DATA_DIR?.includes('Workbench-dev') && !process.env.WORKBENCH_PUBLIC_DIR) return; // the dev copy stays private
  try {
    mkdirSync(join(PUBLIC_DIR, 'bin'), { recursive: true, mode: 0o755 });
    writeFileSync(join(PUBLIC_DIR, 'hub.json'), JSON.stringify({ port }), { mode: 0o644 });
    chmodSync(join(PUBLIC_DIR, 'hub.json'), 0o644);
    if (existsSync(WB)) {
      const shim = join(PUBLIC_DIR, 'bin', 'wb');
      writeFileSync(shim, `#!/bin/sh\nexec "${NODE}" "${WB}" "$@"\n`, { mode: 0o755 });
      chmodSync(shim, 0o755);
    }
    // claude too, for accounts whose own setup doesn't have it (sessions run as them put this folder on PATH).
    const claude = which('claude');
    if (claude) {
      const link = join(PUBLIC_DIR, 'bin', 'claude');
      rmSync(link, { force: true });
      symlinkSync(claude, link);
    }
  } catch (err) {
    console.log(`${new Date().toISOString()} [hub] can't publish to ${PUBLIC_DIR}: ${(err as Error).message}`);
  }
}
