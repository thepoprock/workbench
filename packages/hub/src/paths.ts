import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DB_FILE, DISCOVERY_FILE } from '@workbench/shared';
import { defaultDataDir } from './platform.ts';

// WORKBENCH_DATA_DIR overrides the location (tests, throwaway runs).
export const dataDir = process.env.WORKBENCH_DATA_DIR ?? defaultDataDir();

export const dbPath = join(dataDir, DB_FILE);
export const discoveryPath = join(dataDir, DISCOVERY_FILE);
export const scrollbackDir = join(dataDir, 'scrollback');

export function ensureDirs(): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(scrollbackDir, { recursive: true, mode: 0o700 });
}
