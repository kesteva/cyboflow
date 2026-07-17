/**
 * SessionRow memoization (perf fix 3.3) — the sidebar's session tree used to
 * re-render EVERY row inline whenever `allSessions` got a new array reference
 * (e.g. a git-status batch touching one session), because there was no memo
 * boundary between the row and the whole list. SessionRow (extracted +
 * React.memo'd, see DraggableProjectTreeView.tsx) fixes that.
 *
 * Covers:
 *   - sessionRowPropsEqual (the memo comparator) — the pure logic gating
 *     whether a row actually re-renders: same `session` reference / primitives
 *     / stable callbacks / CONTENT-equal `childRuns` (compared by id+status+
 *     variant_label, not array identity, since childRuns is rebuilt via
 *     `.filter()` on every parent render even when nothing relevant changed).
 *   - A DOM-level proof that React.memo actually skips re-rendering when the
 *     comparator says "equal": childRuns is swapped for a new array/object
 *     with the SAME id/status/variant_label but a DIFFERENT (uncompared)
 *     workflowName — if the row had re-rendered, the displayed name would
 *     have changed; it does not, proving the skip is real.
 */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SessionRow, sessionRowPropsEqual, type SessionRowProps } from '../DraggableProjectTreeView';
import type { Session } from '../../types/session';
import type { ActiveRunRow } from '../../stores/activeRunsStore';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    name: 'My Session',
    projectId: 1,
    displayOrder: 0,
    worktreePath: '/tmp/sess-1',
    prompt: '',
    status: 'ready',
    createdAt: '2026-01-01',
    output: [],
    jsonMessages: [],
    ...overrides,
  };
}

function makeRun(overrides: Partial<ActiveRunRow> = {}): ActiveRunRow {
  return {
    id: 'run-1',
    workflow_id: 'wf-1',
    project_id: 1,
    status: 'running',
    substrate: 'sdk',
    worktree_path: '/tmp/wt',
    branch_name: 'branch-1',
    session_id: 'sess-1',
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    started_at: null,
    ended_at: null,
    stuck_reason: null,
    workflowName: 'sprint',
    ...overrides,
  } as unknown as ActiveRunRow;
}

function makeProps(overrides: Partial<SessionRowProps> = {}): SessionRowProps {
  return {
    session: makeSession(),
    projectId: 1,
    isLastSession: true,
    isActive: false,
    relativeTime: '5 minutes ago',
    sessionDropIndicator: null,
    childRuns: [],
    activeRunId: null,
    onSessionClick: vi.fn(),
    onDragStart: vi.fn(),
    onDragOver: vi.fn(),
    onDrop: vi.fn(),
    onDragEnd: vi.fn(),
    onDragEnter: vi.fn(),
    onDragLeave: vi.fn(),
    onActiveRunClick: vi.fn(),
    ...overrides,
  };
}

