import { useCallback, useEffect, useState } from 'react';
import type { Harness, UserCheck, WorkbenchUser } from '@workbench/shared';
import { hub } from './hub.ts';

type Row = WorkbenchUser & UserCheck;

// Other people using this Workbench. Each has a Mac account their projects run as and
// a key of their own (Workbench puts it in their account as ~/.workbench-key). They see
// only their own projects; you see theirs in a section of their own.
export function UsersManager({ onClose }: { onClose: () => void }) {
  const [users, setUsers] = useState<Row[] | null>(null);
  const [name, setName] = useState('');
  const [account, setAccount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tokenAccounts, setTokenAccounts] = useState<Harness[]>([]);

  const load = useCallback(async () => {
    try {
      setUsers(await hub.call('user.list', {}));
      setTokenAccounts((await hub.call('harness.list', {})).filter((h) => h.type === 'claude-code' && h.config.mode === 'token'));
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);
  useEffect(() => void load(), [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const row = (u: Row) => (
    <li key={u.id}>
      <div className="hm-text">
        <span className="hm-name">
          {u.name} <span className="muted small">Mac account {u.account}</span>
        </span>
        <label className="small users-claude" title="Claude in their projects signs in with this account's token (a setup-token on your subscription)">
          Claude:{' '}
          <select
            value={u.claudeAccount ?? ''}
            disabled={busy || !u.canRun}
            onChange={(e) => void run(() => hub.call('user.setClaude', { id: u.id, harnessId: e.target.value || null }))}
          >
            <option value="">their own sign-in</option>
            {tokenAccounts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
          {tokenAccounts.length === 0 && <span className="muted"> — to share your subscription, add a token account under Harnesses first</span>}
        </label>
        {u.canRun ? (
          <span className="small">{u.keyDelivered ? 'Ready: their key is in ~/.workbench-key in their account.' : 'Allowed, but their key is missing — press New key.'}</span>
        ) : (
          <>
            <span className="small users-warn">Workbench can't start programs as {u.account} yet. Run this once in a terminal (it asks for your Mac password), then press Check:</span>
            <code className="users-rule" onClick={() => void navigator.clipboard.writeText(u.rule)} title="Click to copy">
              {u.rule}
            </code>
          </>
        )}
      </div>
      <button className="link" disabled={busy} onClick={() => void run(() => hub.call('user.check', { id: u.id }))}>
        Check
      </button>
      <button className="link" disabled={busy} title="A new key; the old one stops working" onClick={() => void run(() => hub.call('user.newKey', { id: u.id }))}>
        New key
      </button>
      <button
        className="link"
        disabled={busy}
        onClick={() =>
          void window.workbench
            .menu([
              { id: 'yes', label: `Remove ${u.name} (their projects are archived)` },
              { id: 'no', label: 'Keep' },
            ])
            .then((c) => (c === 'yes' ? run(() => hub.call('user.remove', { id: u.id })) : undefined))
        }
      >
        Remove
      </button>
    </li>
  );

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="search harness-manager" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="hm-head">
          <h2>Users</h2>
          <span className="muted small">People besides you. Each sees only their own projects, which run as their own Mac account.</span>
          <button className="hm-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {error && <div className="error users-error">{error}</div>}
        {users && (users.length ? <ul className="hm-list">{users.map(row)}</ul> : <p className="muted small mcp-empty">No one else yet.</p>)}
        <form
          className="hm-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await hub.call('user.add', { name, account });
              setName('');
              setAccount('');
            });
          }}
        >
          <b>Add someone</b>
          <div className="hm-row">
            <span className="hm-label">Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Haven" />
          </div>
          <div className="hm-row">
            <span className="hm-label">Mac account</span>
            <input value={account} onChange={(e) => setAccount(e.target.value)} placeholder="e.g. haven" autoCapitalize="off" spellCheck={false} />
          </div>
          <div className="hm-row">
            <button className="action primary" disabled={busy || !name.trim() || !account.trim()}>
              Add
            </button>
            <span className="muted small">They connect with the wb command (/Users/Shared/workbench/bin/wb).</span>
          </div>
        </form>
      </div>
    </div>
  );
}
