/**
 * Chat / Data Stream switcher for a worktree-backed quick-session dock.
 *
 * Both panels remain mounted for the component's entire lifetime. In particular,
 * the chat panel can own a live xterm whose PTY subscription and scrollback must
 * survive tab switches; visibility is therefore controlled with display:none,
 * never conditional JSX.
 */
import { useState, type ReactElement, type ReactNode } from 'react';
import { RunView } from './RunView';

interface QuickSessionDockTabsProps {
  chatContent: ReactNode;
  runId: string | null;
}

type QuickDockTab = 'chat' | 'data-stream';

export function QuickSessionDockTabs({
  chatContent,
  runId,
}: QuickSessionDockTabsProps): ReactElement {
  const [activeTab, setActiveTab] = useState<QuickDockTab>('chat');

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="quick-session-dock-tabs">
      <div
        className="flex flex-none items-center gap-1 border-b border-border-primary px-2 py-1"
        role="tablist"
        aria-label="Quick session dock"
      >
        {(['chat', 'data-stream'] as const).map((tab) => {
          const active = activeTab === tab;
          const label = tab === 'chat' ? 'Chat' : 'Data Stream';
          return (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={`quick-session-dock-panel-${tab}`}
              id={`quick-session-dock-tab-${tab}`}
              onClick={() => setActiveTab(tab)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle ${
                active
                  ? 'bg-interactive text-text-on-interactive'
                  : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1">
        <div
          id="quick-session-dock-panel-chat"
          role="tabpanel"
          aria-labelledby="quick-session-dock-tab-chat"
          className="h-full min-h-0 flex-col"
          style={{ display: activeTab === 'chat' ? 'flex' : 'none' }}
          data-testid="quick-session-dock-chat-panel"
        >
          {chatContent}
        </div>
        <div
          id="quick-session-dock-panel-data-stream"
          role="tabpanel"
          aria-labelledby="quick-session-dock-tab-data-stream"
          className="h-full min-h-0 p-2"
          style={{ display: activeTab === 'data-stream' ? 'block' : 'none' }}
          data-testid="quick-session-dock-data-stream-panel"
        >
          <RunView runId={runId} />
        </div>
      </div>
    </div>
  );
}
