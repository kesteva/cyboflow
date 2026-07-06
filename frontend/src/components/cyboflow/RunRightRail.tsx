/**
 * RunRightRail — fixed-width right rail in the CyboflowRoot two-column layout.
 *
 * Contains four tabs:
 *   - Workflow Progress (default selected) — live WorkflowProgressTimeline (plus the
 *     per-task SprintLanesPanel for sprint runs) when activeRunId is non-null; neutral
 *     empty state otherwise.
 *   - File Explorer — live SessionFileExplorer (selected session's worktree tree).
 *     During an active run it is the LAUNCHER for center-pane file/diff tabs (clicking
 *     a file opens a center tab via centerPaneStore.openFileTab); otherwise it falls
 *     back to its own read-only takeover viewer.
 *   - Diff — the working-directory diff. For an active run it is run-scoped
 *     (RunDiffTabPanel; flow runs are keyed by runId since workflow_runs.session_id
 *     is NULL, so it fetches cyboflow.runs.gitDiff, worktree_path-resolved). With no
 *     active run but a selected session it falls back to the session-scoped combined
 *     diff (RunRightRailDiff → CombinedDiffView) — the at-rest experience.
 *   - Artifacts — the "RUN DELIVERABLES" reopen surface (ArtifactsPanel); lists
 *     every artifact the run produced so closed center-pane tabs can be reopened.
 *     Two scopes, mirroring the Diff tab:
 *       • Active run → run-scoped (projectId resolved from the active run row in
 *         useActiveRunsStore, which carries project_id).
 *       • No run but a selected quick session → SESSION-scoped, keyed by
 *         `selectedSessionId` (the SAME synchronous store value used for both
 *         `sessionId` and `sessionKey` — no async-derived value in the mix, so
 *         the two can never briefly disagree the way `quickSessionChatRunId`
 *         vs. `selectedSessionId` could). `quickSessionProjectId` (threaded in
 *         by CyboflowRoot) still gates this arm on !isMainRepo.
 *
 * Collapse: the WHOLE rail is collapsible. `collapsed` + `onToggleCollapse` are
 * lifted to CyboflowRoot (persisted to localStorage); when collapsed the rail
 * renders a thin ~28px strip with only a re-expand chevron. When expanded the
 * collapse chevron sits at the TOP-LEFT of the rail (leading the tab bar).
 *
 * Width: the expanded rail is user-resizable — drag the handle on its LEFT edge
 * (drag left to widen). The chosen width is persisted to localStorage so it
 * survives reloads. The rail stays `shrink-0` in the flex row; the center column
 * reclaims whatever the rail gives up.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { WorkflowProgressTimeline } from './WorkflowProgressTimeline';
import { SprintLanesPanel } from './SprintLanesPanel';
import { SessionFileExplorer } from './SessionFileExplorer';
import { RunDiffTabPanel } from './RunDiffTabPanel';
import { SessionDiffTabPanel } from './SessionDiffTabPanel';
import { ArtifactsPanel } from './ArtifactsPanel';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { useCenterPaneStore } from '../../stores/centerPaneStore';
import { useActiveRunsStore } from '../../stores/activeRunsStore';
import type { UseWorkflowPhaseStateResult } from '../../hooks/useWorkflowPhaseState';

type TabId = 'workflow-progress' | 'file-explorer' | 'diff' | 'artifacts';

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
  {
    id: 'artifacts',
    label: 'Artifacts',
    testid: 'run-right-rail-tab-artifacts',
  },
];

/** Default expanded rail width (the former fixed Tailwind width). */
const RAIL_DEFAULT_WIDTH = 296;
/** Resize clamp: never shrink below a usable column. */
const RAIL_MIN_WIDTH = 240;
/** Resize clamp: cap at the smaller of an absolute ceiling or ~50% of viewport. */
const RAIL_MAX_ABS_WIDTH = 640;
/** localStorage key for the persisted rail width. Brand-new key — no migration. */
const RAIL_WIDTH_KEY = 'cyboflow.runRightRail.width';

/** Upper resize bound: absolute cap, but never more than ~50% of the viewport. */
function maxRailWidth(): number {
  const viewportCap =
    typeof window !== 'undefined' && window.innerWidth > 0
      ? Math.round(window.innerWidth * 0.5)
      : RAIL_MAX_ABS_WIDTH;
  return Math.min(RAIL_MAX_ABS_WIDTH, viewportCap);
}

