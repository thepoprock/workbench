import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { APP_DIR_NAME, DB_FILE, DISCOVERY_FILE } from '@workbench/shared';

// WORKBENCH_DATA_DIR overrides the location (tests, throwaway runs).
export const dataDir =
  process.env.WORKBENCH_DATA_DIR ?? join(homedir(), 'Library', 'Application Support', APP_DIR_NAME);

export const dbPath = join(dataDir, DB_FILE);
export const discoveryPath = join(dataDir, DISCOVERY_FILE);
export const scrollbackDir = join(dataDir, 'scrollback');

export function ensureDirs(): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(scrollbackDir, { recursive: true, mode: 0o700 });
}
