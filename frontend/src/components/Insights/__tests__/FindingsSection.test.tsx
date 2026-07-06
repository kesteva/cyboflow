/**
 * FindingsSection — findings-triage surface tests.
 *
 * The insights store HOOK is mocked over a mutable in-memory state object so the
 * section renders against a fixed snapshot without a live tRPC connection; the
 * store's PURE selectors (selectUntriaged / selectReadyBuckets / selectGreedyReadyRows
 * / selectTallyParts / selectSelectedFindingIds / selectFindingsCounters) come from
 * the REAL module via importActual so the load-bearing bucketing/allocation logic
 * is exercised, not re-stubbed. The action callbacks are vi.fn()s that ALSO mutate
 * the in-memory state (mirroring the store's optimistic patch) so a re-render after
 * an action reflects the new triage state. The navigation store's goToWizard +
 * useProjectsCount are captured/flipped to assert the CTA + gating.
 *
 * Coverage (plan §7): top-5 untriaged + "Show N more"; Approve/Modify/Dismiss per
 * row; single-open Modify drawer (opening B closes A); re-tag/re-prioritize mutate
 * in place; Approve → ready bucket matching tag, NOT selected, closes drawer;
 * Dismiss removes + increments Dismissed; empty states (untriaged/ready/cold-start);
 * READY collapsed renders EXACTLY 5 rows in bucket order, a budget-starved bucket
 * hidden while present buckets show full header counts; ONE section toggle;
 * P0→P1→P2 within bucket; Select all/Deselect all/bucket-header/whole-row toggles;
 * tray tally pluralization + CTA count (N); CTA → goToWizard with compound + ids;
 * legacy 'prompt'→doc bucket; null-priority renders '—'.
 */
import '@testing-library/jest-dom';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReviewItemSummary, QualityFinding } from '../../../../../shared/types/insights';
import type {
  FindingPriority,
  FindingProposedTarget,
} from '../../../../../shared/types/reviews';
import {
  selectUntriaged,
  selectReadyBuckets,
  selectGreedyReadyRows,
  selectTallyParts,
  selectSelectedFindingIds,
  selectFindingsCounters,
  type TriageFinding,
} from '../../../stores/insightsStore';
import { findingBucket } from '../../../../../shared/types/reviews';

// ---------------------------------------------------------------------------
// Mutable in-memory store state + action mocks.
// ---------------------------------------------------------------------------

interface MockState {
  triageFindings: TriageFinding[];
  reviewSummary: ReviewItemSummary | null;
  qualityFindings: QualityFinding[];
  projectFilter: number | null;
  untriagedExpanded: boolean;
  readyShowAll: boolean;
}

let mockState: MockState;
// Subscriber set the mocked hook re-renders through. `mock`-prefixed so it is
// safe to reference inside the vi.mock factory (vitest hoisting rule).
const mockListeners = new Set<() => void>();

/** Re-render every mounted consumer (the mocked hook subscribes via this set). */
function notify(): void {
  for (const l of mockListeners) l();
}

function patchFindings(fn: (f: TriageFinding[]) => TriageFinding[]): void {
  mockState.triageFindings = fn(mockState.triageFindings);
  notify();
}

