/**
 * Three-tab shell wrapping the run view content. Tab state is local; cyboflowStore
 * is unchanged. Chat and Terminal tabs are placeholders to be filled by TASK-761
 * (RunChatView) and a future Terminal-integration task.
 */
import { useState } from 'react';
import { RunView } from './RunView';
import { RunChatView } from './RunChatView';
import { DemoTerminalView } from './DemoTerminalView';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { useConfigStore } from '../../stores/configStore';

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
                ? 'border-b-2 border-interactive px-4 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-text-primary'
                : 'px-4 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-text-tertiary hover:text-text-primary'
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
  // Demo mode swaps the "coming soon" Terminal placeholder for a canned, scripted
  // Claude Code terminal so the PTY surface can be illustrated end-to-end.
  const demoModeEnabled = useConfigStore((s) => s.config?.demoMode ?? false);

  return (
    <div className="flex h-full flex-col">
      <LocalTabBar tabs={TABS} activeTab={activeTab} onTabChange={setActiveTab} />
      <div role="tabpanel" className="flex-1 overflow-auto">
        {activeTab === 'data-stream' && <RunView />}
        {activeTab === 'terminal' &&
          (demoModeEnabled ? (
            <div className="h-full" data-testid="run-bottom-pane-terminal-demo">
              <DemoTerminalView />
            </div>
          ) : (
            <div
              data-testid="run-bottom-pane-terminal-placeholder"
              className="p-4 text-sm text-text-secondary"
            >
              Terminal — coming soon
            </div>
          ))}
        {activeTab === 'chat' && <RunChatView runId={activeRunId} />}
      </div>
    </div>
  );
}
