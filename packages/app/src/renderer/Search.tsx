import { useEffect, useRef, useState } from 'react';
import type { Project, SearchHit } from '@workbench/shared';
import { hub } from './hub.ts';

const SOURCE_LABEL = { agent: 'Agent', terminal: 'Terminal', transcript: 'Claude', commit: 'Commit', error: 'Error' } as const;

const ago = (t: number | null) => {
  if (!t) return '';
  const s = (Date.now() - t) / 1000;
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

// snippet() marks matches with \u0001…\u0002.
function Snippet({ text }: { text: string }) {
  const parts = text.replace(/\s+/g, ' ').split(/(\u0001[^\u0002]*\u0002)/);
  return (
    <span className="hit-snippet">
      {parts.map((p, i) => (p.startsWith('\u0001') ? <mark key={i}>{p.slice(1, -1)}</mark> : <span key={i}>{p}</span>))}
    </span>
  );
}

interface Props {
  project: Project | null;
  onOpen: (hit: SearchHit) => void;
  onClose: () => void;
}

export function Search({ project, onOpen, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [scopeAll, setScopeAll] = useState(!project);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [hitsFor, setHitsFor] = useState(''); // the query+scope these hits answer
  const [enterQueued, setEnterQueued] = useState(false);
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);

  const key = `${scopeAll ? '*' : project?.id}:${query.trim()}`;
  const fresh = hitsFor === key;

  useEffect(() => {
    if (!query.trim()) {
      setHits([]);
      setHitsFor(key);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      hub
        .call('history.search', { query, projectId: scopeAll ? undefined : project?.id })
        .then(
          (h) => {
            if (cancelled) return;
            setHits(h);
            setHitsFor(key);
            setActive(0);
          },
          () => {
            if (cancelled) return;
            setHits([]);
            setHitsFor(key);
          },
        );
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    list.current?.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (h: SearchHit | undefined) => {
    if (!h) return;
    onOpen(h);
    onClose();
  };

  // Enter pressed before results for the current query arrived: act when they do.
  useEffect(() => {
    if (enterQueued && fresh) {
      setEnterQueued(false);
      choose(hits[0]);
    }
  }, [enterQueued, fresh]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="search" onMouseDown={(e) => e.stopPropagation()}>
        <div className="search-head">
          <input
            autoFocus
            placeholder="Search terminals, agents and Claude conversations…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, hits.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === 'Enter') {
                if (fresh) choose(hits[active]);
                else setEnterQueued(true);
              }
            }}
          />
          <div className="scope">
            <button className={!scopeAll ? 'on' : ''} disabled={!project} onClick={() => setScopeAll(false)}>
              {project ? project.name : 'This project'}
            </button>
            <button className={scopeAll ? 'on' : ''} onClick={() => setScopeAll(true)}>
              All
            </button>
          </div>
        </div>
        <ul className={`hits ${fresh ? '' : 'stale'}`} ref={list}>
          {hits.map((h, i) => (
            <li key={`${h.source}:${h.sessionId ?? h.transcriptId}:${h.ts}`}>
              <button className={i === active ? 'active' : ''} onMouseEnter={() => setActive(i)} onClick={() => choose(h)}>
                <span className="hit-top">
                  <span className={`badge ${h.source}`}>{SOURCE_LABEL[h.source]}</span>
                  <span className="hit-title">{h.title}</span>
                  <span className="hit-meta">
                    {h.where} · {ago(h.ts)}
                  </span>
                </span>
                <Snippet text={h.snippet} />
              </button>
            </li>
          ))}
          {query.trim() && fresh && hits.length === 0 && <li className="empty">No matches</li>}
        </ul>
      </div>
    </div>
  );
}
