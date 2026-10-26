import { useCallback, useEffect, useState } from 'react';
import type { Harness, McpHealth, McpScope, McpServer, Project } from '@workbench/shared';
import { hub } from './hub.ts';

const SECTIONS: { scope: McpScope; title: string; hint: string }[] = [
  { scope: 'user', title: 'Everywhere', hint: 'every project, just you' },
  { scope: 'local', title: 'This project · just you', hint: 'this folder only, not shared' },
  { scope: 'project', title: 'This project · shared', hint: ".mcp.json in the folder — anyone with the repo gets it" },
  { scope: 'other', title: 'claude.ai connectors & plugins', hint: 'added at claude.ai or by a plugin; switch them off per project here' },
];

const STATE_LABEL: Record<McpHealth['state'], string> = {
  connected: 'connected',
  'needs-auth': 'needs sign-in',
  failed: 'failed',
  pending: 'waiting for approval',
  disabled: 'off here',
  unknown: 'unknown',
};

interface Draft {
  was?: { name: string; scope: McpScope };
  name: string;
  scope: McpScope;
  transport: 'stdio' | 'http' | 'sse';
  command: string;
  args: string; // one per line
  env: string; // KEY=value per line
  url: string;
  headers: string; // Name: value per line
}

const blank = (scope: McpScope): Draft => ({ name: '', scope, transport: 'http', command: '', args: '', env: '', url: '', headers: '' });

const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);
const pairs = (s: string, sep: string) =>
  Object.fromEntries(
    lines(s)
      .map((l) => [l.slice(0, l.indexOf(sep)).trim(), l.slice(l.indexOf(sep) + 1).trim()])
      .filter(([k]) => k),
  );
const unpairs = (m: unknown, sep: string) =>
  Object.entries((m as Record<string, string>) ?? {})
    .map(([k, v]) => `${k}${sep}${v}`)
    .join('\n');

function toDraft(s: McpServer): Draft {
  const c = s.config;
  const transport = (s.transport === 'sse' || s.transport === 'http' ? s.transport : 'stdio') as Draft['transport'];
  return {
    was: { name: s.name, scope: s.scope },
    name: s.name,
    scope: s.scope,
    transport,
    command: String(c.command ?? ''),
    args: ((c.args as string[]) ?? []).join('\n'),
    env: unpairs(c.env, '='),
    url: String(c.url ?? ''),
    headers: unpairs(c.headers, ': '),
  };
}

function toConfig(d: Draft): Record<string, unknown> {
  if (d.transport === 'stdio') return { type: 'stdio', command: d.command.trim(), args: lines(d.args), env: pairs(d.env, '=') };
  return { type: d.transport, url: d.url.trim(), headers: pairs(d.headers, ':') };
}

// Pasted setup snippets come as {"mcpServers": {name: {...}}} or {name: {...}}.
function parsePasted(text: string): [string, Record<string, unknown>][] {
  const j = JSON.parse(text) as Record<string, unknown>;
  const servers = (j.mcpServers ?? j) as Record<string, Record<string, unknown>>;
  const out = Object.entries(servers).filter(([, v]) => v && typeof v === 'object' && (v.command || v.url));
  if (!out.length) throw new Error('no servers found in that JSON (expected {"mcpServers": {"name": {...}}})');
  return out.map(([n, v]) => [n, { ...v, type: v.type ?? (v.url ? 'http' : 'stdio') }]);
}

