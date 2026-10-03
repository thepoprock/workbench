import { useEffect, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';

export interface RemoteParams {
  url: string; // a claude.ai/code page: the session list or one Remote Control session
}

const HOME = 'https://claude.ai/code';
const isClaudeUrl = (u: string) => /^https:\/\/([a-z0-9-]+\.)*claude\.ai(\/|$)/i.test(u);

type WebviewEl = HTMLElement & {
  src: string;
  getURL(): string;
  canGoBack(): boolean;
  goBack(): void;
  reload(): void;
};

// Remote Control sessions (this Mac, the Windows PC, anywhere) driven through
// claude.ai inside Workbench. Sandboxed by the main process: own partition,
// no preload, claude.ai and sign-in hosts only. Sign in once; it persists.
export function RemotePane({ params, api }: IDockviewPanelProps<RemoteParams>) {
  const view = useRef<WebviewEl | null>(null);
  const [address, setAddress] = useState(params.url);
  const [loading, setLoading] = useState(true);
  const ready = useRef(false); // webview methods throw until dom-ready

  // Retargeted by "Open on claude.ai" from an agent row.
  useEffect(() => {
    if (view.current && ready.current && isClaudeUrl(params.url) && params.url !== view.current.getURL()) {
      view.current.src = params.url;
    }
    setAddress(params.url);
  }, [params.url]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const nav = () => {
      setAddress(v.getURL());
      setLoading(false);
    };
    const title = (e: Event) => api.setTitle(`Remote · ${(e as Event & { title: string }).title || 'claude.ai'}`);
    const start = () => setLoading(true);
    const domReady = () => {
      ready.current = true;
      nav();
    };
    v.addEventListener('dom-ready', domReady);
    v.addEventListener('did-navigate', nav);
    v.addEventListener('did-navigate-in-page', nav);
    v.addEventListener('did-stop-loading', nav);
    v.addEventListener('did-start-loading', start);
    v.addEventListener('page-title-updated', title);
    return () => {
      v.removeEventListener('dom-ready', domReady);
      v.removeEventListener('did-navigate', nav);
      v.removeEventListener('did-navigate-in-page', nav);
      v.removeEventListener('did-stop-loading', nav);
      v.removeEventListener('did-start-loading', start);
      v.removeEventListener('page-title-updated', title);
    };
  }, [api]);

  const go = (url: string) => {
    const u = url.trim();
    if (view.current && isClaudeUrl(u)) view.current.src = u;
  };

  return (
    <div className="remote-pane">
      <div className="history-bar">
        <button onClick={() => ready.current && view.current?.canGoBack() && view.current.goBack()} title="Back">
          ◀
        </button>
        <button onClick={() => ready.current && view.current?.reload()} title="Reload">
          ↻
        </button>
        <button onClick={() => go(HOME)} title="All your sessions on claude.ai">
          Sessions
        </button>
        <input
          className="note-input mono"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && go(address)}
          placeholder="Paste a claude.ai/code/session_… link"
          spellCheck={false}
        />
        <span className="history-status">{loading ? 'loading…' : ''}</span>
      </div>
      {/* webview attributes are validated and locked down by the main process */}
      <webview ref={view as never} className="remote-view" src={isClaudeUrl(params.url) ? params.url : HOME} />
    </div>
  );
}
