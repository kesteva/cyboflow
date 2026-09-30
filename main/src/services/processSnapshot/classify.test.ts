import { describe, it, expect } from 'vitest';
import {
  buildLiveInstanceSet,
  classify,
  isOrphanProcess,
  selectSweepSet,
  type ClassifiedProcess,
  type ForeignProcess,
  type LiveInstanceSet,
  type MarkedProcess,
  type OrphanProcess,
} from './classify';
import { buildWorktreeTruthFixture } from './worktreeTruth';

const SELF = 'inst-self';
const OTHER_LIVE = 'inst-other';
const DEAD = 'inst-dead';

const live: LiveInstanceSet = {
  selfInstanceId: SELF,
  liveInstanceIds: new Set([SELF, OTHER_LIVE]),
};
const truth = buildWorktreeTruthFixture(['/wt/known']);

function proc(pid: number, command: string, over: Partial<MarkedProcess> = {}): MarkedProcess {
  return {
    pid,
    ppid: 1,
    pcpu: 2.5,
    pmem: 0.4,
    etimeSeconds: 120,
    command,
    processType: 'unknown',
    worktreePath: null,
    owner: null,
    marker: null,
    ...over,
  };
}

// A ps-shaped fixture covering every bucket.
const OWNED_TAGGED = proc(100, 'claude --resume', {
  processType: 'claude-cli',
  worktreePath: '/wt/known',
  owner: { kind: 'cli', panelId: 'p', sessionId: 's' },
  marker: { instanceId: SELF, worktree: '/wt/known' },
});
const OWNED_HANDLE_ONLY = proc(101, '-zsh', {
  processType: 'shell-pty',
  worktreePath: '/wt/known',
  owner: { kind: 'run-shell', runId: 'r', terminalId: 't' },
});
const FOREIGN_OTHER_INSTANCE = proc(200, 'codex', {
  marker: { instanceId: OTHER_LIVE, worktree: '/wt/theirs' },
});
const FOREIGN_UNRELATED = proc(201, '/Applications/Slack.app/Contents/MacOS/Slack');
const ORPHAN_DEAD_INSTANCE = proc(300, 'codex app-server', {
  marker: { instanceId: DEAD, worktree: '/wt/known' },
});
const SUSPECTED_BROKER = proc(400, 'node /x/app-server-broker.mjs serve --cwd /wt/known', {
  processType: 'codex-broker',
  worktreePath: '/wt/known',
});
const SUSPECTED_CLI_IN_KNOWN_WORKTREE = proc(401, 'claude --cwd /wt/known --print');
const SUSPECTED_BY_ANCESTRY = proc(402, 'node worker.js', { ppid: 400 });

const FIXTURE: MarkedProcess[] = [
  OWNED_TAGGED,
  OWNED_HANDLE_ONLY,
  FOREIGN_OTHER_INSTANCE,
  FOREIGN_UNRELATED,
  ORPHAN_DEAD_INSTANCE,
  SUSPECTED_BROKER,
  SUSPECTED_CLI_IN_KNOWN_WORKTREE,
  SUSPECTED_BY_ANCESTRY,
];

function bucketOf(out: ClassifiedProcess[], command: string): ClassifiedProcess {
  const hit = out.find((c) => c.command === command);
  if (!hit) throw new Error(`no classified row for ${command}`);
  return hit;
}

describe('classify', () => {
  const out = classify(FIXTURE, live, truth);

  it('returns one classification per row, in order', () => {
    expect(out).toHaveLength(FIXTURE.length);
    expect(out.map((c) => c.command)).toEqual(FIXTURE.map((r) => r.command));
  });

  it('marker of the live self instance → owned', () => {
    const c = out[0];
    expect(c.bucket).toBe('owned');
    if (c.bucket === 'owned') expect(c.instanceId).toBe(SELF);
  });

  it('manager handle without a marker → owned', () => {
    expect(bucketOf(out, '-zsh').bucket).toBe('owned');
  });

  it('marker of a DIFFERENT live instance → foreign and readOnly', () => {
    const c = bucketOf(out, 'codex');
    expect(c.bucket).toBe('foreign');
    if (c.bucket === 'foreign') {
      expect(c.readOnly).toBe(true);
      expect(c.foreignInstanceId).toBe(OTHER_LIVE);
    }
  });

  it('an unrelated process outside any known worktree → foreign', () => {
    const c = bucketOf(out, FOREIGN_UNRELATED.command);
    expect(c.bucket).toBe('foreign');
    if (c.bucket === 'foreign') {
      expect(c.readOnly).toBe(true);
      expect(c.foreignInstanceId).toBeNull();
    }
  });

  it('marker of a dead instance → orphan, the only sweep-eligible bucket', () => {
    const c = bucketOf(out, 'codex app-server');
    expect(c.bucket).toBe('orphan');
    if (isOrphanProcess(c)) {
      expect(c.sweepEligible).toBe(true);
      expect(c.instanceId).toBe(DEAD);
      expect(c.process.pid).toBe(300);
    }
  });

  it('cyboflow-shaped ancestry with NO marker → suspected, never orphan', () => {
    for (const r of [SUSPECTED_BROKER, SUSPECTED_CLI_IN_KNOWN_WORKTREE, SUSPECTED_BY_ANCESTRY]) {
      expect(bucketOf(out, r.command).bucket).toBe('suspected');
    }
    expect(out.some((c) => c.bucket === 'orphan' && c.process.pid >= 400)).toBe(false);
  });

  it('does not match a sibling path that merely shares a known worktree prefix', () => {
    const [c] = classify([proc(500, 'claude --cwd /wt/known-but-different')], live, truth);
    expect(c.bucket).toBe('foreign');
  });

  it('a child of a marked ancestor of ANOTHER live instance is not suspected', () => {
    const parent = proc(600, 'codex', { marker: { instanceId: OTHER_LIVE, worktree: '/x' } });
    const child = proc(601, 'node child.js', { ppid: 600 });
    const res = classify([parent, child], live, truth);
    expect(res[1].bucket).toBe('foreign');
  });

  it('terminates on a ppid cycle', () => {
    const a = proc(700, 'a', { ppid: 701 });
    const b = proc(701, 'b', { ppid: 700 });
    const res = classify([a, b], live, truth);
    expect(res.map((c) => c.bucket)).toEqual(['foreign', 'foreign']);
  });

  it('is deterministic and does not mutate its inputs', () => {
    const before = JSON.stringify(FIXTURE);
    expect(classify(FIXTURE, live, truth)).toEqual(out);
    expect(JSON.stringify(FIXTURE)).toBe(before);
  });
});

