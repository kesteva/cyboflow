/**
 * dynamicWorkflowStore — seed / snapshot-replace / selector unit tests.
 *
 * Covers:
 *   (a) init() seeds byWfRunId from dynamicWorkflows.list({})
 *   (b) an onChanged event REPLACES the keyed entry with the full snapshot
 *       (never merges — fields absent from the new snapshot disappear)
 *   (c) an event for an unseen wfRunId inserts a new entry
 *   (d) selectForSession filters by sessionId and sorts startedAt desc
 *   (e) selectActive keeps only status === 'running' across all sessions
 *   (f) init() is idempotent (one list query, one subscription)
 *   (g) a failed seed warns and leaves state untouched
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  DynamicWorkflowChangedEvent,
  DynamicWorkflowRemovedEvent,
  DynamicWorkflowRunState,
} from '../../../../shared/types/dynamicWorkflows';

// ---------------------------------------------------------------------------
// Mock the trpc client before the store is imported (vi.mock is hoisted, so
// the mock fns must come from vi.hoisted — same pattern as mcpHealthStore.test).
// ---------------------------------------------------------------------------

const { mockListQuery, mockOnChangedSubscribe, mockOnRemovedSubscribe } = vi.hoisted(() => ({
  mockListQuery:
    vi.fn<(input: { sessionId?: string }) => Promise<DynamicWorkflowRunState[]>>(),
  mockOnChangedSubscribe: vi.fn<
    (
      input: undefined,
      observer: {
        onData: (event: DynamicWorkflowChangedEvent) => void;
        onError: (err: unknown) => void;
      },
    ) => { unsubscribe: () => void }
  >(),
  mockOnRemovedSubscribe: vi.fn<
    (
      input: undefined,
      observer: {
        onData: (event: DynamicWorkflowRemovedEvent) => void;
        onError: (err: unknown) => void;
      },
    ) => { unsubscribe: () => void }
  >(),
}));

vi.mock('../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      dynamicWorkflows: {
        list: { query: mockListQuery },
        onChanged: { subscribe: mockOnChangedSubscribe },
        onRemoved: { subscribe: mockOnRemovedSubscribe },
      },
    },
  },
}));

import {
  useDynamicWorkflowStore,
  selectForSession,
  selectActive,
} from '../dynamicWorkflowStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(overrides: Partial<DynamicWorkflowRunState> = {}): DynamicWorkflowRunState {
  return {
    wfRunId: 'wf_a',
    taskId: 'w1',
    runId: 'run-1',
    sessionId: 'sess-1',
    projectId: 1,
    sessionName: 'tester-mctest',
    name: 'refactor-blitz',
    phases: [{ title: 'Plan' }, { title: 'Execute' }],
    agents: [],
    status: 'running',
    startedAt: '2026-06-11T10:00:00.000Z',
    ...overrides,
  };
}

/** Flush the seed query's .then chain (a couple of microtask turns). */
async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

/** The observer the store registered on the (mocked) onChanged subscription. */
function capturedObserver() {
  expect(mockOnChangedSubscribe).toHaveBeenCalledTimes(1);
  return mockOnChangedSubscribe.mock.calls[0][1];
}

/** The observer the store registered on the (mocked) onRemoved subscription. */
function capturedRemovedObserver() {
  expect(mockOnRemovedSubscribe).toHaveBeenCalledTimes(1);
  return mockOnRemovedSubscribe.mock.calls[0][1];
}

let teardown: (() => void) | null = null;

beforeEach(() => {
  mockListQuery.mockReset();
  mockOnChangedSubscribe.mockReset();
  mockOnRemovedSubscribe.mockReset();
  mockListQuery.mockResolvedValue([]);
  mockOnChangedSubscribe.mockReturnValue({ unsubscribe: vi.fn() });
  mockOnRemovedSubscribe.mockReturnValue({ unsubscribe: vi.fn() });
  useDynamicWorkflowStore.setState({ byWfRunId: {} });
});