const approveFinding = vi.fn(async (_projectId: number, id: string) => {
  patchFindings((findings) =>
    findings.map((f) =>
      f.id === id
        ? { ...f, staged_at: f.staged_at ?? new Date().toISOString(), selected: false, triageState: 'ready' }
        : f,
    ),
  );
});
const dismissFinding = vi.fn(async (_projectId: number, id: string) => {
  const target = mockState.triageFindings.find((f) => f.id === id);
  patchFindings((findings) => findings.filter((f) => f.id !== id));
  if (mockState.reviewSummary) {
    mockState.reviewSummary = {
      ...mockState.reviewSummary,
      pendingByKind: {
        ...mockState.reviewSummary.pendingByKind,
        finding: Math.max(0, mockState.reviewSummary.pendingByKind.finding - 1),
      },
    };
  }
  if (target) {
    mockState.qualityFindings = [
      ...mockState.qualityFindings,
      qualityDismissed(target),
    ];
  }
  notify();
});
const setFindingTag = vi.fn(async (_projectId: number, id: string, target: FindingProposedTarget) => {
  patchFindings((findings) =>
    findings.map((f) =>
      f.id === id
        ? {
            ...f,
            payload:
              f.payload && f.payload.kind === 'finding'
                ? { ...f.payload, proposedTarget: target }
                : { kind: 'finding', proposedTarget: target },
          }
        : f,
    ),
  );
});
const setFindingPriority = vi.fn(async (_projectId: number, id: string, priority: FindingPriority) => {
  patchFindings((findings) => findings.map((f) => (f.id === id ? { ...f, priority } : f)));
});
const toggleFindingSelected = vi.fn(async (_projectId: number, id: string) => {
  patchFindings((findings) => findings.map((f) => (f.id === id ? { ...f, selected: !f.selected } : f)));
});
const selectAllReady = vi.fn(async (_projectId: number, selected: boolean) => {
  patchFindings((findings) =>
    findings.map((f) => (f.triageState === 'ready' ? { ...f, selected } : f)),
  );
});
const selectBucket = vi.fn(
  async (_projectId: number, bucket: 'quick' | 'doc' | 'task', selected: boolean) => {
    patchFindings((findings) =>
      findings.map((f) =>
        f.triageState === 'ready' && findingBucket(targetOf(f)) === bucket ? { ...f, selected } : f,
      ),
    );
  },
);
const toggleUntriagedExpand = vi.fn(() => {
  mockState.untriagedExpanded = !mockState.untriagedExpanded;
  notify();
});
const toggleReadyShowAll = vi.fn(() => {
  mockState.readyShowAll = !mockState.readyShowAll;
  notify();
});

function targetOf(f: TriageFinding): FindingProposedTarget | null {
  const p = f.payload;
  if (p && p.kind === 'finding' && p.proposedTarget !== undefined) return p.proposedTarget;
  return null;
}

function qualityDismissed(target: TriageFinding): QualityFinding {
  return {
    id: target.id,
    projectId: target.project_id,
    title: target.title,
    severity: target.severity,
    status: 'dismissed',
    source: target.source,
    sourceStep: null,
    category: null,
    locations: [],
    createdAt: target.created_at,
    resolution: null,
    runId: target.run_id,
    runOutcome: null,
    runEndedAt: null,
    workflowName: null,
  };
}

// `mock`-prefixed so the vi.mock factory can reference it (vitest hoisting rule).
function mockSelectState() {
  return {
    triageFindings: mockState.triageFindings,
    reviewSummary: mockState.reviewSummary,
    qualityFindings: mockState.qualityFindings,
    projectFilter: mockState.projectFilter,
    untriagedExpanded: mockState.untriagedExpanded,
    readyShowAll: mockState.readyShowAll,
    approveFinding,
    dismissFinding,
    setFindingTag,
    setFindingPriority,
    toggleFindingSelected,
    selectAllReady,
    selectBucket,
    toggleUntriagedExpand,
    toggleReadyShowAll,
  };
}

// The REAL insightsStore module imports trpc + the projects API at module scope;
// importOriginal() below executes it, so stub those so the import does not reach a
// live Electron IPC bridge (we only consume the store's PURE selectors here).
vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      reviewItems: {
        list: { query: vi.fn() },
        approve: { mutate: vi.fn() },
        dismiss: { mutate: vi.fn() },
        setTag: { mutate: vi.fn() },
        setPriority: { mutate: vi.fn() },
        setSelected: { mutate: vi.fn() },
        onReviewItemChanged: { subscribe: vi.fn() },
      },
      insights: {},
      events: {},
    },
  },
}));
vi.mock('../../../utils/api', () => ({ API: { projects: { getAll: vi.fn() } } }));

