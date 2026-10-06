import { describe, it, expect, expectTypeOf } from 'vitest';
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
  deadInstanceIds: new Set([DEAD]),
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

  it('self-stamped marker WITHOUT a manager handle → suspected, not owned', () => {
    const stray = proc(110, 'claude --leaked', {
      marker: { instanceId: SELF, worktree: '/wt/known' },
    });
    const [c] = classify([stray], live, truth);
    expect(c.bucket).toBe('suspected');
    expect(selectSweepSet([c])).toEqual([]);
  });

  it('marker naming an instance that is neither live nor confirmed dead → suspected', () => {
    const unknown = proc(111, 'codex', { marker: { instanceId: 'inst-unknown', worktree: null } });
    const [c] = classify([unknown], live, truth);
    expect(c.bucket).toBe('suspected');
    expect(selectSweepSet([c])).toEqual([]);
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

/** Keys of T whose type is (or transitively contains) a number/bigint. */
type NumericKeys<T> = {
  [K in keyof T]-?: [Extract<NonNullable<T[K]>, number | bigint>] extends [never]
    ? NonNullable<T[K]> extends object
      ? [NumericKeys<NonNullable<T[K]>>] extends [never]
        ? never
        : K
      : never
    : K;
}[keyof T];

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

  it('display figures are formatted for the view, not raw numbers stringified', () => {
    // FOREIGN_UNRELATED is proc(201): pcpu 2.5, pmem 0.4, etime 120s.
    const f = foreign.find((x) => x.pidLabel === '201');
    expect(f?.display).toEqual({ cpu: '2.5%', mem: '0.4%', elapsed: '2m' });
    const long = classify([proc(202, 'x', { pcpu: null, pmem: null, etimeSeconds: 388920 })], live, truth)[0];
    expect(long.bucket === 'foreign' && long.display).toEqual({ cpu: null, mem: null, elapsed: '4d' });
  });

  it('has no number-typed field anywhere (compile-time), while the other buckets keep theirs', () => {
    expectTypeOf<NumericKeys<ForeignProcess>>().toEqualTypeOf<never>();
    expectTypeOf<NumericKeys<OrphanProcess>>().not.toEqualTypeOf<never>();
    for (const f of foreign) {
      const walk = (v: unknown): void => {
        expect(typeof v).not.toBe('number');
        if (v && typeof v === 'object') Object.values(v).forEach(walk);
      };
      walk(f);
    }
  });

  it('cannot be passed to a killTree-shaped call without an unsafe cast', () => {
    const killTreeLike = (pid: number): number => pid;
    const f = foreign[0];
    if (f.display.cpu !== null) {
      // @ts-expect-error display figures are strings, not numbers
      killTreeLike(f.display.cpu);
    }
    // @ts-expect-error the metric fields do not exist on a foreign entry
    killTreeLike(f.pcpu);
    // @ts-expect-error the metric fields do not exist on a foreign entry
    killTreeLike(f.etimeSeconds);
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
    expect([...set.deadInstanceIds]).toEqual([DEAD]);
  });

  it('feeds classify: a record whose pid died (confirmed dead) turns its children into orphans', () => {
    const set = buildLiveInstanceSet(SELF, [{ instanceId: OTHER_LIVE, pid: 11 }], () => false);
    const [c] = classify(
      [proc(9, 'codex', { marker: { instanceId: OTHER_LIVE, worktree: null } })],
      set,
      truth,
    );
    expect(c.bucket).toBe('orphan');
  });

  it('an instance id with no record at all is unknown, never swept', () => {
    const set = buildLiveInstanceSet(SELF, [], () => false);
    const res = classify(
      [proc(9, 'codex', { marker: { instanceId: 'inst-never-recorded', worktree: null } })],
      set,
      truth,
    );
    expect(res[0].bucket).toBe('suspected');
    expect(selectSweepSet(res)).toEqual([]);
  });
});

describe('descendants of a live owned process', () => {
  it('classifies MCP-server children of an owned CLI as owned, inheriting its owner and worktree', () => {
    const cli = proc(500, 'claude --model x', {
      processType: 'claude-cli',
      worktreePath: '/wt/known',
      owner: { kind: 'cli', panelId: 'p', sessionId: 's' },
    });
    const npm = proc(501, 'npm exec @playwright/mcp@latest', { ppid: 500 });
    const mcp = proc(502, 'node playwright-mcp', { ppid: 501 });
    const res = classify([cli, npm, mcp], live, truth);
    expect(res.map((c) => c.bucket)).toEqual(['owned', 'owned', 'owned']);
    expect(res[2].worktreePath).toBe('/wt/known');
    expect(selectSweepSet(res)).toEqual([]);
  });

  it('does not claim a child of another live instance\'s process', () => {
    const theirs = proc(600, 'claude', {
      owner: { kind: 'cli', panelId: 'p', sessionId: 's' },
      marker: { instanceId: OTHER_LIVE, worktree: null },
    });
    const child = proc(601, 'npm exec x', { ppid: 600 });
    expect(classify([theirs, child], live, truth)[1].bucket).not.toBe('owned');
  });
});

describe('classify — marker worktree attribution', () => {
  it("files a detached marked row under the marker's worktree when no handle matched", () => {
    const [orphan, selfStray] = classify(
      [
        proc(400, 'node idle.js', { marker: { instanceId: DEAD, worktree: '/wt/gone' } }),
        proc(401, 'node idle.js', { marker: { instanceId: SELF, worktree: '/wt/known' } }),
      ],
      live,
      truth,
    );
    expect(orphan).toMatchObject({ bucket: 'orphan', worktreePath: '/wt/gone' });
    expect(selfStray).toMatchObject({ bucket: 'suspected', worktreePath: '/wt/known' });
  });

  it('keeps a handle-matched worktree over the marker, and a null marker worktree changes nothing', () => {
    const [handled, bare] = classify(
      [
        proc(402, 'claude', {
          worktreePath: '/wt/known',
          owner: { kind: 'cli', panelId: 'p', sessionId: 's' },
          marker: { instanceId: SELF, worktree: '/wt/other' },
        }),
        proc(403, 'node x', { marker: { instanceId: DEAD, worktree: null } }),
      ],
      live,
      truth,
    );
    expect(handled).toMatchObject({ bucket: 'owned', worktreePath: '/wt/known' });
    expect(bare).toMatchObject({ bucket: 'orphan', worktreePath: null });
  });
});
