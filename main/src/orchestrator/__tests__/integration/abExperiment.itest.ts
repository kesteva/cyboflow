/**
 * Tier-3 mocked-SDK integration — workflow A/B testing end-to-end
 * (variant registry + rotation, side-by-side experiments + entity sandbox,
 * pairwise judge, decide/rerun guards). Migrations 048 / 049 / 050.
 *
 * Like the other *.itest.ts, this boots the REAL orchestrator stack over a
 * migration-replay temp-file DB (the full current schema, replayed through 050)
 * and fakes ONLY the process/filesystem boundary the Tier-3 harness cannot do
 * for real. Concretely REAL here:
 *   - the migration chain + every table CHECK/UNIQUE/index (real DatabaseService);
 *   - WorkflowRegistry.createVariantFromCurrent / setVariantStatus / createRun
 *     (real variant + experiment stamping, real spec_hash + workflow_revisions);
 *   - VariantResolver weighted rotation (real, injected deterministic rng);
 *   - the experiments orchestration core (startExperiment / decideExperiment via
 *     setExperimentsDeps) driven over a REAL TaskChangeRouter (real sandbox guard,
 *     real clone/reveal/fold/sweep) + REAL experimentStore (insert/reconcile/get);
 *   - ReviewItemRouter (the real review_items chokepoint) for the decision item;
 *   - PairwiseJudgeWorker (real snapshot → sample → aggregate → mint → resolve),
 *     with a FAKE PairwiseJudgeClient and a FAKE gitDiff (the diff boundary);
 *   - the runs.restart / experiments.rerun guards through the REAL appRouter caller.
 *
 * FAKED (the sanctioned unit-test level, matching experiments.router.test.ts +
 * pairwiseJudgeWorker.test.ts — no full SDK spawn / real git worktrees):
 *   - RunLauncher.launch → resolves the pinned variant + calls the REAL
 *     WorkflowRegistry.createRun (so arm runs get real variant/experiment stamps),
 *     then stamps a worktree_path; it does NOT spawn a `claude`;
 *   - createArmSession → inserts a real `sessions` row (satisfies the FK) and
 *     returns a synthetic worktree path;
 *   - worktreeManager base-sha/branch resolution + PairwiseJudgeWorker.gitDiff →
 *     canned values (the fake judge decides the winner, not the diff content).
 * Wiring real arm worktrees + real git diffs would require the full spawn path,
 * which the single-run headlessRun harness does not expose for the experiment
 * launcher — reported as a harness limitation, not a coverage gap in the feature.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TRPCError } from '@trpc/server';
import { DatabaseService } from '../../../database/database';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import { makeSpyLogger } from '../../__test_fixtures__/loggerLikeSpy';
import { WorkflowRegistry } from '../../workflowRegistry';
import { VariantResolver } from '../../variantResolver';
import { computeSpecHash } from '../../specHash';
import { resolveRunFrozenSpec } from '../../runFrozenSpec';
import { TaskChangeRouter } from '../../taskChangeRouter';
import { ReviewItemRouter } from '../../reviewItemRouter';
import {
  getExperiment,
  insertExperiment,
  listExperimentSeedTasks,
  reconcileExperimentStatus,
} from '../../experimentStore';
import {
  startExperiment,
  decideExperiment,
  setExperimentsDeps,
  type ExperimentsDeps,
} from '../../trpc/routers/experiments';
import { PairwiseJudgeWorker } from '../../eval/pairwiseJudgeWorker';
import type { PairwiseJudgeWorkerDeps } from '../../eval/pairwiseJudgeWorker';
import type {
  PairwiseJudgeClient,
  PairwiseGradeInput,
  PairwiseRawResult,
} from '../../eval/pairwiseJudge';
import { selectProjectBacklog } from '../../taskListing';
import { appRouter } from '../../trpc/router';
import { createContext } from '../../trpc/context';
import { setStartRunDeps, type StartRunDeps } from '../../trpc/routers/runs';
import type { DatabaseLike } from '../../types';
import type { RunGitDiff } from '../../../../../shared/types/runFiles';

// ---------------------------------------------------------------------------
// Migration-replay temp DB (full current app schema through 050).
// ---------------------------------------------------------------------------

const WF_ID = 'wf-planner';
const SPRINT_WF_ID = 'wf-sprint';
const PROJECT_ID = 1;

interface TestDb {
  service: DatabaseService;
  raw: ReturnType<DatabaseService['getDb']>;
  db: DatabaseLike;
  dir: string;
}

function buildMigrationDb(): TestDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-ab-db-'));
  const service = new DatabaseService(path.join(dir, 'ab.db'));
  service.initialize();
  const raw = service.getDb();
  raw.prepare('INSERT OR IGNORE INTO projects (id, name, path) VALUES (?, ?, ?)').run(
    PROJECT_ID,
    'ab-proj',
    '/tmp/ab-proj',
  );
  // Boards/stages are provisioned at project-creation time (not by migrations), so
  // seed the default board the entity chokepoint resolves against.
  service.seedDefaultBoard(PROJECT_ID);
  // A resolvable built-in workflow so createVariantFromCurrent freezes a concrete graph.
  raw
    .prepare("INSERT INTO workflows (id, project_id, name, spec_json) VALUES (?, ?, 'planner', '{}')")
    .run(WF_ID, PROJECT_ID);
  // The task-driven sprint workflow (migration 051 seed-task experiments).
  raw
    .prepare("INSERT INTO workflows (id, project_id, name, spec_json) VALUES (?, ?, 'sprint', '{}')")
    .run(SPRINT_WF_ID, PROJECT_ID);
  return { service, raw, db: dbAdapter(raw), dir };
}

function teardownDb(t: TestDb): void {
  t.raw.close();
  fs.rmSync(t.dir, { recursive: true, force: true });
}

function hasTable(t: TestDb, name: string): boolean {
  return (
    t.raw.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name) !==
    undefined
  );
}

function columns(t: TestDb, table: string): Set<string> {
  const info = t.raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(info.map((c) => c.name));
}

function runField(t: TestDb, runId: string, col: string): unknown {
  return (t.raw.prepare(`SELECT ${col} AS v FROM workflow_runs WHERE id = ?`).get(runId) as
    | { v: unknown }
    | undefined)?.v;
}

function entityField(t: TestDb, table: string, id: string, col: string): unknown {
  return (t.raw.prepare(`SELECT ${col} AS v FROM ${table} WHERE id = ?`).get(id) as
    | { v: unknown }
    | undefined)?.v;
}

function entityExists(t: TestDb, table: string, id: string): boolean {
  return t.raw.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) !== undefined;
}

// ---------------------------------------------------------------------------
// Fakes at the process/filesystem boundary (the ONLY faked seam).
// ---------------------------------------------------------------------------

const diffFor = (file: string, text: string): RunGitDiff => ({
  diff: text,
  stats: { additions: 1, deletions: 0, filesChanged: 1 },
  changedFiles: [file],
});

class FakeJudge implements PairwiseJudgeClient {
  readonly name = 'fake';
  readonly resolvedModel = 'fake-model';
  constructor(private readonly impl: (input: PairwiseGradeInput) => Promise<PairwiseRawResult>) {}
  grade(input: PairwiseGradeInput): Promise<PairwiseRawResult> {
    return this.impl(input);
  }
}

interface ExpHarness {
  deps: ExperimentsDeps;
  dismissed: string[];
  canceled: string[];
  /** Per-arm seedTaskIds the fake launcher received (migration 051 task-seeded arms). */
  launchedSeedTaskIds: { A?: string[]; B?: string[] };
  /** review-item resolutions kicked off by the fail-soft resolveReviewItem seam. */
  resolvePromises: Promise<unknown>[];
}

