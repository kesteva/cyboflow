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
import type {
  ExploreStaleProofFinding,
  RunbookBootstrapPreflightDeps,
} from '../runbookBootstrapPreflight';
import type { VerifyRunbookV1 } from '../../../../../shared/types/verifyRunbook';
import type { VerificationModality } from '../../../../../shared/types/visualVerification';
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

  it('declines a MOBILE lane before it reads anything, and before any controller exists', async () => {
    // The whole point of putting the policy in the eligibility layer: a mobile
    // lane costs a decision and nothing else — no status read, no stamp claim,
    // no drafting agent, no controller. The `calls` assertion is what proves the
    // read never happened; the returned decline is what stops the caller from
    // constructing one.
    const info = vi.fn();
    const d = deps({ logger: { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() } });
    await expect(
      runbookBootstrapPreflight({ ...ARGS, modality: 'mobile' }, d),
    ).resolves.toEqual({ proceed: false, reason: 'auto-derive-unsupported' });
    expect(d.calls).toEqual([]);
    // Loud, not quiet: "why did my mobile verification never run" is a question
    // someone asks of this log, and the answer has to be in it.
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('auto-derive-unsupported'),
      // NOT the seeded 'indeterminate' — that is a real answer meaning the store
      // could not tell, and logging it for a read that never happened would send
      // a reader hunting a store fault that does not exist.
      expect.objectContaining({ modality: 'mobile', runbookReason: null }),
    );
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

// ── §A7: bootstrap under explore (runbook-optional-verification.md) ──────────
describe('runbookBootstrapPreflight — explore (§A7)', () => {
  let runSeq = 0;
  /** A fresh run id per case: the drift-finding dedupe is per (run, modality), process-wide. */
  const freshArgs = (
    over: Partial<Omit<typeof ARGS, 'modality'>> & { modality?: VerificationModality } = {},
  ): Omit<typeof ARGS, 'modality'> & { modality: VerificationModality } => ({
    ...ARGS,
    runId: `explore-run-${++runSeq}`,
    ...over,
  });

  const EXPLORE_ON = { requireProvenRunbook: false, record: () => null };
  const KILL_SWITCH_ON = { requireProvenRunbook: true, record: () => null };
  const statusOf = (detail: VerifyRunbookStatusDetail) => async (): Promise<VerifyRunbookStatusDetail> => detail;
  const CDP_WITH_LEVER: VerifyRunbookV1 = {
    version: 1,
    modalities: {
      'cdp-app': {
        serve: { cmd: 'x', attach: 'cdp' },
        attestation: { kind: 'cdp-token', expression: 'window.__BUILD__', expected: 'v1' },
      },
    },
    levers: { dataDirEnv: 'CYBOFLOW_DIR' },
  };

  it('answers explore-mode instead of deriving for a web request that will explore', async () => {
    await expect(runbookBootstrapPreflight(freshArgs(), deps({ explore: EXPLORE_ON }))).resolves.toEqual({
      proceed: false,
      reason: 'explore-mode',
    });
  });

  it('turns the draft arm prove-only under explore', async () => {
    const d = deps({ explore: EXPLORE_ON, status: statusOf({ status: 'unproven-draft', reason: 'draft' }) });
    await expect(runbookBootstrapPreflight(freshArgs(), d)).resolves.toEqual({
      proceed: true,
      mode: 'derive',
      adopt: false,
      proveRegistered: true,
      proveOnly: true,
    });
  });

  it("keeps 'drifted' → reprove exactly", async () => {
    const d = deps({ explore: EXPLORE_ON, status: statusOf({ status: 'unproven-draft', reason: 'drifted' }) });
    await expect(runbookBootstrapPreflight(freshArgs(), d)).resolves.toEqual({ proceed: true, mode: 'reprove' });
  });

  it('a cdp-app request explores only when the record carries a bindable data-dir lever (isExploreEligible)', async () => {
    const noLever = deps({ explore: EXPLORE_ON });
    await expect(
      runbookBootstrapPreflight(freshArgs({ modality: 'cdp-app' }), noLever),
    ).resolves.toEqual({ proceed: true, mode: 'derive', adopt: false, proveRegistered: false });
    const withLever = deps({
      explore: { requireProvenRunbook: false, record: () => ({ runbook: CDP_WITH_LEVER }) },
    });
    await expect(
      runbookBootstrapPreflight(freshArgs({ modality: 'cdp-app' }), withLever),
    ).resolves.toEqual({ proceed: false, reason: 'explore-mode' });
  });

  it('a record read that throws reads as "no record" (cdp-app does not explore), never as a throw', async () => {
    const d = deps({
      explore: {
        requireProvenRunbook: false,
        record: () => {
          throw new Error('store gone');
        },
      },
    });
    await expect(
      runbookBootstrapPreflight(freshArgs({ modality: 'cdp-app' }), d),
    ).resolves.toMatchObject({ proceed: true, mode: 'derive' });
  });

  it('native-screen never explores: derived exactly as before, and its record is not read', async () => {
    const record = vi.fn(() => ({ runbook: CDP_WITH_LEVER }));
    const d = deps({ explore: { requireProvenRunbook: false, record } });
    await expect(
      runbookBootstrapPreflight(freshArgs({ modality: 'native-screen' }), d),
    ).resolves.toEqual({ proceed: true, mode: 'derive', adopt: false, proveRegistered: false });
    expect(record).not.toHaveBeenCalled();
  });

  it.each<[string, Partial<RunbookBootstrapPreflightDeps>]>([
    ['the kill switch is engaged', { explore: KILL_SWITCH_ON }],
    ['the explore deps are not wired', {}],
  ])('behaves exactly as before when %s — derive arms, draft arm, no finding', async (_label, over) => {
    const sink = vi.fn();
    await expect(
      runbookBootstrapPreflight(freshArgs(), deps({ ...over, reportStaleProofFinding: sink })),
    ).resolves.toEqual({ proceed: true, mode: 'derive', adopt: false, proveRegistered: false });
    await expect(
      runbookBootstrapPreflight(
        freshArgs(),
        deps({ ...over, status: statusOf({ status: 'unproven-draft', reason: 'draft' }) }),
      ),
    ).resolves.toEqual({ proceed: true, mode: 'derive', adopt: false, proveRegistered: true });
    // A content-drifted record under the switch: the same decline, and NO finding.
    const drifted = deps({
      ...over,
      status: statusOf({ status: 'unproven-draft', reason: 'content-drifted' }),
      reportStaleProofFinding: sink,
    });
    await expect(runbookBootstrapPreflight(freshArgs(), drifted)).resolves.toEqual({
      proceed: false,
      reason: 'stale-proof',
    });
    // And the feature-off / mobile paths still read nothing.
    const off = deps({ ...over, enabled: false, reportStaleProofFinding: sink });
    await runbookBootstrapPreflight(freshArgs({ modality: 'mobile' }), off);
    expect(off.calls).toEqual([]);
    expect(sink).not.toHaveBeenCalled();
  });

  describe('the drift finding', () => {
    it('files bootstrapRemedyText(stale-proof) ONCE per run and modality for a content-drifted record', async () => {
      const findings: ExploreStaleProofFinding[] = [];
      const d = deps({
        explore: EXPLORE_ON,
        status: statusOf({ status: 'unproven-draft', reason: 'content-drifted' }),
        reportStaleProofFinding: (f) => {
          findings.push(f);
        },
      });
      const args = freshArgs();
      await expect(runbookBootstrapPreflight(args, d)).resolves.toEqual({ proceed: false, reason: 'stale-proof' });
      await runbookBootstrapPreflight({ ...args, laneTaskRef: 'TASK-8' }, d);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        projectId: 1,
        runId: args.runId,
        modality: 'web',
        dedupeKey: `visual-verify:explore-stale-proof:${args.runId}:web`,
      });
      expect(findings[0].body).toContain('re-registered');
      expect(findings[0].body).toContain('content-drifted');
      // A second modality in the same run is its own finding.
      await runbookBootstrapPreflight({ ...args, modality: 'mobile' }, d);
      expect(findings).toHaveLength(2);
    });

    it('files for a MOBILE lane (which still declines the bootstrap) and with the toggle OFF — both still explore', async () => {
      const sink = vi.fn();
      const drifted = statusOf({ status: 'unproven-draft', reason: 'drifted' });
      const mobile = deps({ explore: EXPLORE_ON, status: drifted, reportStaleProofFinding: sink });
      await expect(
        runbookBootstrapPreflight(freshArgs({ modality: 'mobile' }), mobile),
      ).resolves.toEqual({ proceed: false, reason: 'auto-derive-unsupported' });
      const off = deps({ enabled: false, explore: EXPLORE_ON, status: drifted, reportStaleProofFinding: sink });
      await expect(runbookBootstrapPreflight(freshArgs(), off)).resolves.toEqual({
        proceed: false,
        reason: 'disabled',
      });
      expect(sink).toHaveBeenCalledTimes(2);
    });

    it('does NOT file for a drifted record the bootstrap is about to REPROVE', async () => {
      const sink = vi.fn();
      const d = deps({
        explore: EXPLORE_ON,
        status: statusOf({ status: 'unproven-draft', reason: 'drifted' }),
        reportStaleProofFinding: sink,
      });
      await expect(runbookBootstrapPreflight(freshArgs(), d)).resolves.toEqual({ proceed: true, mode: 'reprove' });
      expect(sink).not.toHaveBeenCalled();
    });

    it('does not file for a request that cannot explore, or for a record that is not drifted', async () => {
      const sink = vi.fn();
      const native = deps({
        explore: EXPLORE_ON,
        status: statusOf({ status: 'unproven-draft', reason: 'content-drifted' }),
        reportStaleProofFinding: sink,
      });
      await runbookBootstrapPreflight(freshArgs({ modality: 'native-screen' }), native);
      const absent = deps({ explore: EXPLORE_ON, reportStaleProofFinding: sink });
      await runbookBootstrapPreflight(freshArgs(), absent);
      expect(sink).not.toHaveBeenCalled();
    });

    it('a sink that throws never escapes the preflight', async () => {
      const d = deps({
        explore: EXPLORE_ON,
        status: statusOf({ status: 'unproven-draft', reason: 'content-drifted' }),
        reportStaleProofFinding: () => {
          throw new Error('queue down');
        },
      });
      await expect(runbookBootstrapPreflight(freshArgs(), d)).resolves.toEqual({
        proceed: false,
        reason: 'stale-proof',
      });
    });
  });
});
