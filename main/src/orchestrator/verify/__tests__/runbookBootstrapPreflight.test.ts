/**
 * Unit tests for the runbook-bootstrap preflight
 * (docs/proposals/lane-runbook-bootstrap.md §12 step 1).
 *
 * The decision itself is covered in bootstrapEligibility.test.ts. What is under
 * test HERE is the wiring around it, and specifically the three things that
 * could make a correct decision arrive with wrong inputs or at the wrong cost:
 * that the run's worktree is what gets probed, that the status read is SKIPPED
 * when its answer cannot change the outcome, and that a resolver which throws
 * declines instead of propagating into a seam whose contract is never-throws.
 */
import { describe, it, expect, vi } from 'vitest';
import { runbookBootstrapPreflight } from '../runbookBootstrapPreflight';
import type { RunbookBootstrapPreflightDeps } from '../runbookBootstrapPreflight';
import type { VerifyRunbookStatusDetail } from '../runbookStore';

const SERVE_TASK = { serve: { cmd: 'pnpm dev --port ${PORT}' } };
const TARGET_ONLY = {};

const ARGS = {
  projectId: 1,
  runId: 'run-1',
  laneTaskRef: 'TASK-7',
  modality: 'web' as const,
  task: SERVE_TASK,
  probePath: '/live/worktree',
};

function deps(
  over: Partial<RunbookBootstrapPreflightDeps> = {},
): RunbookBootstrapPreflightDeps & { calls: Array<string | undefined> } {
  const calls: Array<string | undefined> = [];
  const base: RunbookBootstrapPreflightDeps = {
    enabled: true,
    status: async (_projectId, _modality, probePath) => {
      calls.push(probePath);
      return { status: 'absent', reason: 'no-record' } satisfies VerifyRunbookStatusDetail;
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
  return { ...base, ...over, calls };
}

describe('runbookBootstrapPreflight', () => {
  it("probes the run's worktree, not the project root", async () => {
    // The tree the request would actually execute in — the same one the degrade
    // gate now probes. Probing the project root here would recreate §3's
    // disagreement one seam earlier: the preflight would see a runbook the gate
    // cannot use, decline, and the lane would skip anyway.
    const d = deps();
    await runbookBootstrapPreflight(ARGS, d);
    expect(d.calls).toEqual(['/live/worktree']);
  });

  it('proceeds when the project has no runbook and the task derives an environment', async () => {
    await expect(runbookBootstrapPreflight(ARGS, deps())).resolves.toEqual({
      proceed: true,
      mode: 'derive',
      adopt: false,
      proveRegistered: false,
    });
  });

  it('a DRIFTED proof proceeds in REPROVE mode, and says so at INFO', async () => {
    // F4 / Codex #2. Loud for the same reason 'proof-belongs-elsewhere' is: the
    // two proceed modes are opposite actions against a human's runbook, and a
    // log line that called both "would bootstrap" would hide the one distinction
    // someone reading this log is trying to check.
    const info = vi.fn();
    const d = deps({
      status: async () => ({ status: 'unproven-draft', reason: 'drifted' }),
      logger: { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });
    await expect(runbookBootstrapPreflight(ARGS, d)).resolves.toEqual({
      proceed: true,
      mode: 'reprove',
    });
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('re-prove the existing runbook'),
      expect.objectContaining({ runbookReason: 'drifted' }),
    );
  });

  it('does NOT read the runbook status when the feature is off', async () => {
    // The read is a file read plus a project input hash. Spending it to reach a
    // conclusion already in hand would tax every run on every project that never
    // turned this on.
    const d = deps({ enabled: false });
    await expect(runbookBootstrapPreflight(ARGS, d)).resolves.toEqual({
      proceed: false,
      reason: 'disabled',
    });
    expect(d.calls).toEqual([]);
  });

  it('does NOT read the runbook status for a task that derives no environment', async () => {
    const d = deps();
    await expect(
      runbookBootstrapPreflight({ ...ARGS, task: TARGET_ONLY }, d),
    ).resolves.toEqual({ proceed: false, reason: 'no-environment' });
    expect(d.calls).toEqual([]);
  });

  it('declines (never throws) when the status resolver blows up', async () => {
    // The enqueue seam's contract is NEVER THROWS — a throw here would crash a
    // lane. Declining costs exactly today's behavior.
    const warn = vi.fn();
    const d = deps({
      status: async () => {
        throw new Error('db is on fire');
      },
      logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
    });
    await expect(runbookBootstrapPreflight(ARGS, d)).resolves.toEqual({
      proceed: false,
      reason: 'unobservable',
    });
    expect(warn).toHaveBeenCalled();
  });

  it('declines on a proof that belongs to another branch, and says so at INFO', async () => {
    // Loud on purpose: this is the case where the obvious remedy (run
    // verification setup) is the destructive one.
    const info = vi.fn();
    const d = deps({
      status: async () => ({ status: 'unproven-draft', reason: 'proven-file-absent-here' }),
      logger: { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });
    await expect(runbookBootstrapPreflight(ARGS, d)).resolves.toEqual({
      proceed: false,
      reason: 'proof-belongs-elsewhere',
    });
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('proof-belongs-elsewhere'),
      expect.objectContaining({ runbookReason: 'proven-file-absent-here' }),
    );
  });

  it('keeps the two non-events at DEBUG so ordinary runs stay quiet', async () => {
    const debug = vi.fn();
    const info = vi.fn();
    const d = deps({
      enabled: false,
      logger: { info, warn: vi.fn(), error: vi.fn(), debug },
    });
    await runbookBootstrapPreflight(ARGS, d);
    expect(debug).toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });
});
