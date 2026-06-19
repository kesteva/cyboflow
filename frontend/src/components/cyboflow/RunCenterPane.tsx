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
import { useEffect, useRef, type ReactElement } from 'react';
import { WorkflowCanvas } from './WorkflowCanvas';
import { SprintSwimlaneCanvas } from './SprintSwimlaneCanvas';
import { RunBottomPane } from './RunBottomPane';
import { CenterPaneTabStrip } from './CenterPaneTabStrip';
import { FileTabRenderer } from './FileTabRenderer';
import { ArtifactTabRenderer } from './ArtifactTabRenderer';
import { TerminalDock } from './TerminalDock';
import { useCenterPaneStore, useCenterPaneSession } from '../../stores/centerPaneStore';
import { useArtifactsList } from '../../hooks/useArtifactsList';
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

  // The run's project — needed for the artifacts list query + change subscription
  // and threaded into ArtifactTabRenderer. ActiveRunRow extends WorkflowRunListRow
  // (project_id: number); null until the run row resolves in activeRunsStore.
  const projectId = activeRun?.project_id ?? null;

  const ensureSession = useCenterPaneStore((s) => s.ensureSession);
  const focusTab = useCenterPaneStore((s) => s.focusTab);
  const closeTab = useCenterPaneStore((s) => s.closeTab);
  const toggleTerminal = useCenterPaneStore((s) => s.toggleTerminal);
  const session = useCenterPaneSession(sessionKey);

  // Live artifacts for this run (initial list + ArtifactChanged subscription).
  const { artifacts } = useArtifactsList(activeRunId, projectId);

  useEffect(() => {
    ensureSession(sessionKey);
  }, [ensureSession, sessionKey]);

  // ── Auto-open artifact tabs ────────────────────────────────────────────────
  // Register a tab for every artifact, but only STEAL FOCUS for freshly-minted
  // ones (`isNew === true` — produced mid-run). The pre-existing set surfaced on
  // first load must NOT yank the user off the Flow tab.
  //
  // centerPaneStore.openArtifactTab ALWAYS focuses the tab it opens/touches —
  // there is no no-focus "register" action. To honour "don't steal focus on
  // first load" without editing the store (not my file; flagged in the summary),
  // we:
  //   - track which artifact ids we've already registered (a ref Set), and
  //   - on each sync, open ONLY artifacts that are both new-to-us AND isNew===true.
  //     Pre-existing (isNew===false) artifacts are intentionally NOT auto-tabbed;
  //     they are reopened on demand from the right-rail Artifacts panel or the
  //     "creates ⟨artifact⟩" step chips. This is the documented v1 choice: it
  //     avoids a focus-restore dance and a no-focus store action while still
  //     auto-surfacing the artifacts a running flow mints in front of the user.
  const seenArtifactIds = useRef<Set<string>>(new Set());
  // Reset the seen-set when the pane switches to a different run/session so a
  // new run's freshly-minted artifacts focus correctly.
  const seenForKey = useRef<string | null>(null);
  useEffect(() => {
    if (seenForKey.current !== sessionKey) {
      seenArtifactIds.current = new Set();
      seenForKey.current = sessionKey;
    }
    for (const artifact of artifacts) {
      if (seenArtifactIds.current.has(artifact.id)) continue;
      seenArtifactIds.current.add(artifact.id);
      // Only freshly-minted artifacts auto-open (and thereby focus). Pre-existing
      // ones are left to the right-rail / step-chip reopen surfaces.
      if (artifact.isNew) {
        useCenterPaneStore.getState().openArtifactTab(sessionKey, {
          atype: artifact.atype,
          label: artifact.label,
          artifactId: artifact.id,
          committed: artifact.committed,
          isNew: true,
        });
      }
    }
  }, [artifacts, sessionKey]);

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
        sessionKey={sessionKey}
      />
    );
  };

  const renderActiveTab = (): ReactElement => {
    if (!activeTab || activeTab.kind === 'flow') return renderFlow();
    if (activeTab.kind === 'file' && activeTab.filePath) {
      // The diff source is the pane's session key (the run's parent session).
      return (
        <FileTabRenderer sessionId={sessionKey} filePath={activeTab.filePath} status={activeTab.status} />
      );
    }
    if (activeTab.kind === 'artifact') {
      // Resolve the backing artifact row from the live list. Prefer the tab's
      // stored artifactId (set when auto-opened); fall back to atype (chip-opened
      // tabs carry only atype until the row arrives). The artifacts table is one
      // row per (run, atype) so atype is a stable secondary key.
      const artifact =
        artifacts.find((a) => a.id === activeTab.artifactId) ??
        artifacts.find((a) => a.atype === activeTab.atype);
      if (artifact && projectId !== null) {
        return (
          <ArtifactTabRenderer artifact={artifact} projectId={projectId} runId={activeRunId} />
        );
      }
      // Row not loaded yet (chip-opened tab before the list resolves, or the
      // artifact hasn't been minted) — small loading state.
      return (
        <div className="flex h-full items-center justify-center text-sm text-text-secondary">
          Loading {activeTab.label}…
        </div>
      );
    }
    // Unknown tab kind — render the label as a minimal fallback.
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
