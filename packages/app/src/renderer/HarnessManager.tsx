import { useCallback, useEffect, useState } from 'react';
import type { Harness, HarnessType, ModelServer } from '@workbench/shared';
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

export function HarnessManager({ onClose }: { onClose: () => void }) {
  const [harnesses, setHarnesses] = useState<Harness[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [servers, setServers] = useState<ModelServer[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => setHarnesses(await hub.call('harness.list', {})), []);
  useEffect(() => void load(), [load]);

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
                  {TYPE_LABEL[h.type]}
                  {h.config.model ? ` · ${h.config.model}` : ''}
                  {h.config.baseUrl ? ` · ${h.config.baseUrl}` : ''}
                  {h.config.command ? ` · ${h.config.command}` : ''}
                  {h.config.script ? ` · ${h.config.script}` : ''}
                </span>
              </div>
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
            <button className="action" onClick={() => void detect()}>
              Find local model servers
            </button>
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
