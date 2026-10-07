import { useCallback, useEffect, useState } from 'react';
import type { AccountMode, AccountStatus, Harness, HarnessType, ModelServer, ShareGroup } from '@workbench/shared';

const SHARE_LABELS: { group: ShareGroup; label: string; hint: string }[] = [
  { group: 'instructions', label: 'Instructions & settings', hint: 'CLAUDE.md, settings, hooks' },
  { group: 'extensions', label: 'Agents, commands & skills', hint: 'agents, commands, skills, plugins' },
  { group: 'history', label: 'History & memory', hint: 'conversations and per-project memory' },
];
import { hub } from './hub.ts';

const TYPE_LABEL: Record<HarnessType, string> = {
  'claude-code': 'Claude Code',
  'agent-sdk': 'Agent SDK script',
  'local-model': 'Local model',
  custom: 'Custom command',
};

// Fields each type's config takes.
const FIELDS: Record<HarnessType, { key: string; label: string; placeholder: string; optional?: boolean }[]> = {
  'claude-code': [],
  'agent-sdk': [
    { key: 'script', label: 'Script', placeholder: 'blank = built-in starter (packages/runner/sdk-agent.mjs)', optional: true },
    { key: 'model', label: 'Model', placeholder: 'blank = SDK default', optional: true },
  ],
  'local-model': [
    { key: 'baseUrl', label: 'Server URL', placeholder: 'http://localhost:11434/v1' },
    { key: 'model', label: 'Model', placeholder: 'llama3.1' },
    { key: 'apiKey', label: 'API key', placeholder: 'only if the server needs one', optional: true },
  ],
  custom: [{ key: 'command', label: 'Command', placeholder: 'e.g. aider --model ollama/llama3.1' }],
};

type Draft = Omit<Harness, 'id' | 'builtin'> & { id?: string };

