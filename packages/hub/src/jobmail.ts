// Job-application inbox watch. Every few minutes the hub reads new Gmail
// messages over IMAP (an app password kept in the macOS Keychain), keeps the
// ones that are replies to job applications (the sender or text names a
// company in ~/Desktop/Job Applications, or the mail comes from an applicant
// tracking system), sorts them into received / interview / rejection / other,
// stores them, pushes them to the app (which notifies) and appends a line to
// ~/job-hunt/responses.md so a Claude session can watch for new ones.
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { JobMail, JobMailKind, JobMailStatus } from '@workbench/shared';
import type { DB } from './db/index.ts';
import { keychainGet, keychainSet } from './keychain.ts';

const POLL_MS = 5 * 60_000;
const FIRST_RUN_DAYS = 21;
const APPS_DIR = join(homedir(), 'Desktop', 'Job Applications');
const LOG_FILE = join(homedir(), 'job-hunt', 'responses.md');
const ATS = /greenhouse\.io|ashbyhq\.com|lever\.co|myworkday(jobs)?\.com|workday\.com|smartrecruiters\.com|workable\.com|rippling\.com|icims\.com|jobvite\.com|bamboohr\.com|breezy\.hr|recruitee\.com|teamtailor\.com|jobs-noreply@linkedin\.com|hire\.lever|gem\.com|dover\.com/i;
const INTERVIEW = /\binterview|next steps?\b|schedul(e|ing) (a|some) (time|call)|your availability|calendly\.com|book a time|phone screen|recruiter (call|screen)|would love to (chat|speak|talk|connect)|set up a (call|time|chat)|move forward with your (application|candidacy)/i;
const REJECTION = /unfortunately|not (be )?(moving|move) forward|other candidates|decided to (pursue|move forward with)|not (a|the right) fit|position has been filled|regret to inform|will not be (moving|proceeding)|no longer (being )?considered|we.ve filled/i;
const RECEIVED = /received your application|application was sent|your application to .{1,60} (was|has been) (sent|submitted)|thank(s| you) for (applying|your application|your interest)|application (has been |was )?(received|submitted)|we.ve received|successfully submitted/i;

const JOBWORDS = /application|applying|applied|candidate|candidacy|\brole\b|position|interview|recruit|hiring|opportunit|offer|resume|talent/i;
const log = (m: string) => console.log(`${new Date().toISOString()} [jobmail] ${m}`);

// Companies applied to, from the folder names "<STATUS> - <Company> - <Role>".
export function companies(): string[] {
  if (!existsSync(APPS_DIR)) return [];
  const out = new Set<string>();
  for (const f of readdirSync(APPS_DIR)) {
    const m = f.match(/^(?:SENT \d+|TO SEND(?: \(Easy Apply\))?|SKIPPED|INTERVIEW|REJECTED) - (.+?) - /);
    if (m) out.add(m[1].trim());
  }
  return [...out];
}

export function classify(subject: string, text: string): JobMailKind {
  const s = `${subject}\n${text}`;
  if (REJECTION.test(s)) return 'rejection';
  if (INTERVIEW.test(s)) return 'interview';
  if (RECEIVED.test(s)) return 'received';
  return 'other';
}

