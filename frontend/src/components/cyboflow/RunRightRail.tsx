/**
 * RunRightRail — fixed-width right rail in the CyboflowRoot two-column layout.
 *
 * Contains two tabs:
 *   - Workflow Progress (default selected) — live WorkflowProgressTimeline (plus the
 *     per-task SprintLanesPanel for sprint runs) when activeRunId is non-null; neutral
 *     empty state otherwise.
 *   - File Explorer — live SessionFileExplorer (selected session's worktree tree).
 *     During an active run it is the LAUNCHER for center-pane file/diff tabs (clicking
 *     a file opens a center tab via centerPaneStore.openFileTab); otherwise it falls
 *     back to its own read-only takeover viewer.
 *
 * The standalone Diff tab was removed: per-file diffs now open as center-pane file
 * tabs (FileTabRenderer). The Artifacts tab + full 2-tab restructure land in M4.
 */
import { useState } from 'react';
import { WorkflowProgressTimeline } from './WorkflowProgressTimeline';
import { SprintLanesPanel } from './SprintLanesPanel';
import { SessionFileExplorer } from './SessionFileExplorer';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { useCenterPaneStore } from '../../stores/centerPaneStore';
import type { UseWorkflowPhaseStateResult } from '../../hooks/useWorkflowPhaseState';

type TabId = 'workflow-progress' | 'file-explorer';

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
];

export function RunRightRail({ phaseState }: { phaseState: UseWorkflowPhaseStateResult }) {
  const [activeTab, setActiveTab] = useState<TabId>('workflow-progress');
  const activeRunId = useCyboflowStore((s) => s.activeRunId);
  const selectedSessionId = useCyboflowStore((s) => s.selectedSessionId);
  const openFileTab = useCenterPaneStore((s) => s.openFileTab);

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
        ) : (
          selectedSessionId ? (
            <SessionFileExplorer
              sessionId={selectedSessionId}
              // During an active run, clicking a file opens a center-pane file/diff
              // tab (the centerPane key == selectedSessionId == the run's parent
              // session). Without an active run there is no tabbed center pane, so
              // the explorer uses its own takeover viewer.
              onOpenFile={
                activeRunId !== null
                  ? (filePath) => openFileTab(selectedSessionId, { filePath })
                  : undefined
              }
            />
          ) : (
            <div
              data-testid="run-right-rail-file-explorer-empty"
              className="p-4 text-sm text-text-secondary"
            >
              Select a session to view its files.
            </div>
          )
        )}
      </div>
    </aside>
  );
}
