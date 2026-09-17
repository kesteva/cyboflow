/**
 * Unit tests for the bootstrap sequence itself
 * (docs/proposals/lane-runbook-bootstrap.md §12).
 *
 * The sequence is claim → draft → validate → apply rung-1 → commit → register →
 * PROVE → re-enqueue, and the property that matters most is not that the happy
 * path works. It is that **no exit leaves a promoted record this run did not
 * prove**, and that every refusal costs exactly what §10 says it costs and no
 * more. So the tests are organized around exits rather than around steps.
 *
 * The three that would be silent in production if they regressed:
 *
 *  - a PROOF FAILURE must never return `proven` — the runner learns about
 *    promotion, it never performs it (the engine's terminal path owns
 *    `markProven`), and a `proven` outcome here is what makes the caller stop
 *    treating the lane as unverified.
 *  - a NOT-POSSIBLE draft must write the §10 suppression, and a VALIDATION
 *    rejection must NOT. One is a claim about the project, the other is a claim
 *    about this draft, and conflating them either burns budget forever or
 *    silences a project on one bad draft.
 *  - a resumed owner mid-proof must AWAIT the request it already fired rather
 *    than firing a second one, which would dedup to the first and deploy nothing.
 */
import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  composeBootstrapProofTask,
  MAX_BOOTSTRAP_ROUNDS,
  runRunbookBootstrap,
  type BootstrapProofOutcome,
  type RunbookBootstrapDeps,
} from '../runbookBootstrapRunner';
import { RunbookBootstrapStampStore } from '../bootstrapStampStore';
import { BootstrapSuppressionStore } from '../bootstrapSuppressionStore';
import type { DatabaseLike } from '../../types';
import { VERIFY_RUNBOOK_RELATIVE_PATH } from '../../../../../shared/types/verifyRunbook';
import type { VerificationModality } from '../../../../../shared/types/visualVerification';
import type { VerifyRunbookV1 } from '../../../../../shared/types/verifyRunbook';

/** Recorders for the two optional reporting seams, typed off the deps themselves. */
type ArtifactReport = Parameters<NonNullable<RunbookBootstrapDeps['reportArtifact']>>[0];
type FindingReport = Parameters<NonNullable<RunbookBootstrapDeps['reportFinding']>>[0];

function recorder<T>(): { fn: (arg: T) => Promise<void>; calls: T[] } {
  const calls: T[] = [];
  return {
    fn: async (arg: T) => {
      calls.push(arg);
    },
    calls,
  };
}

const MIG_DIR = join(__dirname, '..', '..', '..', 'database', 'migrations');

const MANIFEST = JSON.stringify({ scripts: { build: 'vite build', preview: 'vite preview' } }, null, 2);

const RUNBOOK: VerifyRunbookV1 = {
  version: 1,
  modalities: {
    web: {
      build: ['pnpm run build'],
      serve: { cmd: 'pnpm run preview --port ${PORT}' },
      attestation: { kind: 'dom-marker', selector: '[data-verify-build]' },
    },
  },
};

/** The fields both modes share; `mode` (F4 / Codex #2) is what splits them. */
const BASE = {
  projectId: 1,
  runId: 'run-1',
  laneTaskRef: 'TASK-7',
  modality: 'web' as const,
  worktreePath: '/wt',
};

const ARGS = { ...BASE, mode: 'derive' as const, adopt: false };

/**
 * The re-prove arm. It carries NO `adopt` — the union has none on this side, and
 * writing one would assert an authorship decision that was never taken.
 */
const REPROVE_ARGS = { ...BASE, mode: 'reprove' as const };

const PASS: BootstrapProofOutcome = { status: 'passed', errorMessage: null, failureClass: null, feedback: null };
const FAIL: BootstrapProofOutcome = {
  status: 'failed',
  errorMessage: 'the serve command exited immediately',
  failureClass: 'deliverable',
  feedback: null,
};

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(readFileSync(join(MIG_DIR, '108_runbook_bootstrap_stamp.sql'), 'utf-8'));
  db.exec(readFileSync(join(MIG_DIR, '109_runbook_bootstrap_suppression.sql'), 'utf-8'));
  return db;
}

interface Harness {
  deps: RunbookBootstrapDeps;
  db: Database.Database;
  stamps: RunbookBootstrapStampStore;
  suppression: BootstrapSuppressionStore;
  written: Array<{ path: string; content: string }>;
  commits: Array<{ paths: readonly string[]; message: string }>;
  proofs: Array<{ round: number; runbookHash: string; runbookLocalVersion: number }>;
  drafts: number;
  /** What a human would actually see — recorded by default so every test can assert on it. */
  artifacts: ArtifactReport[];
  findings: FindingReport[];
}

