// npm postinstall: fetch the Electron binary and make node-pty's helper
// executable (prebuilt tarballs lose the bit). Plain node so it runs on Windows too.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

execFileSync(process.execPath, ['node_modules/electron/install.js'], { stdio: 'inherit' });

const prebuilds = 'node_modules/node-pty/prebuilds';
if (process.platform !== 'win32' && existsSync(prebuilds)) {
  for (const dir of readdirSync(prebuilds)) {
    const helper = join(prebuilds, dir, 'spawn-helper');
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
}