// Which company a message is about, or null when it isn't a job reply.
export function matchCompany(from: string, subject: string, text: string, names: string[]): string | null {
  const head = `${from}\n${subject}`.toLowerCase();
  const body = text.slice(0, 4000).toLowerCase();
  const ats = ATS.test(from);
  // Whole-word match, so "Built" or "Ramp" inside ordinary words or mail doesn't count.
  const has = (hay: string, key: string) => new RegExp(`(^|[^a-z0-9])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(hay);
  for (const n of [...names].sort((a, b) => b.length - a.length)) {
    const key = n.toLowerCase().replace(/\s+(inc|llc|labs|technologies|solutions)\.?$/, '');
    if (key.length < 3) continue;
    if (has(head, key) && (ats || JOBWORDS.test(`${subject}\n${body}`))) return n; // named in the sender or subject, about a job
    if (ats && has(body, key)) return n; // an applicant-tracking mail that names the company
  }
  return ats || /your application|your candidacy|your interest in/i.test(subject) ? '(unmatched company)' : null;
}

interface Row { id: string; ts: number; from_addr: string; subject: string; company: string; kind: JobMailKind; snippet: string; seen: number }
const toMail = (r: Row): JobMail => ({ id: r.id, ts: r.ts, from: r.from_addr, subject: r.subject, company: r.company, kind: r.kind, snippet: r.snippet, seen: r.seen === 1 });

export class JobMailWatch {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<number> | null = null;
  private lastCheck: number | null = null;
  private error: string | null = null;

  constructor(private db: DB, private push: (mail: JobMail, alert: boolean) => void) {
    if (this.user()) this.schedule(10_000);
  }

  private user(): string | null {
    return (this.db.prepare("SELECT value FROM settings WHERE key = 'jobmail.user'").get() as { value: string } | undefined)?.value ?? null;
  }

  status(): JobMailStatus {
    const n = (this.db.prepare('SELECT COUNT(*) AS n, SUM(seen = 0) AS unseen FROM jobmail').get() as { n: number; unseen: number | null });
    return { user: this.user(), lastCheck: this.lastCheck, error: this.error, count: n.n, unseen: n.unseen ?? 0, companies: companies() };
  }

  list(): JobMail[] {
    return (this.db.prepare('SELECT * FROM jobmail ORDER BY ts DESC LIMIT 300').all() as unknown as Row[]).map(toMail);
  }

  markSeen(id: string | null): void {
    if (id) this.db.prepare('UPDATE jobmail SET seen = 1 WHERE id = ?').run(id);
    else this.db.prepare('UPDATE jobmail SET seen = 1').run();
  }

  // The app password is typed by the user into the Workbench form and goes straight to the Keychain.
  async configure(user: string, password?: string): Promise<JobMailStatus> {
    const u = user.trim();
    if (!/^[^@\s]+@[^@\s]+$/.test(u)) throw new Error('enter the Gmail address');
    if (password) await keychainSet(`jobmail:${u}`, password.replace(/\s+/g, ''));
    if (!(await keychainGet(`jobmail:${u}`))) throw new Error('enter the app password (myaccount.google.com/apppasswords)');
    this.db.prepare("INSERT INTO settings (key, value) VALUES ('jobmail.user', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(u);
    this.error = null;
    await this.check();
    this.schedule(POLL_MS);
    return this.status();
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.check().finally(() => this.schedule(POLL_MS)), ms);
    this.timer.unref();
  }

  check(): Promise<number> {
    this.running ??= this.poll().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async poll(): Promise<number> {
    const user = this.user();
    if (!user) return 0;
    const pass = await keychainGet(`jobmail:${user}`);
    if (!pass) {
      this.error = 'no app password saved';
      return 0;
    }
    const names = companies();
    const lastTs = (this.db.prepare('SELECT MAX(ts) AS t FROM jobmail').get() as { t: number | null }).t;
    const since = new Date((this.lastCheck ?? lastTs ?? Date.now() - FIRST_RUN_DAYS * 86400_000) - 2 * 86400_000);
    const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user, pass }, logger: false });
    let added = 0;
    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        const uids = (await client.search({ since }, { uid: true })) || [];
        for (const uid of uids.slice(-400)) {
          const msg = await client.fetchOne(String(uid), { envelope: true, internalDate: true, source: { maxLength: 200_000 } }, { uid: true });
          if (!msg || !msg.envelope) continue;
          const id = msg.envelope.messageId || `uid:${uid}`;
          if (this.db.prepare('SELECT 1 FROM jobmail WHERE id = ?').get(id)) continue;
          const parsed = msg.source ? await simpleParser(msg.source) : null;
          const text = (parsed?.text || '').replace(/\s+/g, ' ').trim();
          const fromObj = msg.envelope.from?.[0];
          const from = fromObj ? `${fromObj.name || ''} <${fromObj.address || ''}>`.trim() : '';
          const subject = msg.envelope.subject || '';
          const company = matchCompany(from, subject, text, names);
          if (!company) continue;
          const kind = classify(subject, text);
          const ts = new Date(msg.internalDate || msg.envelope.date || Date.now()).getTime();
          const row: Row = { id, ts, from_addr: from, subject, company, kind, snippet: text.slice(0, 600), seen: 0 };
          this.db.prepare('INSERT INTO jobmail (id, ts, from_addr, subject, company, kind, snippet, seen) VALUES (?, ?, ?, ?, ?, ?, ?, 0)').run(row.id, row.ts, row.from_addr, row.subject, row.company, row.kind, row.snippet);
          added++;
          const first = this.lastCheck === null && lastTs === null; // first sweep: store quietly
          this.push(toMail(row), !first);
          try {
            appendFileSync(LOG_FILE, `- ${new Date(ts).toISOString().slice(0, 16).replace('T', ' ')} UTC · ${company} · ${kind.toUpperCase()} · ${subject.replace(/\n/g, ' ')} · from ${from}\n`);
          } catch {}
        }
      } finally {
        lock.release();
      }
      await client.logout();
      this.error = null;
    } catch (err) {
      this.error = (err as Error).message;
      log(`check failed: ${this.error}`);
      try { client.close(); } catch {}
    }
    this.lastCheck = Date.now();
    if (added) log(`${added} new job replies`);
    return added;
  }

  shutdown(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}

// Kept for tests: classify + match on plain text without IMAP.
export function readSample(path: string): string {
  return readFileSync(path, 'utf8');
}
