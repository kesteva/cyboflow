/**
 * Tab shell wrapping the run view content. Tab state is local; cyboflowStore is
 * unchanged.
 *
 * Tabs:
 *   - Chat        — the unified run transcript (default).
 *   - Agent       — the live AGENT PTY (interactive substrate) or the scripted
 *                   demo terminal. Present ONLY when such a terminal exists
 *                   (interactive run, or demo mode); SDK runs have no agent PTY.
 *   - Shell       — a PLAIN user shell ($SHELL) in the run's worktree, for running
 *                   commands against the code a flow built (e.g. a dev server).
 *                   ALWAYS available, every substrate. Distinct process + lifecycle
 *                   from the agent terminal: it survives run completion.
 *   - Data Stream — the raw event log.
 */
import { useMemo, useState } from 'react';
import { RunView } from './RunView';
import { RunChatView } from './RunChatView';
import { DemoTerminalView } from './DemoTerminalView';
import { InteractiveTerminalView } from './InteractiveTerminalView';
import { RunShellTerminalView } from './RunShellTerminalView';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { useConfigStore } from '../../stores/configStore';
import { useActiveRunsStore } from '../../stores/activeRunsStore';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TabId = 'chat' | 'agent' | 'shell' | 'data-stream';

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
const AGENT_TAB = { id: 'agent', label: 'Agent' } as const;
const SHELL_TAB = { id: 'shell', label: 'Shell' } as const;
const DATA_STREAM_TAB = { id: 'data-stream', label: 'Data Stream' } as const;

// ---------------------------------------------------------------------------
// RunBottomPane
// ---------------------------------------------------------------------------

export function RunBottomPane() {
  // Default to the unified Chat transcript so a run opens to the same rich
  // experience as a quick session.
  const [activeTab, setActiveTab] = useState<TabId>('chat');
  const activeRunId = useCyboflowStore((s) => s.activeRunId);
  // Demo mode swaps the Agent tab for a canned, scripted Claude Code terminal so
  // the PTY surface can be illustrated end-to-end.
  const demoModeEnabled = useConfigStore((s) => s.config?.demoMode ?? false);

  // Resolve the run's substrate the same way RunChatView does (scan the
  // active-runs rows for this run id). Only the interactive substrate has a live
  // AGENT PTY; an SDK run's agent executes in-process and has none — so the Agent
  // tab is offered ONLY when an agent terminal actually exists (interactive run,
  // or demo mode). The Shell tab is independent of this and always present.
  const runsByProject = useActiveRunsStore((s) => s.runsByProject);
  const isInteractive = useMemo(() => {
    if (activeRunId === null) return false;
    for (const rows of Object.values(runsByProject)) {
      const found = rows.find((r) => r.id === activeRunId);
      if (found) return found.substrate === 'interactive';
    }
    return false;
  }, [activeRunId, runsByProject]);
  const agentTerminalAvailable = demoModeEnabled || isInteractive;

  const tabs = useMemo(
    () => [
      CHAT_TAB,
      ...(agentTerminalAvailable ? [AGENT_TAB] : []),
      SHELL_TAB,
      DATA_STREAM_TAB,
    ],
    [agentTerminalAvailable],
  );
  // If the Agent tab vanished (e.g. an SDK run replaced an interactive one) while
  // it was active, fall back to Chat so the pane never renders an unavailable tab.
  // The Shell tab is always available, so it never needs a fallback.
  const effectiveTab: TabId = activeTab === 'agent' && !agentTerminalAvailable ? 'chat' : activeTab;

  return (
    <div className="flex h-full flex-col">
      <LocalTabBar tabs={tabs} activeTab={effectiveTab} onTabChange={setActiveTab} />
      <div role="tabpanel" className="flex-1 overflow-auto">
        {effectiveTab === 'data-stream' && <RunView />}
        {effectiveTab === 'agent' && agentTerminalAvailable && (
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
        {effectiveTab === 'shell' && (
          <div className="h-full" data-testid="run-bottom-pane-terminal-shell">
            {activeRunId !== null ? (
              <RunShellTerminalView runId={activeRunId} />
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-text-tertiary">
                No active run.
              </div>
            )}
          </div>
        )}
        {effectiveTab === 'chat' && <RunChatView runId={activeRunId} />}
      </div>
    </div>
  );
}
