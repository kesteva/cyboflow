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
import { FLOW_TAB_ID } from '../../../../shared/types/centerPane';
import { useArtifactsList } from '../../hooks/useArtifactsList';
import type { UseWorkflowPhaseStateResult } from '../../hooks/useWorkflowPhaseState';
import type { ActiveRunRow } from '../../stores/activeRunsStore';

interface RunCenterPaneProps {
  activeRunId: string;
  phaseState: UseWorkflowPhaseStateResult;
  activeRun?: ActiveRunRow;
  /**
   * When set (the run has ended — `runEndEligible`), the Flow tab renders this
   * node (the end-of-workflow summary) INSTEAD of the phase canvas. The tab strip
   * and the terminal dock (chat) stay mounted, so completion never hides the chat.
   */
  flowEndSummary?: ReactElement;
}

/** Basename of a worktree path for the dock header (e.g. "recipe-holder"). */
function folderBasename(worktreePath?: string | null): string | undefined {
  if (!worktreePath) return undefined;
  const parts = worktreePath.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || undefined;
}

export function RunCenterPane({ activeRunId, phaseState, activeRun, flowEndSummary }: RunCenterPaneProps): ReactElement {
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
  // Register a tab for every artifact, and FLIP the center pane to ones genuinely
  // minted AFTER this pane mounted for the current session (a fresh deliverable
  // surfaces itself). The pre-existing set surfaced on first load must NOT yank
  // the user off the Flow tab.
  //
  // The DB `is_new` flag CANNOT be trusted for this: it is never written back to
  // 0, so on app refresh / fresh run re-select `artifacts.list` re-seeds every
  // prior artifact with isNew===true — which would steal focus on every reload
  // (exactly what this effect forbids). Instead we treat "new" as purely a
  // client-session notion: the FIRST sync for a session key marks every artifact
  // already present as already-seen (so it is opened WITHOUT stealing focus), and
  // only ids that appear in a LATER sync count as freshly minted and focus.
  //
  // centerPaneStore.openArtifactTab ALWAYS focuses the tab it opens/touches —
  // there is no no-focus "register" action. To open the initial seed without
  // stealing focus we capture the active tab id before the pass and restore it
  // afterwards (the Flow tab carries no `isNew`, so focusTab restoring it is a
  // no-op beyond setting activeTabId).
  const seenArtifactIds = useRef<Set<string>>(new Set());
  // Reset the seen-set when the pane switches to a different run/session so a
  // new run's freshly-minted artifacts focus correctly.
  const seenForKey = useRef<string | null>(null);
  useEffect(() => {
    const store = useCenterPaneStore.getState();
    // The active tab the user is currently on — restored after the initial seed
    // so pre-existing artifacts open silently (no focus steal).
    const activeBeforeSeed = store.bySession[sessionKey]?.activeTabId ?? FLOW_TAB_ID;

    const isInitialSeed = seenForKey.current !== sessionKey;
    if (isInitialSeed) {
      seenArtifactIds.current = new Set();
      seenForKey.current = sessionKey;
    }

    for (const artifact of artifacts) {
      if (seenArtifactIds.current.has(artifact.id)) continue;
      seenArtifactIds.current.add(artifact.id);
      // On the initial seed, every artifact is "pre-existing" — open it but do
      // NOT steal focus (it is restored below) so first load never yanks the user
      // off the Flow tab. After the initial seed, an unseen artifact id is
      // genuinely fresh THIS session: it is content-driven (only minted once it
      // has content), so we FLIP the center pane to it (focus:true) — the run just
      // produced a deliverable and the pane surfaces it. The seenArtifactIds guard
      // means each id flips at most once (no repeated yanking on later syncs).
      store.openArtifactTab(sessionKey, {
        atype: artifact.atype,
        label: artifact.label,
        artifactId: artifact.id,
        committed: artifact.committed,
        isNew: false,
        ...(isInitialSeed ? {} : { focus: true }),
      });
    }

    // Restore focus after the initial seed so opening pre-existing artifacts
    // never yanks the user off the Flow (or whichever) tab they were on.
    if (isInitialSeed && artifacts.length > 0) {
      useCenterPaneStore.getState().focusTab(sessionKey, activeBeforeSeed);
    }
  }, [artifacts, sessionKey]);

  // ── Close tabs whose backing artifact row vanished ─────────────────────────
  // A pruned / deleted artifact leaves its center-pane tab stranded on a
  // perpetual "Loading…" state (renderActiveTab can't resolve the row). Close
  // any artifact tab whose id AND atype no longer appear in the live list.
  useEffect(() => {
    const session = useCenterPaneStore.getState().bySession[sessionKey];
    if (!session) return;
    for (const tab of session.tabs) {
      if (tab.kind !== 'artifact') continue;
      const stillExists =
        artifacts.some((a) => a.id === tab.artifactId) ||
        artifacts.some((a) => a.atype === tab.atype);
      if (!stillExists) {
        // Drop our memory of the id too, so a re-mint re-opens (and focuses) it.
        if (tab.artifactId) seenArtifactIds.current.delete(tab.artifactId);
        useCenterPaneStore.getState().closeTab(sessionKey, tab.id);
      }
    }
  }, [artifacts, sessionKey]);

  const activeTab = session.tabs.find((t) => t.id === session.activeTabId) ?? session.tabs[0];

  const renderFlow = (): ReactElement => {
    // Run ended → the Flow tab shows the end-of-workflow summary instead of the
    // phase canvas. The tab strip + terminal dock (chat) stay mounted below, so
    // completion never hides the chat.
    if (flowEndSummary) return flowEndSummary;
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
