/**
 * RunRightRail — fixed-width right rail in the CyboflowRoot two-column layout.
 *
 * Contains three tabs:
 *   - Workflow Progress (default selected) — live WorkflowProgressTimeline (plus the
 *     per-task SprintLanesPanel for sprint runs) when activeRunId is non-null; neutral
 *     empty state otherwise.
 *   - File Explorer — live SessionFileExplorer (selected session's worktree tree).
 *     During an active run it is the LAUNCHER for center-pane file/diff tabs (clicking
 *     a file opens a center tab via centerPaneStore.openFileTab); otherwise it falls
 *     back to its own read-only takeover viewer.
 *   - Artifacts — the "RUN DELIVERABLES" reopen surface (ArtifactsPanel) when
 *     activeRunId is non-null; lists every artifact the run produced so closed
 *     center-pane tabs can be reopened. projectId is resolved from the active run
 *     row in useActiveRunsStore (the row carries project_id) — RunRightRail takes
 *     no extra prop (CyboflowRoot is owned by the orchestrator).
 *
 * The standalone Diff tab was removed: per-file diffs now open as center-pane file
 * tabs (FileTabRenderer).
 */
import { useState } from 'react';
import { WorkflowProgressTimeline } from './WorkflowProgressTimeline';
import { SprintLanesPanel } from './SprintLanesPanel';
import { SessionFileExplorer } from './SessionFileExplorer';
import { ArtifactsPanel } from './ArtifactsPanel';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { useCenterPaneStore } from '../../stores/centerPaneStore';
import { useActiveRunsStore } from '../../stores/activeRunsStore';
import type { UseWorkflowPhaseStateResult } from '../../hooks/useWorkflowPhaseState';

type TabId = 'workflow-progress' | 'file-explorer' | 'artifacts';

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
    id: 'artifacts',
    label: 'Artifacts',
    testid: 'run-right-rail-tab-artifacts',
  },
];

/**
 * Resolve the active run's project_id from the active-runs store. The row lives
 * under its project's bucket; we scan every bucket because RunRightRail does not
 * know which project the run belongs to (and takes no prop for it). Returns null
 * when the run isn't tracked yet (e.g. before the rail's project-expand refresh).
 */
function selectActiveRunProjectId(
  runsByProject: ReturnType<typeof useActiveRunsStore.getState>['runsByProject'],
  runId: string | null,
): number | null {
  if (runId === null) return null;
  for (const rows of Object.values(runsByProject)) {
    const row = rows.find((r) => r.id === runId);
    if (row) return row.project_id;
  }
  return null;
}

export function RunRightRail({ phaseState }: { phaseState: UseWorkflowPhaseStateResult }) {
  const [activeTab, setActiveTab] = useState<TabId>('workflow-progress');
  const activeRunId = useCyboflowStore((s) => s.activeRunId);
  const selectedSessionId = useCyboflowStore((s) => s.selectedSessionId);
  const openFileTab = useCenterPaneStore((s) => s.openFileTab);
  const runsByProject = useActiveRunsStore((s) => s.runsByProject);

  const activeRunProjectId = selectActiveRunProjectId(runsByProject, activeRunId);
  // The center-pane key is the run's parent session when known, else the run id
  // (legacy parentless runs) — matches RunCenterPane's keying.
  const artifactsSessionKey = selectedSessionId ?? activeRunId ?? '';

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
        ) : (
          // Artifacts tab — needs an active run AND its resolved project id.
          activeRunId !== null && activeRunProjectId !== null ? (
            <ArtifactsPanel
              runId={activeRunId}
              projectId={activeRunProjectId}
              sessionKey={artifactsSessionKey}
            />
          ) : (
            <div
              data-testid="run-right-rail-artifacts-empty"
              className="p-4 text-sm text-text-secondary"
            >
              No active run
            </div>
          )
        )}
      </div>
    </aside>
  );
}