vi.mock('../../../stores/insightsStore', async (importOriginal) => {
  // Keep the REAL pure selectors (stateless) and replace only the hook so the
  // load-bearing bucketing/allocation/tally logic is exercised, not re-stubbed.
  const actual = await importOriginal<typeof import('../../../stores/insightsStore')>();
  // The hook: re-render via a React state-bump subscribed to `mockListeners`.
  const { useState, useEffect } = await import('react');
  const useInsightsStore = (selector: (s: ReturnType<typeof mockSelectState>) => unknown) => {
    const [, force] = useState(0);
    useEffect(() => {
      const l = () => force((n) => n + 1);
      mockListeners.add(l);
      return () => {
        mockListeners.delete(l);
      };
    }, []);
    return selector(mockSelectState());
  };
  useInsightsStore.getState = () => mockSelectState();
  // The real useVisibleTriageFindings closes over the REAL (empty) zustand store,
  // so override it to read the MOCK state through the mock hook + the REAL pure
  // selectors (the selection-locked project filter under test).
  const useVisibleTriageFindings = (): TriageFinding[] => {
    const findings = useInsightsStore((s) => s.triageFindings) as TriageFinding[];
    return actual.selectVisibleFindings(findings, actual.selectLockProjectId(findings));
  };
  return { ...actual, useInsightsStore, useVisibleTriageFindings };
});

const mockGoToWizard = vi.fn();
vi.mock('../../../stores/navigationStore', () => {
  const useNavigationStore = (selector: (s: { goToWizard: typeof mockGoToWizard }) => unknown) =>
    selector({ goToWizard: mockGoToWizard });
  useNavigationStore.getState = () => ({ goToWizard: mockGoToWizard });
  return { useNavigationStore };
});

let mockProjectsCount = 1;
vi.mock('../../../stores/landingStore', () => ({
  useProjectsCount: () => mockProjectsCount,
  useLandingProjects: () => [{ id: 1, name: 'cyboflow' }],
}));

import { FindingsSection } from '../FindingsSection';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

let idCounter = 0;
function finding(overrides: Partial<TriageFinding> = {}): TriageFinding {
  idCounter += 1;
  const staged = overrides.staged_at ?? null;
  return {
    id: overrides.id ?? `f-${idCounter}`,
    project_id: 1,
    run_id: 'run-1',
    entity_type: null,
    entity_id: null,
    kind: 'finding',
    status: 'pending',
    blocking: false,
    title: overrides.title ?? `Finding ${idCounter}`,
    body: null,
    severity: 'warning',
    priority: null,
    staged_at: staged,
    selected: false,
    source: 'agent:executor',
    payload: { kind: 'finding' },
    created_at: `2026-06-2${idCounter % 9}T00:00:00.000Z`,
    updated_at: '2026-06-20T00:00:00.000Z',
    resolved_by: null,
    resolution: null,
    triageState: staged === null ? 'untriaged' : 'ready',
    ...overrides,
  };
}

/** A staged (ready) finding with a given target bucket + priority. */
function ready(
  target: FindingProposedTarget | null,
  priority: FindingPriority | null,
  extra: Partial<TriageFinding> = {},
): TriageFinding {
  return finding({
    staged_at: '2026-06-20T00:00:00.000Z',
    triageState: 'ready',
    priority,
    payload: target === null ? { kind: 'finding' } : { kind: 'finding', proposedTarget: target },
    ...extra,
  });
}

