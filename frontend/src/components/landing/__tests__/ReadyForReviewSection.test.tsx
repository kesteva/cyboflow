/**
 * ReadyForReviewSection — describeReadyState labels, the >3-row collapse,
 * row expansion, the guarded-session Merge/Dismiss withholding, and a
 * flow-run row's Open-only affordance.
 */
import '@testing-library/jest-dom';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import type { QuickSessionRow } from '../../../../../shared/types/quickSessions';
import type { ActiveRunRow } from '../../../stores/activeRunsStore';
import { ReadyForReviewSection, type ReadyRow } from '../ReadyForReviewSection';

function quickRow(overrides: Partial<QuickSessionRow> = {}): QuickSessionRow {
  return {
    sessionId: overrides.sessionId ?? 'sess-a',
    name: overrides.name ?? 'smooth-falcon',
    projectId: overrides.projectId ?? 1,
    runId: overrides.runId ?? 'quick-run-1',
    state: overrides.state ?? 'idle',
    idleSince: overrides.idleSince ?? '2026-07-06T00:00:00.000Z',
    unviewed: overrides.unviewed ?? false,
    restedAtIso: overrides.restedAtIso ?? '2026-07-06T00:00:00.000Z',
    rawStatus: overrides.rawStatus ?? 'completed',
    exitCode: overrides.exitCode ?? null,
    summary: overrides.summary ?? 'Fixed the login redirect bug.',
    summaryState: overrides.summaryState ?? null,
    waitingOn: overrides.waitingOn ?? null,
    summarySupported: overrides.summarySupported ?? true,
    worktreeName: overrides.worktreeName ?? null,
    git: overrides.git ?? null,
  };
}

function makeRun(overrides: Partial<ActiveRunRow> & { id: string }): ActiveRunRow {
  return {
    workflow_id: 'wf-1',
    project_id: 1,
    status: 'awaiting_review',
    worktree_path: '/wt',
    branch_name: 'ship/feature-x',
    permission_mode_snapshot: 'default',
    workflowName: 'Ship',
    created_at: '2026-07-06 12:00:00',
    updated_at: '2026-07-06 12:30:00',
    started_at: '2026-07-06 12:00:00',
    ended_at: null,
    stuck_reason: null,
    ...overrides,
  };
}

function quickReadyRow(row: QuickSessionRow): ReadyRow {
  return { kind: 'quick', id: row.sessionId, row };
}

function runReadyRow(run: ActiveRunRow): ReadyRow {
  return { kind: 'run', id: run.id, run };
}

const NOOP = (): void => {};
const NOW = Date.parse('2026-07-06T01:00:00.000Z');

