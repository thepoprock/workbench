// People who use this Workbench besides its owner (whoever runs the hub and holds the
// token in hub.json). Each has a name, a Mac account and a key of their own. Their
// projects run as their account, so their sessions see their files and their Claude
// login, not the owner's. Starting programs as another account needs an admin rule,
// added once per user (see rule()); until then their sessions fail at once and say so.
import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { userInfo } from 'node:os';
import type { Me, UserCheck, WorkbenchUser } from '@workbench/shared';
import type { DB } from './db/index.ts';

export const SUDO = '/usr/bin/sudo';
const ACCOUNT = /^[a-z_][a-z0-9_.-]{0,31}$/;
const hash = (key: string) => createHash('sha256').update(key).digest('hex');

interface Row {
  id: string;
  name: string;
  account: string;
  key_hash: string;
  created_at: number;
}

const toUser = (r: Row): WorkbenchUser => ({ id: r.id, name: r.name, account: r.account, createdAt: r.created_at });

export class Users {
  readonly me = userInfo().username; // the account the hub runs as: the owner's
  readonly owner: Me = { id: null, name: this.me, owner: true };

  constructor(private db: DB) {}

  list(): WorkbenchUser[] {
    return (this.db.prepare('SELECT * FROM users ORDER BY name COLLATE NOCASE').all() as unknown as Row[]).map(toUser);
  }

  get(id: string): WorkbenchUser {
    const r = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new Error('unknown user');
    return toUser(r);
  }

  // Who a key belongs to, or null.
  byKey(key: string): Me | null {
    const given = Buffer.from(hash(key));
    for (const r of this.db.prepare('SELECT * FROM users').all() as unknown as Row[]) {
      const want = Buffer.from(r.key_hash);
      if (want.length === given.length && timingSafeEqual(want, given)) return { id: r.id, name: r.name, owner: false };
    }
    return null;
  }

  // The Mac account a project runs as; null when it is the owner's (run as the hub).
  accountFor(projectId: string | null): string | null {
    if (!projectId) return null;
    const r = this.db.prepare('SELECT u.account FROM projects p JOIN users u ON u.id = p.owner_id WHERE p.id = ?').get(projectId) as
      | { account: string }
      | undefined;
    return r && r.account !== this.me ? r.account : null;
  }

  async add(name: string, account: string): Promise<WorkbenchUser & UserCheck> {
    account = account.trim();
    if (!name.trim()) throw new Error('a user needs a name');
    if (!ACCOUNT.test(account)) throw new Error('a Mac account name is lowercase letters, digits, - _ .');
    if (account === this.me) throw new Error(`${account} is the account Workbench runs as: that's you`);
    try {
      execFileSync('/usr/bin/id', ['-u', account], { stdio: 'ignore' });
    } catch {
      throw new Error(`there is no Mac account called ${account}`);
    }
    const id = randomUUID();
    this.db.prepare('INSERT INTO users (id, name, account, key_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(id, name.trim(), account, '', Date.now());
    return { ...this.get(id), ...(await this.newKey(id)) };
  }

  rename(id: string, name: string): WorkbenchUser {
    if (!name.trim()) throw new Error('a user needs a name');
    this.get(id);
    this.db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name.trim(), id);
    return this.get(id);
  }

  // Their projects are archived (sessions and history stay); the key stops working.
  remove(id: string): void {
    this.get(id);
    this.db.prepare('UPDATE projects SET archived = 1, owner_id = NULL WHERE owner_id = ?').run(id);
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }

  // A new key, written into their account as ~/.workbench-key when the rule allows.
  async newKey(id: string): Promise<UserCheck> {
    const user = this.get(id);
    const key = randomBytes(32).toString('hex');
    this.db.prepare('UPDATE users SET key_hash = ? WHERE id = ?').run(hash(key), id);
    const keyDelivered = await this.asUser(user.account, ['/bin/sh', '-c', 'umask 077 && cat > "$HOME/.workbench-key"'], key);
    return { canRun: await this.canRun(user.account), rule: this.rule(user.account), keyDelivered };
  }

  async check(id: string): Promise<UserCheck> {
    const { account } = this.get(id);
    const canRun = await this.canRun(account);
    const keyDelivered = canRun && (await this.asUser(account, ['/bin/test', '-s', `/Users/${account}/.workbench-key`]));
    return { canRun, rule: this.rule(account), keyDelivered };
  }

  // The one line, run once in a terminal with an admin password.
  rule(account: string): string {
    const file = `/etc/sudoers.d/workbench-${account}`;
    return `echo '${this.me} ALL=(${account}) NOPASSWD: ALL' | sudo tee ${file} >/dev/null && sudo chmod 440 ${file}`;
  }

  canRun(account: string): Promise<boolean> {
    return this.asUser(account, ['/usr/bin/true']);
  }

  // Runs a command as the account without a password prompt; false if not allowed.
  private asUser(account: string, command: string[], input?: string): Promise<boolean> {
    return new Promise((resolve) => {
      const child = execFile(SUDO, ['-n', '-u', account, '-H', '--', ...command], { timeout: 10_000 }, (err) => resolve(!err));
      child.stdin?.end(input ?? '');
    });
  }
}