function setFindings(findings: TriageFinding[]): void {
  mockState.triageFindings = findings;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  idCounter = 0;
  mockListeners.clear();
  mockProjectsCount = 1;
  mockState = {
    triageFindings: [],
    reviewSummary: {
      total: 0,
      pending: 0,
      resolved: 0,
      dismissed: 0,
      pendingByKind: { finding: 0, permission: 0, decision: 0, human_task: 0, notification: 0 },
    },
    qualityFindings: [],
    projectFilter: null,
    untriagedExpanded: false,
    readyShowAll: false,
  };
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Cold-start + empty states
// ---------------------------------------------------------------------------

describe('FindingsSection — empty states', () => {
  it('renders the cold-start empty states for both sections', () => {
    render(<FindingsSection />);
    expect(screen.getByTestId('findings-section')).toBeInTheDocument();
    expect(screen.getByTestId('untriaged-empty')).toHaveTextContent(/nothing to triage/i);
    expect(screen.getByTestId('ready-empty')).toHaveTextContent(/approve a finding/i);
  });

  it('shows the untriaged-empty state when only ready findings exist', () => {
    setFindings([ready('fix', 'P0')]);
    render(<FindingsSection />);
    expect(screen.getByTestId('untriaged-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('ready-empty')).not.toBeInTheDocument();
  });

  it('shows the ready-empty state when only untriaged findings exist', () => {
    setFindings([finding()]);
    render(<FindingsSection />);
    expect(screen.getByTestId('ready-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('untriaged-empty')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Untriaged list: top-5 + Show N more
// ---------------------------------------------------------------------------

describe('FindingsSection — untriaged top-5 + show more', () => {
  it('renders only the top 5 untriaged rows and a "Show N more" toggle', () => {
    setFindings(Array.from({ length: 8 }, () => finding()));
    render(<FindingsSection />);
    expect(screen.getAllByTestId('untriaged-row')).toHaveLength(5);
    const toggle = screen.getByTestId('untriaged-toggle');
    expect(toggle).toHaveTextContent('Show 3 more untriaged');
  });

  it('expands to all rows then collapses', () => {
    setFindings(Array.from({ length: 8 }, () => finding()));
    render(<FindingsSection />);
    fireEvent.click(screen.getByTestId('untriaged-toggle'));
    expect(toggleUntriagedExpand).toHaveBeenCalledTimes(1);
    expect(screen.getAllByTestId('untriaged-row')).toHaveLength(8);
    expect(screen.getByTestId('untriaged-toggle')).toHaveTextContent('Collapse');
    fireEvent.click(screen.getByTestId('untriaged-toggle'));
    expect(screen.getAllByTestId('untriaged-row')).toHaveLength(5);
  });

  it('renders no toggle when there are <=5 untriaged rows', () => {
    setFindings(Array.from({ length: 4 }, () => finding()));
    render(<FindingsSection />);
    expect(screen.queryByTestId('untriaged-toggle')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Per-row actions
// ---------------------------------------------------------------------------

describe('FindingsSection — row actions', () => {
  it('Approve stages a finding into the matching ready bucket, NOT selected', () => {
    setFindings([finding({ id: 'a', payload: { kind: 'finding', proposedTarget: 'fix' } })]);
    render(<FindingsSection />);
    fireEvent.click(within(screen.getByTestId('untriaged-row')).getByTestId('untriaged-approve'));
    expect(approveFinding).toHaveBeenCalledWith(1, 'a');
    // Now ready, in the quick bucket, but UNSELECTED — selection is a separate action.
    expect(screen.queryByTestId('untriaged-row')).not.toBeInTheDocument();
    const quick = screen.getByTestId('ready-bucket-quick');
    expect(within(quick).getByTestId('ready-row')).toHaveAttribute('data-selected', 'false');
  });

  it('Approve of an UNTAGGED finding defaults it to the Quick fix bucket (OD-3)', () => {
    setFindings([finding({ id: 'u', payload: { kind: 'finding' } })]);
    render(<FindingsSection />);
    fireEvent.click(screen.getByTestId('untriaged-approve'));
    // OD-3: an untagged finding is explicitly tagged 'fix' on approve, so it lands
    // in the Quick fix bucket (NOT the data-layer null→doc fold).
    expect(setFindingTag).toHaveBeenCalledWith(1, 'u', 'fix');
    expect(approveFinding).toHaveBeenCalledWith(1, 'u');
    expect(screen.getByTestId('ready-bucket-quick')).toBeInTheDocument();
    expect(screen.queryByTestId('ready-bucket-doc')).not.toBeInTheDocument();
  });

  it('Dismiss removes the row and bumps the Dismissed counter', () => {
    setFindings([finding({ id: 'd' }), finding({ id: 'keep' })]);
    mockState.reviewSummary = {
      total: 2,
      pending: 2,
      resolved: 0,
      dismissed: 0,
      pendingByKind: { finding: 2, permission: 0, decision: 0, human_task: 0, notification: 0 },
    };
    render(<FindingsSection />);
    expect(screen.getByTestId('findings-counter-dismissed')).toHaveTextContent('0');
    const targetRow = screen
      .getAllByTestId('untriaged-row')
      .find((r) => r.getAttribute('data-finding-id') === 'd');
    expect(targetRow).toBeDefined();
    fireEvent.click(within(targetRow as HTMLElement).getByTestId('untriaged-dismiss'));
    expect(dismissFinding).toHaveBeenCalledWith(1, 'd');
    expect(screen.getAllByTestId('untriaged-row')).toHaveLength(1);
    expect(screen.getByTestId('findings-counter-dismissed')).toHaveTextContent('1');
    expect(screen.getByTestId('findings-counter-pending')).toHaveTextContent('1');
  });
});

// ---------------------------------------------------------------------------
// Modify drawer
// ---------------------------------------------------------------------------

describe('FindingsSection — modify drawer', () => {
  it('opens one drawer at a time (opening B closes A)', () => {
    setFindings([finding({ id: 'a' }), finding({ id: 'b' })]);
    render(<FindingsSection />);
    const rows = screen.getAllByTestId('untriaged-row');
    fireEvent.click(within(rows[0]).getByTestId('untriaged-modify'));
    expect(screen.getAllByTestId('modify-drawer')).toHaveLength(1);
    expect(within(rows[0]).getByTestId('modify-drawer')).toBeInTheDocument();
    fireEvent.click(within(rows[1]).getByTestId('untriaged-modify'));
    expect(screen.getAllByTestId('modify-drawer')).toHaveLength(1);
    expect(within(rows[1]).getByTestId('modify-drawer')).toBeInTheDocument();
  });

  it('re-tag and re-prioritize mutate the finding in place', () => {
    setFindings([finding({ id: 'a' })]);
    render(<FindingsSection />);
    fireEvent.click(screen.getByTestId('untriaged-modify'));
    const drawer = screen.getByTestId('modify-drawer');
    // Re-tag → Quick fix (target 'fix').
    fireEvent.click(within(drawer).getByText('Quick fix'));
    expect(setFindingTag).toHaveBeenCalledWith(1, 'a', 'fix');
    // Re-prioritize → P0.
    fireEvent.click(within(screen.getByTestId('modify-drawer')).getByText('P0'));
    expect(setFindingPriority).toHaveBeenCalledWith(1, 'a', 'P0');
    // The mutated finding's badge reflects P0 now (in place).
    expect(within(screen.getByTestId('untriaged-row')).getByTestId('priority-badge')).toHaveTextContent(
      'P0',
    );
  });

  it('closes the drawer when its row is approved', () => {
    setFindings([finding({ id: 'a', payload: { kind: 'finding', proposedTarget: 'fix' } })]);
    render(<FindingsSection />);
    fireEvent.click(screen.getByTestId('untriaged-modify'));
    expect(screen.getByTestId('modify-drawer')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('untriaged-approve'));
    expect(screen.queryByTestId('modify-drawer')).not.toBeInTheDocument();
  });

  it('closes the drawer via Done', () => {
    setFindings([finding({ id: 'a' })]);
    render(<FindingsSection />);
    fireEvent.click(screen.getByTestId('untriaged-modify'));
    fireEvent.click(screen.getByTestId('modify-drawer-done'));
    expect(screen.queryByTestId('modify-drawer')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Ready section: greedy-5 budget + bucket order + header counts
// ---------------------------------------------------------------------------

describe('FindingsSection — ready greedy budget', () => {
  it('renders EXACTLY 5 rows in bucket order and hides a starved bucket', () => {
    // 4 quick + 4 doc + 2 task = 10 ready; budget 5 fills quick(4) then doc(1),
    // leaving the task bucket entirely starved (hidden) but present buckets keep
    // their FULL header counts.
    setFindings([
      ...Array.from({ length: 4 }, () => ready('fix', 'P1')),
      ...Array.from({ length: 4 }, () => ready('docs', 'P1')),
      ...Array.from({ length: 2 }, () => ready('backlog', 'P1')),
    ]);
    render(<FindingsSection />);
    expect(screen.getAllByTestId('ready-row')).toHaveLength(5);
    // Quick first (4), then doc (1); task hidden.
    expect(within(screen.getByTestId('ready-bucket-quick')).getAllByTestId('ready-row')).toHaveLength(4);
    expect(within(screen.getByTestId('ready-bucket-doc')).getAllByTestId('ready-row')).toHaveLength(1);
    expect(screen.queryByTestId('ready-bucket-task')).not.toBeInTheDocument();
    // Present buckets show FULL header counts (selected/total = 0/4).
    expect(within(screen.getByTestId('ready-bucket-quick')).getByText('0/4')).toBeInTheDocument();
    expect(within(screen.getByTestId('ready-bucket-doc')).getByText('0/4')).toBeInTheDocument();
    // ONE section-level toggle labelled with the hidden count (10 - 5 = 5).
    expect(screen.getByTestId('ready-toggle')).toHaveTextContent('Show 5 more');
  });

  it('expands to show all ready rows with one section toggle', () => {
    setFindings([
      ...Array.from({ length: 4 }, () => ready('fix', 'P1')),
      ...Array.from({ length: 4 }, () => ready('docs', 'P1')),
      ...Array.from({ length: 2 }, () => ready('backlog', 'P1')),
    ]);
    render(<FindingsSection />);
    fireEvent.click(screen.getByTestId('ready-toggle'));
    expect(toggleReadyShowAll).toHaveBeenCalledTimes(1);
    expect(screen.getAllByTestId('ready-row')).toHaveLength(10);
    expect(screen.getByTestId('ready-bucket-task')).toBeInTheDocument();
    expect(screen.getByTestId('ready-toggle')).toHaveTextContent('Collapse');
  });

  it('orders rows P0 → P1 → P2 within a bucket (null last)', () => {
    setFindings([
      ready('fix', 'P2', { id: 'p2', title: 'priority-two' }),
      ready('fix', null, { id: 'pnull', title: 'priority-none' }),
      ready('fix', 'P0', { id: 'p0', title: 'priority-zero' }),
      ready('fix', 'P1', { id: 'p1', title: 'priority-one' }),
    ]);
    render(<FindingsSection />);
    const rows = within(screen.getByTestId('ready-bucket-quick')).getAllByTestId('ready-row');
    expect(rows.map((r) => r.getAttribute('data-finding-id'))).toEqual(['p0', 'p1', 'p2', 'pnull']);
  });

  it("folds a legacy 'prompt' target into the doc bucket", () => {
    setFindings([ready('prompt', 'P1', { id: 'legacy' })]);
    render(<FindingsSection />);
    expect(screen.getByTestId('ready-bucket-doc')).toBeInTheDocument();
    expect(screen.queryByTestId('ready-bucket-quick')).not.toBeInTheDocument();
  });

  it("renders the UNSET '—' badge for a null priority", () => {
    setFindings([ready('fix', null, { id: 'np' })]);
    render(<FindingsSection />);
    const row = within(screen.getByTestId('ready-bucket-quick')).getByTestId('ready-row');
    expect(within(row).getByTestId('priority-badge')).toHaveTextContent('—');
  });
});

// ---------------------------------------------------------------------------
// Selection toggles
// ---------------------------------------------------------------------------

describe('FindingsSection — selection', () => {
  it('toggles one ready row (whole-row click)', () => {
    setFindings([ready('fix', 'P0', { id: 'r1', selected: false })]);
    render(<FindingsSection />);
    fireEvent.click(within(screen.getByTestId('ready-bucket-quick')).getByTestId('ready-row'));
    expect(toggleFindingSelected).toHaveBeenCalledWith(1, 'r1');
    expect(within(screen.getByTestId('ready-bucket-quick')).getByTestId('ready-row')).toHaveAttribute(
      'data-selected',
      'true',
    );
  });

  it('toggles a whole bucket via its header checkbox', () => {
    setFindings([ready('fix', 'P0', { id: 'r1' }), ready('fix', 'P1', { id: 'r2' })]);
    render(<FindingsSection />);
    fireEvent.click(screen.getByTestId('ready-bucket-checkbox-quick'));
    expect(selectBucket).toHaveBeenCalledWith(1, 'quick', true);
    expect(within(screen.getByTestId('ready-bucket-quick')).getByText('2/2')).toBeInTheDocument();
  });

  it('Select all / Deselect all toggles every ready finding', () => {
    setFindings([ready('fix', 'P0', { id: 'q' }), ready('docs', 'P0', { id: 'd' })]);
    render(<FindingsSection />);
    fireEvent.click(screen.getByTestId('ready-select-all'));
    expect(selectAllReady).toHaveBeenCalledWith(1, true);
    expect(screen.getByTestId('ready-select-all')).toHaveTextContent('Deselect all');
    fireEvent.click(screen.getByTestId('ready-select-all'));
    expect(selectAllReady).toHaveBeenCalledWith(1, false);
  });
});

// ---------------------------------------------------------------------------
// Compounding tray
// ---------------------------------------------------------------------------

describe('FindingsSection — compounding tray', () => {
  it('renders the pluralized tally + CTA count for the selected set', () => {
    setFindings([
      ready('fix', 'P0', { id: 'q1', selected: true }),
      ready('fix', 'P1', { id: 'q2', selected: true }),
      ready('docs', 'P0', { id: 'd1', selected: true }),
      ready('backlog', 'P0', { id: 't1', selected: false }),
    ]);
    render(<FindingsSection />);
    const tray = screen.getByTestId('compounding-tray');
    expect(tray).toHaveTextContent('Compounding 3 findings → 2 quick fixes · 1 doc update');
    expect(screen.getByTestId('run-compounding-session')).toHaveTextContent('Run compounding session (3) →');
  });

  it("shows 'nothing selected' and disables the CTA when nothing is selected", () => {
    setFindings([ready('fix', 'P0', { id: 'q1', selected: false })]);
    render(<FindingsSection />);
    expect(screen.getByTestId('compounding-tray')).toHaveTextContent('nothing selected');
    expect(screen.getByTestId('run-compounding-session')).toBeDisabled();
  });

  it('routes the CTA through goToWizard with compound + selected ids + the selection-derived lockProjectId', () => {
    setFindings([
      ready('fix', 'P0', { id: 'q1', selected: true }),
      ready('docs', 'P0', { id: 'd1', selected: true }),
      ready('backlog', 'P0', { id: 't1', selected: false }),
    ]);
    render(<FindingsSection />);
    fireEvent.click(screen.getByTestId('run-compounding-session'));
    expect(mockGoToWizard).toHaveBeenCalledTimes(1);
    // No explicit projectFilter, but the selection is single-project (the fixtures
    // default to project 1), so lockProjectId is derived from it → the wizard skips
    // the project step and lands on Configure.
    expect(mockGoToWizard).toHaveBeenCalledWith({
      preselectWorkflowName: 'compound',
      selectedFindingIds: ['q1', 'd1'],
      lockProjectId: 1,
    });
  });

  it('threads the active project filter as lockProjectId when set', () => {
    mockState.projectFilter = 7;
    setFindings([ready('fix', 'P0', { id: 'q1', selected: true })]);
    render(<FindingsSection />);
    fireEvent.click(screen.getByTestId('run-compounding-session'));
    expect(mockGoToWizard).toHaveBeenCalledWith({
      preselectWorkflowName: 'compound',
      selectedFindingIds: ['q1'],
      lockProjectId: 7,
    });
  });

  it('hides the tray when there are no projects', () => {
    mockProjectsCount = 0;
    setFindings([ready('fix', 'P0', { id: 'q1', selected: true })]);
    render(<FindingsSection />);
    expect(screen.queryByTestId('compounding-tray')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Single-project selection lock: selecting a finding narrows ONLY the
// READY-to-compound section to that finding's project. The untriaged list and
// the Pending counter stay unfiltered (triage is cross-project).
// ---------------------------------------------------------------------------

describe('FindingsSection — single-project selection lock', () => {
  it('renders ALL projects when nothing is selected', () => {
    setFindings([
      finding({ id: 'a-u', project_id: 1, title: 'A untriaged' }),
      finding({ id: 'b-u', project_id: 2, title: 'B untriaged' }),
      ready('fix', 'P0', { id: 'a-r', project_id: 1 }),
      ready('docs', 'P0', { id: 'b-r', project_id: 2 }),
    ]);
    render(<FindingsSection />);
    expect(screen.getByText('A untriaged')).toBeInTheDocument();
    expect(screen.getByText('B untriaged')).toBeInTheDocument();
    expect(screen.getByTestId('ready-bucket-quick')).toBeInTheDocument();
    expect(screen.getByTestId('ready-bucket-doc')).toBeInTheDocument();
  });

  it('filters ONLY the ready section once a finding is selected; untriaged + counter stay unfiltered', () => {
    setFindings([
      finding({ id: 'a-u', project_id: 1, title: 'A untriaged' }),
      finding({ id: 'b-u', project_id: 2, title: 'B untriaged' }),
      ready('fix', 'P0', { id: 'a-r', project_id: 1 }), // quick bucket, project 1
      ready('docs', 'P0', { id: 'b-r', project_id: 2 }), // doc bucket, project 2
    ]);
    render(<FindingsSection />);
    // Click the project-1 quick row (the only row in the quick bucket) to select it.
    fireEvent.click(within(screen.getByTestId('ready-bucket-quick')).getByTestId('ready-row'));
    expect(toggleFindingSelected).toHaveBeenCalledWith(1, 'a-r');

    // READY section locks to project 1: project-2's doc bucket disappears.
    expect(screen.getByTestId('ready-bucket-quick')).toBeInTheDocument();
    expect(screen.queryByTestId('ready-bucket-doc')).not.toBeInTheDocument();

    // UNTRIAGED list stays UNFILTERED — both projects' untriaged rows remain.
    expect(screen.getByText('A untriaged')).toBeInTheDocument();
    expect(screen.getByText('B untriaged')).toBeInTheDocument();

    // The Pending counter is the total backlog (all 4 pending), NOT narrowed.
    expect(within(screen.getByTestId('findings-counter-pending')).getByText('4')).toBeInTheDocument();
  });

  it('the tray CTA threads the selection-derived lockProjectId (cross-project, no filter)', () => {
    setFindings([
      ready('fix', 'P0', { id: 'a-r', project_id: 1 }),
      ready('docs', 'P0', { id: 'b-r', project_id: 2 }),
    ]);
    render(<FindingsSection />);
    fireEvent.click(within(screen.getByTestId('ready-bucket-quick')).getByTestId('ready-row'));
    fireEvent.click(screen.getByTestId('run-compounding-session'));
    expect(mockGoToWizard).toHaveBeenCalledWith({
      preselectWorkflowName: 'compound',
      selectedFindingIds: ['a-r'],
      lockProjectId: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// Pure selectors sanity (the store contract the section binds to)
// ---------------------------------------------------------------------------

describe('FindingsSection — selector contract', () => {
  it('selectFindingsCounters is findings-scoped — pending = the rendered triage rows', () => {
    // pending = triageFindings.length (untriaged ∪ ready), NOT a whole-inbox
    // finding total: orphan-hidden findings are never in this list.
    const triage: TriageFinding[] = [finding({ id: 'a' }), finding({ id: 'b' }), finding({ id: 'c' })];
    const quality: QualityFinding[] = [qualityDismissed(finding({ id: 'x' }))];
    quality[0].status = 'resolved';
    const counters = selectFindingsCounters(triage, quality);
    expect(counters.pending).toBe(3); // = triageFindings.length
    expect(counters.resolved).toBe(1);
  });

  it('selectSelectedFindingIds returns selected ready ids in bucket order', () => {
    const findings = [
      ready('backlog', 'P0', { id: 't', selected: true }),
      ready('fix', 'P0', { id: 'q', selected: true }),
      ready('docs', 'P0', { id: 'd', selected: false }),
    ];
    expect(selectSelectedFindingIds(findings)).toEqual(['q', 't']);
  });

  it('selectUntriaged excludes ready findings', () => {
    const findings = [finding({ id: 'u' }), ready('fix', 'P0', { id: 'r' })];
    expect(selectUntriaged(findings).map((f) => f.id)).toEqual(['u']);
  });

  it('selectReadyBuckets + selectGreedyReadyRows + selectTallyParts compose', () => {
    const findings = [ready('fix', 'P0', { id: 'q', selected: true })];
    const buckets = selectReadyBuckets(findings);
    expect(buckets.quick).toHaveLength(1);
    expect(selectGreedyReadyRows(buckets, false).visibleRows).toBe(1);
    expect(selectTallyParts(findings)).toEqual({ count: 1, quick: 1, doc: 0, task: 0 });
  });
});