// onLogin opens a pane running `claude mcp login` (needs an open project).
export function McpManager({
  project,
  onClose,
  onLogin,
}: {
  project: Project | null;
  onClose: () => void;
  onLogin: (name: string, harnessId: string) => void;
}) {
  const projectId = project?.rootPath ? project.id : undefined;
  const [accounts, setAccounts] = useState<Harness[]>([]);
  const [harnessId, setHarnessId] = useState('claude-code');
  const [servers, setServers] = useState<McpServer[]>([]);
  const [health, setHealth] = useState<McpHealth[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pasting, setPasting] = useState<{ scope: McpScope; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const where = { projectId, harnessId };

  const load = useCallback(async () => {
    setServers(await hub.call('mcp.list', { projectId, harnessId }));
  }, [projectId, harnessId]);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      setHealth(await hub.call('mcp.health', { projectId, harnessId }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setChecking(false);
    }
  }, [projectId, harnessId]);

  useEffect(() => {
    void hub.call('harness.list', {}).then((l) => setAccounts(l.filter((h) => h.type === 'claude-code' && (h.builtin || h.config.configDir))));
  }, []);
  useEffect(() => {
    setHealth(null);
    void load().catch((err) => setError((err as Error).message));
    void check();
  }, [load, check]);

  const run = async (fn: () => Promise<unknown>, recheck = false) => {
    try {
      await fn();
      setError(null);
      await load();
      if (recheck) void check();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  };

  const save = async () => {
    if (!draft) return;
    const ok = await run(
      () => hub.call('mcp.save', { ...where, name: draft.name.trim(), scope: draft.scope, config: toConfig(draft), was: draft.was }),
      true,
    );
    if (ok) setDraft(null);
  };

  const importPasted = async () => {
    if (!pasting) return;
    const ok = await run(async () => {
      for (const [name, config] of parsePasted(pasting.text)) await hub.call('mcp.save', { ...where, name, scope: pasting.scope, config });
    }, true);
    if (ok) setPasting(null);
  };

  // Configured servers, plus anything else Claude loads here (connectors, plugins).
  const healthOf = (name: string) => health?.find((h) => h.name === name);
  const others: McpServer[] = (health ?? [])
    .filter((h) => !servers.some((s) => s.name === h.name))
    .map((h) => ({ name: h.name, scope: 'other', transport: '', target: h.target, config: {}, enabled: h.state !== 'disabled' }));
  const all = [...servers, ...others];

  const statusText = (s: McpServer) => {
    if (s.approval === 'rejected') return 'rejected';
    const h = healthOf(s.name);
    if (!h) return checking ? 'checking…' : '';
    // Claude only honours approvals in a folder it trusts (verified on 2.1.310).
    if (h.state === 'pending' && s.approval === 'approved') return 'approved — start Claude in this folder once to trust it';
    return h.state === 'failed' && h.detail ? `failed — ${h.detail}` : STATE_LABEL[h.state];
  };

  const row = (s: McpServer) => {
    const h = healthOf(s.name);
    const remote = s.scope === 'other' || s.transport === 'http' || s.transport === 'sse';
    return (
      <li key={`${s.scope}:${s.name}`}>
        {projectId && (
          <label className="hm-toggle" title={s.enabled ? 'On in this project — click to switch off here' : 'Off in this project'}>
            <input type="checkbox" checked={s.enabled} onChange={(e) => void run(() => hub.call('mcp.setEnabled', { ...where, projectId, name: s.name, enabled: e.target.checked }), true)} />
          </label>
        )}
        <div className="hm-text">
          <span className="hm-name mcp-name">
            {s.name}{' '}
            <span className={`mcp-state ${h?.state ?? ''}`} title={statusText(s)}>
              {statusText(s)}
            </span>
          </span>
          <span className="muted small mono" title={s.target}>
            {s.transport && `${s.transport} · `}
            {s.target}
          </span>
        </div>
        {projectId && s.approval === 'pending' && (
          <>
            <button className="link" onClick={() => void run(() => hub.call('mcp.setApproval', { ...where, projectId, name: s.name, approved: true }), true)}>
              Approve
            </button>
            <button className="link" onClick={() => void run(() => hub.call('mcp.setApproval', { ...where, projectId, name: s.name, approved: false }), true)}>
              Reject
            </button>
          </>
        )}
        {projectId && s.approval === 'rejected' && (
          <button className="link" onClick={() => void run(() => hub.call('mcp.setApproval', { ...where, projectId, name: s.name, approved: true }), true)}>
            Approve
          </button>
        )}
        {h?.state === 'needs-auth' && (
          <button className="link" onClick={() => (projectId ? onLogin(s.name, harnessId) : setError('Open a project first — the sign-in runs in one of its panes.'))}>
            Sign in
          </button>
        )}
        {remote && h?.state === 'connected' && (
          <button className="link" title="Forget this server's saved sign-in" onClick={() => void run(() => hub.call('mcp.logout', { ...where, name: s.name }), true)}>
            Sign out
          </button>
        )}
        {s.scope !== 'other' && (
          <>
            <button className="link" onClick={() => setDraft(toDraft(s))}>
              Edit
            </button>
            <button className="link danger" onClick={() => void run(() => hub.call('mcp.remove', { ...where, name: s.name, scope: s.scope }), true)}>
              Remove
            </button>
          </>
        )}
      </li>
    );
  };

  const scopes = SECTIONS.filter((x) => x.scope === 'user' || x.scope === 'other' || projectId);
  const editable = scopes.filter((x) => x.scope !== 'other');

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="search harness-manager" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="hm-head">
          <h2>MCP servers</h2>
          <span className="muted small">
            {projectId ? `What Claude loads in ${project!.name}` : 'Open a project to see its servers too'}
          </span>
          <button className="hm-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="hm-row hm-actions">
          {accounts.length > 1 && (
            <select value={harnessId} onChange={(e) => setHarnessId(e.target.value)} title="Each separate-folder account has its own MCP setup">
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
          <button className="action" onClick={() => void check()} disabled={checking}>
            {checking ? 'Checking…' : 'Check connections'}
          </button>
          <span className="muted small">Changes apply to Claude sessions started (or resumed) after this.</span>
        </div>

        {scopes.map((sec) => {
          const items = all.filter((s) => s.scope === sec.scope);
          if (sec.scope === 'other' && !items.length) return null;
          return (
            <div key={sec.scope} className="mcp-section">
              <div className="mcp-section-head">
                <b>{sec.title}</b> <span className="muted small">{sec.hint}</span>
                {sec.scope === 'other' && (
                  <a className="link small" href="https://claude.ai/settings/connectors" target="_blank" rel="noreferrer">
                    Manage connectors at claude.ai
                  </a>
                )}
              </div>
              {items.length ? <ul className="hm-list">{items.map(row)}</ul> : <p className="muted small mcp-empty">None.</p>}
            </div>
          );
        })}

        {draft ? (
          <div className="hm-form">
            <div className="hm-row">
              <span className="hm-label">Name</span>
              <input autoFocus className="mono" placeholder="e.g. github" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              <select value={draft.scope} onChange={(e) => setDraft({ ...draft, scope: e.target.value as McpScope })}>
                {editable.map((x) => (
                  <option key={x.scope} value={x.scope}>
                    {x.title}
                  </option>
                ))}
              </select>
            </div>
            <div className="hm-row">
              <span className="hm-label">Type</span>
              <select value={draft.transport} onChange={(e) => setDraft({ ...draft, transport: e.target.value as Draft['transport'] })}>
                <option value="http">Remote (HTTP)</option>
                <option value="sse">Remote (SSE)</option>
                <option value="stdio">Local command (stdio)</option>
              </select>
            </div>
            {draft.transport === 'stdio' ? (
              <>
                <div className="hm-row">
                  <span className="hm-label">Command</span>
                  <input className="mono" placeholder="npx" value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })} />
                </div>
                <div className="hm-row">
                  <span className="hm-label">Arguments</span>
                  <textarea className="mono" rows={3} placeholder={'one per line\n-y\n@modelcontextprotocol/server-filesystem'} value={draft.args} onChange={(e) => setDraft({ ...draft, args: e.target.value })} />
                </div>
                <div className="hm-row">
                  <span className="hm-label">Environment</span>
                  <textarea className="mono" rows={2} placeholder="API_KEY=…  (one per line)" value={draft.env} onChange={(e) => setDraft({ ...draft, env: e.target.value })} />
                </div>
              </>
            ) : (
              <>
                <div className="hm-row">
                  <span className="hm-label">URL</span>
                  <input className="mono" placeholder="https://…/mcp" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} />
                </div>
                <div className="hm-row">
                  <span className="hm-label">Headers</span>
                  <textarea className="mono" rows={2} placeholder="Authorization: Bearer …  (one per line; blank if it signs in)" value={draft.headers} onChange={(e) => setDraft({ ...draft, headers: e.target.value })} />
                </div>
              </>
            )}
            <div className="hm-row">
              <button className="action primary" onClick={() => void save()}>
                Save
              </button>
              <button className="action" onClick={() => setDraft(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : pasting ? (
          <div className="hm-form">
            <div className="hm-row">
              <textarea
                autoFocus
                className="mono"
                rows={7}
                placeholder={'Paste a setup snippet:\n{ "mcpServers": { "name": { "command": "npx", "args": [...] } } }'}
                value={pasting.text}
                onChange={(e) => setPasting({ ...pasting, text: e.target.value })}
              />
            </div>
            <div className="hm-row">
              <span className="hm-label">Add to</span>
              <select value={pasting.scope} onChange={(e) => setPasting({ ...pasting, scope: e.target.value as McpScope })}>
                {editable.map((x) => (
                  <option key={x.scope} value={x.scope}>
                    {x.title}
                  </option>
                ))}
              </select>
              <button className="action primary" onClick={() => void importPasted()}>
                Add
              </button>
              <button className="action" onClick={() => setPasting(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="hm-row hm-actions">
            <button className="action" onClick={() => setDraft(blank('user'))}>
              Add server
            </button>
            <button className="action" onClick={() => setPasting({ scope: 'user', text: '' })}>
              Paste JSON
            </button>
          </div>
        )}
        {error && <div className="error">{error}</div>}
      </div>
    </div>
  );
}
