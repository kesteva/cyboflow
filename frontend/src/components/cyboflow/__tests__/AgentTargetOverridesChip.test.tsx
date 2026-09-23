/**
 * AgentTargetOverridesChip — the one-line "Agents switched: … · Revert" notice
 * RunPendingInputStrip renders above its pending items (plan v2 D3/D4).
 *
 * Covers: hidden when the run carries no overrides; grouping several agent
 * keys pinned to an identical target onto one line, with distinct targets on
 * their own; Revert calling clearRunAgentTargets then bumping the run's
 * agent-targets version (which re-queries here AND re-fetches the canvas
 * step models in RunCenterPane); re-querying on an external bump.
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { ReviewItem } from '../../../../../shared/types/reviews';
import type { RunAgentTargetOverrides } from '../../../../../shared/types/workflows';

let mockItems: ReviewItem[] = [];
vi.mock('../../../stores/reviewItemsSlice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../stores/reviewItemsSlice')>();
  const useReviewItemsSlice = Object.assign(
    (selector: (s: { items: ReviewItem[] }) => unknown) => selector({ items: mockItems }),
    { getState: () => ({ items: mockItems }) },
  );
  return { ...actual, useReviewItemsSlice };
});

const mockRunAgentTargets = vi.fn();
const mockClearRunAgentTargets = vi.fn();
vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      runs: {
        runAgentTargets: { query: (...args: unknown[]) => mockRunAgentTargets(...args) },
        clearRunAgentTargets: { mutate: (...args: unknown[]) => mockClearRunAgentTargets(...args) },
      },
    },
  },
}));

import { AgentTargetOverridesChip } from '../AgentTargetOverridesChip';
import { useRunAgentTargetsStore } from '../../../stores/runAgentTargetsStore';

beforeEach(() => {
  mockItems = [];
  useRunAgentTargetsStore.setState({ versionByRun: {} });
  mockRunAgentTargets.mockReset();
  mockClearRunAgentTargets.mockReset();
  mockClearRunAgentTargets.mockResolvedValue({ delivered: true });
});

describe('AgentTargetOverridesChip', () => {
  it('renders nothing when the run has no overrides (null)', async () => {
    mockRunAgentTargets.mockResolvedValue(null);
    const { container } = render(<AgentTargetOverridesChip runId="run-1" />);
    await waitFor(() => expect(mockRunAgentTargets).toHaveBeenCalledWith({ runId: 'run-1' }));
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the run has an empty override map', async () => {
    mockRunAgentTargets.mockResolvedValue({});
    const { container } = render(<AgentTargetOverridesChip runId="run-1" />);
    await waitFor(() => expect(mockRunAgentTargets).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('renders one line per DISTINCT target, grouping agent keys that share one', async () => {
    const overrides: RunAgentTargetOverrides = {
      implement: { runtime: 'codex-sdk', providerModel: 'gpt-5.4-codex' },
      'code-review': { runtime: 'codex-sdk', providerModel: 'gpt-5.4-codex' },
      'write-tests': { runtime: 'omp-sdk' },
    };
    mockRunAgentTargets.mockResolvedValue(overrides);
    render(<AgentTargetOverridesChip runId="run-1" />);
    await waitFor(() => expect(screen.getByTestId('agent-targets-chip')).toBeInTheDocument());
    const text = screen.getByTestId('agent-targets-chip').textContent ?? '';
    expect(text).toContain('implement, code-review → Codex SDK (gpt-5.4-codex)');
    expect(text).toContain('write-tests → OMP');
  });

  it('falls back to "same runtime" and omits the parenthetical when a target has no runtime/model', async () => {
    mockRunAgentTargets.mockResolvedValue({ implement: { effort: 'high' } } satisfies RunAgentTargetOverrides);
    render(<AgentTargetOverridesChip runId="run-1" />);
    await waitFor(() => expect(screen.getByTestId('agent-targets-chip')).toBeInTheDocument());
    expect(screen.getByTestId('agent-targets-chip').textContent).toContain('implement → same runtime');
  });

  it('Revert calls clearRunAgentTargets, bumps the run\'s agent-targets version, and re-queries runAgentTargets', async () => {
    mockRunAgentTargets
      .mockResolvedValueOnce({ implement: { runtime: 'codex-sdk' } } satisfies RunAgentTargetOverrides)
      .mockResolvedValueOnce(null);
    render(<AgentTargetOverridesChip runId="run-1" />);
    await waitFor(() => expect(screen.getByTestId('agent-targets-chip')).toBeInTheDocument());
    expect(useRunAgentTargetsStore.getState().versionByRun['run-1']).toBeUndefined();

    fireEvent.click(screen.getByTestId('agent-targets-revert'));

    await waitFor(() => expect(mockClearRunAgentTargets).toHaveBeenCalledWith({ runId: 'run-1' }));
    // The bump is what the canvas step-model rail (RunCenterPane) keys its
    // re-fetch on — Revert must signal it, not just re-query privately.
    await waitFor(() => expect(useRunAgentTargetsStore.getState().versionByRun['run-1']).toBe(1));
    await waitFor(() => expect(mockRunAgentTargets).toHaveBeenCalledTimes(2));
    // The re-query resolved null — the chip collapses.
    await waitFor(() => expect(screen.queryByTestId('agent-targets-chip')).not.toBeInTheDocument());
  });

  it('re-queries when the run\'s agent-targets version is bumped externally (a switch landed)', async () => {
    mockRunAgentTargets
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ implement: { runtime: 'codex-sdk' } } satisfies RunAgentTargetOverrides);
    const { container } = render(<AgentTargetOverridesChip runId="run-1" />);
    await waitFor(() => expect(mockRunAgentTargets).toHaveBeenCalledTimes(1));
    expect(container).toBeEmptyDOMElement();

    act(() => {
      useRunAgentTargetsStore.getState().bump('run-1');
    });
    await waitFor(() => expect(mockRunAgentTargets).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('agent-targets-chip')).toBeInTheDocument());
  });

  it('re-queries when the run pending items change (a new pause / one clearing)', async () => {
    mockRunAgentTargets.mockResolvedValue(null);
    mockItems = [];
    const { rerender } = render(<AgentTargetOverridesChip runId="run-1" />);
    await waitFor(() => expect(mockRunAgentTargets).toHaveBeenCalledTimes(1));

    mockItems = [
      {
        id: 'rvw_pause',
        project_id: 5,
        run_id: 'run-1',
        entity_type: null,
        entity_id: null,
        kind: 'decision',
        status: 'pending',
        blocking: true,
        audience: 'human',
        title: 'Systemic pause',
        body: null,
        severity: null,
        priority: null,
        staged_at: null,
        selected: false,
        source: 'gate:systemic-pause:implement',
        payload: null,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        resolved_by: null,
        resolution: null,
      },
    ];
    rerender(<AgentTargetOverridesChip runId="run-1" />);
    await waitFor(() => expect(mockRunAgentTargets.mock.calls.length).toBeGreaterThan(1));
  });
});
