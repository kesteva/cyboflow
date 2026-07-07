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
import { FileTabRenderer } from './FileTabRenderer';
import { ArtifactTabRenderer } from './ArtifactTabRenderer';
import { TerminalDock } from './TerminalDock';
import { useCenterPaneStore, useCenterPaneSession } from '../../stores/centerPaneStore';
import { ARTIFACT_COLORS, ARTIFACT_GLYPHS } from '../../../../shared/types/artifacts';
import { useArtifactsList, useSessionArtifactsList } from '../../hooks/useArtifactsList';
import { useArtifactTabsSync } from '../../hooks/useArtifactTabsSync';
import { useNavigationStore } from '../../stores/navigationStore';
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
  // The run's parent session, when known (null for legacy parentless runs).
  const parentSessionId = activeRun?.session_id ?? null;
  // Per-session key: the run's parent session when known, else the run id
  // (legacy parentless runs still get isolated, stable tab state).
  const sessionKey = parentSessionId ?? activeRunId;

  // The run's project — needed for the artifacts list query + change subscription
  // and threaded into ArtifactTabRenderer. ActiveRunRow extends WorkflowRunListRow
  // (project_id: number); null until the run row resolves in activeRunsStore.
  const projectId = activeRun?.project_id ?? null;

  const ensureSession = useCenterPaneStore((s) => s.ensureSession);
  const focusTab = useCenterPaneStore((s) => s.focusTab);
  const closeTab = useCenterPaneStore((s) => s.closeTab);
  const toggleTerminal = useCenterPaneStore((s) => s.toggleTerminal);
  const session = useCenterPaneSession(sessionKey);

  // Live artifacts feeding the tab store — which MUST be session-scoped, not
  // run-scoped, because sessionKey above is the run's PARENT SESSION (shared
  // with QuickSessionCenterPane's own session-keyed tab store). A run-scoped
  // list only sees this run's rows, so switching the center-pane host between
  // RunCenterPane and QuickSessionCenterPane (same session, different runs)
  // would make the OTHER host's artifacts read as "vanished" and get pruned by
  // useArtifactTabsSync even though their DB rows still exist. Both hooks are
  // called unconditionally (Rules of Hooks) — each no-ops (returns []) on a
  // null input — and we select whichever one actually has a live key.
  const sessionScoped = useSessionArtifactsList(parentSessionId, projectId);
  const runScoped = useArtifactsList(parentSessionId === null ? activeRunId : null, projectId);
  const { artifacts, loaded } = parentSessionId !== null ? sessionScoped : runScoped;

  useEffect(() => {
    ensureSession(sessionKey);
  }, [ensureSession, sessionKey]);

  // Auto-open + prune artifact tabs (shared with QuickSessionCenterPane) — see
  // useArtifactTabsSync for the focus-steal / loading-vs-deleted-flicker fixes.
  useArtifactTabsSync(sessionKey, artifacts, loaded);

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
        // The artifact's OWN runId — the list may now be session-scoped (see
        // above), so a tab's backing row can belong to a DIFFERENT run than
        // this pane's activeRunId (e.g. a chat-minted artifact from an earlier
        // quick-session run).
        return (
          <ArtifactTabRenderer artifact={artifact} projectId={projectId} runId={artifact.runId} />
        );
      }
      // List still resolving (chip-opened tab racing the initial fetch) — a
      // genuine loading state.
      if (!loaded) {
        return (
          <div className="flex h-full items-center justify-center text-sm text-text-secondary">
            Loading {activeTab.label}…
          </div>
        );
      }
      // List loaded and no backing row: the artifact has NOT been minted yet
      // (a step's "creates ⟨artifact⟩" chip opens tabs eagerly). Render an
      // explicit not-created-yet state instead of a perpetual fake "Loading…";
      // the ArtifactChanged subscription fills this tab in live the moment the
      // producing step reports it.
      const atype = activeTab.atype ?? 'generic';
      return (
        <div
          data-testid="artifact-tab-not-created"
          className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center"
        >
          <span aria-hidden style={{ fontSize: '30px', color: ARTIFACT_COLORS[atype], opacity: 0.55 }}>
            {ARTIFACT_GLYPHS[atype]}
          </span>
          <span className="text-sm font-semibold text-text-primary">
            {activeTab.label} hasn&apos;t been created yet
          </span>
          <span className="max-w-sm text-xs text-text-secondary">
            It will appear here as soon as its workflow step produces it.
          </span>
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
      <div style={{ display: 'flex', alignItems: 'stretch' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <CenterPaneTabStrip
            tabs={session.tabs}
            activeTabId={session.activeTabId}
            onTabClick={(id) => focusTab(sessionKey, id)}
            onTabClose={(id) => closeTab(sessionKey, id)}
          />
        </div>
        {/* A/B variant pill (migration 048) — reads the denormalized
            workflow_runs.variant_label off the active run row, so no extra query
            is needed. Absent for baseline (non-variant) runs. */}
        {activeRun?.variant_label && (
          <div
            data-testid="run-variant-pill"
            title={`Variant: ${activeRun.variant_label}`}
            style={{
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '0 11px',
              fontSize: '10.5px',
              fontWeight: 600,
              letterSpacing: '-.005em',
              color: 'var(--color-text-secondary)',
              background: 'var(--color-bg-secondary)',
              borderBottom: '1px solid var(--color-border-primary)',
              borderLeft: '1px solid var(--color-border-primary)',
              whiteSpace: 'nowrap',
            }}
          >
            Variant: {activeRun.variant_label}
          </div>
        )}
        {/* A/B side-by-side experiment chip (migration 049, slice B thin launch
            UI) — reads the denormalized workflow_runs.experiment_id/experiment_arm
            off the active run row. Absent for a non-experiment run. Deliberately
            minimal (label + arm only); the full banner + gated "View comparison"
            CTA lives on WorkflowSummaryPanel (slice C). This chip is a clickable
            shortcut straight to the comparison view — ungated (unlike the panel's
            CTA) since a click here is an explicit user action on an affordance
            they already know is experiment-scoped; the comparison view itself
            renders the pending/absent states gracefully. */}
        {activeRun?.experiment_id && activeRun.experiment_arm && (
          <button
            type="button"
            data-testid="run-experiment-chip"
            title={`A/B experiment · Arm ${activeRun.experiment_arm} — open comparison`}
            onClick={() => {
              if (activeRun.experiment_id) {
                useNavigationStore.getState().openExperimentComparison(activeRun.experiment_id);
              }
            }}
            style={{
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '0 11px',
              fontSize: '10.5px',
              fontWeight: 600,
              letterSpacing: '-.005em',
              color: 'var(--color-text-secondary)',
              background: 'var(--color-bg-secondary)',
              border: 'none',
              borderBottom: '1px solid var(--color-border-primary)',
              borderLeft: '1px solid var(--color-border-primary)',
              whiteSpace: 'nowrap',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            A/B experiment · Arm {activeRun.experiment_arm}
          </button>
        )}
      </div>
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