describe('sweep-set structure', () => {
  const out = classify(FIXTURE, live, truth);

  it('selectSweepSet returns only orphans', () => {
    const sweep = selectSweepSet(out);
    expect(sweep.map((o) => o.process.pid)).toEqual([300]);
    expect(sweep.every((o) => o.bucket === 'orphan')).toBe(true);
  });

  it('a naive "everything not owned/foreign" builder cannot feed the sweep API', () => {
    const naive = out.filter((c) => c.bucket !== 'owned' && c.bucket !== 'foreign');
    // The naive filter really does drag suspected rows in...
    expect(naive.some((c) => c.bucket === 'suspected')).toBe(true);
    // ...but they lack the sweep-eligibility marker, so the sweep type rejects them.
    expect(naive.filter((c) => 'sweepEligible' in c).map((c) => c.bucket)).toEqual(['orphan']);

    const takesSweepSet = (targets: readonly OrphanProcess[]): number => targets.length;
    // @ts-expect-error a naive orphan|suspected list is not assignable to OrphanProcess[]
    takesSweepSet(naive);
    // The sanctioned builder is.
    expect(takesSweepSet(selectSweepSet(out))).toBe(1);
  });

  it('a suspected row is not assignable to OrphanProcess', () => {
    const suspected = out.find((c) => c.bucket === 'suspected');
    if (!suspected) throw new Error('fixture has a suspected row');
    // @ts-expect-error SuspectedProcess lacks sweepEligible: true
    const asOrphan: OrphanProcess = suspected;
    expect((asOrphan as unknown as Record<string, unknown>).sweepEligible).toBeUndefined();
  });
});

describe('foreign entries are unkillable by construction', () => {
  const foreign = classify(FIXTURE, live, truth).filter(
    (c): c is ForeignProcess => c.bucket === 'foreign',
  );

  it('carry no numeric field at all except cpu/mem/elapsed figures, and no pid/ppid', () => {
    expect(foreign.length).toBeGreaterThan(0);
    for (const f of foreign) {
      expect(f).not.toHaveProperty('pid');
      expect(f).not.toHaveProperty('ppid');
      expect(f).not.toHaveProperty('process');
      expect(typeof f.pidLabel).toBe('string');
    }
  });

  it('cannot be passed to a killTree-shaped call without an unsafe cast', () => {
    const killTreeLike = (pid: number): number => pid;
    const f = foreign[0];
    // @ts-expect-error pidLabel is a string, not a pid
    killTreeLike(f.pidLabel);
    // @ts-expect-error there is no pid property on a foreign entry
    killTreeLike(f.pid);
  });
});

describe('buildLiveInstanceSet', () => {
  it('keeps self plus every record whose pid is alive', () => {
    const set = buildLiveInstanceSet(
      SELF,
      [
        { instanceId: OTHER_LIVE, pid: 11 },
        { instanceId: DEAD, pid: 12 },
      ],
      (pid) => pid === 11,
    );
    expect(set.selfInstanceId).toBe(SELF);
    expect([...set.liveInstanceIds].sort()).toEqual([OTHER_LIVE, SELF].sort());
  });

  it('feeds classify: a record whose pid died turns its children into orphans', () => {
    const set = buildLiveInstanceSet(SELF, [{ instanceId: OTHER_LIVE, pid: 11 }], () => false);
    const [c] = classify(
      [proc(9, 'codex', { marker: { instanceId: OTHER_LIVE, worktree: null } })],
      set,
      truth,
    );
    expect(c.bucket).toBe('orphan');
  });
});
