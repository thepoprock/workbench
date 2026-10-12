import { existsSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { ClaudeTranscript } from '@workbench/shared';

const CODEX_SESSIONS = join(homedir(), '.codex', 'sessions');
const LIMIT = 100;
const clip = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n);

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return filesUnder(path);
    return e.isFile() && e.name.endsWith('.jsonl') ? [path] : [];
  });
}

function messageText(payload: Record<string, unknown>): string {
  if (!Array.isArray(payload.content)) return '';
  return payload.content
    .filter((part): part is Record<string, unknown> => typeof part === 'object' && part !== null)
    .filter((part) => part.type === 'input_text' || part.type === 'output_text')
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('\n')
    .trim();
}

async function readSession(path: string): Promise<ClaudeTranscript | null> {
  const st = statSync(path);
  let id = basename(path).replace(/^rollout-/, '').replace(/\.jsonl$/, '').split('-').slice(-5).join('-');
  let cwd: string | undefined;
  let startedAt = st.birthtimeMs || st.mtimeMs;
  let updatedAt = st.mtimeMs;
  let firstPrompt: string | null = null;
  let lastPrompt: string | null = null;
  let title: string | null = null;
  const stream = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of stream) {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const payload = row.payload && typeof row.payload === 'object' ? (row.payload as Record<string, unknown>) : {};
    const ts = Date.parse(String(row.timestamp ?? ''));
    if (Number.isFinite(ts)) updatedAt = Math.max(updatedAt, ts);
    if (row.type === 'session_meta') {
      if (typeof payload.session_id === 'string') id = payload.session_id;
      if (typeof payload.cwd === 'string') cwd = payload.cwd;
      const start = Date.parse(String(payload.timestamp ?? row.timestamp ?? ''));
      if (Number.isFinite(start)) startedAt = start;
      continue;
    }
    if (row.type !== 'response_item' || payload.type !== 'message') continue;
    const role = payload.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = messageText(payload);
    if (!text) continue;
    if (role === 'user') {
      firstPrompt ??= text;
      lastPrompt = text;
    } else if (role === 'assistant') {
      // The final plain-text assistant message is a useful title when available.
      title = clip(text, 100) || title;
    }
  }
  if (!cwd || !firstPrompt) return null;
  return {
    id,
    harnessId: 'openai-codex',
    provider: 'openai-codex',
    cwd,
    title: clip(lastPrompt || title || 'Codex conversation', 100) || 'Codex conversation',
    firstPrompt: clip(firstPrompt, 300) || null,
    startedAt,
    updatedAt,
    bytes: st.size,
  };
}

export async function codexHistory(root: string | null): Promise<ClaudeTranscript[]> {
  if (!root) return [];
  const target = resolve(root);
  const files = filesUnder(CODEX_SESSIONS);
  const transcripts: ClaudeTranscript[] = [];
  for (const file of files) {
    try {
      const t = await readSession(file);
      if (t && resolve(t.cwd ?? '') === target) transcripts.push(t);
    } catch {
      // A session can still be in the process of being written.
    }
  }
  return transcripts.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, LIMIT);
}
