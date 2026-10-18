import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { JobMail, JobMailStatus } from '@workbench/shared';
import { hub } from './hub.ts';

const when = (ts: number) => new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const LABEL: Record<JobMail['kind'], string> = { interview: 'Interview / next steps', rejection: 'Rejection', received: 'Received', other: 'Other' };

// Replies to job applications, read from Gmail by the hub. Setup takes the
// Gmail address and a Google app password (stored in the macOS Keychain).
export function JobMailPane() {
  const [status, setStatus] = useState<JobMailStatus | null>(null);
  const [mail, setMail] = useState<JobMail[]>([]);
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, m] = await Promise.all([hub.call('jobmail.status', {}), hub.call('jobmail.list', {})]);
      setStatus(s);
      setMail(m);
      if (s.user) setUser(s.user);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);
  useEffect(() => void load(), [load]);
  useEffect(() => hub.onPush((p) => p.event === 'jobmail.update' && void load()), [load]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setStatus(await hub.call('jobmail.configure', { user, password: pass || undefined }));
      setPass('');
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };

  const check = async () => {
    setBusy(true);
    try {
      await hub.call('jobmail.check', {});
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };

  const counts = (k: JobMail['kind']) => mail.filter((m) => m.kind === k).length;

  return (
    <div className="changelog jobmail">
      <div className="changelog-bar">
        <b>Job inbox</b>
        {status?.user ? (
          <span className="muted small">
            {status.user} · checked {status.lastCheck ? when(status.lastCheck) : 'not yet'} · every 5 min · watching {status.companies.length} companies
          </span>
        ) : (
          <span className="muted small">not connected</span>
        )}
        <span className="spacer" />
        {status?.user && (
          <>
            <button className="rules-toggle" disabled={busy} onClick={() => void check()}>
              {busy ? 'Checking…' : 'Check now'}
            </button>
            <button className="rules-toggle" onClick={() => void hub.call('jobmail.seen', { id: null }).then(load)}>
              Mark all read
            </button>
          </>
        )}
      </div>
      <div className="changelog-list">
        {(!status?.user || error || status?.error) && (
          <form className="jm-setup" onSubmit={(e) => void save(e)}>
            <p>
              Connect Gmail with an <b>app password</b>: turn on 2-Step Verification, then create one at{' '}
              <a href="https://myaccount.google.com/apppasswords">myaccount.google.com/apppasswords</a> and paste it here. It is
              stored in your Mac's Keychain and used only to read your inbox.
            </p>
            <div className="hm-row">
              <span className="hm-label">Gmail</span>
              <input value={user} onChange={(e) => setUser(e.target.value)} placeholder="you@gmail.com" />
            </div>
            <div className="hm-row">
              <span className="hm-label">App password</span>
              <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder={status?.user ? '(saved — leave empty to keep)' : 'xxxx xxxx xxxx xxxx'} />
              <button className="action primary" disabled={busy}>
                {busy ? 'Connecting…' : 'Connect'}
              </button>
            </div>
            {(error || status?.error) && <div className="voice-error">{error ?? status?.error}</div>}
          </form>
        )}
        {status?.user && (
          <div className="jm-counts">
            {(['interview', 'rejection', 'received', 'other'] as const).map((k) => (
              <span key={k} className={`jm-count jm-${k}`}>
                {LABEL[k]}: <b>{counts(k)}</b>
              </span>
            ))}
          </div>
        )}
        {status?.user && mail.length === 0 && <div className="placeholder-text">No replies yet. New ones show up here and as a notification.</div>}
        {mail.map((m) => (
          <div key={m.id} className={`rec-item ${m.seen ? '' : 'jm-unseen'}`}>
            <button
              className="entry-row"
              onClick={() => {
                setOpen(open === m.id ? null : m.id);
                if (!m.seen) void hub.call('jobmail.seen', { id: m.id }).then(load);
              }}
            >
              <span className={`badge jm-${m.kind}`}>{LABEL[m.kind]}</span>
              <span className="entry-summary">
                <b>{m.company}</b> · {m.subject}
              </span>
              <span className="entry-meta">{when(m.ts)}</span>
            </button>
            {open === m.id && (
              <div className="entry-detail">
                <div className="muted small">{m.from}</div>
                <p className="final">{m.snippet}</p>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
