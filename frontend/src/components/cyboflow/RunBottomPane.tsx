/**
 * Three-tab shell wrapping the run view content. Tab state is local; cyboflowStore
 * is unchanged. Chat and Terminal tabs are placeholders to be filled by TASK-761
 * (RunChatView) and a future Terminal-integration task.
 */
import { useMemo, useState } from 'react';
import { RunView } from './RunView';
import { RunChatView } from './RunChatView';
import { DemoTerminalView } from './DemoTerminalView';
import { InteractiveTerminalView } from './InteractiveTerminalView';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { useConfigStore } from '../../stores/configStore';
import { useActiveRunsStore } from '../../stores/activeRunsStore';

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

const CHAT_TAB = { id: 'chat', label: 'Chat' } as const;
const TERMINAL_TAB = { id: 'terminal', label: 'Terminal' } as const;
const DATA_STREAM_TAB = { id: 'data-stream', label: 'Data Stream' } as const;

// ---------------------------------------------------------------------------
// RunBottomPane
// ---------------------------------------------------------------------------

export function RunBottomPane() {
  // Default to the unified Chat transcript so a run opens to the same rich
  // experience as a quick session. Data Stream (raw event log) and Terminal
  // remain available as secondary tabs.
  const [activeTab, setActiveTab] = useState<TabId>('chat');
  const activeRunId = useCyboflowStore((s) => s.activeRunId);
  // Demo mode swaps the Terminal tab for a canned, scripted Claude Code terminal
  // so the PTY surface can be illustrated end-to-end.
  const demoModeEnabled = useConfigStore((s) => s.config?.demoMode ?? false);

  // Resolve the run's substrate the same way RunChatView does (scan the
  // active-runs rows for this run id). Only the interactive substrate has a live
  // PTY; an SDK run executes in-process and has NO terminal — so the Terminal
  // tab was a dead "coming soon" placeholder for SDK runs. Offer the Terminal
  // tab ONLY when a terminal actually exists (interactive run, or demo mode).
  const runsByProject = useActiveRunsStore((s) => s.runsByProject);
  const isInteractive = useMemo(() => {
    if (activeRunId === null) return false;
    for (const rows of Object.values(runsByProject)) {
      const found = rows.find((r) => r.id === activeRunId);
      if (found) return found.substrate === 'interactive';
    }
    return false;
  }, [activeRunId, runsByProject]);
  const terminalAvailable = demoModeEnabled || isInteractive;

  const tabs = useMemo(
    () => (terminalAvailable ? [CHAT_TAB, TERMINAL_TAB, DATA_STREAM_TAB] : [CHAT_TAB, DATA_STREAM_TAB]),
    [terminalAvailable],
  );
  // If the terminal tab vanished (e.g. an SDK run replaced an interactive one)
  // while it was active, fall back to Chat so the pane never renders an
  // unavailable tab.
  const effectiveTab: TabId = activeTab === 'terminal' && !terminalAvailable ? 'chat' : activeTab;

  return (
    <div className="flex h-full flex-col">
      <LocalTabBar tabs={tabs} activeTab={effectiveTab} onTabChange={setActiveTab} />
      <div role="tabpanel" className="flex-1 overflow-auto">
        {effectiveTab === 'data-stream' && <RunView />}
        {effectiveTab === 'terminal' && terminalAvailable && (
          demoModeEnabled ? (
            <div className="h-full" data-testid="run-bottom-pane-terminal-demo">
              <DemoTerminalView />
            </div>
          ) : (
            <div className="h-full" data-testid="run-bottom-pane-terminal-interactive">
              {activeRunId !== null && <InteractiveTerminalView runId={activeRunId} />}
            </div>
          )
        )}
        {effectiveTab === 'chat' && <RunChatView runId={activeRunId} />}
      </div>
    </div>
  );
}