/**
 * Build the experiments deps bag over the REAL TaskChangeRouter + registry +
 * review-item chokepoint. The launcher/session/worktree/gitDiff seams are faked
 * (see file header) but every entity/experiment/review write is real.
 */
function makeExpHarness(t: TestDb, registry: WorkflowRegistry, tcr: TaskChangeRouter): ExpHarness {
  const dismissed: string[] = [];
  const canceled: string[] = [];
  const launchedSeedTaskIds: { A?: string[]; B?: string[] } = {};
  const resolvePromises: Promise<unknown>[] = [];

  const deps: ExperimentsDeps = {
    db: t.db,
    // Faked launch: resolve the pinned variant, drive the REAL createRun (arm runs
    // get real variant_id/experiment_id/experiment_arm/spec_hash), then stamp a
    // synthetic worktree_path. No SDK spawn (so the sprint lane machinery is not
    // exercised — see file header; the clone eligibility is still asserted directly).
    runLauncher: {
      launch: async (
        workflowId,
        _pp,
        _sub,
        _tid,
        _ideaId,
        sessionId,
        _pm,
        _bb,
        seedTaskIds,
        _pid,
        _em,
        _fids,
        _model,
        _ev,
        opts,
      ) => {
        const variant = opts?.requestedVariantId
          ? registry.getVariantById(opts.requestedVariantId)
          : null;
        const experiment = opts?.experiment;
        const { runId } = registry.createRun(workflowId, undefined, sessionId ?? 'sess-x', undefined, {
          projectId: PROJECT_ID,
          ...(variant
            ? { variantId: variant.id, variantLabel: variant.label, variantSpecJson: variant.spec_json }
            : {}),
          ...(experiment ? { experimentId: experiment.experimentId, experimentArm: experiment.arm } : {}),
        });
        const arm = experiment?.arm ?? 'X';
        if (arm === 'A' || arm === 'B') launchedSeedTaskIds[arm] = seedTaskIds;
        const worktreePath = `/wt/arm-${arm}`;
        t.raw.prepare('UPDATE workflow_runs SET worktree_path = ? WHERE id = ?').run(worktreePath, runId);
        return { runId, worktreePath, branchName: `b/${runId}`, permissionMode: 'default' as const };
      },
    },
    worktreeManager: {
      getProjectMainBranch: async () => 'main',
      getHeadCommit: async () => 'basesha-abcdef0',
    },
    createArmSession: async ({ projectId, nameHint }) => {
      const sessionId = `sess-${randomUUID()}`;
      const worktreePath = `/wt/${nameHint}`;
      t.raw
        .prepare(
          `INSERT INTO sessions (id, name, initial_prompt, worktree_name, worktree_path, project_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(sessionId, `${nameHint} session`, 'arm run', nameHint, worktreePath, projectId);
      return { sessionId, worktreePath };
    },
    taskChangeRouter: tcr,
    dismissSession: async (sid) => {
      dismissed.push(sid);
    },
    cancelRun: async (rid) => {
      canceled.push(rid);
    },
    getVariant: (id) => registry.getVariantById(id),
    getWorkflow: (id) => {
      const row = registry.getById(id);
      return row ? { id: row.id, name: row.name } : null;
    },
    getProjectPath: () => '/tmp/ab-proj',
    setVariantStatus: (id, status) => registry.setVariantStatus(id, status),
    setVariantWeight: (id, weight) => registry.updateVariant(id, { weight }),
    // Fail-soft resolve of the pairwise decision item at decide-time — kicked off
    // async (the seam is sync `=> void`); collected so the test can await it.
    resolveReviewItem: (reviewItemId) => {
      resolvePromises.push(
        ReviewItemRouter.getInstance().applyReviewItem(PROJECT_ID, {
          op: 'resolve',
          actor: 'user',
          reviewItemId,
        }),
      );
    },
  };
  return { deps, dismissed, canceled, launchedSeedTaskIds, resolvePromises };
}

function makePairwiseWorker(
  t: TestDb,
  judge: PairwiseJudgeClient,
  over: Partial<PairwiseJudgeWorkerDeps> = {},
): PairwiseJudgeWorker {
  PairwiseJudgeWorker._resetForTesting();
  return PairwiseJudgeWorker.initialize(t.db, undefined, {
    // Canned per-arm diffs keyed off the stamped worktree path.
    gitDiff: async (worktreePath: string) =>
      worktreePath.includes('-A') ? diffFor('a.ts', 'DIFF-A') : diffFor('b.ts', 'DIFF-B'),
    judge,
    reviewItemWriter: async (projectId, change) => {
      const { reviewItemId } = await ReviewItemRouter.getInstance().applyReviewItem(projectId, change);
      return { reviewItemId };
    },
    appVersion: '0.1.15',
    isEvalEnabled: () => true,
    rng: () => 0.1, // positionAFirst=true every sample ⇒ raw '1' maps to arm A
    sleep: async () => {},
    ...over,
  });
}

/** Create an idea (main-board, untagged) and return its id. */
async function seedIdea(tcr: TaskChangeRouter, body: string): Promise<string> {
  const res = await tcr.applyChange(PROJECT_ID, {
    actor: 'user',
    entityType: 'idea',
    title: 'seed idea',
    body,
  });
  return res.taskId;
}

/** Simulate an arm agent minting an epic + child task under its run (auto-tagged). */
async function seedArmWork(
  tcr: TaskChangeRouter,
  runId: string,
): Promise<{ epicId: string; taskId: string }> {
  const epic = await tcr.applyChange(PROJECT_ID, {
    actor: 'agent:planner',
    entityType: 'epic',
    title: 'arm epic',
    runId,
  });
  const task = await tcr.applyChange(PROJECT_ID, {
    actor: 'agent:planner',
    entityType: 'task',
    title: 'arm task',
    parentEpicId: epic.taskId,
    runId,
  });
  return { epicId: epic.taskId, taskId: task.taskId };
}

function setRunStatus(t: TestDb, runId: string, status: string): void {
  t.raw.prepare('UPDATE workflow_runs SET status = ? WHERE id = ?').run(status, runId);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Tier-3 A/B testing: variants, rotation, side-by-side experiments, pairwise judge', () => {
  let t: TestDb;
  let registry: WorkflowRegistry;
  let tcr: TaskChangeRouter;

  beforeEach(() => {
    t = buildMigrationDb();
    registry = new WorkflowRegistry(t.db, makeSpyLogger());
    ReviewItemRouter.initialize(t.db);
    tcr = TaskChangeRouter.initialize(t.db);
  });

  afterEach(() => {
    // TaskChangeRouter / ReviewItemRouter are reset by integration.setup.ts;
    // PairwiseJudgeWorker is not enumerated there, so reset it here.
    PairwiseJudgeWorker._resetForTesting();
    teardownDb(t);
  });

  it('1. migration replay: the three A/B tables + the run/entity stamp columns exist through 050', () => {
    expect(hasTable(t, 'workflow_variants')).toBe(true); // mig 048
    expect(hasTable(t, 'experiments')).toBe(true); // mig 049
    expect(hasTable(t, 'experiment_comparisons')).toBe(true); // mig 050

    const runCols = columns(t, 'workflow_runs');
    for (const col of ['experiment_id', 'experiment_arm', 'variant_id', 'variant_label', 'merge_sha']) {
      expect(runCols.has(col)).toBe(true);
    }
    for (const table of ['ideas', 'epics', 'tasks']) {
      const cols = columns(t, table);
      expect(cols.has('experiment_id')).toBe(true);
      expect(cols.has('caused_by_run_id')).toBe(true);
    }
  });

  it('2. variant + rotation: an active variant is picked by the rng, stamps the run, and freezes its spec', () => {
    const variant = registry.createVariantFromCurrent(WF_ID, 'challenger');
    expect(variant.status).toBe('draft');
    registry.setVariantStatus(variant.id, 'active');

    // A hosting session for the run (workflow_runs.session_id FK).
    const sessionId = `sess-${randomUUID()}`;
    t.raw
      .prepare(
        `INSERT INTO sessions (id, name, initial_prompt, worktree_name, worktree_path, project_id)
         VALUES (?, 'rot session', 'p', 'rot', '/wt/rot', ?)`,
      )
      .run(sessionId, PROJECT_ID);

    // rng()=0 ⇒ weightedPick returns the first (only) active candidate deterministically.
    const resolver = new VariantResolver(t.db, () => 0);
    const resolved = resolver.resolveForLaunch(WF_ID);
    expect(resolved?.variantId).toBe(variant.id);

    const { runId } = registry.createRun(WF_ID, undefined, sessionId, undefined, {
      projectId: PROJECT_ID,
      variantId: resolved!.variantId,
      variantLabel: resolved!.variantLabel,
      variantSpecJson: resolved!.specJson,
    });

    expect(runField(t, runId, 'variant_id')).toBe(variant.id);
    expect(runField(t, runId, 'variant_label')).toBe('challenger');
    expect(runField(t, runId, 'spec_hash')).toBe(computeSpecHash(variant.spec_json));

    // The frozen spec is resolvable back for the run (workflow_revisions row written in-tx).
    const frozen = resolveRunFrozenSpec(t.db, runId);
    expect(frozen?.specJson).toBe(variant.spec_json);
  });

  it('3. side-by-side round trip: sandboxed clones → grading → pairwise verdict → decide promotes the winner', async () => {
    const variantA = registry.createVariantFromCurrent(WF_ID, 'arm-a');
    const variantB = registry.createVariantFromCurrent(WF_ID, 'arm-b');
    const h = makeExpHarness(t, registry, tcr);
    setExperimentsDeps(h.deps);

    const ideaId = await seedIdea(tcr, 'ORIGINAL BODY');

    // -- startSideBySide (idea-seeded): pins base sha, clones per arm, launches both --
    const res = await startExperiment(h.deps, {
      projectId: PROJECT_ID,
      workflowId: WF_ID,
      variantAId: variantA.id,
      variantBId: variantB.id,
      seedIdeaId: ideaId,
    });
    const exp0 = getExperiment(t.db, res.experimentId)!;
    expect(exp0.base_sha).toBe('basesha-abcdef0');
    expect(exp0.run_a_id).toBe(res.armA.runId);
    expect(exp0.run_b_id).toBe(res.armB.runId);
    expect(exp0.seed_idea_clone_a_id).not.toBeNull();
    expect(exp0.seed_idea_clone_b_id).not.toBeNull();

    // Both arm runs carry the experiment + variant stamps (REAL createRun).
    expect(runField(t, res.armA.runId, 'experiment_id')).toBe(res.experimentId);
    expect(runField(t, res.armA.runId, 'experiment_arm')).toBe('A');
    expect(runField(t, res.armA.runId, 'variant_id')).toBe(variantA.id);
    expect(runField(t, res.armB.runId, 'experiment_arm')).toBe('B');

    // Seed clones are tagged + hidden: selectProjectBacklog EXCLUDES them by default,
    // INCLUDES them only with includeExperimentTagged.
    const cloneA = exp0.seed_idea_clone_a_id!;
    const cloneB = exp0.seed_idea_clone_b_id!;
    expect(entityField(t, 'ideas', cloneA, 'experiment_id')).toBe(res.experimentId);
    const defaultBacklog = selectProjectBacklog(t.db, PROJECT_ID).map((r) => r.id);
    expect(defaultBacklog).toContain(ideaId);
    expect(defaultBacklog).not.toContain(cloneA);
    expect(defaultBacklog).not.toContain(cloneB);
    const taggedBacklog = selectProjectBacklog(t.db, PROJECT_ID, {
      includeExperimentTagged: true,
    }).map((r) => r.id);
    expect(taggedBacklog).toContain(cloneA);
    expect(taggedBacklog).toContain(cloneB);

    // Arm work (auto-tagged via the run's experiment_id).
    const aWork = await seedArmWork(tcr, res.armA.runId);
    const bWork = await seedArmWork(tcr, res.armB.runId);

    // -- Sandbox denials (REAL TaskChangeRouter guard) --
    // (a) an arm run editing the ORIGINAL (main-board) idea is denied.
    await expect(
      tcr.applyChange(PROJECT_ID, {
        actor: 'agent:planner',
        taskId: ideaId,
        fields: { title: 'sneaky' },
        runId: res.armA.runId,
      }),
    ).rejects.toMatchObject({ code: 'experiment_sandboxed' });
    // (b) a user actor editing a hidden (tagged) clone is denied.
    await expect(
      tcr.applyChange(PROJECT_ID, {
        actor: 'user',
        taskId: cloneA,
        fields: { title: 'peek' },
      }),
    ).rejects.toMatchObject({ code: 'experiment_sandboxed' });

    // -- Drive both arms terminal → reconcile flips running → grading --
    setRunStatus(t, res.armA.runId, 'awaiting_review');
    setRunStatus(t, res.armB.runId, 'awaiting_review');
    const reconcile = reconcileExperimentStatus(t.db, res.experimentId);
    expect(reconcile).toMatchObject({ changed: true, status: 'grading' });
    expect(getExperiment(t.db, res.experimentId)!.status).toBe('grading');

    // -- Pairwise judge (FAKE judge): snapshot → aggregate → mint decision item --
    const worker = makePairwiseWorker(
      t,
      new FakeJudge(async () => ({ preference: '1', confidence: 0.9, rationale: 'A wins' })),
    );
    const outcome = await worker.maybeSnapshotAndEnqueue(res.experimentId);
    expect(outcome).toBe('enqueued');
    await worker._queue().onIdle();

    const cmp = t.raw
      .prepare(
        'SELECT eval_status AS s, preference AS p, decision_review_item_id AS d FROM experiment_comparisons WHERE experiment_id = ?',
      )
      .get(res.experimentId) as { s: string; p: string; d: string | null };
    expect(cmp.s).toBe('complete');
    expect(cmp.p).toBe('A'); // rng=0.1 ⇒ positionAFirst, raw '1' ⇒ arm A
    expect(cmp.d).not.toBeNull();

    // The blocking kind='decision' review item is in the queue and still pending.
    const decisionItem = t.raw
      .prepare("SELECT id, blocking, status FROM review_items WHERE kind = 'decision' AND id = ?")
      .get(cmp.d) as { id: string; blocking: number; status: string };
    expect(decisionItem.blocking).toBe(1);
    expect(decisionItem.status).toBe('pending');

    // -- decide(winner = arm A): fold clone → original, reveal winner, sweep loser --
    // Overwrite the winner clone body so the REPLACE-fold is observable.
    t.raw.prepare('UPDATE ideas SET body = ? WHERE id = ?').run('WINNER BODY', cloneA);

    const dec = await decideExperiment(h.deps, res.experimentId, res.armA.runId);
    expect(dec.status).toBe('decided');
    await Promise.all(h.resolvePromises); // let the fail-soft review-item resolve settle

    // Winner entities revealed (tag cleared, approved) + reparented to the original idea.
    expect(entityField(t, 'epics', aWork.epicId, 'experiment_id')).toBeNull();
    expect(entityField(t, 'epics', aWork.epicId, 'approved_at')).not.toBeNull();
    expect(entityField(t, 'epics', aWork.epicId, 'originating_idea_id')).toBe(ideaId);
    expect(entityExists(t, 'tasks', aWork.taskId)).toBe(true);
    // Original idea REPLACE-folded from the winner clone; the winner clone discarded.
    expect(entityField(t, 'ideas', ideaId, 'body')).toBe('WINNER BODY');
    expect(entityExists(t, 'ideas', cloneA)).toBe(false);
    // Loser arm fully swept.
    expect(entityExists(t, 'epics', bWork.epicId)).toBe(false);
    expect(entityExists(t, 'tasks', bWork.taskId)).toBe(false);
    expect(entityExists(t, 'ideas', cloneB)).toBe(false);
    // Loser session dismissed; winner session left for normal close-out.
    expect(h.dismissed).toContain(exp0.session_b_id);
    expect(h.dismissed).not.toContain(exp0.session_a_id);
    // Experiment stamped.
    const exp1 = getExperiment(t.db, res.experimentId)!;
    expect(exp1.winner_run_id).toBe(res.armA.runId);
    expect(exp1.winner_arm).toBe('A');
    expect(exp1.decided_at).not.toBeNull();
    // The pairwise decision review item is now resolved.
    expect(entityField(t, 'review_items', cmp.d!, 'status')).toBe('resolved');
  });

  it('4. negative guards: decide-before-settled + experiment-arm restart + rerun-before-settled all reject', async () => {
    const variantA = registry.createVariantFromCurrent(WF_ID, 'arm-a');
    const variantB = registry.createVariantFromCurrent(WF_ID, 'arm-b');
    const h = makeExpHarness(t, registry, tcr);
    setExperimentsDeps(h.deps);

    const res = await startExperiment(h.deps, {
      projectId: PROJECT_ID,
      workflowId: WF_ID,
      variantAId: variantA.id,
      variantBId: variantB.id,
    });

    // REAL appRouter caller for the two router-level guards.
    const caller = appRouter.createCaller(createContext({ db: t.db, workflowRegistry: registry }));

    // (a) rerun before the source experiment settles → CONFLICT.
    await expect(
      caller.cyboflow.experiments.rerun({ experimentId: res.experimentId }),
    ).rejects.toMatchObject({ code: 'CONFLICT' } satisfies Partial<TRPCError>);

    // (b) decide before both arms settle → rejects (arm B still running).
    setRunStatus(t, res.armA.runId, 'awaiting_review');
    setRunStatus(t, res.armB.runId, 'running');
    await expect(
      decideExperiment(h.deps, res.experimentId, res.armA.runId),
    ).rejects.toThrow(/settled/);

    // (c) restart of an experiment-tagged FAILED arm run → CONFLICT.
    const stubStartDeps = {
      runLauncher: {
        launch: async () => {
          throw new Error('restart guard must reject before launching');
        },
      },
      sessionManager: { getProjectById: () => undefined },
    } as unknown as StartRunDeps;
    setStartRunDeps(stubStartDeps);

    const failedRunId = `run-${randomUUID()}`;
    t.raw
      .prepare(
        `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, experiment_id)
         VALUES (?, ?, ?, 'failed', 'default', ?)`,
      )
      .run(failedRunId, WF_ID, PROJECT_ID, res.experimentId);
    await expect(caller.cyboflow.runs.restart({ runId: failedRunId })).rejects.toMatchObject({
      code: 'CONFLICT',
    } satisfies Partial<TRPCError>);

    // Sanity: an insert-only running experiment reconciles as unchanged (half-check).
    const other = insertExperiment(t.db, {
      projectId: PROJECT_ID,
      workflowId: WF_ID,
      baseBranch: 'main',
      baseSha: 'sha',
      variantAId: variantA.id,
      variantBId: variantB.id,
    });
    expect(reconcileExperimentStatus(t.db, other.id)).toMatchObject({
      changed: true,
      status: 'abandoned',
      halfCreated: true,
    });
  });

  it('5. sprint task-seeded round trip: clones per arm (tagged+approved), arms launch with clone taskIds, decide folds body+stage back + sweeps all clones', async () => {
    const variantA = registry.createVariantFromCurrent(SPRINT_WF_ID, 'sprint-a');
    const variantB = registry.createVariantFromCurrent(SPRINT_WF_ID, 'sprint-b');
    const h = makeExpHarness(t, registry, tcr);
    setExperimentsDeps(h.deps);

    // A sprint-eligible ORIGINAL task (approved + Ready-for-development, untagged).
    const orig = (
      await tcr.applyChange(PROJECT_ID, {
        actor: 'user',
        entityType: 'task',
        title: 'original task',
        body: 'ORIGINAL TASK BODY',
      })
    ).taskId;

    const res = await startExperiment(h.deps, {
      projectId: PROJECT_ID,
      workflowId: SPRINT_WF_ID,
      variantAId: variantA.id,
      variantBId: variantB.id,
      seedTaskIds: [orig],
    });

    // Mapping rows: 1 original × 2 arms; each clone is real, experiment-tagged, approved.
    const rows = listExperimentSeedTasks(t.db, res.experimentId);
    expect(rows).toHaveLength(2);
    const cloneA = rows.find((r) => r.arm === 'A')!.clone_task_id;
    const cloneB = rows.find((r) => r.arm === 'B')!.clone_task_id;
    for (const cloneId of [cloneA, cloneB]) {
      expect(entityField(t, 'tasks', cloneId, 'experiment_id')).toBe(res.experimentId);
      expect(entityField(t, 'tasks', cloneId, 'approved_at')).not.toBeNull();
    }
    // Clones are board-hidden; the original stays on the board.
    const backlog = selectProjectBacklog(t.db, PROJECT_ID).map((r) => r.id);
    expect(backlog).toContain(orig);
    expect(backlog).not.toContain(cloneA);
    expect(backlog).not.toContain(cloneB);

    // Each arm launched with ITS clone ids as seedTaskIds (the sprint launch seam).
    expect(h.launchedSeedTaskIds.A).toEqual([cloneA]);
    expect(h.launchedSeedTaskIds.B).toEqual([cloneB]);
    // Arm runs carry the experiment stamp (REAL createRun) on the sprint workflow.
    expect(runField(t, res.armA.runId, 'experiment_id')).toBe(res.experimentId);
    expect(runField(t, res.armA.runId, 'experiment_arm')).toBe('A');

    // Winner arm A's clone evolves: new body + moved to 'Done' (position 9).
    const doneStageId = (
      t.raw.prepare('SELECT id FROM board_stages WHERE position = 9 LIMIT 1').get() as { id: string }
    ).id;
    t.raw.prepare('UPDATE tasks SET body = ? WHERE id = ?').run('WINNER TASK BODY', cloneA);
    await tcr.applyChange(PROJECT_ID, {
      actor: 'orchestrator',
      entityType: 'task',
      taskId: cloneA,
      stageId: doneStageId,
    });

    setRunStatus(t, res.armA.runId, 'awaiting_review');
    setRunStatus(t, res.armB.runId, 'awaiting_review');
    expect(reconcileExperimentStatus(t.db, res.experimentId)).toMatchObject({ status: 'grading' });

    const dec = await decideExperiment(h.deps, res.experimentId, res.armA.runId);
    expect(dec.status).toBe('decided');

    // Original folded from the WINNER clone: body REPLACED + moved to the clone's stage.
    expect(entityField(t, 'tasks', orig, 'body')).toBe('WINNER TASK BODY');
    expect(entityField(t, 'tasks', orig, 'stage_id')).toBe(doneStageId);
    expect(entityField(t, 'tasks', orig, 'experiment_id')).toBeNull();
    // Every clone swept + mapping cleared; the original survives on the board.
    expect(entityExists(t, 'tasks', cloneA)).toBe(false);
    expect(entityExists(t, 'tasks', cloneB)).toBe(false);
    expect(entityExists(t, 'tasks', orig)).toBe(true);
    expect(listExperimentSeedTasks(t.db, res.experimentId)).toEqual([]);
  });
});
