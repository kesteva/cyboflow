/**
 * VersionHistory rendering tests.
 *
 * The component is PURE-PROPS (no store / router import), so each test renders it
 * directly with a fixed `revisions` array — no store mock needed. Coverage:
 *   - short-hash (7 chars) + relative-age + success% + avg-tokens (k-format).
 *   - LIVE badge appears only on the isCurrent revision.
 *   - token delta sign + color intent vs the NEXT-OLDER revision (down=green,
 *     up=red), oldest revision carries no delta, and a null-avg side suppresses it.
 *   - empty list renders nothing (the defensive < 1 gate).
 *
 * formatAge is time-relative; we pin a fixed `Date.now()` via fake timers so the
 * age assertions are deterministic.
 */
import '@testing-library/jest-dom';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowRevisionStats } from '../../../../../shared/types/insights';
import { VersionHistory } from '../VersionHistory';

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

function revision(over: Partial<WorkflowRevisionStats> = {}): WorkflowRevisionStats {
  return {
    workflowId: 'wf-1',
    specHash: 'abcdef0123456789',
    firstSeenAt: '2026-06-10T00:00:00.000Z',
    isCurrent: false,
    runs: 3,
    mergedRuns: 2,
    failedRuns: 1,
    successRatePct: 66.7,
    avgTotalTokens: 1500,
    ...over,
  };
}

beforeEach(() => {
  // Pin "now" so formatAge buckets deterministically (10 days after firstSeenAt).
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-20T00:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('VersionHistory', () => {
  it('renders the short hash (7 chars), success% and k-formatted avg tokens', () => {
    render(
      <VersionHistory
        workflowName="Sprint"
        revisions={[revision({ specHash: 'deadbeefcafef00d', successRatePct: 66.7, avgTotalTokens: 1500 })]}
      />,
    );
    // First 7 chars of the hash.
    expect(screen.getByText('deadbee')).toBeInTheDocument();
    // Success rate + avg tokens (1500 → '2k' via toFixed(0)).
    expect(screen.getByText('66.7% ok')).toBeInTheDocument();
    expect(screen.getByTestId('revision-avg-tokens')).toHaveTextContent('2k');
  });

  it('renders the LIVE badge ONLY on the isCurrent revision', () => {
    render(
      <VersionHistory
        workflowName="Sprint"
        revisions={[
          revision({ specHash: 'aaaaaaa1111', isCurrent: true, avgTotalTokens: 1000 }),
          revision({ specHash: 'bbbbbbb2222', isCurrent: false, avgTotalTokens: 1000 }),
        ]}
      />,
    );
    const badges = screen.getAllByTestId('revision-live-badge');
    expect(badges).toHaveLength(1);

    const liveRow = screen.getByTestId('revision-row-aaaaaaa1111');
    expect(within(liveRow).getByTestId('revision-live-badge')).toHaveTextContent('LIVE');

    const oldRow = screen.getByTestId('revision-row-bbbbbbb2222');
    expect(within(oldRow).queryByTestId('revision-live-badge')).toBeNull();
  });

  it('shows a GREEN down-arrow delta when the newer revision uses FEWER tokens', () => {
    render(
      <VersionHistory
        workflowName="Sprint"
        revisions={[
          // newest: 1000 tokens; next-older: 3000 → drop of 2000 → ↓2k green.
          revision({ specHash: 'newer000', avgTotalTokens: 1000 }),
          revision({ specHash: 'older000', avgTotalTokens: 3000 }),
        ]}
      />,
    );
    const newerRow = screen.getByTestId('revision-row-newer000');
    const delta = within(newerRow).getByTestId('revision-delta');
    expect(delta).toHaveTextContent('↓2k');
    expect(delta.className).toContain('text-status-success');
  });

  it('shows a RED up-arrow delta when the newer revision uses MORE tokens', () => {
    render(
      <VersionHistory
        workflowName="Sprint"
        revisions={[
          // newest: 4000; next-older: 1000 → rise of 3000 → ↑3k red.
          revision({ specHash: 'newer111', avgTotalTokens: 4000 }),
          revision({ specHash: 'older111', avgTotalTokens: 1000 }),
        ]}
      />,
    );
    const newerRow = screen.getByTestId('revision-row-newer111');
    const delta = within(newerRow).getByTestId('revision-delta');
    expect(delta).toHaveTextContent('↑3k');
    expect(delta.className).toContain('text-status-error');
  });

  it('renders no delta for the OLDEST revision (no older sibling to compare)', () => {
    render(
      <VersionHistory
        workflowName="Sprint"
        revisions={[
          revision({ specHash: 'newer222', avgTotalTokens: 1000 }),
          revision({ specHash: 'oldest22', avgTotalTokens: 3000 }),
        ]}
      />,
    );
    const oldestRow = screen.getByTestId('revision-row-oldest22');
    expect(within(oldestRow).queryByTestId('revision-delta')).toBeNull();
  });

  it('suppresses the delta when either revision has a null avgTotalTokens', () => {
    render(
      <VersionHistory
        workflowName="Sprint"
        revisions={[
          revision({ specHash: 'nullnew0', avgTotalTokens: null }),
          revision({ specHash: 'older333', avgTotalTokens: 2000 }),
        ]}
      />,
    );
    const newerRow = screen.getByTestId('revision-row-nullnew0');
    expect(within(newerRow).queryByTestId('revision-delta')).toBeNull();
    // The avg-tokens cell falls back to the em dash for the null side.
    expect(within(newerRow).getByTestId('revision-avg-tokens')).toHaveTextContent('—');
  });

  it('renders nothing for an empty revision list (defensive < 1 gate)', () => {
    const { container } = render(<VersionHistory workflowName="Sprint" revisions={[]} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('version-history')).toBeNull();
  });
});
