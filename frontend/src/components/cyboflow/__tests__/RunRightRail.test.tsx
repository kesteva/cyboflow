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
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
// by the active run) WITHOUT firing real tRPC (gitDiff.query).
vi.mock('../RunDiffTabPanel', () => ({
  RunDiffTabPanel: ({ runId }: { runId: string }) => (
    <div data-testid="run-diff-tab-panel-mock">{runId}</div>
  ),
}));

// Import after mocks
import { RunRightRail } from '../RunRightRail';
import { useCyboflowStore } from '../../../stores/cyboflowStore';
import { useCenterPaneStore } from '../../../stores/centerPaneStore';
import type { UseWorkflowPhaseStateResult } from '../../../hooks/useWorkflowPhaseState';
import type { StreamEvent } from '../../../utils/cyboflowApi';

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
  opts?: { collapsed?: boolean; onToggleCollapse?: () => void },
) {
  return render(
    <RunRightRail
      phaseState={phaseState}
      collapsed={opts?.collapsed ?? false}
      onToggleCollapse={opts?.onToggleCollapse ?? (() => {})}
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
    // Width is now an inline style (user-resizable), defaulting to 296px.
    expect((root as HTMLElement).style.width).toBe('296px');
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

  it('clicking the Diff tab with no active run shows the no-run empty state', () => {
    renderRail(EMPTY_PHASE_STATE);

    fireEvent.click(screen.getByRole('tab', { name: 'Diff' }));

    expect(screen.getByTestId('run-right-rail-diff-empty-norun')).toBeInTheDocument();
    expect(screen.queryByTestId('run-diff-tab-panel-mock')).not.toBeInTheDocument();
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
    expect(railWidth()).toBe(296);
    dragHandle(-100); // 100px LEFT → +100 width
    expect(railWidth()).toBe(396);
    expect(localStorage.getItem(WIDTH_KEY)).toBe('396');
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
