/**
 * RunCenterPane — the tabbed center surface for an active workflow run.
 *
 * Replaces the former WorkflowCanvas-over-RunBottomPane vertical stack. Owns:
 *   - a tab strip (pinned Flow tab; file/diff + artifact tabs land in later
 *     milestones),
 *   - a content area rendering the active tab (Flow → WorkflowCanvas, or
 *     SprintSwimlaneCanvas for sprint runs),
 *   - a collapsible terminal dock wrapping RunBottomPane (chat / terminal /
 *     data-stream) below.
 *
 * Tab state is per-session and in-memory (centerPaneStore), keyed by the run's
 * parent session id when known (else the run id for legacy parentless runs). The
 * terminal dock collapses via display:none and NEVER unmounts RunBottomPane, so
 * the live interactive xterm survives a collapse (see TerminalDock).
 */
import { useEffect, type ReactElement } from 'react';
import { WorkflowCanvas } from './WorkflowCanvas';
import { SprintSwimlaneCanvas } from './SprintSwimlaneCanvas';
import { RunBottomPane } from './RunBottomPane';
import { CenterPaneTabStrip } from './CenterPaneTabStrip';
import { TerminalDock } from './TerminalDock';
import { useCenterPaneStore, useCenterPaneSession } from '../../stores/centerPaneStore';
import type { UseWorkflowPhaseStateResult } from '../../hooks/useWorkflowPhaseState';
import type { ActiveRunRow } from '../../stores/activeRunsStore';

interface RunCenterPaneProps {
  activeRunId: string;
  phaseState: UseWorkflowPhaseStateResult;
  activeRun?: ActiveRunRow;
}

/** Basename of a worktree path for the dock header (e.g. "recipe-holder"). */
function folderBasename(worktreePath?: string | null): string | undefined {
  if (!worktreePath) return undefined;
  const parts = worktreePath.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || undefined;
}

export function RunCenterPane({ activeRunId, phaseState, activeRun }: RunCenterPaneProps): ReactElement {
  // Per-session key: the run's parent session when known, else the run id
  // (legacy parentless runs still get isolated, stable tab state).
  const sessionKey = activeRun?.session_id ?? activeRunId;

  const ensureSession = useCenterPaneStore((s) => s.ensureSession);
  const focusTab = useCenterPaneStore((s) => s.focusTab);
  const closeTab = useCenterPaneStore((s) => s.closeTab);
  const toggleTerminal = useCenterPaneStore((s) => s.toggleTerminal);
  const session = useCenterPaneSession(sessionKey);

  useEffect(() => {
    ensureSession(sessionKey);
  }, [ensureSession, sessionKey]);

  const activeTab = session.tabs.find((t) => t.id === session.activeTabId) ?? session.tabs[0];

  const renderFlow = (): ReactElement => {
    if (phaseState.definition === null) {
      return (
        <div className="flex h-full items-center justify-center text-sm text-text-secondary">
          Loading workflow…
        </div>
      );
    }
    if (activeRun?.batch_id != null) {
      // Parallel sprint run — the Flow tab hosts the per-task swim lanes.
      return (
        <SprintSwimlaneCanvas
          runId={activeRunId}
          phaseState={phaseState}
          sprintStatus={activeRun?.status}
        />
      );
    }
    return (
      <WorkflowCanvas
        definition={phaseState.definition}
        currentStepId={phaseState.currentStepId}
        runLabel={activeRunId}
        folderPath={activeRun?.worktree_path}
        branchName={activeRun?.branch_name}
        isRunning={activeRun?.status === 'running' || activeRun?.status === 'starting'}
        paused={activeRun?.status === 'paused'}
        status={activeRun?.status}
      />
    );
  };

  const renderActiveTab = (): ReactElement => {
    if (!activeTab || activeTab.kind === 'flow') return renderFlow();
    // file / artifact tab content arrives in later milestones.
    return (
      <div className="flex h-full items-center justify-center text-sm text-text-secondary">
        {activeTab.label}
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col overflow-hidden" data-testid="run-center-pane">
      <CenterPaneTabStrip
        tabs={session.tabs}
        activeTabId={session.activeTabId}
        onTabClick={(id) => focusTab(sessionKey, id)}
        onTabClose={(id) => closeTab(sessionKey, id)}
      />
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>{renderActiveTab()}</div>
      <TerminalDock
        open={session.terminalOpen}
        onToggle={() => toggleTerminal(sessionKey)}
        folderLabel={folderBasename(activeRun?.worktree_path)}
        branchName={activeRun?.branch_name ?? undefined}
      >
        <RunBottomPane />
      </TerminalDock>
    </div>
  );
}