/** Clamp a candidate width into [min, max]. */
function clampRailWidth(w: number): number {
  return Math.max(RAIL_MIN_WIDTH, Math.min(maxRailWidth(), w));
}

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

interface RunRightRailProps {
  phaseState: UseWorkflowPhaseStateResult;
  /** Whether the rail is collapsed to a thin re-expand strip. */
  collapsed: boolean;
  /** Toggle the collapsed state (lifted to + persisted by CyboflowRoot). */
  onToggleCollapse: () => void;
  /**
   * The selected quick session's project id, so the Artifacts tab works with
   * NO active flow run — mirroring the Diff tab's session fallback
   * (RunDiffTabPanel → SessionDiffTabPanel). Paired with `selectedSessionId`
   * (read directly from the store below) for the session-scoped ArtifactsPanel.
   */
  quickSessionProjectId?: number | null;
}

export function RunRightRail({
  phaseState,
  collapsed,
  onToggleCollapse,
  quickSessionProjectId,
}: RunRightRailProps) {
  const [activeTab, setActiveTab] = useState<TabId>('workflow-progress');
  const activeRunId = useCyboflowStore((s) => s.activeRunId);
  const selectedSessionId = useCyboflowStore((s) => s.selectedSessionId);
  const openFileTab = useCenterPaneStore((s) => s.openFileTab);
  const runsByProject = useActiveRunsStore((s) => s.runsByProject);

  // User-resizable width: seed from localStorage (default RAIL_DEFAULT_WIDTH),
  // always clamped. Mirrors TerminalDock's height-resize pattern, horizontal.
  const [width, setWidth] = useState<number>(() => {
    const saved =
      typeof localStorage !== 'undefined' ? localStorage.getItem(RAIL_WIDTH_KEY) : null;
    const parsed = saved !== null ? parseInt(saved, 10) : NaN;
    return clampRailWidth(Number.isFinite(parsed) ? parsed : RAIL_DEFAULT_WIDTH);
  });
  const [isResizing, setIsResizing] = useState(false);
  const startXRef = useRef<number>(0);
  const startWidthRef = useRef<number>(0);

  // Persist the chosen width. (Brand-new key — no migrateLocalStorageKey needed.)
  useEffect(() => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(RAIL_WIDTH_KEY, width.toString());
    }
  }, [width]);

  const handleResizeDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsResizing(true);
      startXRef.current = e.clientX;
      startWidthRef.current = width;
    },
    [width],
  );

  const handleResizeMove = useCallback((e: MouseEvent) => {
    // The rail sits on the right, so dragging its LEFT edge leftward (smaller
    // clientX) grows it.
    const deltaX = startXRef.current - e.clientX;
    setWidth(clampRailWidth(startWidthRef.current + deltaX));
  }, []);

  const handleResizeUp = useCallback(() => {
    setIsResizing(false);
  }, []);

  // Attach global listeners only while actively dragging.
  useEffect(() => {
    if (!isResizing) return;
    document.addEventListener('mousemove', handleResizeMove);
    document.addEventListener('mouseup', handleResizeUp);
    const prevUserSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ew-resize';
    return () => {
      document.removeEventListener('mousemove', handleResizeMove);
      document.removeEventListener('mouseup', handleResizeUp);
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = prevCursor;
    };
  }, [isResizing, handleResizeMove, handleResizeUp]);

  const activeRunProjectId = selectActiveRunProjectId(runsByProject, activeRunId);
  // The center-pane key is the run's parent session when known, else the run id
  // (legacy parentless runs) — matches RunCenterPane's keying.
  const artifactsSessionKey = selectedSessionId ?? activeRunId ?? '';

  // Clicking a file in the Diff tab opens it as a center-pane file tab (keyed by
  // the selected session, like the File Explorer launcher). Undefined when no
  // session backs the center pane (e.g. a parentless flow run) — the diff then
  // keeps its click = toggle behavior.
  const openDiffFile =
    selectedSessionId !== null
      ? (filePath: string) => openFileTab(selectedSessionId, { filePath })
      : undefined;

  const currentTab = TABS.find((t) => t.id === activeTab) ?? TABS[0];

  // Collapsed: a thin strip with only a re-expand chevron (affordance mirrors
  // TerminalDock's header chevron). The center column reclaims the rail's width.
  if (collapsed) {
    return (
      <aside
        data-testid="run-right-rail-collapsed"
        className="w-[28px] shrink-0 flex flex-col items-center border-l border-border-primary bg-bg-secondary"
      >
        <button
          type="button"
          data-testid="run-right-rail-expand"
          aria-label="Expand right rail"
          title="Expand right rail"
          onClick={onToggleCollapse}
          className="flex h-8 w-full items-center justify-center text-text-tertiary hover:text-text-primary"
        >
          <ChevronLeft size={14} />
        </button>
      </aside>
    );
  }

  return (
    <aside
      data-testid="run-right-rail"
      className="relative shrink-0 flex flex-col border-l border-border-primary bg-bg-primary"
      style={{ width }}
    >
      {/* Left-edge drag handle — resize the rail (drag LEFT to widen). Straddles
          the left border (centered on it via -translate-x-1/2) and sits above the
          content so it stays grabbable; it highlights while dragging. */}
      <div
        data-testid="run-right-rail-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize right rail"
        onMouseDown={handleResizeDown}
        title="Drag to resize"
        className="absolute left-0 top-0 z-10 h-full w-1.5 -translate-x-1/2 cursor-ew-resize"
        style={{ background: isResizing ? 'var(--color-border-primary)' : 'transparent' }}
      />

      {/* Tab bar — LEADING collapse chevron at the top-left, then the tabs. */}
      <div
        role="tablist"
        className="flex items-stretch border-b border-border-primary"
      >
        <button
          type="button"
          data-testid="run-right-rail-collapse"
          aria-label="Collapse right rail"
          title="Collapse right rail"
          onClick={onToggleCollapse}
          className="flex w-7 shrink-0 items-center justify-center border-r border-border-primary text-text-tertiary hover:text-text-primary"
        >
          <ChevronRight size={14} />
        </button>
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
        ) : currentTab.id === 'diff' ? (
          // Diff tab — two scopes:
          //  • Active run → run-scoped working-directory diff (keyed by runId,
          //    since flow runs have session_id NULL).
          //  • No run but a session is selected → session-scoped combined diff
          //    (the at-rest experience for quick / session-hosted sessions). The
          //    earlier change wired only the run path and regressed this case to
          //    a dead-end "No active run".
          activeRunId !== null ? (
            <div className="h-full overflow-hidden">
              <RunDiffTabPanel runId={activeRunId} onOpenFile={openDiffFile} />
            </div>
          ) : selectedSessionId !== null ? (
            <SessionDiffTabPanel sessionId={selectedSessionId} onOpenFile={openDiffFile} />
          ) : (
            <div
              data-testid="run-right-rail-diff-empty-norun"
              className="p-4 text-sm text-text-secondary"
            >
              Select a session to view its diff.
            </div>
          )
        ) : (
          // Artifacts tab — two scopes, mirroring the Diff tab:
          //  • Active run → run-scoped (existing behavior, keyed by the run's
          //    parent session / run-id fallback).
          //  • No run but a selected quick session → SESSION-scoped, keyed by
          //    `selectedSessionId` — the SAME synchronous store value used for
          //    BOTH `sessionId` and `sessionKey`, which by construction can
          //    never disagree with itself (unlike the former
          //    `quickSessionChatRunId`, an async-derived value that could
          //    briefly lag `selectedSessionId` across a session switch and mint
          //    a tab in the wrong session's centerPaneStore bucket).
          //    `activeRunId === null` is required EXPLICITLY so a flow run
          //    whose project id hasn't resolved yet in activeRunsStore never
          //    briefly shows the quick session's artifacts (activeRunProjectId
          //    would be null in that transient window too).
          activeRunId !== null && activeRunProjectId !== null ? (
            <ArtifactsPanel
              runId={activeRunId}
              projectId={activeRunProjectId}
              sessionKey={artifactsSessionKey}
            />
          ) : activeRunId === null &&
            quickSessionProjectId != null &&
            selectedSessionId !== null ? (
            <ArtifactsPanel
              sessionId={selectedSessionId}
              projectId={quickSessionProjectId}
              sessionKey={selectedSessionId}
            />
          ) : (
            <div
              data-testid="run-right-rail-artifacts-empty"
              className="p-4 text-sm text-text-secondary"
            >
              Select a session to view its artifacts.
            </div>
          )
        )}
      </div>
    </aside>
  );
}