// onLogin opens a sign-in pane for a Claude account (needs an open project).
// onTokenPane opens a pane that runs `claude setup-token` for a token account.
export function HarnessManager({
  onClose,
  onLogin,
  onTokenPane,
}: {
  onClose: () => void;
  onLogin: (harnessId: string) => void;
  onTokenPane: (harnessId: string) => void;
}) {
  const [harnesses, setHarnesses] = useState<Harness[]>([]);
  const [status, setStatus] = useState<Record<string, AccountStatus | 'error'>>({});
  const [newAccount, setNewAccount] = useState<string | null>(null);
  const [newMode, setNewMode] = useState<AccountMode>('folder');
  const [pasting, setPasting] = useState<{ id: string; value: string } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [servers, setServers] = useState<ModelServer[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const list = await hub.call('harness.list', {});
    setHarnesses(list);
    // Who is signed in to each Claude account.
    for (const h of list.filter((x) => x.type === 'claude-code')) {
      hub.call('account.status', { harnessId: h.id }).then(
        (st) => setStatus((m) => ({ ...m, [h.id]: st })),
        () => setStatus((m) => ({ ...m, [h.id]: 'error' })),
      );
    }
  }, []);
  useEffect(() => {
    void load();
    return hub.onPush((p) => {
      if (p.event === 'account.update') void load();
    });
  }, [load]);

  const addAccount = async () => {
    const name = newAccount?.trim();
    if (!name) return setNewAccount(null);
    let id: string | null = null;
    await run(async () => {
      id = (await hub.call('account.add', { name, mode: newMode })).id;
    });
    setNewAccount(null);
    if (id) (newMode === 'token' ? onTokenPane : onLogin)(id);
  };

  const saveToken = async () => {
    if (!pasting) return;
    if (await run(() => hub.call('account.setToken', { harnessId: pasting.id, token: pasting.value }))) setPasting(null);
  };

  const accountLine = (h: Harness) => {
    const st = status[h.id];
    if (!st) return 'checking…';
    if (st === 'error') return 'status unavailable';
    if (h.config.mode === 'token') return st.tokenHint ? `token …${st.tokenHint} saved · shares your main folder` : 'no token yet';
    return st.loggedIn ? `signed in as ${st.email ?? 'unknown'}` : 'not signed in';
  };
  const kindLabel = (h: Harness) =>
    h.config.mode === 'token' ? 'Token account' : h.config.configDir ? 'Separate-folder account' : 'Main Claude account';

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setError(null);
      await load();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  };

  const save = async () => {
    if (draft && (await run(() => hub.call('harness.save', { harness: draft })))) setDraft(null);
  };

  const detect = async () => {
    setServers(null);
    setServers(await hub.call('harness.detect', {}));
  };

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="search harness-manager" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="hm-head">
          <h2>Harnesses</h2>
          <span className="muted small">Agent programs Workbench can run. Each speaks the hook protocol in packages/runner/events.mjs.</span>
          <button className="hm-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <ul className="hm-list">
          {harnesses.map((h) => (
            <li key={h.id}>
              <label className="hm-toggle" title={h.builtin ? 'Always on' : h.enabled ? 'Turn off' : 'Turn on'}>
                <input
                  type="checkbox"
                  checked={h.enabled}
                  disabled={h.builtin}
                  onChange={(e) => void run(() => hub.call('harness.save', { harness: { ...h, enabled: e.target.checked } }))}
                />
              </label>
              <div className="hm-text">
                <span className="hm-name">{h.name}</span>
                <span className="muted small">
                  {h.type === 'claude-code' ? `${kindLabel(h)} · ${accountLine(h)}` : TYPE_LABEL[h.type]}
                  {h.config.model ? ` · ${h.config.model}` : ''}
                  {h.config.baseUrl ? ` · ${h.config.baseUrl}` : ''}
                  {h.config.command ? ` · ${h.config.command}` : ''}
                  {h.config.script ? ` · ${h.config.script}` : ''}
                </span>
                {h.sharing && (
                  <span className="hm-share">
                    Share with main:
                    {SHARE_LABELS.map((x) => (
                      <label key={x.group} title={x.hint}>
                        <input
                          type="checkbox"
                          checked={h.sharing![x.group]}
                          onChange={(e) =>
                            void run(() => hub.call('account.share', { harnessId: h.id, group: x.group, shared: e.target.checked }))
                          }
                        />
                        {x.label}
                      </label>
                    ))}
                  </span>
                )}
                {pasting?.id === h.id && (
                  <span className="hm-row hm-paste">
                    <input
                      autoFocus
                      type="password"
                      className="mono"
                      placeholder="sk-ant-oat…"
                      value={pasting.value}
                      onChange={(e) => setPasting({ id: h.id, value: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void saveToken();
                        if (e.key === 'Escape') setPasting(null);
                      }}
                    />
                    <button className="action primary" onClick={() => void saveToken()}>
                      Save to Keychain
                    </button>
                  </span>
                )}
              </div>
              {h.config.mode === 'token' && (
                <>
                  <button className="link" onClick={() => onTokenPane(h.id)} title="Run claude setup-token and capture the token">
                    Get token
                  </button>
                  <button className="link" onClick={() => setPasting({ id: h.id, value: '' })}>
                    Paste token
                  </button>
                </>
              )}
              {h.type === 'claude-code' && h.config.mode !== 'token' && status[h.id] && status[h.id] !== 'error' && !(status[h.id] as AccountStatus).loggedIn && (
                <button className="link" onClick={() => onLogin(h.id)}>
                  Sign in
                </button>
              )}
              {!h.builtin && (
                <>
                  <button className="link" onClick={() => setDraft({ ...h })}>
                    Edit
                  </button>
                  <button className="link danger" onClick={() => void run(() => hub.call('harness.delete', { id: h.id }))}>
                    Delete
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>

        {draft ? (
          <div className="hm-form">
            <div className="hm-row">
              {draft.type === 'claude-code' ? (
                <span className="hm-label">Claude account</span>
              ) : (
              <select
                value={draft.type}
                disabled={!!draft.id}
                onChange={(e) => setDraft({ ...draft, type: e.target.value as HarnessType, config: {} })}
              >
                {(['local-model', 'agent-sdk', 'custom'] as const).map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABEL[t]}
                  </option>
                ))}
              </select>
              )}
              <input placeholder="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </div>
            {FIELDS[draft.type].map((f) => (
              <div className="hm-row" key={f.key}>
                <span className="hm-label">{f.label}</span>
                <input
                  className="mono"
                  placeholder={f.placeholder}
                  value={draft.config[f.key] ?? ''}
                  onChange={(e) => setDraft({ ...draft, config: { ...draft.config, [f.key]: e.target.value } })}
                />
              </div>
            ))}
            <div className="hm-row">
              <button className="action primary" onClick={() => void save()}>
                Save
              </button>
              <button className="action" onClick={() => setDraft(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="hm-row hm-actions">
            <button
              className="action"
              onClick={() => setDraft({ type: 'local-model', name: 'Local model', enabled: true, config: { baseUrl: 'http://localhost:11434/v1', model: '' } })}
            >
              Add harness
            </button>
            <button className="action" onClick={() => setNewAccount('')}>
              Add Claude account
            </button>
            <button className="action" onClick={() => void detect()}>
              Find local model servers
            </button>
          </div>
        )}
        {newAccount !== null && (
          <div className="hm-form">
            <div className="hm-row">
              <span className="hm-label">Account</span>
              <select value={newMode} onChange={(e) => setNewMode(e.target.value as AccountMode)}>
                <option value="folder">Separate folder (own sign-in)</option>
                <option value="token">Main folder + token (shares everything)</option>
              </select>
              <input
                autoFocus
                placeholder="A name for it, e.g. Work"
                value={newAccount}
                onChange={(e) => setNewAccount(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void addAccount();
                  if (e.key === 'Escape') setNewAccount(null);
                }}
              />
              <button className="action primary" onClick={() => void addAccount()}>
                {newMode === 'token' ? 'Add & get token' : 'Add & sign in'}
              </button>
            </div>
            <p className="muted small">
              {newMode === 'token'
                ? "Uses your main Claude folder (same history, memory and settings) with this account's setup-token. Pick it with Credits in the title bar and new sessions run, and count, on it. Your main login is untouched; the token is kept in the macOS Keychain."
                : 'Gets its own Claude folder and sign-in. Nothing is shared unless you switch it on below (instructions & settings, agents & skills, history & memory).'}
            </p>
          </div>
        )}

        {servers && (
          <div className="hm-servers">
            {servers.length === 0 && <p className="muted small">No Ollama, LM Studio or llama.cpp server answered on localhost.</p>}
            {servers.map((s) => (
              <div key={s.baseUrl}>
                <div className="small">
                  <b>{s.name}</b> <span className="muted">{s.baseUrl}</span>
                </div>
                {s.models.map((m) => (
                  <button
                    key={m}
                    className="link"
                    onClick={() =>
                      setDraft({ type: 'local-model', name: `${s.name} · ${m.split('/').pop()}`, enabled: true, config: { baseUrl: s.baseUrl, model: m } })
                    }
                  >
                    + {m}
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
        {error && <div className="error">{error}</div>}
      </div>
    </div>
  );
}
