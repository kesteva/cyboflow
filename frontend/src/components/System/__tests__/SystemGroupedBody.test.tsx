/**
 * SystemGroupedBody — By-worktree / By-process-type rendering, trust tiers
 * (foreign read-only, suspected tier) and Open session/run activation order.
 * The navigation stores are mocked so the three-call sequence is observable.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SystemSnapshotData } from '../../../hooks/useSystemSnapshot';

const { calls, setActiveQuickSession, setActiveRun, setActiveProjectId, goToSession } = vi.hoisted(() => {
  const calls: string[] = [];
  return {
    calls,
    setActiveQuickSession: vi.fn((...a: unknown[]) => void calls.push(`setActiveQuickSession(${a.join(',')})`)),
    setActiveRun: vi.fn((...a: unknown[]) => void calls.push(`setActiveRun(${a.join(',')})`)),
    setActiveProjectId: vi.fn((...a: unknown[]) => void calls.push(`setActiveProjectId(${a.join(',')})`)),
    goToSession: vi.fn(() => void calls.push('goToSession()')),
  };
});

vi.mock('../../../stores/cyboflowStore', () => ({
  useCyboflowStore: { getState: () => ({ setActiveQuickSession, setActiveRun }) },
}));
vi.mock('../../../stores/navigationStore', () => ({
  useNavigationStore: { getState: () => ({ setActiveProjectId, goToSession }) },
}));

import {
  SystemGroupedBody,
  sortWorktrees,
  sortProcesses,
  sortTypeGroups,
  processName,
  formatElapsed,
  type SystemProcess,
  type SystemWorktree,
} from '../SystemGroupedBody';

const MB = 1024 * 1024;

function wt(path: string, over: Partial<SystemWorktree> = {}): SystemWorktree {
  return {
    path,
    branch: `b-${path}`,
    tag: 'session-owned',
    prunable: true,
    sessionId: `s-${path}`,
    usage: { status: 'measured', bytes: 10 * MB, measuredAt: 1 },
    ...over,
  } as SystemWorktree;
}

function proc(pid: number, over: Record<string, unknown> = {}): SystemProcess {
  return {
    bucket: 'owned',
    processType: 'claude-cli',
    command: `claude --resume ${pid}`,
    worktreePath: '/wt/a',
    pid,
    ppid: 1,
    pcpu: 1.5,
    pmem: 0.5,
    etimeSeconds: 720,
    owner: { kind: 'cli', panelId: 'p', sessionId: `sess-${pid}` },
    ...over,
  } as SystemProcess;
}

function foreign(label: string, over: Record<string, unknown> = {}): SystemProcess {
  return {
    bucket: 'foreign',
    readOnly: true,
    processType: 'unknown',
    command: 'vite --port 4521',
    worktreePath: '/wt/a',
    pidLabel: label,
    display: { cpu: '2.0%', mem: '1.0%', elapsed: '3h 1m' },
    foreignInstanceId: null,
    ...over,
  } as SystemProcess;
}

function snap(worktrees: SystemWorktree[], processes: SystemProcess[]): SystemSnapshotData {
  return {
    status: 'ready',
    generatedAt: 1,
    capabilities: { diskSizing: { supported: true } },
    processes,
    worktrees,
    ports: {
      tcp: [{ port: 3000, label: 'watched', inUse: false }],
      orchSocket: { connectionCount: 0, runBindings: {} },
    },
  };
}

const handlers = {
  onKillTree: vi.fn(),
  onKillAll: vi.fn(),
  onPruneWorktree: vi.fn(),
};

beforeEach(() => {
  calls.length = 0;
  vi.clearAllMocks();
});

describe('By worktree', () => {
  it('renders one card per non-orphan worktree with nested process rows tagged as processes', () => {
    const s = snap(
      [wt('/wt/a'), wt('/wt/b'), wt('/wt/stale', { tag: 'orphan' })],
      [proc(1), proc(2, { worktreePath: '/wt/b' }), proc(3, { bucket: 'orphan', worktreePath: '/wt/stale' })],
    );
    render(<SystemGroupedBody snapshot={s} projectId={7} groupBy="worktree" sortBy="cpu" />);
    const cards = screen.getAllByTestId('wt-card');
    expect(cards.map((c) => c.getAttribute('data-worktree')).sort()).toEqual(['/wt/a', '/wt/b']);
    const cardA = cards.find((c) => c.getAttribute('data-worktree') === '/wt/a');
    expect(cardA).toBeDefined();
    if (!cardA) return;
    expect(within(cardA).getAllByTestId('proc-row')).toHaveLength(1);
    expect(within(cardA).getByTestId('kind-badge-process')).toBeInTheDocument();
    expect(within(cardA).getByTestId('kind-tile-worktree')).toBeInTheDocument();
    // The orphan process/worktree are left to the Orphans section.
    expect(screen.queryByText('/wt/stale')).not.toBeInTheDocument();
    expect(screen.getByTestId('system-worktrees-count')).toHaveTextContent('2 owned · 2 processes');
  });

  it('parks processes with no listed worktree in an Unattributed card', () => {
    const s = snap([wt('/wt/a')], [proc(1, { worktreePath: null })]);
    render(<SystemGroupedBody snapshot={s} projectId={7} groupBy="worktree" sortBy="cpu" />);
    expect(within(screen.getByTestId('unattributed-card')).getAllByTestId('proc-row')).toHaveLength(1);
  });

  it('never renders an unmeasured worktree disk figure as 0 MB', () => {
    const s = snap(
      [
        wt('/wt/m', { usage: { status: 'measuring' } }),
        wt('/wt/q', { usage: { status: 'queued' } }),
      ],
      [],
    );
    const { container } = render(<SystemGroupedBody snapshot={s} projectId={7} groupBy="worktree" sortBy="disk" />);
    const states = screen.getAllByTestId('wt-disk').map((e) => e.getAttribute('data-state')).sort();
    expect(states).toEqual(['measuring', 'queued']);
    expect(container.textContent).not.toMatch(/0 ?MB|0 ?B\b/);
  });

  it('sorts disk descending with unmeasured last, and the naive path order differs (negative control)', () => {
    const list = [
      wt('/a', { usage: { status: 'queued' } }),
      wt('/b', { usage: { status: 'measured', bytes: 5 * MB, measuredAt: 1 } }),
      wt('/c', { usage: { status: 'measured', bytes: 50 * MB, measuredAt: 1 } }),
    ];
    const sorted = sortWorktrees(list, new Map(), 'disk').map((w) => w.path);
    expect(sorted).toEqual(['/c', '/b', '/a']);
    expect(list.map((w) => w.path)).not.toEqual(sorted);
  });
});

describe('By process type', () => {
  it('renders an aggregate card per type with member count and owning-worktree column', () => {
    const s = snap(
      [wt('/wt/a')],
      [
        proc(1, { pcpu: 2, pmem: 1 }),
        proc(2, { pcpu: 3, pmem: 1 }),
        proc(9, {
          bucket: 'orphan',
          processType: 'codex-broker',
          command: 'node /x/app-server-broker.mjs',
          worktreePath: null,
          owner: null,
          sweepEligible: true,
          instanceId: 'dead',
        }),
      ],
    );
    render(<SystemGroupedBody snapshot={s} projectId={7} groupBy="process-type" sortBy="cpu" />);
    expect(screen.getByTestId('type-aggregate-claude-cli')).toHaveTextContent('2 processes · 5.0% CPU · 2.0% mem');
    const broker = screen.getByTestId('type-group-codex-broker');
    expect(within(broker).getByTestId('proc-owning-worktree')).toHaveTextContent('none — orphaned');
    expect(within(screen.getByTestId('type-group-claude-cli')).getAllByTestId('proc-owning-worktree')[0]).toHaveTextContent('a');
    expect(processName('node /x/app-server-broker.mjs')).toBe('app-server-broker.mjs');
  });
});

describe('trust tiers', () => {
  it('foreign rows carry no enabled destructive control, in both groupings', () => {
    const s = snap([wt('/wt/a')], [foreign('~pid 4242')]);
    for (const groupBy of ['worktree', 'process-type'] as const) {
      const { unmount } = render(<SystemGroupedBody snapshot={s} projectId={7} groupBy={groupBy} sortBy="cpu" {...handlers} />);
      const row = screen.getByTestId('proc-row');
      expect(row).toHaveAttribute('data-bucket', 'foreign');
      expect(within(row).getByTestId('proc-readonly')).toHaveTextContent('Foreign · read-only');
      expect(within(row).queryByRole('button')).toBeNull();
      unmount();
    }
  });

  it('control: an owned row in the same setup DOES offer Kill tree (the foreign absence is not a missing handler)', () => {
    render(<SystemGroupedBody snapshot={snap([wt('/wt/a')], [proc(1)])} projectId={7} groupBy="worktree" sortBy="cpu" {...handlers} />);
    fireEvent.click(screen.getByTestId('kill-tree-1'));
    expect(handlers.onKillTree).toHaveBeenCalledTimes(1);
  });

  it('Kill all excludes foreign members', () => {
    const s = snap([wt('/wt/a')], [proc(1), foreign('~pid 9')]);
    render(<SystemGroupedBody snapshot={s} projectId={7} groupBy="process-type" sortBy="cpu" {...handlers} />);
    // foreign is processType 'unknown'; owned is claude-cli
    expect(screen.getByTestId('type-kill-all-claude-cli')).toHaveTextContent('Kill all (1)');
    expect(screen.getByTestId('type-kill-all-unknown')).toBeDisabled();
  });

  it("Kill all counts only this project's worktrees — never another project's or an unattributed row", () => {
    const s = snap(
      [wt('/wt/a')],
      [proc(1), proc(2, { worktreePath: '/other-project/wt/x' }), proc(3, { bucket: 'suspected', worktreePath: null, owner: null })],
    );
    render(<SystemGroupedBody snapshot={s} projectId={7} groupBy="process-type" sortBy="cpu" {...handlers} />);
    expect(screen.getByTestId('type-aggregate-claude-cli')).toHaveTextContent('3 processes');
    fireEvent.click(screen.getByTestId('type-kill-all-claude-cli'));
    expect(screen.getByTestId('type-kill-all-claude-cli')).toHaveTextContent('Kill all (1)');
    const [killed] = handlers.onKillAll.mock.calls[0] as [Array<{ pid: number }>];
    expect(killed.map((p) => p.pid)).toEqual([1]);
  });

  it('renders suspected rows in their own tier with the marker', () => {
    const s = snap([wt('/wt/a')], [proc(1), proc(2, { bucket: 'suspected', owner: null })]);
    render(<SystemGroupedBody snapshot={s} projectId={7} groupBy="worktree" sortBy="cpu" />);
    const tier = screen.getByTestId('suspected-tier');
    expect(within(tier).getAllByTestId('proc-row')).toHaveLength(1);
    expect(within(tier).getAllByTestId('suspected-badge').length).toBeGreaterThan(0);
    // The confirmed row is NOT inside the tier.
    expect(screen.getAllByTestId('proc-row')).toHaveLength(2);
    expect(within(tier).queryByText(/claude --resume 1/)).toBeNull();
  });

  it('offers no destructive controls at all when no handlers are supplied', () => {
    render(<SystemGroupedBody snapshot={snap([wt('/wt/a')], [proc(1)])} projectId={7} groupBy="worktree" sortBy="cpu" />);
    expect(screen.queryByTestId('kill-tree-1')).toBeNull();
    expect(screen.queryByTestId('wt-prune')).toBeNull();
  });

  it('disables Prune on a non-prunable worktree', () => {
    render(
      <SystemGroupedBody
        snapshot={snap([wt('/wt/main', { tag: 'is_main_repo', prunable: false })], [])}
        projectId={7}
        groupBy="worktree"
        sortBy="cpu"
        {...handlers}
      />,
    );
    expect(screen.getByTestId('wt-prune')).toBeDisabled();
  });
});

describe('Open session / Open run', () => {
  it('worktree Open session runs setActiveQuickSession → setActiveProjectId → goToSession', () => {
    render(<SystemGroupedBody snapshot={snap([wt('/wt/a')], [])} projectId={7} groupBy="worktree" sortBy="cpu" />);
    fireEvent.click(screen.getByTestId('wt-open-session'));
    expect(calls).toEqual(['setActiveQuickSession(s-/wt/a)', 'setActiveProjectId(7)', 'goToSession()']);
  });

  it('worktree Open run runs setActiveRun → setActiveProjectId → goToSession', () => {
    const s = snap([wt('/wt/r', { tag: 'run-owned', sessionId: undefined, runId: 'run-9' })], []);
    render(<SystemGroupedBody snapshot={s} projectId={3} groupBy="worktree" sortBy="cpu" />);
    expect(screen.queryByTestId('wt-open-session')).toBeNull();
    fireEvent.click(screen.getByTestId('wt-open-run'));
    expect(calls).toEqual(['setActiveRun(run-9)', 'setActiveProjectId(3)', 'goToSession()']);
  });

  it('a process row tied to a session opens it; a run-shell row opens its run', () => {
    const s = snap(
      [wt('/wt/a')],
      [proc(1), proc(2, { owner: { kind: 'run-shell', runId: 'run-2', terminalId: 't' }, processType: 'shell-pty' })],
    );
    render(<SystemGroupedBody snapshot={s} projectId={7} groupBy="worktree" sortBy="cpu" />);
    fireEvent.click(screen.getByTestId('open-session-proc-1'));
    expect(calls).toEqual(['setActiveQuickSession(sess-1)', 'setActiveProjectId(7)', 'goToSession()']);
    calls.length = 0;
    fireEvent.click(screen.getByTestId('open-run-proc-2'));
    expect(calls).toEqual(['setActiveRun(run-2)', 'setActiveProjectId(7)', 'goToSession()']);
  });
});

describe('formatting', () => {
  it('formats elapsed time', () => {
    expect(formatElapsed(null)).toBe('—');
    expect(formatElapsed(45)).toBe('45s');
    expect(formatElapsed(720)).toBe('12m');
    expect(formatElapsed(3960)).toBe('1h 6m');
    expect(formatElapsed(6 * 86400)).toBe('6d');
  });
});

describe('By process type sort', () => {
  // Canonical TYPE_ORDER is claude-cli, codex-cli, shell-pty; each sort key below
  // produces a DIFFERENT order, so a body that ignored sortBy would fail them.
  const s = snap(
    [
      wt('/wt/zeta', { usage: { status: 'measured', bytes: 900 * MB, measuredAt: 1 } }),
      wt('/wt/alpha', { usage: { status: 'measured', bytes: 50 * MB, measuredAt: 1 } }),
      wt('/wt/mid', { usage: { status: 'queued' } }),
    ],
    [
      proc(1, { processType: 'claude-cli', worktreePath: '/wt/mid', pcpu: 1, pmem: 9 }),
      proc(2, { processType: 'codex-cli', command: 'codex a', worktreePath: '/wt/alpha', pcpu: 30, pmem: 2 }),
      proc(3, { processType: 'shell-pty', command: 'zsh', worktreePath: '/wt/zeta', pcpu: 5, pmem: 4 }),
    ],
  );
  const cardOrder = (sortBy: 'disk' | 'cpu' | 'mem' | 'owner'): string[] => {
    const { container, unmount } = render(<SystemGroupedBody snapshot={s} projectId={7} groupBy="process-type" sortBy={sortBy} />);
    const ids = Array.from(container.querySelectorAll('[data-testid^="type-group-"]')).map((e) =>
      (e.getAttribute('data-testid') ?? '').replace('type-group-', ''),
    );
    unmount();
    return ids;
  };

  it('orders the type cards by the selected sort key', () => {
    expect(cardOrder('cpu')).toEqual(['codex-cli', 'shell-pty', 'claude-cli']);
    expect(cardOrder('mem')).toEqual(['claude-cli', 'shell-pty', 'codex-cli']);
    expect(cardOrder('disk')).toEqual(['shell-pty', 'codex-cli', 'claude-cli']);
    expect(cardOrder('owner')).toEqual(['codex-cli', 'claude-cli', 'shell-pty']);
    // negative control: the canonical order is none of the above
    expect(['claude-cli', 'codex-cli', 'shell-pty']).not.toEqual(cardOrder('cpu'));
  });

  it('owner sort orders rows by owning worktree name, not command name', () => {
    const procs = [
      proc(1, { command: 'aaa', worktreePath: '/wt/zeta' }),
      proc(2, { command: 'zzz', worktreePath: '/wt/alpha' }),
      proc(3, { command: 'mmm', worktreePath: null, owner: null }),
    ];
    const byPath = new Map(s.worktrees.map((w) => [w.path, w] as const));
    expect(sortProcesses(procs, 'owner', byPath).map((p) => (p.bucket === 'foreign' ? 0 : p.pid))).toEqual([2, 1, 3]);
    // the old command-name ordering would have been aaa, mmm, zzz
    expect(sortProcesses(procs, 'owner').map((p) => (p.bucket === 'foreign' ? 0 : p.pid))).toEqual([1, 3, 2]);
  });

  it('disk sort orders rows by owning worktree size, unmeasured last', () => {
    const procs = [
      proc(1, { worktreePath: '/wt/mid', pcpu: 99 }),
      proc(2, { worktreePath: '/wt/alpha', pcpu: 1 }),
      proc(3, { worktreePath: '/wt/zeta', pcpu: 50 }),
    ];
    const byPath = new Map(s.worktrees.map((w) => [w.path, w] as const));
    expect(sortProcesses(procs, 'disk', byPath).map((p) => (p.bucket === 'foreign' ? 0 : p.pid))).toEqual([3, 2, 1]);
  });

  it('type card aggregate sums CPU/mem over ALL members, foreign included', () => {
    const s = snap([wt('/wt/a')], [
      proc(1, { pcpu: 1, pmem: 0.5 }),
      foreign('~pid 9', { processType: 'claude-cli', display: { cpu: '2.0%', mem: '1.0%', elapsed: '3h' } }),
    ]);
    render(<SystemGroupedBody snapshot={s} projectId={7} groupBy="process-type" sortBy="cpu" {...handlers} />);
    expect(screen.getByTestId('type-aggregate-claude-cli')).toHaveTextContent('2 processes · 3.0% CPU · 1.5% mem');
    // Kill all still counts only the actionable member.
    expect(screen.getByTestId('type-kill-all-claude-cli')).toHaveTextContent('Kill all (1)');
  });

  it('a foreign-only type card shows its figures and a disabled Kill all', () => {
    const s = snap([wt('/wt/a')], [foreign('~pid 9')]);
    render(<SystemGroupedBody snapshot={s} projectId={7} groupBy="process-type" sortBy="cpu" {...handlers} />);
    expect(screen.getByTestId('type-aggregate-unknown')).toHaveTextContent('1 process · 2.0% CPU · 1.0% mem');
    expect(screen.getByTestId('type-kill-all-unknown')).toBeDisabled();
  });

  it('sortTypeGroups orders by a total that comes mostly from a foreign process', () => {
    const groups = [
      { type: 'claude-cli' as const, members: [proc(1, { pcpu: 5, pmem: 5 })] },
      {
        type: 'unknown' as const,
        members: [foreign('~pid 9', { display: { cpu: '40.0%', mem: '30.0%', elapsed: null } })],
      },
    ];
    expect(sortTypeGroups(groups, 'cpu', new Map()).map((g) => g.type)).toEqual(['unknown', 'claude-cli']);
    expect(sortTypeGroups(groups, 'mem', new Map()).map((g) => g.type)).toEqual(['unknown', 'claude-cli']);
  });

  it('sortTypeGroups keeps canonical order on ties', () => {
    const groups = [
      { type: 'claude-cli' as const, members: [proc(1, { pcpu: 1 })] },
      { type: 'codex-cli' as const, members: [proc(2, { pcpu: 1 })] },
    ];
    expect(sortTypeGroups(groups, 'cpu', new Map()).map((g) => g.type)).toEqual(['claude-cli', 'codex-cli']);
  });
});
