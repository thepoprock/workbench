import { useEffect, useState } from 'react';
import type { IDockviewPanelHeaderProps } from 'dockview-react';
import type { TerminalParams } from './TerminalPane.tsx';
import { hub } from './hub.ts';

// Closing a terminal tab is the one explicit "I'm done" — it kills the shell.
// Switching projects or quitting the app only detaches.
export function Tab({ api, params }: IDockviewPanelHeaderProps<TerminalParams>) {
  const [title, setTitle] = useState(api.title ?? '');
  useEffect(() => {
    const d = api.onDidTitleChange((e) => setTitle(e.title));
    return () => d.dispose();
  }, [api]);

  const close = (e: React.MouseEvent) => {
    e.stopPropagation();
    hub.notify('term.kill', { sessionId: params.sessionId });
    api.close();
  };

  return (
    <div
      className="tab"
      onMouseDown={(e) => {
        if (e.button === 1) close(e); // middle-click
      }}
      title={title}
    >
      <span className="tab-title">{title}</span>
      <button className="tab-close" onMouseDown={(e) => e.stopPropagation()} onClick={close} aria-label="Close terminal">
        ×
      </button>
    </div>
  );
}