describe('sessionRowPropsEqual (SessionRow memo comparator)', () => {
  it('is true for identical primitives + the SAME session/callback references', () => {
    const props = makeProps();
    expect(sessionRowPropsEqual(props, { ...props })).toBe(true);
  });

  it('is false when the session object reference differs (even with identical field values)', () => {
    const session = makeSession();
    const props = makeProps({ session });
    expect(sessionRowPropsEqual(props, { ...props, session: { ...session } })).toBe(false);
  });

  it('is false when a callback prop is a fresh (non-memoized) closure', () => {
    const props = makeProps();
    expect(sessionRowPropsEqual(props, { ...props, onSessionClick: vi.fn() })).toBe(false);
  });

  it('is false when isActive / isLastSession / relativeTime / sessionDropIndicator differ', () => {
    const props = makeProps();
    expect(sessionRowPropsEqual(props, { ...props, isActive: true })).toBe(false);
    expect(sessionRowPropsEqual(props, { ...props, isLastSession: false })).toBe(false);
    expect(sessionRowPropsEqual(props, { ...props, relativeTime: 'just now' })).toBe(false);
    expect(sessionRowPropsEqual(props, { ...props, sessionDropIndicator: 'before' })).toBe(false);
  });

  it('is true for a childRuns array rebuilt with new object/array references but identical id/status/variant_label', () => {
    const run = makeRun();
    const props = makeProps({ childRuns: [run] });
    // A fresh .filter()/.map() pass — exactly what the parent recomputes every
    // render — produces new array + object references with the same content.
    // Every OTHER prop (notably `session`) must stay the SAME reference, since
    // that's what an unrelated sibling row's re-render looks like in practice.
    const rebuilt = { ...props, childRuns: [{ ...run }] };
    expect(sessionRowPropsEqual(props, rebuilt)).toBe(true);
  });

  it('is false when a childRun\'s status (or id, or variant_label) actually changes', () => {
    const run = makeRun({ status: 'running' });
    const props = makeProps({ childRuns: [run] });
    expect(
      sessionRowPropsEqual(props, { ...props, childRuns: [{ ...run, status: 'completed' }] }),
    ).toBe(false);
    expect(
      sessionRowPropsEqual(props, { ...props, childRuns: [{ ...run, id: 'run-2' }] }),
    ).toBe(false);
    expect(
      sessionRowPropsEqual(props, { ...props, childRuns: [{ ...run, variant_label: 'Variant B' }] }),
    ).toBe(false);
  });

  it('is false when childRuns length differs', () => {
    const run = makeRun();
    const props = makeProps({ childRuns: [run] });
    expect(sessionRowPropsEqual(props, { ...props, childRuns: [run, makeRun({ id: 'run-2' })] })).toBe(false);
    expect(sessionRowPropsEqual(props, { ...props, childRuns: [] })).toBe(false);
  });
});

describe('SessionRow — React.memo actually skips re-rendering on an equal-per-comparator update', () => {
  it('keeps showing the OLD workflow name after a childRuns update the comparator treats as unchanged', () => {
    const run = makeRun({ workflowName: 'sprint' });
    const props = makeProps({ childRuns: [run] });
    const { rerender } = render(<SessionRow {...props} />);
    expect(screen.getByText('sprint')).toBeInTheDocument();

    // New array + new object (same id/status/variant_label — sessionRowPropsEqual
    // says "equal") but a DIFFERENT workflowName, a field the comparator does NOT
    // compare. If SessionRow re-rendered, this text would flip to "renamed"; the
    // memo boundary is only doing its job if it stays "sprint".
    rerender(<SessionRow {...props} childRuns={[{ ...run, workflowName: 'renamed' }]} />);

    expect(screen.getByText('sprint')).toBeInTheDocument();
    expect(screen.queryByText('renamed')).toBeNull();
  });

  it('DOES pick up a childRuns change the comparator treats as a real difference (status)', () => {
    const run = makeRun({ status: 'running', workflowName: 'sprint' });
    const props = makeProps({ childRuns: [run] });
    const { rerender } = render(<SessionRow {...props} />);
    expect(screen.getByTitle('running')).toBeInTheDocument();

    rerender(<SessionRow {...props} childRuns={[{ ...run, status: 'completed' }]} />);

    expect(screen.getByTitle('completed')).toBeInTheDocument();
  });

  it('re-renders when isActive flips (a genuinely different row gets highlighted)', () => {
    const props = makeProps({ isActive: false });
    const { container, rerender } = render(<SessionRow {...props} />);
    const row = container.querySelector('[draggable="true"]');
    const sessionName = screen.getByText('My Session');
    expect(row?.className).not.toContain('bg-interactive/10');
    expect(sessionName.className).toContain('text-text-primary');
    expect(sessionName.className).not.toContain('font-semibold');
    expect(sessionName.className).not.toContain('text-interactive');

    rerender(<SessionRow {...props} isActive />);
    expect(container.querySelector('[draggable="true"]')?.className).toContain('bg-interactive/10');
    expect(sessionName.className).toContain('font-semibold');
    expect(sessionName.className).toContain('text-interactive');
    expect(sessionName.className).not.toContain('text-text-primary');
  });
});
