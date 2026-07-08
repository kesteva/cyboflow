/**
 * Unit tests for variantsStore.
 *
 * Verifies:
 *   (a) fetch populates byWorkflowId + loadedWorkflowIds for the given workflowId.
 *   (b) fetch is a re-entrancy no-op while already loading for that workflowId.
 *   (c) a fetch failure records the error and leaves loading false.
 *   (d) invalidate re-fetches even if a (settled) fetch already ran, and
 *       bypasses the loading re-entrancy guard.
 *   (e) two workflowIds are tracked independently.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkflowVariantRow } from '../variantsStore';

const { mockVariantsListQuery, mockGetBaselineRotationQuery } = vi.hoisted(() => ({
  mockVariantsListQuery: vi.fn<(input: { workflowId: string }) => Promise<WorkflowVariantRow[]>>(),
  mockGetBaselineRotationQuery:
    vi.fn<(input: { workflowId: string }) => Promise<{ inRotation: boolean; weight: number }>>(),
}));

vi.mock('../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      variants: {
        list: {
          query: mockVariantsListQuery,
        },
        getBaselineRotation: {
          query: mockGetBaselineRotationQuery,
        },
      },
    },
  },
}));

import { useVariantsStore } from '../variantsStore';

function makeVariant(overrides: Partial<WorkflowVariantRow> = {}): WorkflowVariantRow {
  return {
    id: 'wfv_1',
    workflow_id: 'wf-1',
    label: 'Variant A',
    spec_json: '{}',
    agent_overrides_json: null,
    model: null,
    execution_model: null,
    weight: 1,
    status: 'active',
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

beforeEach(() => {
  mockVariantsListQuery.mockReset();
  mockGetBaselineRotationQuery.mockReset().mockResolvedValue({ inRotation: false, weight: 1 });
  useVariantsStore.setState({
    byWorkflowId: {},
    baselineByWorkflowId: {},
    loadedWorkflowIds: {},
    loading: {},
    error: {},
  });
});

describe('variantsStore.fetch', () => {
  it('(a) populates byWorkflowId + baselineByWorkflowId + loadedWorkflowIds on success', async () => {
    mockVariantsListQuery.mockResolvedValue([makeVariant()]);
    mockGetBaselineRotationQuery.mockResolvedValue({ inRotation: true, weight: 3 });
    await useVariantsStore.getState().fetch('wf-1');

    expect(useVariantsStore.getState().byWorkflowId['wf-1']).toHaveLength(1);
    expect(useVariantsStore.getState().baselineByWorkflowId['wf-1']).toEqual({ inRotation: true, weight: 3 });
    expect(useVariantsStore.getState().loadedWorkflowIds['wf-1']).toBe(true);
    expect(useVariantsStore.getState().loading['wf-1']).toBe(false);
    expect(useVariantsStore.getState().error['wf-1']).toBeNull();
  });

  it('(b) is a no-op re-entrancy guard while already loading', async () => {
    let resolveFirst: (rows: WorkflowVariantRow[]) => void = () => {};
    mockVariantsListQuery.mockImplementationOnce(
      () => new Promise((resolve) => { resolveFirst = resolve; }),
    );
    const firstCall = useVariantsStore.getState().fetch('wf-1');
    // A second fetch while the first is in flight must not call the query again.
    await useVariantsStore.getState().fetch('wf-1');
    expect(mockVariantsListQuery).toHaveBeenCalledTimes(1);

    resolveFirst([makeVariant()]);
    await firstCall;
    expect(useVariantsStore.getState().byWorkflowId['wf-1']).toHaveLength(1);
  });

  it('(c) records the error message on failure and leaves loading false', async () => {
    mockVariantsListQuery.mockRejectedValue(new Error('boom'));
    await useVariantsStore.getState().fetch('wf-1');

    expect(useVariantsStore.getState().error['wf-1']).toBe('boom');
    expect(useVariantsStore.getState().loading['wf-1']).toBe(false);
    expect(useVariantsStore.getState().loadedWorkflowIds['wf-1']).toBeUndefined();
  });

  it('(e) tracks two workflowIds independently', async () => {
    mockVariantsListQuery.mockImplementation(({ workflowId }) =>
      Promise.resolve([makeVariant({ id: `${workflowId}-v1`, workflow_id: workflowId })]),
    );
    await useVariantsStore.getState().fetch('wf-1');
    await useVariantsStore.getState().fetch('wf-2');

    expect(useVariantsStore.getState().byWorkflowId['wf-1']).toHaveLength(1);
    expect(useVariantsStore.getState().byWorkflowId['wf-2']).toHaveLength(1);
    expect(useVariantsStore.getState().byWorkflowId['wf-1'][0].id).toBe('wf-1-v1');
    expect(useVariantsStore.getState().byWorkflowId['wf-2'][0].id).toBe('wf-2-v1');
  });
});

describe('variantsStore.invalidate', () => {
  it('(d) re-fetches even right after a settled fetch, refreshing the list', async () => {
    mockVariantsListQuery.mockResolvedValueOnce([makeVariant({ id: 'v1' })]);
    await useVariantsStore.getState().fetch('wf-1');
    expect(useVariantsStore.getState().byWorkflowId['wf-1']).toHaveLength(1);

    mockVariantsListQuery.mockResolvedValueOnce([makeVariant({ id: 'v1' }), makeVariant({ id: 'v2' })]);
    await useVariantsStore.getState().invalidate('wf-1');

    expect(mockVariantsListQuery).toHaveBeenCalledTimes(2);
    expect(useVariantsStore.getState().byWorkflowId['wf-1']).toHaveLength(2);
  });
});