describe('ReadyForReviewSection', () => {
  it('renders nothing for an empty row list', () => {
    const { container } = render(
      <ReadyForReviewSection
        rows={[]}
        projectNameById={{}}
        guardedSessionIds={new Set()}
        nowMs={NOW}
        onOpenQuickSession={NOOP}
        onOpenRun={NOOP}
        onMergeSession={NOOP}
        onDismissSession={NOOP}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows describeReadyState labels per row (ready-to-merge vs stopped-early)', () => {
    const clean = quickRow({
      sessionId: 's1',
      name: 'busy-otter',
      git: { isReadyToMerge: true, hasUncommittedChanges: false, hasUntrackedFiles: false, ahead: 3, behind: 0, lastCheckedIso: '2026-07-06T00:59:00.000Z' },
    });
    const failed = quickRow({ sessionId: 's2', name: 'tidy-valley', rawStatus: 'failed', exitCode: 1 });
    render(
      <ReadyForReviewSection
        rows={[quickReadyRow(clean), quickReadyRow(failed)]}
        projectNameById={{ 1: 'proj-1' }}
        guardedSessionIds={new Set()}
        nowMs={NOW}
        onOpenQuickSession={NOOP}
        onOpenRun={NOOP}
        onMergeSession={NOOP}
        onDismissSession={NOOP}
      />,
    );
    expect(screen.getByText('ready to merge ↑3 · clean')).toBeInTheDocument();
    expect(screen.getByText('stopped early')).toBeInTheDocument();
  });

  it('collapses past 3 rows behind "View N more" and expands on click', async () => {
    const user = userEvent.setup();
    const rows = ['a', 'b', 'c', 'd', 'e'].map((n) => quickReadyRow(quickRow({ sessionId: `s-${n}`, name: n })));
    render(
      <ReadyForReviewSection
        rows={rows}
        projectNameById={{}}
        guardedSessionIds={new Set()}
        nowMs={NOW}
        onOpenQuickSession={NOOP}
        onOpenRun={NOOP}
        onMergeSession={NOOP}
        onDismissSession={NOOP}
      />,
    );

    expect(screen.getAllByTestId('rq-ready-row')).toHaveLength(3);
    expect(screen.getByText('View 2 more ▾')).toBeInTheDocument();

    await user.click(screen.getByText('View 2 more ▾'));
    expect(screen.getAllByTestId('rq-ready-row')).toHaveLength(5);
    expect(screen.getByText('Collapse to 3 ▴')).toBeInTheDocument();
  });

  it('expands a row into rq-ready-expanded with Merge/Open/Dismiss on click', async () => {
    const user = userEvent.setup();
    const row = quickRow({ sessionId: 's1', name: 'busy-otter' });
    render(
      <ReadyForReviewSection
        rows={[quickReadyRow(row)]}
        projectNameById={{ 1: 'proj-1' }}
        guardedSessionIds={new Set()}
        nowMs={NOW}
        onOpenQuickSession={NOOP}
        onOpenRun={NOOP}
        onMergeSession={NOOP}
        onDismissSession={NOOP}
      />,
    );

    expect(screen.queryByTestId('rq-ready-expanded')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('rq-ready-row'));
    const expanded = screen.getByTestId('rq-ready-expanded');
    expect(within(expanded).getByText('Merge')).toBeInTheDocument();
    expect(within(expanded).getByText('Open session')).toBeInTheDocument();
    expect(within(expanded).getByText('Dismiss session')).toBeInTheDocument();
  });

  it('hides Merge and Dismiss but keeps Open for a guarded session', async () => {
    const user = userEvent.setup();
    const row = quickRow({ sessionId: 's1', name: 'busy-otter' });
    render(
      <ReadyForReviewSection
        rows={[quickReadyRow(row)]}
        projectNameById={{ 1: 'proj-1' }}
        guardedSessionIds={new Set(['s1'])}
        nowMs={NOW}
        onOpenQuickSession={NOOP}
        onOpenRun={NOOP}
        onMergeSession={NOOP}
        onDismissSession={NOOP}
      />,
    );

    await user.click(screen.getByTestId('rq-ready-row'));
    const expanded = screen.getByTestId('rq-ready-expanded');
    expect(within(expanded).queryByText('Merge')).not.toBeInTheDocument();
    expect(within(expanded).queryByText('Dismiss session')).not.toBeInTheDocument();
    expect(within(expanded).getByText('Open session')).toBeInTheDocument();
  });

  it('shows a flow-run row and routes Open through onOpenRun', async () => {
    const user = userEvent.setup();
    const onOpenRun = vi.fn();
    const run = makeRun({ id: 'run-a' });
    render(
      <ReadyForReviewSection
        rows={[runReadyRow(run)]}
        projectNameById={{ 1: 'proj-1' }}
        guardedSessionIds={new Set()}
        nowMs={NOW}
        onOpenQuickSession={NOOP}
        onOpenRun={onOpenRun}
        onMergeSession={NOOP}
        onDismissSession={NOOP}
      />,
    );

    expect(screen.getByText('Ship')).toBeInTheDocument();
    expect(screen.getByText('ship/feature-x')).toBeInTheDocument();
    await user.click(screen.getByText('Open →'));
    expect(onOpenRun).toHaveBeenCalledWith(run);

    // A run row's expanded state has no Merge/Dismiss — Open is the only action.
    await user.click(screen.getByTestId('rq-ready-row'));
    const expanded = screen.getByTestId('rq-ready-expanded');
    expect(within(expanded).queryByText('Merge')).not.toBeInTheDocument();
    expect(within(expanded).queryByText('Dismiss session')).not.toBeInTheDocument();
  });
});
