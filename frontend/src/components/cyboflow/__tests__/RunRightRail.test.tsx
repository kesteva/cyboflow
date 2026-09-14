/**
 * RunRightRail component tests (TASK-767, TASK-780, TASK-783).
 *
 * After TASK-783, RunRightRail accepts phaseState as a required prop and forwards
 * it to WorkflowProgressTimeline.  Tests pass EMPTY_PHASE_STATE or LOADED_PHASE_STATE
 * fixtures directly — no tRPC mock needed. The rail now also accepts
 * `collapsed` + `onToggleCollapse` (whole-rail collapse, lifted to CyboflowRoot)
 * — supplied via the renderRail() helper which defaults collapsed=false.
 *
 * Behaviors verified:
 *   1. Renders four tabs (Workflow Progress / File Explorer / Diff / Artifacts);
 *      Workflow Progress is default selected; shows empty-state when activeRunId
 *      is null.
 *   2. Clicking File Explorer with no active quick session shows its empty state
 *      and hides the Workflow Progress panel.
 *   3. Clicking File Explorer WITH an active quick session mounts SessionFileExplorer
 *      keyed by that session id.
 *   4. During an active run, the File Explorer is the launcher: opening a file calls
 *      centerPaneStore.openFileTab so a center-pane file tab appears.
 *   5. Mounts WorkflowProgressTimeline in the workflow-progress tab when activeRunId is set
 *      (timeline renders phase sections from the phaseState prop).
 *   6. Shows empty state in workflow-progress tab when activeRunId is null.
 *   7. The Diff tab mounts RunDiffTabPanel (keyed by the active run) during a run.
 *   8. Whole-rail collapse: collapsed=true renders the thin strip with only an
 *      expand affordance; the expand/collapse chevrons call onToggleCollapse.
 *   9. Artifacts tab quick-session fallback: with no active run, the
 *      selectedSessionId store value + quickSessionProjectId prop (threaded by
 *      CyboflowRoot) render ArtifactsPanel scoped to the session (across ALL
 *      its runs); without them (or without an active run) the empty state
 *      directs the user to select a session. An active run whose project id
 *      hasn't resolved yet never falls through to the quick-session arm.
 */
import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Fixture bases for the RunDiffTabPanel/SessionDiffTabPanel mocks below (TASK-214).
// Declared via vi.hoisted so they're initialized before vitest hoists the
// vi.mock() factory calls that reference them above the imports. DELIBERATELY
// distinct values — the whole point of TASK-214's default-case test is that the
// run-scoped panel and the session-scoped panel can (today, pre-fix) resolve
// DIFFERENT bases for the "same" diff, and the rail must forward whichever
// panel is actually showing, never a value derived independently.
// ---------------------------------------------------------------------------

const { RUN_PANEL_RESOLVED_BASE, SESSION_PANEL_RESOLVED_BASE } = vi.hoisted(() => ({
  RUN_PANEL_RESOLVED_BASE: 'sha-run-base-sha',
  SESSION_PANEL_RESOLVED_BASE: 'sha-session-derived',
}));

// ---------------------------------------------------------------------------
// Mock cyboflowApi — WorkflowProgressTimeline reads streamEvents from the store
// which is seeded via subscribeToStreamEvents.
// ---------------------------------------------------------------------------

vi.mock('../../../utils/cyboflowApi', () => ({
  subscribeToStreamEvents: vi.fn(() => vi.fn()),
  cyboflowApi: {
    subscribeToStreamEvents: vi.fn(() => vi.fn()),
    approveRun: vi.fn(),
  },
}));

// Stub SessionFileExplorer so the File-Explorer-content test can assert the rail
// mounts it (keyed by the selected session) WITHOUT firing real tRPC. The stub
// exposes the onOpenFile launcher (wired only during an active run) as a button.
vi.mock('../SessionFileExplorer', () => ({
  SessionFileExplorer: ({
    sessionId,
    onOpenFile,
  }: {
    sessionId: string;
    onOpenFile?: (filePath: string) => void;
  }) => (
    <div data-testid="session-file-explorer-mock">
      {sessionId}
      {onOpenFile && (
        <button data-testid="mock-open-file" onClick={() => onOpenFile('src/x.ts')}>
          open file
        </button>
      )}
    </div>
  ),
}));

