/**
 * Three-tab shell wrapping the run view content. Tab state is local; cyboflowStore
 * is unchanged. Chat and Terminal tabs are placeholders to be filled by TASK-761
 * (RunChatView) and a future Terminal-integration task.
 */
import { useState } from 'react';
import { RunView } from './RunView';
import { RunChatView } from './RunChatView';
import { useCyboflowStore } from '../../stores/cyboflowStore';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TabId = 'chat' | 'terminal' | 'data-stream';

interface LocalTabBarProps {
  tabs: ReadonlyArray<{ id: TabId; label: string }>;
  activeTab: TabId;
  onTabChange: (id: TabId) => void;
}

// ---------------------------------------------------------------------------
// LocalTabBar — private to this module
// ---------------------------------------------------------------------------

function LocalTabBar({ tabs, activeTab, onTabChange }: LocalTabBarProps) {
  return (
    <div
      role="tablist"
      className="flex border-b border-border-primary bg-bg-secondary"
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            data-testid={`run-bottom-pane-tab-${tab.id}`}
            onClick={() => onTabChange(tab.id)}
            className={
              isActive
                ? 'border-b-2 border-interactive px-4 py-2 text-sm font-medium text-text-primary'
                : 'px-4 py-2 text-sm font-medium text-text-secondary hover:text-text-primary'
            }
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab definitions
// ---------------------------------------------------------------------------

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'chat', label: 'Chat' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'data-stream', label: 'Data Stream' },
];

// ---------------------------------------------------------------------------
// RunBottomPane
// ---------------------------------------------------------------------------

export function RunBottomPane() {
  // Default to the unified Chat transcript so a run opens to the same rich
  // experience as a quick session. Data Stream (raw event log) and Terminal
  // remain available as secondary tabs.
  const [activeTab, setActiveTab] = useState<TabId>('chat');
  const activeRunId = useCyboflowStore((s) => s.activeRunId);

  return (
    <div className="flex h-full flex-col">
      <LocalTabBar tabs={TABS} activeTab={activeTab} onTabChange={setActiveTab} />
      <div role="tabpanel" className="flex-1 overflow-auto">
        {activeTab === 'data-stream' && <RunView />}
        {activeTab === 'terminal' && (
          <div
            data-testid="run-bottom-pane-terminal-placeholder"
            className="p-4 text-sm text-text-secondary"
          >
            Terminal — coming soon
          </div>
        )}
        {activeTab === 'chat' && <RunChatView runId={activeRunId} />}
      </div>
    </div>
  );
}