afterEach(() => {
  // Resets the store's `initialized` guard so the next test can re-init.
  teardown?.();
  teardown = null;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dynamicWorkflowStore — init seed', () => {
  it('(a) seeds byWfRunId from dynamicWorkflows.list({})', async () => {
    const a = makeState({ wfRunId: 'wf_a' });
    const b = makeState({ wfRunId: 'wf_b', sessionId: 'sess-2' });
    mockListQuery.mockResolvedValue([a, b]);

    teardown = useDynamicWorkflowStore.getState().init();
    await flushMicrotasks();

    expect(mockListQuery).toHaveBeenCalledWith({});
    expect(useDynamicWorkflowStore.getState().byWfRunId).toEqual({ wf_a: a, wf_b: b });
  });

  it('(g) warns and leaves state untouched when the seed query fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockListQuery.mockRejectedValue(new Error('tRPC unavailable'));

    teardown = useDynamicWorkflowStore.getState().init();
    await flushMicrotasks();

    expect(useDynamicWorkflowStore.getState().byWfRunId).toEqual({});
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('(f) is idempotent — one list query, one subscription, same unsubscribe', async () => {
    teardown = useDynamicWorkflowStore.getState().init();
    const second = useDynamicWorkflowStore.getState().init();
    await flushMicrotasks();

    expect(mockListQuery).toHaveBeenCalledTimes(1);
    expect(mockOnChangedSubscribe).toHaveBeenCalledTimes(1);
    expect(second).toBe(teardown);
  });
});

describe('dynamicWorkflowStore — onChanged snapshots', () => {
  it('(b) REPLACES the keyed entry with the full snapshot (never merges)', async () => {
    const seeded = makeState({
      wfRunId: 'wf_a',
      description: 'stale description',
      agents: [{ agentId: 'agent-1', status: 'running' }],
    });
    mockListQuery.mockResolvedValue([seeded]);

    teardown = useDynamicWorkflowStore.getState().init();
    await flushMicrotasks();

    // New snapshot omits `description` — after replace it must be GONE.
    const next = makeState({
      wfRunId: 'wf_a',
      agents: [{ agentId: 'agent-1', status: 'done' }],
      status: 'completed',
      completedAt: '2026-06-11T10:05:00.000Z',
      summary: 'all done',
      totals: { agentCount: 1 },
    });
    capturedObserver().onData({ state: next });

    const stored = useDynamicWorkflowStore.getState().byWfRunId['wf_a'];
    expect(stored).toEqual(next);
    expect(stored.description).toBeUndefined();
    expect(stored.agents).toEqual([{ agentId: 'agent-1', status: 'done' }]);
  });

  it('(c) inserts a new entry for an unseen wfRunId', async () => {
    teardown = useDynamicWorkflowStore.getState().init();
    await flushMicrotasks();

    const fresh = makeState({ wfRunId: 'wf_new' });
    capturedObserver().onData({ state: fresh });

    expect(useDynamicWorkflowStore.getState().byWfRunId).toEqual({ wf_new: fresh });
  });
});

describe('dynamicWorkflowStore — onRemoved', () => {
  it('(h) drops the keyed entry on removal; unknown wfRunId is a no-op', async () => {
    const a = makeState({ wfRunId: 'wf_a' });
    const b = makeState({ wfRunId: 'wf_b' });
    mockListQuery.mockResolvedValue([a, b]);

    teardown = useDynamicWorkflowStore.getState().init();
    await flushMicrotasks();

    capturedRemovedObserver().onData({ wfRunId: 'wf_a' });
    expect(useDynamicWorkflowStore.getState().byWfRunId).toEqual({ wf_b: b });

    // Removing an id that is not present leaves state untouched.
    capturedRemovedObserver().onData({ wfRunId: 'wf_gone' });
    expect(useDynamicWorkflowStore.getState().byWfRunId).toEqual({ wf_b: b });
  });
});

describe('dynamicWorkflowStore — selectors', () => {
  it('(d) selectForSession filters by sessionId and sorts startedAt desc', () => {
    const older = makeState({
      wfRunId: 'wf_old',
      sessionId: 'sess-1',
      startedAt: '2026-06-11T09:00:00.000Z',
    });
    const newer = makeState({
      wfRunId: 'wf_new',
      sessionId: 'sess-1',
      startedAt: '2026-06-11T11:00:00.000Z',
    });
    const other = makeState({ wfRunId: 'wf_other', sessionId: 'sess-2' });

    const rows = selectForSession(
      { wf_old: older, wf_new: newer, wf_other: other },
      'sess-1',
    );
    expect(rows.map((r) => r.wfRunId)).toEqual(['wf_new', 'wf_old']);
  });

  it('(e) selectActive keeps only running workflows across all sessions', () => {
    const running1 = makeState({ wfRunId: 'wf_r1', sessionId: 'sess-1' });
    const running2 = makeState({ wfRunId: 'wf_r2', sessionId: 'sess-2' });
    const done = makeState({ wfRunId: 'wf_d', status: 'completed' });
    const failed = makeState({ wfRunId: 'wf_f', status: 'failed' });

    const rows = selectActive({ wf_r1: running1, wf_r2: running2, wf_d: done, wf_f: failed });
    expect(rows.map((r) => r.wfRunId).sort()).toEqual(['wf_r1', 'wf_r2']);
  });
});