// Stub RunDiffTabPanel so the Diff-tab test can assert the rail mounts it (keyed
// by the active run) WITHOUT firing real tRPC (gitDiff.query). Also exposes the
// onOpenFile/onResolvedBase callbacks the rail wires in (TASK-214) as buttons so
// tests can drive them deterministically — the mock echoes a FIXED fixture base
// (RUN_PANEL_RESOLVED_BASE) on "mount" (a simulated single successful fetch),
// distinct from the session panel's fixture base below, to exercise the
// default-case desync the real bug is about.
vi.mock('../RunDiffTabPanel', () => ({
  RunDiffTabPanel: ({
    runId,
    onOpenFile,
    onResolvedBase,
  }: {
    runId: string;
    onOpenFile?: (filePath: string, scope?: string) => void;
    onResolvedBase?: (base: string | null) => void;
  }) => {
    React.useEffect(() => {
      onResolvedBase?.(RUN_PANEL_RESOLVED_BASE);
      // Mount-only echo, mirroring the real panel's single-fetch effect.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return (
      <div data-testid="run-diff-tab-panel-mock">
        {runId}
        {onOpenFile && (
          <button
            data-testid="mock-run-diff-open-file"
            onClick={() => onOpenFile('src/x.ts', 'unstaged')}
          >
            open file
          </button>
        )}
      </div>
    );
  },
}));

// Stub SessionDiffTabPanel (the session-scoped diff body) so the at-rest Diff-tab
// fallback test can assert the rail mounts it keyed by the selected session
// WITHOUT firing the real session-diff IPC. Mirrors the RunDiffTabPanel mock's
// onResolvedBase echo, with its OWN fixture base (SESSION_PANEL_RESOLVED_BASE) —
// distinct from the run panel's — since the two paths resolve bases independently.
vi.mock('../SessionDiffTabPanel', () => ({
  SessionDiffTabPanel: ({
    sessionId,
    onOpenFile,
    onResolvedBase,
  }: {
    sessionId: string;
    onOpenFile?: (filePath: string, scope?: string) => void;
    onResolvedBase?: (base: string | null) => void;
  }) => {
    React.useEffect(() => {
      onResolvedBase?.(SESSION_PANEL_RESOLVED_BASE);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return (
      <div data-testid="session-diff-tab-panel-mock">
        {sessionId}
        {onOpenFile && (
          <button
            data-testid="mock-session-diff-open-file"
            onClick={() => onOpenFile('src/x.ts', 'staged')}
          >
            open file
          </button>
        )}
      </div>
    );
  },
}));

// The Artifacts tab renders the REAL ArtifactsPanel (its own suite covers its
// internals) — only its data source is stubbed here so this file never fires
// the real tRPC artifacts client. Empty list is enough to prove which arm of
// the tab's three-way branch mounted (ArtifactsPanel's own testid vs. the
// empty-state div). ArtifactsPanel now calls BOTH the run- and session-scoped
// hooks unconditionally (Rules of Hooks) and picks one, so both are stubbed.
vi.mock('../../../hooks/useArtifactsList', () => ({
  useArtifactsList: () => ({ artifacts: [], loaded: true }),
  useSessionArtifactsList: () => ({ artifacts: [], loaded: true }),
}));

// Import after mocks
import { RunRightRail, initialRunRightRailWidth } from '../RunRightRail';
import { useCyboflowStore } from '../../../stores/cyboflowStore';
import { useCenterPaneStore } from '../../../stores/centerPaneStore';
import { trpc } from '../../../trpc/client';
import type { UseWorkflowPhaseStateResult } from '../../../hooks/useWorkflowPhaseState';
import type { StreamEvent } from '../../../utils/cyboflowApi';
import type { RunGitDiff, WorktreeStatusPayload } from '../../../../../shared/types/runFiles';

// ---------------------------------------------------------------------------
// Phase state fixtures
// ---------------------------------------------------------------------------

const EMPTY_PHASE_STATE: UseWorkflowPhaseStateResult = {
  definition: null,
  currentStepId: null,
  stepStates: [],
  isLoading: false,
  error: null,
};

const LOADED_PHASE_STATE: UseWorkflowPhaseStateResult = {
  definition: {
    id: 'sprint',
    phases: [
      {
        id: 'phase-1',
        label: 'Plan',
        color: '#3b6dd6',
        steps: [
          { id: 'step-a', name: 'Step A', agent: 'planner', mcps: [], retries: 0 },
        ],
      },
    ],
  },
  currentStepId: 'step-a',
  stepStates: [{ stepId: 'step-a', status: 'running' }],
  isLoading: false,
  error: null,
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  act(() => {
    useCyboflowStore.getState().clearActiveRun();
    useCyboflowStore.setState({ selectedSessionId: null });
  });
  useCenterPaneStore.setState({ bySession: {} });
});

// ---------------------------------------------------------------------------
// Render helper — supplies the collapse props (default expanded) so each test
// only overrides what it cares about.
// ---------------------------------------------------------------------------

function renderRail(
  phaseState: UseWorkflowPhaseStateResult,
  opts?: {
    collapsed?: boolean;
    onToggleCollapse?: () => void;
    quickSessionProjectId?: number | null;
  },
) {
  return render(
    <RunRightRail
      phaseState={phaseState}
      collapsed={opts?.collapsed ?? false}
      onToggleCollapse={opts?.onToggleCollapse ?? (() => {})}
      quickSessionProjectId={opts?.quickSessionProjectId}
    />,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RunRightRail', () => {
  it('renders four tabs (incl. run-scoped Diff); Workflow Progress is selected by default and shows empty state when no activeRunId', () => {
    renderRail(EMPTY_PHASE_STATE);

    const wpTab = screen.getByRole('tab', { name: 'Workflow Progress' });
    const feTab = screen.getByRole('tab', { name: 'File Explorer' });
    const diffTab = screen.getByRole('tab', { name: 'Diff' });
    const artifactsTab = screen.getByRole('tab', { name: 'Artifacts' });

    expect(wpTab).toBeInTheDocument();
    expect(feTab).toBeInTheDocument();
    // The run-scoped Diff tab is back (keyed by runId, not sessionId).
    expect(diffTab).toBeInTheDocument();
    expect(artifactsTab).toBeInTheDocument();

    expect(wpTab.getAttribute('aria-selected')).toBe('true');
    expect(feTab.getAttribute('aria-selected')).toBe('false');

    expect(screen.getByTestId('run-right-rail-workflow-progress-empty')).toBeInTheDocument();

    const root = screen.getByTestId('run-right-rail');
    // Width is now an inline style (user-resizable), defaulting to 360px.
    expect((root as HTMLElement).style.width).toBe('360px');
    expect(root).toHaveClass('shrink-0');
    expect(root).toHaveClass('border-l');
    // A left-edge drag handle is present for resizing.
    expect(screen.getByTestId('run-right-rail-resize-handle')).toBeInTheDocument();
  });

  it('clicking File Explorer tab with no active session shows its empty state and hides the Workflow Progress panel', () => {
    // No quick session is active, so the File Explorer renders its neutral empty
    // state rather than mounting SessionFileExplorer.
    act(() => {
      useCyboflowStore.setState({ selectedSessionId: null });
    });

    renderRail(EMPTY_PHASE_STATE);

    expect(screen.getByTestId('run-right-rail-workflow-progress-empty')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'File Explorer' }));

    expect(screen.getByTestId('run-right-rail-file-explorer-empty')).toBeInTheDocument();
    expect(screen.getByTestId('run-right-rail-file-explorer-empty')).toHaveTextContent(
      'Select a session to view its files.',
    );
    expect(screen.queryByTestId('session-file-explorer-mock')).not.toBeInTheDocument();
    expect(screen.queryByTestId('run-right-rail-workflow-progress-empty')).not.toBeInTheDocument();

    expect(screen.getByRole('tab', { name: 'File Explorer' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Workflow Progress' }).getAttribute('aria-selected')).toBe('false');
  });

  it('clicking File Explorer tab WITH an active quick session mounts SessionFileExplorer keyed by that session', () => {
    act(() => {
      useCyboflowStore.setState({ selectedSessionId: 'session-fe-001' });
    });

    renderRail(EMPTY_PHASE_STATE);

    fireEvent.click(screen.getByRole('tab', { name: 'File Explorer' }));

    // The session-keyed explorer mounts (keyed by the selected session, NOT a run);
    // the neutral empty state is hidden.
    const explorer = screen.getByTestId('session-file-explorer-mock');
    expect(explorer).toBeInTheDocument();
    expect(explorer).toHaveTextContent('session-fe-001');
    expect(screen.queryByTestId('run-right-rail-file-explorer-empty')).not.toBeInTheDocument();
  });

  it('during an active run, the File Explorer launches a center-pane file tab via openFileTab', async () => {
    // setActiveRun(runId, parentSessionId) sets activeRunId + selectedSessionId so
    // the explorer renders WITH the onOpenFile launcher (active-run context).
    act(() => {
      useCyboflowStore.getState().setActiveRun('run-x', 'session-fe-001');
    });

    renderRail(EMPTY_PHASE_STATE);
    // Flush SprintLanesPanel's lane snapshot (global stub resolves []).
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole('tab', { name: 'File Explorer' }));
    fireEvent.click(screen.getByTestId('mock-open-file'));

    const session = useCenterPaneStore.getState().bySession['session-fe-001'];
    expect(session).toBeDefined();
    const fileTab = session.tabs.find((t) => t.kind === 'file');
    expect(fileTab).toMatchObject({ id: 'file:src/x.ts', label: 'x.ts', filePath: 'src/x.ts' });
    expect(session.activeTabId).toBe('file:src/x.ts');
  });

  it('shows empty state in workflow-progress tab when activeRunId is null', () => {
    renderRail(EMPTY_PHASE_STATE);

    expect(screen.getByTestId('run-right-rail-workflow-progress-empty')).toBeInTheDocument();
  });

  it('mounts WorkflowProgressTimeline in the workflow-progress tab when activeRunId is set', async () => {
    act(() => {
      useCyboflowStore.getState().setActiveRun('run-test-rail-001');
    });

    renderRail(LOADED_PHASE_STATE);
    // Flush SprintLanesPanel's lane snapshot (global stub resolves []) so the
    // async state update lands inside act.
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByTestId('run-right-rail-workflow-progress-empty')).not.toBeInTheDocument();
    expect(screen.getByTestId('phase-section-phase-1')).toBeInTheDocument();
  });

  it('clicking the Diff tab during an active run mounts RunDiffTabPanel keyed by the run', async () => {
    act(() => {
      useCyboflowStore.getState().setActiveRun('run-diff-rail-001');
    });

    renderRail(LOADED_PHASE_STATE);
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Diff' }));

    const panel = screen.getByTestId('run-diff-tab-panel-mock');
    expect(panel).toBeInTheDocument();
    expect(panel).toHaveTextContent('run-diff-rail-001');
  });

  it('clicking the Diff tab with no active run but a selected session falls back to the session-scoped diff', () => {
    act(() => {
      useCyboflowStore.setState({ selectedSessionId: 'sess-diff-rest-001' });
    });

    renderRail(EMPTY_PHASE_STATE);

    fireEvent.click(screen.getByRole('tab', { name: 'Diff' }));

    const panel = screen.getByTestId('session-diff-tab-panel-mock');
    expect(panel).toBeInTheDocument();
    expect(panel).toHaveTextContent('sess-diff-rest-001');
    // Not the run-scoped panel, and not the dead-end empty state.
    expect(screen.queryByTestId('run-diff-tab-panel-mock')).not.toBeInTheDocument();
    expect(screen.queryByTestId('run-right-rail-diff-empty-norun')).not.toBeInTheDocument();
  });

  it('clicking the Diff tab with no active run and no selected session shows the empty state', () => {
    renderRail(EMPTY_PHASE_STATE);

    fireEvent.click(screen.getByRole('tab', { name: 'Diff' }));

    expect(screen.getByTestId('run-right-rail-diff-empty-norun')).toBeInTheDocument();
    expect(screen.queryByTestId('run-diff-tab-panel-mock')).not.toBeInTheDocument();
    expect(screen.queryByTestId('session-diff-tab-panel-mock')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// TASK-214 — lift resolvedBase from the diff panels to the rail, into both
// openFileTab call sites. The RunDiffTabPanel/SessionDiffTabPanel mocks above
// echo a FIXED, panel-specific fixture base (RUN_PANEL_RESOLVED_BASE /
// SESSION_PANEL_RESOLVED_BASE) via onResolvedBase on mount, simulating each
// panel's single successful fetch — deliberately DIFFERENT values, since the
// live bug (RunDiffTabPanel diffs against row.base_sha; SessionDiffTabPanel/
// useFileDiffData resolve their own base with no base passed in) means the two
// paths really can disagree about what "the" base is.
// ---------------------------------------------------------------------------

describe('RunRightRail — TASK-214 resolvedBase lift', () => {
  it('AC1 (default case / live bug): the run panel\'s echoed resolvedBase — not a separately-derived one — flows into openFileTab', async () => {
    act(() => {
      useCyboflowStore.getState().setActiveRun('run-lift-001', 'session-lift-001');
    });

    renderRail(EMPTY_PHASE_STATE);
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Diff' }));
    // The mounted RunDiffTabPanel mock has already echoed RUN_PANEL_RESOLVED_BASE
    // via its mount effect (simulating its one successful fetch).
    fireEvent.click(screen.getByTestId('mock-run-diff-open-file'));

    const session = useCenterPaneStore.getState().bySession['session-lift-001'];
    expect(session).toBeDefined();
    const fileTab = session.tabs.find((t) => t.kind === 'file');
    // Pre-fix, RunRightRail's openDiffFile called openFileTab with only
    // `{ filePath }` — baseRef would be undefined here, and this assertion
    // would fail: that is exactly the live default-base desync this task closes.
    expect(fileTab).toMatchObject({
      filePath: 'src/x.ts',
      baseRef: RUN_PANEL_RESOLVED_BASE,
      scope: 'unstaged',
    });
  });

  it('AC2 / R-9: the File-Explorer arm passes the SAME lifted base as the diff-opened tab, never undefined', async () => {
    act(() => {
      useCyboflowStore.getState().setActiveRun('run-lift-002', 'session-lift-002');
    });

    renderRail(EMPTY_PHASE_STATE);
    await act(async () => {
      await Promise.resolve();
    });

    // Open the file from the Diff tab first, so a resolvedBase has been
    // echoed and a file tab already carries it.
    fireEvent.click(screen.getByRole('tab', { name: 'Diff' }));
    fireEvent.click(screen.getByTestId('mock-run-diff-open-file'));

    let session = useCenterPaneStore.getState().bySession['session-lift-002'];
    let fileTab = session.tabs.find((t) => t.kind === 'file');
    expect(fileTab?.baseRef).toBe(RUN_PANEL_RESOLVED_BASE);

    // Now re-open the SAME path from the File-Explorer arm. An unconditional
    // store write of `undefined` here would silently reset the tab's base —
    // the File Explorer must forward the SAME lifted base instead.
    fireEvent.click(screen.getByRole('tab', { name: 'File Explorer' }));
    fireEvent.click(screen.getByTestId('mock-open-file'));

    session = useCenterPaneStore.getState().bySession['session-lift-002'];
    fileTab = session.tabs.find((t) => t.kind === 'file');
    expect(fileTab).toMatchObject({
      filePath: 'src/x.ts',
      baseRef: RUN_PANEL_RESOLVED_BASE,
    });
    // The File-Explorer arm omits scope (it isn't a diff-group click).
    expect(fileTab?.scope).toBeUndefined();
  });

  it('AC4: forwards the clicked row\'s scope from the session-scoped panel too', () => {
    act(() => {
      useCyboflowStore.setState({ selectedSessionId: 'sess-lift-003' });
    });

    renderRail(EMPTY_PHASE_STATE);

    fireEvent.click(screen.getByRole('tab', { name: 'Diff' }));
    fireEvent.click(screen.getByTestId('mock-session-diff-open-file'));

    const session = useCenterPaneStore.getState().bySession['sess-lift-003'];
    const fileTab = session.tabs.find((t) => t.kind === 'file');
    expect(fileTab).toMatchObject({
      filePath: 'src/x.ts',
      baseRef: SESSION_PANEL_RESOLVED_BASE,
      scope: 'staged',
    });
  });

  it('before any diff fetch resolves, the lifted base is null (the representable session default)', () => {
    // No Diff tab click at all — no panel has mounted, so onResolvedBase has
    // never fired. Opening straight from the File Explorer (a run WITH no
    // Diff-tab visit yet) must still write baseRef: null, not undefined.
    act(() => {
      useCyboflowStore.getState().setActiveRun('run-lift-004', 'session-lift-004');
    });

    renderRail(EMPTY_PHASE_STATE);

    fireEvent.click(screen.getByRole('tab', { name: 'File Explorer' }));
    fireEvent.click(screen.getByTestId('mock-open-file'));

    const session = useCenterPaneStore.getState().bySession['session-lift-004'];
    const fileTab = session.tabs.find((t) => t.kind === 'file');
    expect(fileTab).toMatchObject({ filePath: 'src/x.ts', baseRef: null });
  });
});

// ---------------------------------------------------------------------------
// Artifacts tab — quick-session fallback (mirrors the Diff tab's session
// fallback). No active flow run, so the tab relies on the synchronous
// selectedSessionId store value + the quickSessionProjectId prop CyboflowRoot
// threads in — both session-scoped now (F1 fix: no async-derived
// quickSessionChatRunId in the mix that could briefly disagree with
// selectedSessionId across a session switch).
// ---------------------------------------------------------------------------

describe('RunRightRail — Artifacts tab quick-session fallback', () => {
  it('with no active run, a selected session, and quickSessionProjectId set, renders ArtifactsPanel scoped to the session', () => {
    act(() => {
      useCyboflowStore.setState({ selectedSessionId: 'sess-quick-1' });
    });

    renderRail(EMPTY_PHASE_STATE, {
      quickSessionProjectId: 9,
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Artifacts' }));

    expect(screen.getByTestId('artifacts-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('run-right-rail-artifacts-empty')).not.toBeInTheDocument();
  });

  it('with quickSessionProjectId null (and no active run), shows the empty state directing to select a session', () => {
    renderRail(EMPTY_PHASE_STATE);

    fireEvent.click(screen.getByRole('tab', { name: 'Artifacts' }));

    const empty = screen.getByTestId('run-right-rail-artifacts-empty');
    expect(empty).toBeInTheDocument();
    expect(empty).toHaveTextContent('Select a session to view its artifacts.');
    expect(screen.queryByTestId('artifacts-panel')).not.toBeInTheDocument();
  });

  it('an active run whose project id has not resolved yet does NOT fall through to the quick-session arm', () => {
    // activeRunId is set but no matching row exists in runsByProject, so
    // activeRunProjectId resolves to null — the quick arm must require
    // activeRunId === null EXPLICITLY, so this transient state still shows the
    // empty state rather than briefly borrowing the quick session's artifacts.
    act(() => {
      useCyboflowStore.getState().setActiveRun('run-unresolved-project');
      useCyboflowStore.setState({ selectedSessionId: 'sess-quick-1' });
    });

    renderRail(EMPTY_PHASE_STATE, {
      quickSessionProjectId: 9,
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Artifacts' }));

    expect(screen.getByTestId('run-right-rail-artifacts-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('artifacts-panel')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Whole-rail collapse (lifted to CyboflowRoot; persisted there). RunRightRail
// only renders the collapsed/expanded shells + fires onToggleCollapse.
// ---------------------------------------------------------------------------

describe('RunRightRail — whole-rail collapse', () => {
  it('collapsed=true renders the thin strip with only an expand affordance (no tabs)', () => {
    renderRail(EMPTY_PHASE_STATE, { collapsed: true });

    const strip = screen.getByTestId('run-right-rail-collapsed');
    expect(strip).toBeInTheDocument();
    expect(strip).toHaveClass('w-[28px]');
    expect(strip).toHaveClass('border-l');

    // The expanded shell (and its tabs) is not rendered while collapsed.
    expect(screen.queryByTestId('run-right-rail')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Workflow Progress' })).not.toBeInTheDocument();
    expect(screen.getByTestId('run-right-rail-expand')).toBeInTheDocument();
  });

  it('the expand chevron calls onToggleCollapse when collapsed', () => {
    const onToggleCollapse = vi.fn();
    renderRail(EMPTY_PHASE_STATE, { collapsed: true, onToggleCollapse });

    fireEvent.click(screen.getByTestId('run-right-rail-expand'));
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
  });

  it('the collapse chevron calls onToggleCollapse when expanded', () => {
    const onToggleCollapse = vi.fn();
    renderRail(EMPTY_PHASE_STATE, { collapsed: false, onToggleCollapse });

    fireEvent.click(screen.getByTestId('run-right-rail-collapse'));
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Width resize — drag the LEFT-edge handle (drag left to widen), persisted to
// localStorage under the brand-new key 'cyboflow.runRightRail.width'.
// ---------------------------------------------------------------------------

describe('RunRightRail — width resize', () => {
  const WIDTH_KEY = 'cyboflow.runRightRail.width';

  beforeEach(() => {
    localStorage.removeItem(WIDTH_KEY);
    // Large viewport so the ~50% cap never gates the absolute clamps.
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: 2000,
    });
  });

  function railWidth(): number {
    return parseInt((screen.getByTestId('run-right-rail') as HTMLElement).style.width, 10);
  }

  /** Drag the left handle by `dx` px (negative = LEFT = widen). */
  function dragHandle(dx: number, startX = 1000): void {
    const handle = screen.getByTestId('run-right-rail-resize-handle');
    fireEvent.mouseDown(handle, { clientX: startX });
    fireEvent.mouseMove(document, { clientX: startX + dx });
    fireEvent.mouseUp(document);
  }

  it('grows the rail on a leftward drag and persists the width', () => {
    renderRail(EMPTY_PHASE_STATE);
    expect(railWidth()).toBe(360);
    dragHandle(-100); // 100px LEFT → +100 width
    expect(railWidth()).toBe(460);
    expect(localStorage.getItem(WIDTH_KEY)).toBe('460');
  });

  it('does not write a width to localStorage until the user resizes', () => {
    renderRail(EMPTY_PHASE_STATE);
    // A mount write would stamp the current default into every install and
    // stop any later default change from reaching anyone.
    expect(localStorage.getItem(WIDTH_KEY)).toBeNull();
    dragHandle(-40);
    expect(localStorage.getItem(WIDTH_KEY)).toBe('400');
  });

  it('does not write on mount even under React.StrictMode (double-invoked effects)', () => {
    // renderRail() doesn't take a wrapper option, so render the same JSX it
    // would render, ourselves, inside StrictMode.
    render(
      <React.StrictMode>
        <RunRightRail
          phaseState={EMPTY_PHASE_STATE}
          collapsed={false}
          onToggleCollapse={() => {}}
        />
      </React.StrictMode>,
    );
    // StrictMode double-invokes effects on mount; the write must still come
    // only from the drag handler, never from a mount effect.
    expect(localStorage.getItem(WIDTH_KEY)).toBeNull();
    dragHandle(-40);
    expect(localStorage.getItem(WIDTH_KEY)).toBe('400');
  });

  it('opens at the current default when storage holds the superseded 296', () => {
    localStorage.setItem(WIDTH_KEY, '296');
    renderRail(EMPTY_PHASE_STATE);
    expect(railWidth()).toBe(360);
  });

  it('honours a width the user actually chose', () => {
    localStorage.setItem(WIDTH_KEY, '420');
    renderRail(EMPTY_PHASE_STATE);
    expect(railWidth()).toBe(420);
  });

  it('initialRunRightRailWidth: stored wins, superseded default does not, junk falls back', () => {
    expect(initialRunRightRailWidth('420')).toBe(420);
    expect(initialRunRightRailWidth('296')).toBe(360);
    expect(initialRunRightRailWidth(null)).toBe(360);
    expect(initialRunRightRailWidth('not-a-number')).toBe(360);
  });

  it('clamps to the minimum on a large rightward drag', () => {
    renderRail(EMPTY_PHASE_STATE);
    dragHandle(400); // 400px RIGHT → would shrink below min
    expect(railWidth()).toBe(240);
    expect(localStorage.getItem(WIDTH_KEY)).toBe('240');
  });

  it('seeds the initial width from a persisted (clamped) value', () => {
    localStorage.setItem(WIDTH_KEY, '420');
    renderRail(EMPTY_PHASE_STATE);
    expect(railWidth()).toBe(420);
  });
});

// ---------------------------------------------------------------------------
// Q3 panel-preservation parity (IDEA-013 / TASK-812)
//
// The structured panel renders interactive-substrate runs WITHOUT any change
// because the S2 transcriptNormalizer makes the interactive `cyboflow:stream:`
// envelope SHAPE-IDENTICAL to the SDK envelope before it reaches the panel.
// This proves the render path is substrate-agnostic: the SAME normalized
// {type,payload,timestamp} envelope (the shape transcriptNormalizer emits for
// interactive lines, equal to the SDK wire shape) yields identical DOM.
// ---------------------------------------------------------------------------

const RUN_ID = 'run-parity-rail-001';

/**
 * A normalized assistant envelope as it reaches the panel. transcriptNormalizer
 * reshapes an interactive transcript `assistant` line into THIS exact shape —
 * identical to the SDK wire `assistant` event — so the only difference between
 * the two substrate inputs below is provenance, never structure.
 */
function makeAssistantEnvelope(): StreamEvent {
  return {
    type: 'assistant',
    payload: {
      type: 'assistant',
      message: {
        id: 'msg_parity_001',
        model: 'claude-opus-4-5',
        role: 'assistant',
        content: [{ type: 'text', text: 'Implementing the change now.' }],
      },
      session_id: RUN_ID,
    },
    timestamp: '2026-06-01T12:00:00.000Z',
  } as StreamEvent;
}

/**
 * Render RunRightRail for an active run after seeding the store with the given
 * stream envelope, and return the rendered HTML of the timeline subtree.
 */
function renderTimelineHtml(envelope: StreamEvent): string {
  act(() => {
    // setActiveRun resets streamEvents:[] — seed AFTER it.
    useCyboflowStore.getState().setActiveRun(RUN_ID);
    useCyboflowStore.getState().appendStreamEvent(envelope);
  });
  const { container, unmount } = renderRail(LOADED_PHASE_STATE);
  const html = (container.querySelector('[role="tabpanel"]') as HTMLElement).innerHTML;
  unmount();
  return html;
}

describe('RunRightRail — Q3 panel preservation (substrate parity)', () => {
  beforeEach(() => {
    act(() => {
      useCyboflowStore.getState().clearActiveRun();
    });
  });

  it('renders an interactive-substrate-normalized envelope identically to an SDK-sourced one', () => {
    // SDK-sourced envelope (the wire shape published by ClaudeCodeManager).
    const sdkHtml = renderTimelineHtml(makeAssistantEnvelope());

    // Interactive-substrate envelope: the normalized shape transcriptNormalizer
    // emits is byte-identical to the SDK envelope, so an equal object is the
    // faithful representation of what reaches the panel.
    const interactiveHtml = renderTimelineHtml(makeAssistantEnvelope());

    // Q3: identical rendered output regardless of substrate — proves the panel
    // is substrate-agnostic and needs zero modification for interactive runs.
    expect(interactiveHtml).toBe(sdkHtml);
    // Sanity: the timeline actually mounted (phase section present in the HTML).
    expect(sdkHtml).toContain('phase-section-phase-1');
  });
});

// ---------------------------------------------------------------------------
// TASK-214 AC3 — onResolvedBase call-count contract on the REAL panels (the
// vi.mock() stubs above intentionally short-circuit the fetch, so they cannot
// exercise this). Bypasses the file's own RunDiffTabPanel/SessionDiffTabPanel
// mocks via vi.importActual and mounts each panel standalone (not through
// RunRightRail — no need for the rail's unrelated tRPC surface). `trpc` here
// is the SAME globally-mocked object from src/test/setup.ts (this file never
// overrides '../../../trpc/client'); `gitDiff` / `sessionGit` are added onto it
// per-test since setup.ts's stub doesn't define them.
// ---------------------------------------------------------------------------

/** Minimal valid WorktreeStatusPayload — its content is irrelevant to these
 * tests, only its presence (RunGitDiff/SessionGitDiffResult require it). */
const EMPTY_WORKTREE_STATUS: WorktreeStatusPayload = {
  entries: [],
  groups: [
    { scope: 'unstaged', files: [], additions: 0, deletions: 0 },
    { scope: 'staged', files: [], additions: 0, deletions: 0 },
    { scope: 'untracked', files: [], additions: 0, deletions: 0 },
    { scope: 'committed', files: [], additions: 0, deletions: 0 },
  ],
  committedUnavailable: true,
};

function makeRunGitDiffFixture(resolvedBase: string | null): RunGitDiff {
  return {
    diff: '',
    stats: { additions: 0, deletions: 0, filesChanged: 0 },
    changedFiles: [],
    resolvedBase,
    worktree: EMPTY_WORKTREE_STATUS,
  };
}

/** Structural shape of `trpc.cyboflow.runs` once `gitDiff` is mocked in. Only
 * covers what these tests touch — never a substitute for AppRouter's real type. */
interface RunsWithGitDiffMock {
  gitDiff: { query: (input: { runId: string; comparisonRef?: string }) => Promise<RunGitDiff | null> };
}

/** Structural shape of `trpc.cyboflow.sessionGit` once mocked in — see above. */
interface SessionGitWithCombinedDiffMock {
  getCombinedDiff: {
    query: (input: {
      sessionId: string;
      executionIds?: number[];
      comparisonRef?: string;
      scope?: string;
    }) => Promise<
      | { success: true; data: { diff: string; stats: { additions: number; deletions: number; filesChanged: number }; changedFiles: string[]; resolvedBase: string | null; worktree: WorktreeStatusPayload } }
      | { success: false; error: string }
    >;
  };
}

describe('RunDiffTabPanel / SessionDiffTabPanel — onResolvedBase fetch contract (TASK-214 AC3)', () => {
  it('RunDiffTabPanel: calls onResolvedBase exactly once after a successful fetch, issuing exactly one query', async () => {
    const { RunDiffTabPanel: RealRunDiffTabPanel } =
      await vi.importActual<typeof import('../RunDiffTabPanel')>('../RunDiffTabPanel');

    const gitDiffQuery = vi.fn().mockResolvedValue(makeRunGitDiffFixture('sha-real-run-001'));
    (trpc.cyboflow.runs as unknown as RunsWithGitDiffMock).gitDiff = { query: gitDiffQuery };

    const onResolvedBase = vi.fn();
    render(<RealRunDiffTabPanel runId="run-real-001" onResolvedBase={onResolvedBase} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(gitDiffQuery).toHaveBeenCalledTimes(1);
    expect(onResolvedBase).toHaveBeenCalledTimes(1);
    expect(onResolvedBase).toHaveBeenCalledWith('sha-real-run-001');
  });

  it('RunDiffTabPanel: does NOT call onResolvedBase on a failed fetch', async () => {
    const { RunDiffTabPanel: RealRunDiffTabPanel } =
      await vi.importActual<typeof import('../RunDiffTabPanel')>('../RunDiffTabPanel');

    const gitDiffQuery = vi.fn().mockRejectedValue(new Error('boom'));
    (trpc.cyboflow.runs as unknown as RunsWithGitDiffMock).gitDiff = { query: gitDiffQuery };

    const onResolvedBase = vi.fn();
    render(<RealRunDiffTabPanel runId="run-real-002" onResolvedBase={onResolvedBase} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(gitDiffQuery).toHaveBeenCalledTimes(1);
    expect(onResolvedBase).not.toHaveBeenCalled();
  });

  it('SessionDiffTabPanel: calls onResolvedBase exactly once after a successful fetch, issuing exactly one query', async () => {
    const { SessionDiffTabPanel: RealSessionDiffTabPanel } =
      await vi.importActual<typeof import('../SessionDiffTabPanel')>('../SessionDiffTabPanel');

    const getCombinedDiffQuery = vi.fn().mockResolvedValue({
      success: true,
      data: {
        diff: '',
        stats: { additions: 0, deletions: 0, filesChanged: 0 },
        changedFiles: [],
        resolvedBase: 'sha-real-session-001',
        worktree: EMPTY_WORKTREE_STATUS,
      },
    });
    (trpc.cyboflow as unknown as { sessionGit: SessionGitWithCombinedDiffMock }).sessionGit = {
      getCombinedDiff: { query: getCombinedDiffQuery },
    };

    const onResolvedBase = vi.fn();
    render(<RealSessionDiffTabPanel sessionId="sess-real-001" onResolvedBase={onResolvedBase} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getCombinedDiffQuery).toHaveBeenCalledTimes(1);
    expect(onResolvedBase).toHaveBeenCalledTimes(1);
    expect(onResolvedBase).toHaveBeenCalledWith('sha-real-session-001');
  });

  it('SessionDiffTabPanel: does NOT call onResolvedBase when the fetch resolves with success:false', async () => {
    const { SessionDiffTabPanel: RealSessionDiffTabPanel } =
      await vi.importActual<typeof import('../SessionDiffTabPanel')>('../SessionDiffTabPanel');

    const getCombinedDiffQuery = vi.fn().mockResolvedValue({ success: false, error: 'nope' });
    (trpc.cyboflow as unknown as { sessionGit: SessionGitWithCombinedDiffMock }).sessionGit = {
      getCombinedDiff: { query: getCombinedDiffQuery },
    };

    const onResolvedBase = vi.fn();
    render(<RealSessionDiffTabPanel sessionId="sess-real-002" onResolvedBase={onResolvedBase} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getCombinedDiffQuery).toHaveBeenCalledTimes(1);
    expect(onResolvedBase).not.toHaveBeenCalled();
  });
});
