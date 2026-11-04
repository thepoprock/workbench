// Journals: voice logs that stay with one project and one tab. Each journal is its
// own folder, <data>/journals/<projectId>/<journalId>/, holding journal.json and its
// entries as <id>.wav + .txt + .json. Nothing here is shared with <data>/voice, so
// dictation, the Recordings pane and anything that reads that folder never see them.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Journal, JournalRef } from '@workbench/shared';
import { dataDir } from './paths.ts';

export const journalsDir = join(dataDir, 'journals');
const ID = /^[\w-]+$/;
const FILE = 'journal.json';

export function journalDir({ projectId, journalId }: JournalRef): string {
  if (!ID.test(projectId) || !ID.test(journalId)) throw new Error('bad journal');
  return join(journalsDir, projectId, journalId);
}

function read(ref: JournalRef): Journal {
  const { name, createdAt } = JSON.parse(readFileSync(join(journalDir(ref), FILE), 'utf8')) as Pick<Journal, 'name' | 'createdAt'>;
  return { ...ref, name, createdAt };
}

function write(j: Journal): Journal {
  writeFileSync(join(journalDir(j), FILE), JSON.stringify({ name: j.name, createdAt: j.createdAt }));
  return j;
}

export function listJournals(projectId: string): Journal[] {
  if (!ID.test(projectId)) throw new Error('bad project');
  let ids: string[];
  try {
    ids = readdirSync(join(journalsDir, projectId));
  } catch {
    return [];
  }
  return ids.flatMap((journalId) => {
    try {
      return [read({ projectId, journalId })];
    } catch {
      return []; // not a journal
    }
  }).sort((a, b) => a.createdAt - b.createdAt);
}

export function createJournal(projectId: string, name?: string): Journal {
  const n = listJournals(projectId).length;
  const j = { projectId, journalId: randomUUID(), name: name?.trim() || (n ? `Journal ${n + 1}` : 'Journal'), createdAt: Date.now() };
  mkdirSync(journalDir(j), { recursive: true, mode: 0o700 });
  return write(j);
}

export function renameJournal(ref: JournalRef, name: string): Journal {
  if (!name.trim()) throw new Error('a journal needs a name');
  return write({ ...read(ref), name: name.trim() });
}

// Haven's journal. Haven isn't a project, so theirs lives under the name "haven":
// <data>/journals/haven/<journalId>/. Made the first time it's asked for.
export const HAVEN_JOURNALS = 'haven';
export function havenJournal(): Journal {
  return listJournals(HAVEN_JOURNALS)[0] ?? createJournal(HAVEN_JOURNALS, 'Haven');
}