function harness(over: Partial<RunbookBootstrapDeps> & { draftResults?: unknown[]; proofs?: BootstrapProofOutcome[] } = {}): Harness {
  const db = buildDb();
  const stamps = new RunbookBootstrapStampStore(db as unknown as DatabaseLike);
  const suppression = new BootstrapSuppressionStore(db as unknown as DatabaseLike);
  const written: Array<{ path: string; content: string }> = [];
  const commits: Array<{ paths: readonly string[]; message: string }> = [];
  const proofs: Array<{ round: number; runbookHash: string; runbookLocalVersion: number }> = [];
  const state = { drafts: 0, awaits: 0 };
  const artifactRecorder = recorder<ArtifactReport>();
  const findingRecorder = recorder<FindingReport>();
  const draftResults = over.draftResults ?? [{ decision: 'runbook', modality: 'web', runbook: RUNBOOK }];
  const proofOutcomes = over.proofs ?? [PASS];

  const base: RunbookBootstrapDeps = {
    stamps,
    suppression,
    draft: async () => {
      const result = draftResults[Math.min(state.drafts, draftResults.length - 1)];
      state.drafts += 1;
      return result;
    },
    readFile: async (_wt, relativePath) => {
      if (relativePath === 'package.json') return MANIFEST;
      const found = written.find((w) => w.path === relativePath);
      return found?.content ?? null;
    },
    writeFile: async (_wt, relativePath, content) => {
      written.push({ path: relativePath, content });
    },
    commitPaths: async (_wt, paths, message) => {
      commits.push({ paths, message });
      return `sha-${commits.length}`;
    },
    registerDraft: async () => ({ hash: 'hash-1', version: 3 }),
    // The re-prove path's only input: the record as the STORE holds it, which is
    // deliberately a different revision from `registerDraft`'s so a test cannot
    // pass by accident when the two are confused.
    currentRecord: () => ({ hash: 'record-hash', version: 7, runbook: RUNBOOK, status: 'proven' as const }),
    setOrigin: vi.fn(),
    enqueueProof: async ({ round, runbookHash, runbookLocalVersion }) => {
      proofs.push({ round, runbookHash, runbookLocalVersion });
      return { requestId: `req-${round}` };
    },
    // Counted independently of `proofs`: the RESUME path awaits a request it
    // never enqueued in this call, so keying the outcome off the enqueue count
    // would read past the end of the array.
    awaitProof: async () => {
      const outcome = proofOutcomes[Math.min(state.awaits, proofOutcomes.length - 1)];
      state.awaits += 1;
      return outcome;
    },
    computeInputHash: async () => 'input-a',
    hostFingerprint: async () => 'host-a',
    reportArtifact: artifactRecorder.fn,
    reportFinding: findingRecorder.fn,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
  // The two harness-only knobs are stripped rather than destructured-and-ignored:
  // an unused binding is a lint warning, and the intent ("everything except
  // these two is a deps override") reads the same either way.
  const depsOver = { ...over };
  delete depsOver.draftResults;
  delete depsOver.proofs;
  const deps: RunbookBootstrapDeps = { ...base, ...depsOver };
  return {
    deps,
    db,
    stamps,
    suppression,
    written,
    commits,
    proofs,
    artifacts: artifactRecorder.calls,
    findings: findingRecorder.calls,
    get drafts() {
      return state.drafts;
    },
  };
}

describe('runRunbookBootstrap — the happy path', () => {
  it('drafts, commits, registers, proves, and reports the pin', async () => {
    const h = harness();
    const outcome = await runRunbookBootstrap(ARGS, h.deps);
    expect(outcome).toEqual({
      kind: 'proven',
      runbookHash: 'hash-1',
      runbookVersion: 3,
      commitSha: 'sha-1',
      rung1: null,
    });
    h.db.close();
  });

  it('writes the runbook and commits it BY PATHSPEC — one path, not a bare commit', async () => {
    const h = harness();
    await runRunbookBootstrap(ARGS, h.deps);
    // Compared by VALUE, not against the literal above: the controller writes
    // the output of `parseVerifyRunbookV1`, i.e. the runbook as the strict parser
    // reconstructs it — which is the point, since that is exactly what the store
    // will parse back when it registers and pins the revision.
    expect(h.written).toHaveLength(1);
    expect(h.written[0].path).toBe('.cyboflow/verify-runbook.json');
    expect(JSON.parse(h.written[0].content)).toEqual(RUNBOOK);
    expect(h.written[0].content.endsWith('\n')).toBe(true);
    expect(h.commits).toHaveLength(1);
    expect(h.commits[0].paths).toEqual(['.cyboflow/verify-runbook.json']);
    h.db.close();
  });

  it('stamps the record as lane-derived, so a human can tell it from a reviewed one', async () => {
    // Migration 105 provenance. Both origins are proven by the same
    // engine-enforced run; they did not earn the same amount of trust, and
    // collapsing them erases the only durable record of which happened.
    const h = harness();
    await runRunbookBootstrap(ARGS, h.deps);
    expect(h.deps.setOrigin).toHaveBeenCalledWith(1, 'web', 'lane-bootstrap');
    h.db.close();
  });

  it('leaves the stamp PROVEN with the pin, so a sibling lane takes the ordinary path', async () => {
    const h = harness();
    await runRunbookBootstrap(ARGS, h.deps);
    expect(h.stamps.read('run-1', 1, 'web')).toMatchObject({
      state: 'proven',
      runbookHash: 'hash-1',
      runbookVersion: 3,
      commitSha: 'sha-1',
    });
    h.db.close();
  });

  it('clears a stale suppression the success has just falsified', async () => {
    const h = harness();
    h.suppression.suppress({
      projectId: 1,
      modality: 'web',
      inputHash: 'input-a',
      hostFingerprint: 'host-a',
      reason: 'old',
    });
    // Suppression is checked BEFORE the claim, so seed it as non-matching and
    // let the success clear whatever is there.
    h.suppression.suppress({
      projectId: 1,
      modality: 'web',
      inputHash: 'other',
      hostFingerprint: 'other',
      reason: 'old',
    });
    await runRunbookBootstrap(ARGS, h.deps);
    expect(h.suppression.read(1, 'web')).toBeNull();
    h.db.close();
  });
});

describe('runRunbookBootstrap — the refusals', () => {
  it('declines MOBILE — declarable, but not something a lane authors', async () => {
    // The portable contract CAN express `mobile` now (the `app` block), so this
    // is no longer an "undeclarable modality". What stops it is that the
    // derivation is npm-shaped and could never discover an Xcode scheme or a
    // bundle id, so a lane that derived one would register a verification
    // runbook no execution path could satisfy. Zero drafts, and the claim below
    // step (0) is never taken, so no stamp either.
    const h = harness();
    const outcome = await runRunbookBootstrap({ ...ARGS, modality: 'mobile' }, h.deps);
    expect(outcome).toMatchObject({ kind: 'declined', reason: 'auto-derive-unsupported' });
    if (outcome.kind !== 'declined') throw new Error('unreachable');
    expect(outcome.detail).toContain('verify-setup flow');
    // The `isNoModalityDeclineReason` text match keys on this literal, so a
    // reword that drops it stops collapsing per-lane findings into one card.
    expect(outcome.detail).toContain('verification runbook');
    expect(h.drafts).toBe(0);
    expect(h.stamps.read('run-1', 1, 'mobile')).toBeNull();
    h.db.close();
  });

  it('still declines a string that is no runbook modality at all, separately', async () => {
    // The two guards were one `if` before the mobile widening. Keeping the
    // narrower case pinned is what stops a future simplification from folding
    // an unknown value back into the mobile arm and telling a human to run
    // verification setup for a typo.
    const h = harness();
    const outcome = await runRunbookBootstrap(
      { ...ARGS, modality: 'holograph' as VerificationModality },
      h.deps,
    );
    expect(outcome).toMatchObject({ kind: 'declined', reason: 'undeclarable-modality' });
    expect(h.drafts).toBe(0);
    h.db.close();
  });

  it('declines a suppressed project WITHOUT taking the claim or spending a draft', async () => {
    const h = harness();
    h.suppression.suppress({
      projectId: 1,
      modality: 'web',
      inputHash: 'input-a',
      hostFingerprint: 'host-a',
      reason: 'no script serves the renderer',
    });
    const outcome = await runRunbookBootstrap(ARGS, h.deps);
    expect(outcome).toMatchObject({ kind: 'declined', reason: 'suppressed' });
    if (outcome.kind !== 'declined') throw new Error('unreachable');
    expect(outcome.detail).toContain('no script serves the renderer');
    expect(h.drafts).toBe(0);
    expect(h.stamps.read('run-1', 1, 'web')).toBeNull();
    h.db.close();
  });

  it('declines when a DIFFERENT lane holds the single-flight', async () => {
    // Five lanes reach visual-verify at unpredictable moments; exactly one may
    // derive, because registerDraft UPSERTs a singleton row.
    const h = harness();
    h.stamps.claim({ runId: 'run-1', projectId: 1, modality: 'web', ownerTaskRef: 'TASK-2' });
    const outcome = await runRunbookBootstrap(ARGS, h.deps);
    expect(outcome).toMatchObject({ kind: 'declined', reason: 'in-flight' });
    if (outcome.kind !== 'declined') throw new Error('unreachable');
    expect(outcome.detail).toContain('TASK-2');
    expect(h.drafts).toBe(0);
    h.db.close();
  });

  it('reports PROVEN (not a decline) to a lane arriving after the bootstrap finished', async () => {
    // The sibling-lane case: the stamp already settled proven, so this lane must
    // take the ordinary path rather than re-deriving anything.
    const h = harness();
    h.stamps.claim({ runId: 'run-1', projectId: 1, modality: 'web', ownerTaskRef: 'TASK-2' });
    h.stamps.advance({
      runId: 'run-1',
      projectId: 1,
      modality: 'web',
      ownerTaskRef: 'TASK-2',
      state: 'proven',
      runbookHash: 'hash-x',
      runbookVersion: 9,
    });
    const outcome = await runRunbookBootstrap(ARGS, h.deps);
    expect(outcome).toMatchObject({ kind: 'proven', runbookHash: 'hash-x', runbookVersion: 9 });
    expect(h.drafts).toBe(0);
    h.db.close();
  });

  it('declines when this run already failed — the run has decided', async () => {
    const h = harness();
    h.stamps.claim({ runId: 'run-1', projectId: 1, modality: 'web', ownerTaskRef: 'TASK-2' });
    h.stamps.advance({
      runId: 'run-1',
      projectId: 1,
      modality: 'web',
      ownerTaskRef: 'TASK-2',
      state: 'failed',
      detail: 'the project cannot be served',
    });
    const outcome = await runRunbookBootstrap(ARGS, h.deps);
    expect(outcome).toMatchObject({ kind: 'declined', reason: 'already-settled' });
    expect(h.drafts).toBe(0);
    h.db.close();
  });
});

describe('runRunbookBootstrap — NOT-POSSIBLE vs a rejected draft', () => {
  it('NOT-POSSIBLE writes the §10 suppression, so the next sprint does not pay again', async () => {
    const h = harness({
      draftResults: [{ decision: 'not-possible', reason: 'no script serves the renderer' }],
    });
    const outcome = await runRunbookBootstrap(ARGS, h.deps);
    expect(outcome).toMatchObject({ kind: 'declined', reason: 'not-possible' });
    expect(h.suppression.read(1, 'web')).toMatchObject({
      inputHash: 'input-a',
      hostFingerprint: 'host-a',
      reason: 'no script serves the renderer',
    });
    expect(h.written).toEqual([]);
    expect(h.commits).toEqual([]);
    h.db.close();
  });

  it('an UNDECLARED command does NOT suppress — that is about the draft, not the project', async () => {
    // Suppressing here would let one bad draft silence a project whose next
    // draft would have been fine. The run-scoped stamp already stops the retry
    // loop within this run.
    const h = harness({
      draftResults: [
        {
          decision: 'runbook',
          modality: 'web',
          runbook: {
            ...RUNBOOK,
            modalities: { web: { ...RUNBOOK.modalities.web, serve: { cmd: 'vite --port 5173' } } },
          },
        },
      ],
    });
    const outcome = await runRunbookBootstrap(ARGS, h.deps);
    expect(outcome).toMatchObject({ kind: 'declined', reason: 'rejected' });
    if (outcome.kind !== 'declined') throw new Error('unreachable');
    expect(outcome.detail).toContain('vite --port 5173');
    expect(h.suppression.read(1, 'web')).toBeNull();
    expect(h.written).toEqual([]);
    h.db.close();
  });

  it('a malformed draft is refused without writing anything', async () => {
    const h = harness({ draftResults: [{ decision: 'runbook', modality: 'web', runbook: { version: 2 } }] });
    const outcome = await runRunbookBootstrap(ARGS, h.deps);
    expect(outcome).toMatchObject({ kind: 'declined', reason: 'rejected' });
    expect(h.written).toEqual([]);
    expect(h.commits).toEqual([]);
    h.db.close();
  });

  it('a null draft (the agent timed out) is refused, not treated as empty', async () => {
    const h = harness({ draftResults: [null] });
    const outcome = await runRunbookBootstrap(ARGS, h.deps);
    expect(outcome).toMatchObject({ kind: 'declined', reason: 'rejected' });
    h.db.close();
  });
});

describe('runRunbookBootstrap — the rung-1 operation', () => {
  const withOperation = {
    decision: 'runbook',
    modality: 'web',
    runbook: {
      ...RUNBOOK,
      modalities: {
        web: { ...RUNBOOK.modalities.web, serve: { cmd: 'pnpm run verify:serve --port ${PORT}' } },
      },
    },
    operation: { kind: 'add-script', scriptName: 'verify:serve', command: 'vite preview' },
  };

  it('applies the edit and commits it SEPARATELY from the runbook', async () => {
    // §8.1's review surface: one self-contained, revertible commit in the branch
    // diff, not a config change buried alongside a JSON blob.
    const h = harness({ draftResults: [withOperation] });
    const outcome = await runRunbookBootstrap(ARGS, h.deps);
    expect(outcome.kind).toBe('proven');
    expect(h.commits).toHaveLength(2);
    expect(h.commits[0].paths).toEqual(['package.json']);
    expect(h.commits[1].paths).toEqual(['.cyboflow/verify-runbook.json']);
    h.db.close();
  });

  it('validates the commands against the POST-EDIT manifest', async () => {
    // An agent that proposes both "add a verify:serve script" and "serve with
    // pnpm run verify:serve" is self-consistent. Validating against the pre-edit
    // manifest would reject the one shape this feature exists to enable.
    const h = harness({ draftResults: [withOperation] });
    await expect(runRunbookBootstrap(ARGS, h.deps)).resolves.toMatchObject({ kind: 'proven' });
    const manifest = h.written.find((w) => w.path === 'package.json');
    expect(manifest).toBeDefined();
    expect(JSON.parse(manifest?.content ?? '{}').scripts['verify:serve']).toBe('vite preview');
    h.db.close();
  });

  it('records the edited PATH and its own sha on the stamp', async () => {
    // Both are consumed downstream: the path by the eval-diff excision and the
    // address-review denylist, the sha by the commit-integrity probe.
    const h = harness({ draftResults: [withOperation] });
    await runRunbookBootstrap(ARGS, h.deps);
    expect(h.stamps.read('run-1', 1, 'web')).toMatchObject({
      rung1Path: 'package.json',
      rung1CommitSha: 'sha-1',
    });
    expect(h.stamps.commitShasForRun('run-1').sort()).toEqual(['sha-1', 'sha-2']);
    h.db.close();
  });

  it('surfaces the edit on the outcome, so the caller can file a finding naming it', async () => {
    const h = harness({ draftResults: [withOperation] });
    const outcome = await runRunbookBootstrap(ARGS, h.deps);
    if (outcome.kind !== 'proven') throw new Error('unreachable');
    expect(outcome.rung1?.path).toBe('package.json');
    expect(outcome.rung1?.description).toContain('verify:serve');
    h.db.close();
  });

  it('does NOT report proven when the record did not actually flip', async () => {
    // A passing proof is not a proven record. The engine declines to promote one
    // that ran in the dirty-worktree fallback, carried no pin, or lost its CAS —
    // all of which end as `passed`. Claiming proven there hands the lane a
    // runbook its own enqueue then fails to resolve, which surfaces as a
    // mysterious skip after the bootstrap reported success.
    const h = harness({ confirmProven: async () => false });
    const outcome = await runRunbookBootstrap(ARGS, h.deps);
    expect(outcome.kind).toBe('unproven');
    if (outcome.kind !== 'unproven') throw new Error('unreachable');
    expect(outcome.detail).toContain('did not become proven');
    expect(h.stamps.read('run-1', 1, 'web')?.state).toBe('failed');
    h.db.close();
  });

  it('files the finding even when the bootstrap DIES after committing the edit', async () => {
    // The compensating control §15A accepted rung 1 on is not the narrowness of
    // the operation alone — it is the narrowness PLUS a human being told. Every
    // step after the rung-1 commit can fail, and each one used to return
    // `declined` having published nothing, leaving a machine-authored commit on
    // someone's branch that only a log line mentioned.
    const h = harness({
      draftResults: [withOperation],
      registerDraft: async () => ({ error: 'CAS conflict' }),
    });
    const outcome = await runRunbookBootstrap(ARGS, h.deps);
    expect(outcome.kind).toBe('declined');
    // The edit IS on the branch — this is exactly why it must be surfaced.
    expect(h.commits.map((c) => c.paths)).toContainEqual(['package.json']);
    const finding = h.findings.at(-1);
    expect(finding?.locations).toEqual([{ path: 'package.json' }]);
    expect(finding?.body).toContain('package.json');
    expect(h.artifacts).toHaveLength(1);
    h.db.close();
  });

  it('files the finding when a dep THROWS after the edit is committed', async () => {
    // The throw path is the one exit that never runs `refuse`, so it has to do
    // refuse's work itself — including settling the claim, which an unsettled
    // stamp would otherwise leave reading as an owner still mid-flight.
    const h = harness({
      draftResults: [withOperation],
      registerDraft: async () => {
        throw new Error('database is locked');
      },
    });
    const outcome = await runRunbookBootstrap(ARGS, h.deps);
    expect(outcome).toMatchObject({ kind: 'declined', reason: 'infrastructure' });
    expect(h.findings.at(-1)?.locations).toEqual([{ path: 'package.json' }]);
    expect(h.stamps.read('run-1', 1, 'web')?.state).toBe('failed');
    h.db.close();
  });

  it('names a resumed attempt\'s edit, which only the stamp remembers', async () => {
    // A claim resumed after a crash carries its rung-1 path on the stamp and
    // nowhere else. If this attempt also fails, that stamp is the only thing
    // standing between the human and an unexplained commit.
    const h = harness({
      draftResults: [withOperation],
      enqueueProof: async () => ({ error: 'scheduler-unavailable' }),
    });
    await runRunbookBootstrap(ARGS, h.deps);
    expect(h.findings.at(-1)?.locations).toEqual([{ path: 'package.json' }]);
    h.db.close();
  });

  it('publishes NOTHING when it declined before touching the branch', async () => {
    // The mirror of the above: a bootstrap that changed nothing owes nobody a
    // review item, and filing one would train readers to ignore them.
    const h = harness({ draftResults: [{ decision: 'not-possible', reason: 'no script serves the UI' }] });
    await runRunbookBootstrap(ARGS, h.deps);
    expect(h.findings).toHaveLength(0);
    expect(h.artifacts).toHaveLength(0);
    h.db.close();
  });

  it('refuses a denylisted target and writes NOTHING — not even the runbook', async () => {
    // The refusal has to happen before any write, because the runbook's commands
    // depend on the edit: committing one without the other leaves a runbook that
    // cannot work.
    const h = harness({
      draftResults: [
        {
          ...withOperation,
          operation: { kind: 'relax-strict-port', file: '.github/workflows/ci.yml', setting: 'strictPort' },
        },
      ],
    });
    const outcome = await runRunbookBootstrap(ARGS, h.deps);
    expect(outcome).toMatchObject({ kind: 'declined', reason: 'rejected' });
    expect(h.written).toEqual([]);
    expect(h.commits).toEqual([]);
    h.db.close();
  });

  it('refuses when the named target does not exist in this worktree', async () => {
    const h = harness({
      draftResults: [
        { ...withOperation, operation: { kind: 'relax-strict-port', file: 'vite.config.ts', setting: 'strictPort' } },
      ],
    });
    const outcome = await runRunbookBootstrap(ARGS, h.deps);
    expect(outcome).toMatchObject({ kind: 'declined', reason: 'rejected' });
    if (outcome.kind !== 'declined') throw new Error('unreachable');
    expect(outcome.detail).toContain('vite.config.ts');
    h.db.close();
  });
});

describe('runRunbookBootstrap — the proof', () => {
  it('fires an ATTESTATION-ONLY task carrying the runbook\'s own commands', async () => {
    // §7: the proof asks exactly one question — does this project stand up and
    // identify itself? The lane's own task is NOT the proof vehicle, so no
    // failure is ever attributed to the wrong thing.
    const task = composeBootstrapProofTask(RUNBOOK, 'web');
    expect(task).toMatchObject({
      version: 1,
      behaviors: [],
      modality: 'web',
      attestation: { kind: 'dom-marker', selector: '[data-verify-build]' },
      build: ['pnpm run build'],
      serve: { cmd: 'pnpm run preview --port ${PORT}' },
    });
  });

  it('carries the mobile `app` block into the proof, verbatim', async () => {
    // A simulator entry has no `serve` — `app` IS its stand-up. A composer that
    // dropped it would emit a proof task with nothing to launch, and the proof
    // would fail for a reason that has nothing to do with the runbook. A lane
    // never reaches here with a mobile entry (both step-(0) guards decline
    // first); the composer is still correct about the entry it was handed.
    const mobile: VerifyRunbookV1 = {
      version: 1,
      modalities: {
        mobile: {
          build: ['xcodebuild -scheme Demo -destination "generic/platform=iOS Simulator" build'],
          app: {
            platform: 'ios-simulator',
            bundleId: 'com.example.demo',
            scheme: 'Demo',
            productGlob: 'Build/Products/Debug-iphonesimulator/Demo.app',
          },
          attestation: { kind: 'bundle-identity', bundleId: 'com.example.demo' },
        },
      },
    };
    const task = composeBootstrapProofTask(mobile, 'mobile');
    expect(task).toMatchObject({
      modality: 'mobile',
      behaviors: [],
      attestation: { kind: 'bundle-identity', bundleId: 'com.example.demo' },
      app: {
        platform: 'ios-simulator',
        bundleId: 'com.example.demo',
        scheme: 'Demo',
        productGlob: 'Build/Products/Debug-iphonesimulator/Demo.app',
      },
    });
    // A simulator run has no port to lease and no endpoint to attach to.
    expect(task?.serve).toBeUndefined();
  });

  it('leaves `app` off a web proof rather than emitting an empty one', () => {
    expect(composeBootstrapProofTask(RUNBOOK, 'web')).not.toHaveProperty('app');
  });

  it('pins the proof to the revision it just registered', async () => {
    const h = harness();
    await runRunbookBootstrap(ARGS, h.deps);
    expect(h.proofs).toEqual([{ round: 1, runbookHash: 'hash-1', runbookLocalVersion: 3 }]);
    h.db.close();
  });

  it('a FAILED proof never returns proven — it returns an honest unproven draft', async () => {
    // The load-bearing exit. This runner learns about promotion; it never
    // performs it. A `proven` here is what makes the caller stop treating the
    // lane as unverified, so a failing proof reaching it would be the one bug
    // this whole design exists to make impossible.
    const h = harness({ proofs: [FAIL, FAIL] });
    const outcome = await runRunbookBootstrap(ARGS, h.deps);
    expect(outcome.kind).toBe('unproven');
    if (outcome.kind !== 'unproven') throw new Error('unreachable');
    expect(outcome.detail).toContain('the serve command exited immediately');
    expect(outcome.commitSha).not.toBeNull();
    h.db.close();
  });

  it('re-drafts ONCE on a failure, and hands the second round the failure verbatim', async () => {
    // A re-draft with no feedback is the same guess again, which is the only
    // thing that would make a second round worth its cost.
    const feedbacks: Array<string | null> = [];
    const h = harness({
      proofs: [FAIL, PASS],
      draft: async (request) => {
        feedbacks.push(request.feedback);
        return { decision: 'runbook', modality: 'web', runbook: RUNBOOK };
      },
    });
    const outcome = await runRunbookBootstrap(ARGS, h.deps);
    expect(outcome.kind).toBe('proven');
    expect(feedbacks).toHaveLength(2);
    expect(feedbacks[0]).toBeNull();
    expect(feedbacks[1]).toContain('the serve command exited immediately');
    h.db.close();
  });

  it('stops at the round cap rather than guessing a third time', async () => {
    const h = harness({ proofs: [FAIL, FAIL, FAIL] });
    const outcome = await runRunbookBootstrap(ARGS, h.deps);
    expect(outcome.kind).toBe('unproven');
    expect(h.proofs).toHaveLength(MAX_BOOTSTRAP_ROUNDS);
    expect(h.stamps.read('run-1', 1, 'web')?.state).toBe('failed');
    h.db.close();
  });

  it('gives each round its own enqueue round number, which is what makes the key unique', async () => {
    // Without a fresh key, findLiveRequestByEnqueueKey returns round 1's
    // terminal row and round 2 deploys NOTHING while every caller reads it as
    // enqueued — v1's defect 3, silent and total.
    const h = harness({ proofs: [FAIL, FAIL] });
    await runRunbookBootstrap(ARGS, h.deps);
    expect(h.proofs.map((p) => p.round)).toEqual([1, 2]);
    h.db.close();
  });

  it('a proof that could not be ENQUEUED is infrastructure, not a project verdict', async () => {
    const h = harness({ enqueueProof: async () => ({ error: 'scheduler-unavailable' }) });
    const outcome = await runRunbookBootstrap(ARGS, h.deps);
    expect(outcome).toMatchObject({ kind: 'declined', reason: 'infrastructure' });
    expect(h.suppression.read(1, 'web')).toBeNull();
    h.db.close();
  });
});

describe('runRunbookBootstrap — restart and resume', () => {
  it('a restarted owner mid-proof AWAITS its own request rather than firing a second', async () => {
    // The controller restarts lanes at inner step zero. Re-firing would enqueue
    // under the same round key, dedup to the first, and deploy nothing.
    const h = harness();
    h.stamps.claim({ runId: 'run-1', projectId: 1, modality: 'web', ownerTaskRef: 'TASK-7' });
    h.stamps.advance({
      runId: 'run-1',
      projectId: 1,
      modality: 'web',
      ownerTaskRef: 'TASK-7',
      state: 'proving',
      round: 1,
      requestId: 'req-earlier',
      commitSha: 'sha-earlier',
      runbookHash: 'hash-earlier',
      runbookVersion: 2,
    });

    const awaited: string[] = [];
    const deps: RunbookBootstrapDeps = {
      ...h.deps,
      awaitProof: async (requestId) => {
        awaited.push(requestId);
        return PASS;
      },
    };
    const outcome = await runRunbookBootstrap(ARGS, deps);
    expect(awaited).toEqual(['req-earlier']);
    expect(h.proofs).toEqual([]);
    expect(h.drafts).toBe(0);
    expect(outcome).toMatchObject({ kind: 'proven', runbookHash: 'hash-earlier', runbookVersion: 2 });
    h.db.close();
  });

  it('a restarted owner whose in-flight proof FAILED continues at the next round', async () => {
    const h = harness({ proofs: [FAIL, PASS] });
    h.stamps.claim({ runId: 'run-1', projectId: 1, modality: 'web', ownerTaskRef: 'TASK-7' });
    h.stamps.advance({
      runId: 'run-1',
      projectId: 1,
      modality: 'web',
      ownerTaskRef: 'TASK-7',
      state: 'proving',
      round: 1,
      requestId: 'req-earlier',
      runbookHash: 'h',
      runbookVersion: 1,
    });
    const outcome = await runRunbookBootstrap(ARGS, h.deps);
    expect(outcome.kind).toBe('proven');
    // Round 2 only — round 1 was the one already in flight.
    expect(h.proofs.map((p) => p.round)).toEqual([2]);
    h.db.close();
  });
});

describe('runRunbookBootstrap — never throws', () => {
  it('turns a throwing collaborator into a decline', async () => {
    // The one caller is enqueueTaskVerification, whose contract is that it
    // cannot crash a lane.
    const h = harness({
      commitPaths: async () => {
        throw new Error('git exploded');
      },
    });
    const outcome = await runRunbookBootstrap(ARGS, h.deps);
    expect(outcome).toMatchObject({ kind: 'declined' });
    h.db.close();
  });

  it('degrades when the stamp store itself cannot answer', async () => {
    const db = new Database(':memory:'); // no migrations at all
    const h = harness();
    const deps: RunbookBootstrapDeps = {
      ...h.deps,
      stamps: new RunbookBootstrapStampStore(db as unknown as DatabaseLike),
      suppression: new BootstrapSuppressionStore(db as unknown as DatabaseLike),
    };
    const outcome = await runRunbookBootstrap(ARGS, deps);
    expect(outcome).toMatchObject({ kind: 'declined', reason: 'unavailable' });
    db.close();
    h.db.close();
  });

  it('a registration failure is infrastructure and writes no suppression', async () => {
    const h = harness({ registerDraft: async () => ({ error: 'cas-conflict' }) });
    const outcome = await runRunbookBootstrap(ARGS, h.deps);
    expect(outcome).toMatchObject({ kind: 'declined', reason: 'infrastructure' });
    if (outcome.kind !== 'declined') throw new Error('unreachable');
    expect(outcome.detail).toContain('cas-conflict');
    expect(h.suppression.read(1, 'web')).toBeNull();
    h.db.close();
  });
});

describe('runRunbookBootstrap — the human-facing surfaces', () => {
  it('publishes the verify-runbook artifact on the PROVEN path', async () => {
    const artifact = recorder<ArtifactReport>();
    const h = harness({ reportArtifact: artifact.fn });
    await runRunbookBootstrap(ARGS, h.deps);
    expect(artifact.calls).toHaveLength(1);
    expect(artifact.calls[0].runId).toBe('run-1');
    expect(artifact.calls[0].markdown).toContain('PROVEN');
    h.db.close();
  });

  it('publishes it on the FAILED path too — the branch is carrying real state', async () => {
    // §10: a failed bootstrap leaves a committed unproven draft and a spent
    // budget. v1 claimed failure was byte-identical to today; not reporting it
    // would be the same overclaim in a different place.
    const artifact = recorder<ArtifactReport>();
    const h = harness({ proofs: [FAIL, FAIL], reportArtifact: artifact.fn });
    await runRunbookBootstrap(ARGS, h.deps);
    expect(artifact.calls).toHaveLength(1);
    expect(artifact.calls[0].markdown).toContain('NOT PROVEN');
    h.db.close();
  });

  it('files the §8.1 finding NAMING the auto-edited file', async () => {
    // The review-backed half of §15A's trade. Without this the rung-1
    // concession is unearned: a config change a machine made, that nobody was
    // ever asked to look at.
    const finding = recorder<FindingReport>();
    const h = harness({
      reportFinding: finding.fn,
      draftResults: [
        {
          decision: 'runbook',
          modality: 'web',
          runbook: {
            ...RUNBOOK,
            modalities: {
              web: { ...RUNBOOK.modalities.web, serve: { cmd: 'pnpm run verify:serve --port ${PORT}' } },
            },
          },
          operation: { kind: 'add-script', scriptName: 'verify:serve', command: 'vite preview' },
        },
      ],
    });
    await runRunbookBootstrap(ARGS, h.deps);
    expect(finding.calls).toHaveLength(1);
    expect(finding.calls[0].title).toContain('package.json');
    expect(finding.calls[0].locations).toEqual([{ path: 'package.json' }]);
    h.db.close();
  });

  it('files NO finding when no config change was made', async () => {
    const finding = recorder<FindingReport>();
    const h = harness({ reportFinding: finding.fn });
    await runRunbookBootstrap(ARGS, h.deps);
    expect(finding.calls).toEqual([]);
    h.db.close();
  });

  it('a THROWING reporter does not turn a proven runbook into an unproven one', async () => {
    // Best-effort by contract. Losing a tab is not a reason to discard a proof
    // the engine already recorded.
    const h = harness({
      reportArtifact: async () => {
        throw new Error('artifact router is down');
      },
    });
    await expect(runRunbookBootstrap(ARGS, h.deps)).resolves.toMatchObject({ kind: 'proven' });
    h.db.close();
  });

  it('publishes when a LATER round refuses after an earlier one already committed', async () => {
    // The live sequence from the 2026-08-19 smoke, and the one the FAILED-path
    // test above does NOT reach: round 1 derives and COMMITS a runbook, its
    // proof fails, and round 2 answers `not-possible`. That exits through
    // `refuse` → `publishAbandoned` rather than the round-cap path, and keying
    // the publish on `rung1` alone dropped it — leaving a machine-authored
    // commit on a human's branch mentioned only in a log line. Rung 0 commits
    // one file too; §8.1 merely gives the rung-1 edit a SECOND commit.
    const artifact = recorder<ArtifactReport>();
    const h = harness({
      proofs: [FAIL],
      reportArtifact: artifact.fn,
      draftResults: [
        { decision: 'runbook', modality: 'web', runbook: RUNBOOK },
        { decision: 'not-possible', reason: 'the port literal lives under scripts/, denied for every operation' },
      ],
    });
    await runRunbookBootstrap(ARGS, h.deps);
    expect(artifact.calls).toHaveLength(1);
    expect(artifact.calls[0].markdown).toContain('NOT PROVEN');
    // It must name the commit it left behind — that is the whole point of
    // publishing, and an artifact that omitted it would be worse than none.
    expect(artifact.calls[0].markdown).toContain(VERIFY_RUNBOOK_RELATIVE_PATH);
    expect(artifact.calls[0].markdown).toContain('unproven draft');
    h.db.close();
  });

  it('reports nothing for a decline that wrote nothing', async () => {
    // A refused draft left no state to review, and an artifact tab about a
    // non-event is noise in a pane a human opens to find real ones.
    const artifact = recorder<ArtifactReport>();
    const h = harness({
      reportArtifact: artifact.fn,
      draftResults: [{ decision: 'not-possible', reason: 'no dev server' }],
    });
    await runRunbookBootstrap(ARGS, h.deps);
    expect(artifact.calls).toEqual([]);
    h.db.close();
  });
});

/**
 * F4 stage 2 / Codex #2 — the RE-PROVE mode.
 *
 * The situation: a record was proven and then DRIFTED (its inputs, this host, or
 * its own content moved). Since F4 stage 1 that drift is computed on every read
 * and never persisted, so the record answers `'drifted'` forever. Two responses
 * are wrong and both were shipped at some point:
 *
 *  - DERIVE over it (pre-F4, via the write-through demotion that made the next
 *    read say 'draft'): a machine-authored runbook replaces a human's, over a
 *    defect that was never in the runbook.
 *  - DECLINE it (stage 1 alone): the project can never verify again on this
 *    host, because nothing ever re-answers the question.
 *
 * So the tests here are almost entirely about what this mode does NOT do. The
 * absence assertions are the feature.
 */
describe('runRunbookBootstrap — the RE-PROVE mode', () => {
  it('proves the record AS IT STANDS: no draft, no write, no commit, no registration', async () => {
    // Every one of these would change a human's branch or a human's record to
    // fix a proof that expired for environmental reasons. The pin is the
    // record's own (hash, version) — NOT registerDraft's, which is why the
    // harness gives the two different values.
    const registerDraft = vi.fn(async () => ({ hash: 'hash-1', version: 3 }));
    const h = harness({ registerDraft });
    const outcome = await runRunbookBootstrap(REPROVE_ARGS, h.deps);

    expect(outcome).toEqual({
      kind: 'proven',
      runbookHash: 'record-hash',
      runbookVersion: 7,
      commitSha: null,
      rung1: null,
    });
    expect(h.proofs).toEqual([{ round: 1, runbookHash: 'record-hash', runbookLocalVersion: 7 }]);
    expect(h.drafts).toBe(0);
    expect(h.written).toEqual([]);
    expect(h.commits).toEqual([]);
    expect(registerDraft).not.toHaveBeenCalled();
    expect(h.deps.setOrigin).not.toHaveBeenCalled();
    h.db.close();
  });

  it('composes the proof from the RECORD, through the same composer the derive path uses', async () => {
    // The composed task is what the executable fingerprint is derived from, so a
    // reprove-specific composer that shaped the same runbook even slightly
    // differently would produce a task the pinned record does not match — the
    // runner would then reject a proof of its own making.
    const tasks: unknown[] = [];
    const h = harness({
      enqueueProof: async ({ task, round }) => {
        tasks.push(task);
        return { requestId: `req-${round}` };
      },
    });
    await runRunbookBootstrap(REPROVE_ARGS, h.deps);
    expect(tasks).toEqual([composeBootstrapProofTask(RUNBOOK, 'web')]);
    h.db.close();
  });

  it('a FAILED re-prove is unproven, carries the harness reason, and NEVER suppresses', async () => {
    // A suppression asserts "a runbook cannot be derived for this project state
    // on this host". A stale proof failing says the ENVIRONMENT moved; it says
    // nothing structural about the project, and recording it as though it did
    // would silence a project whose runbook is fine.
    const h = harness({ proofs: [FAIL] });
    const outcome = await runRunbookBootstrap(REPROVE_ARGS, h.deps);
    expect(outcome.kind).toBe('unproven');
    if (outcome.kind !== 'unproven') throw new Error('unreachable');
    expect(outcome.detail).toContain('the serve command exited immediately');
    expect(outcome.detail).toContain('deliverable');
    expect(outcome.commitSha).toBeNull();
    expect(outcome.rung1).toBeNull();
    expect(h.suppression.read(1, 'web')).toBeNull();
    h.db.close();
  });

  it('runs exactly ONE round — a re-run of an identical proof buys nothing', async () => {
    // Derive's second round earns its cost by re-drafting with the failure in
    // hand. There is no re-draft here, so a second round would ask the same
    // question of the same record at the same price.
    const h = harness({ proofs: [FAIL, PASS] });
    const outcome = await runRunbookBootstrap(REPROVE_ARGS, h.deps);
    expect(outcome.kind).toBe('unproven');
    expect(h.proofs).toHaveLength(1);
    expect(h.stamps.read('run-1', 1, 'web')?.state).toBe('failed');
    h.db.close();
  });

  it('an EXISTING suppression does not veto a re-prove — and a PASSING one does not clear it', async () => {
    // §10's suppression is a statement about DERIVING. A record that drifted was
    // proven once, so the project demonstrably stands up; letting a failed
    // derivation block re-proving it would answer a question nobody asked.
    //
    // The second half is the F4 fix round: the shared `consumeProof` used to
    // clear the suppression on ANY pass, which is a write — and this mode's
    // whole contract is that it writes nothing. A derive that proves has
    // falsified "a runbook cannot be derived here" and must clear it; a reprove
    // has derived nothing, so it has falsified nothing.
    const h = harness();
    h.suppression.suppress({
      projectId: 1,
      modality: 'web',
      inputHash: 'input-a',
      hostFingerprint: 'host-a',
      reason: 'no script serves the renderer',
    });
    await expect(runRunbookBootstrap(REPROVE_ARGS, h.deps)).resolves.toMatchObject({ kind: 'proven' });
    expect(h.suppression.read(1, 'web')?.reason).toBe('no script serves the renderer');
    h.db.close();
  });

  it('takes the SAME single-flight as derive, so two lanes cannot double-prove', async () => {
    const h = harness();
    h.stamps.claim({ runId: 'run-1', projectId: 1, modality: 'web', ownerTaskRef: 'TASK-2' });
    const outcome = await runRunbookBootstrap(REPROVE_ARGS, h.deps);
    expect(outcome).toMatchObject({ kind: 'declined', reason: 'in-flight' });
    expect(h.proofs).toEqual([]);
    h.db.close();
  });

  it('leaves the stamp PROVEN with the RECORD pin, so a sibling lane resolves it', async () => {
    const h = harness();
    await runRunbookBootstrap(REPROVE_ARGS, h.deps);
    expect(h.stamps.read('run-1', 1, 'web')).toMatchObject({
      state: 'proven',
      runbookHash: 'record-hash',
      runbookVersion: 7,
    });
    h.db.close();
  });

  it('a restarted owner mid-proof AWAITS its own request rather than firing a second', async () => {
    const h = harness();
    h.stamps.claim({ runId: 'run-1', projectId: 1, modality: 'web', ownerTaskRef: 'TASK-7' });
    h.stamps.advance({
      runId: 'run-1',
      projectId: 1,
      modality: 'web',
      ownerTaskRef: 'TASK-7',
      state: 'proving',
      round: 1,
      requestId: 'req-earlier',
      runbookHash: 'record-hash',
      runbookVersion: 7,
    });
    const awaited: string[] = [];
    const deps: RunbookBootstrapDeps = {
      ...h.deps,
      awaitProof: async (requestId) => {
        awaited.push(requestId);
        return PASS;
      },
    };
    const outcome = await runRunbookBootstrap(REPROVE_ARGS, deps);
    expect(awaited).toEqual(['req-earlier']);
    expect(h.proofs).toEqual([]);
    expect(outcome).toMatchObject({ kind: 'proven', runbookHash: 'record-hash', runbookVersion: 7 });
    h.db.close();
  });

  it('a record that cannot be read is infrastructure, and enqueues nothing', async () => {
    const h = harness({ currentRecord: () => null });
    const outcome = await runRunbookBootstrap(REPROVE_ARGS, h.deps);
    expect(outcome).toMatchObject({ kind: 'declined', reason: 'infrastructure' });
    expect(h.proofs).toEqual([]);
    expect(h.suppression.read(1, 'web')).toBeNull();
    h.db.close();
  });

  it('a record that declares no entry for THIS modality is refused, not improvised around', async () => {
    const h = harness({
      currentRecord: () => ({
        hash: 'record-hash',
        version: 7,
        runbook: { version: 1, modalities: {} },
        status: 'proven' as const,
      }),
    });
    const outcome = await runRunbookBootstrap(REPROVE_ARGS, h.deps);
    expect(outcome).toMatchObject({ kind: 'declined', reason: 'rejected' });
    expect(h.proofs).toEqual([]);
    h.db.close();
  });

  it('declines MOBILE without touching the stamp — that flow proves its own runbooks', async () => {
    // The derive twin, on the reprove arm. A lane re-proving a mobile runbook
    // would spend a deployment and a budget charge on a record the verify-setup
    // flow owns and proves itself.
    const h = harness();
    const outcome = await runRunbookBootstrap({ ...REPROVE_ARGS, modality: 'mobile' }, h.deps);
    expect(outcome).toMatchObject({ kind: 'declined', reason: 'auto-derive-unsupported' });
    if (outcome.kind !== 'declined') throw new Error('unreachable');
    expect(outcome.detail).toContain('verification runbook');
    expect(h.proofs).toEqual([]);
    expect(h.stamps.read('run-1', 1, 'mobile')).toBeNull();
    h.db.close();
  });

  it('still declines an unexpressible modality separately, without touching the stamp', async () => {
    const h = harness();
    const outcome = await runRunbookBootstrap(
      { ...REPROVE_ARGS, modality: 'holograph' as VerificationModality },
      h.deps,
    );
    expect(outcome).toMatchObject({ kind: 'declined', reason: 'undeclarable-modality' });
    expect(h.proofs).toEqual([]);
    h.db.close();
  });

  it('does NOT report proven when the record did not actually flip', async () => {
    // Same guard as derive: the engine declines to promote a proof that ran in
    // the dirty-worktree fallback or lost its CAS, and all of those end `passed`.
    const h = harness({ confirmProven: async () => false });
    const outcome = await runRunbookBootstrap(REPROVE_ARGS, h.deps);
    expect(outcome.kind).toBe('unproven');
    h.db.close();
  });

  it('tells a human an EXISTING runbook was re-proved — no commit, nothing to review', async () => {
    // The derive artifact says "Lane X derived one, committed it" and lists what
    // is on the branch. All of that is false here, and pointing a reviewer at a
    // commit that does not exist is worse than saying nothing.
    const artifact = recorder<ArtifactReport>();
    const h = harness({ reportArtifact: artifact.fn });
    await runRunbookBootstrap(REPROVE_ARGS, h.deps);
    expect(artifact.calls).toHaveLength(1);
    const markdown = artifact.calls[0].markdown;
    expect(markdown).toContain('re-proved by this run');
    expect(markdown).toContain('RE-PROVEN');
    expect(markdown).toContain('exactly as it already stands');
    expect(markdown).not.toContain('derived by this run');
    expect(markdown).not.toContain('Commit');
    h.db.close();
  });

  it('reports the FAILED re-prove too, saying the branch was left alone', async () => {
    const artifact = recorder<ArtifactReport>();
    const h = harness({ proofs: [FAIL], reportArtifact: artifact.fn });
    await runRunbookBootstrap(REPROVE_ARGS, h.deps);
    expect(artifact.calls).toHaveLength(1);
    expect(artifact.calls[0].markdown).toContain('STILL NOT PROVEN');
    expect(artifact.calls[0].markdown).toContain('Nothing was changed on this branch');
    expect(artifact.calls[0].markdown).toContain('the serve command exited immediately');
    h.db.close();
  });

  it('files NO rung-1 finding — a re-prove cannot produce a config edit', async () => {
    const finding = recorder<FindingReport>();
    const h = harness({ reportFinding: finding.fn, proofs: [FAIL] });
    await runRunbookBootstrap(REPROVE_ARGS, h.deps);
    expect(finding.calls).toEqual([]);
    h.db.close();
  });

  it('a THROWING reporter does not turn a re-proven runbook into an unproven one', async () => {
    const h = harness({
      reportArtifact: async () => {
        throw new Error('artifact router is down');
      },
    });
    await expect(runRunbookBootstrap(REPROVE_ARGS, h.deps)).resolves.toMatchObject({ kind: 'proven' });
    h.db.close();
  });
});
