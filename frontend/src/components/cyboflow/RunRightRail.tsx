/**
 * RunRightRail — fixed-width right rail in the CyboflowRoot two-column layout.
 *
 * Contains three tabs:
 *   - Workflow Progress (default selected) — live WorkflowProgressTimeline (plus the
 *     per-task SprintLanesPanel for sprint runs) when activeRunId is non-null; neutral
 *     empty state otherwise.
 *   - File Explorer — live SessionFileExplorer (selected session's worktree tree +
 *     read-only viewer) when selectedSessionId is non-null; neutral empty state
 *     otherwise.
 *   - Diff — live working diff (CombinedDiffView) for the active quick session; neutral
 *     message when no session is active.
 */
import { useState } from 'react';
import { WorkflowProgressTimeline } from './WorkflowProgressTimeline';
import { SprintLanesPanel } from './SprintLanesPanel';
import { SessionFileExplorer } from './SessionFileExplorer';
import CombinedDiffView from '../panels/diff/CombinedDiffView';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import type { UseWorkflowPhaseStateResult } from '../../hooks/useWorkflowPhaseState';

type TabId = 'workflow-progress' | 'file-explorer' | 'diff';

interface Tab {
  id: TabId;
  label: string;
  testid: string;
}

const TABS: Tab[] = [
  {
    id: 'workflow-progress',
    label: 'Workflow Progress',
    testid: 'run-right-rail-tab-workflow-progress',
  },
  {
    id: 'file-explorer',
    label: 'File Explorer',
    testid: 'run-right-rail-tab-file-explorer',
  },
  {
    id: 'diff',
    label: 'Diff',
    testid: 'run-right-rail-tab-diff',
  },
];

/**
 * RunRightRailDiff — compact wrapper around the working CombinedDiffView, mirroring the
 * minimal state DiffPanel owns (selectedExecutions defaulting to [] == all uncommitted
 * changes, isGitOperationRunning false). Rendered only when the DIFF tab is active and a
 * sessionId is resolved, so it remounts (and reloads git data) whenever the tab is
 * reopened. CombinedDiffView also exposes its own header refresh control.
 */
function RunRightRailDiff({ sessionId, isActive }: { sessionId: string; isActive: boolean }) {
  // [] == all uncommitted changes (same default DiffPanel uses).
  const [selectedExecutions] = useState<number[]>([]);

  return (
    <div
      data-testid="run-right-rail-diff"
      className="h-full flex flex-col bg-surface-primary"
    >
      <div className="flex-1 overflow-hidden">
        <CombinedDiffView
          sessionId={sessionId}
          selectedExecutions={selectedExecutions}
          isGitOperationRunning={false}
          isVisible={isActive}
        />
      </div>
    </div>
  );
}

export function RunRightRail({ phaseState }: { phaseState: UseWorkflowPhaseStateResult }) {
  const [activeTab, setActiveTab] = useState<TabId>('workflow-progress');
  const activeRunId = useCyboflowStore((s) => s.activeRunId);
  const selectedSessionId = useCyboflowStore((s) => s.selectedSessionId);

  const currentTab = TABS.find((t) => t.id === activeTab) ?? TABS[0];

  return (
    <aside
      data-testid="run-right-rail"
      className="w-[296px] shrink-0 flex flex-col border-l border-border-primary bg-bg-primary"
    >
      {/* Tab bar */}
      <div
        role="tablist"
        className="flex border-b border-border-primary"
      >
        {TABS.map((tab) => {
          const isActive = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              data-testid={tab.testid}
              onClick={() => setActiveTab(tab.id)}
              className={[
                'flex-1 px-2 py-2 text-[10px] font-bold uppercase tracking-[0.14em] transition-colors',
                isActive
                  ? 'border-b-2 border-interactive text-text-primary'
                  : 'text-text-tertiary hover:text-text-primary',
              ].join(' ')}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div
        role="tabpanel"
        className="flex-1 overflow-hidden"
      >
        {currentTab.id === 'workflow-progress' ? (
          activeRunId !== null ? (
            <div className="h-full overflow-y-auto">
              <WorkflowProgressTimeline runId={activeRunId} phaseState={phaseState} />
              {/* Per-task sprint lanes — renders nothing for non-sprint runs. */}
              <SprintLanesPanel runId={activeRunId} />
            </div>
          ) : (
            <div
              data-testid="run-right-rail-workflow-progress-empty"
              className="p-4 text-sm text-text-secondary"
            >
              No active run
            </div>
          )
        ) : currentTab.id === 'file-explorer' ? (
          selectedSessionId ? (
            <SessionFileExplorer sessionId={selectedSessionId} />
          ) : (
            <div
              data-testid="run-right-rail-file-explorer-empty"
              className="p-4 text-sm text-text-secondary"
            >
              Select a session to view its files.
            </div>
          )
        ) : (
          selectedSessionId ? (
            <RunRightRailDiff sessionId={selectedSessionId} isActive />
          ) : (
            <div
              data-testid="run-right-rail-diff-empty"
              className="p-4 text-sm text-text-secondary"
            >
              Select a session to view its diff.
            </div>
          )
        )}
      </div>
    </aside>
  );
}
