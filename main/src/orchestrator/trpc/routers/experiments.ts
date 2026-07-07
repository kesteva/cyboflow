/**
 * cyboflow.experiments sub-router (A/B testing slice B, migration 049).
 *
 * Side-by-side experiment orchestration: startSideBySide launches two variant
 * arms in SHA-pinned worktrees with sandboxed entity writes; decide promotes the
 * winner / discards the loser; abandon tears a live experiment down; rerun chains
 * a second head-to-head; switchToRotation activates both variants. get /
 * listForProject are reads.
 *
 * Deps are injected at boot via setExperimentsDeps() (mirrors setStartRunDeps) so
 * the router keeps the standalone-typecheck invariant: no imports from 'electron',
 * 'better-sqlite3', or main/src/services/*. The concrete WorktreeManager /
 * RunLauncher / SessionManager / create-quick-core / TaskChangeRouter are injected
 * as narrow STRUCTURAL types (never their service classes).
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc';
import type { DatabaseLike } from '../../types';
import type { TaskChange } from '../../taskChangeRouter';
import type { CliSubstrate } from '../../../../../shared/types/substrate';
import type { PermissionMode } from '../../../../../shared/types/workflows';
import type { ExecutionModel } from '../../../../../shared/types/executionModel';
import type {
  ExperimentArm,
  ExperimentRow,
  StartSideBySideResult,
  DecideResult,
  WorkflowVariantRow,
  WorkflowVariantStatus,
  ComparisonStatus,
  ExperimentComparisonRow,
  ExperimentComparisonPayload,
  ExperimentComparisonDiffs,
  ExperimentArmView,
  ExperimentSummary,
  ExperimentComparisonReadyEvent,
  ExperimentDecision,
  PairwiseVerdict,
  PairwiseSample,
  PairwisePreference,
} from '../../../../../shared/types/experiments';
import {
  isExperimentArmSettled,
  isExperimentSettled,
  isBaselineArm,
} from '../../../../../shared/types/experiments';
import {
  insertExperiment,
  getExperiment,
  listExperimentsForProject,
  setExperimentRuns,
  updateExperimentStatus,
} from '../../experimentStore';
import { listRunCreatedEpicIds, listRunCreatedIdeaIds, listRunCreatedTaskIds } from '../../runEntityOwnership';
import { selectRunUsageRollups, selectRunFindings, getRunEval } from '../../insightsQueries';
import { experimentEvents, eventToAsyncIterable } from './events';

// ---------------------------------------------------------------------------
// Injected dependency bag (setExperimentsDeps, mirroring setStartRunDeps).
// ---------------------------------------------------------------------------

/** RunLauncher.launch structural surface (the trailing launchOptions carries the experiment stamp). */
export interface ExperimentsLaunchLike {
  launch(
    workflowId: string,
    projectPath: string,
    substrate?: CliSubstrate,
    taskId?: string,
    ideaId?: string,
    sessionId?: string,
    requestedPermissionMode?: PermissionMode,
    baseBranch?: string,
    seedTaskIds?: string[],
    projectId?: number,
    requestedExecutionModel?: ExecutionModel,
    findingIds?: string[],
    requestedModel?: string,
    requestedEvalEnabled?: boolean,
    launchOptions?: {
      requestedVariantId?: string;
      experiment?: { experimentId: string; arm: ExperimentArm };
      baseline?: boolean;
    },
  ): Promise<{ runId: string; worktreePath: string; branchName: string; permissionMode: PermissionMode }>;
}

/** TaskChangeRouter structural surface used by the experiment orchestration. */
export interface ExperimentsTaskChangeLike {
  applyChange(projectId: number, change: TaskChange): Promise<{ taskId: string }>;
  deleteExperimentArmEntities(
    projectId: number,
    opts: { experimentId: string; runId: string; seedCloneId?: string | null },
  ): Promise<void>;
}

export interface ExperimentsDeps {
  /** DatabaseLike for the experiments table (experimentStore) + entity/run reads. */
  db: DatabaseLike;
  runLauncher: ExperimentsLaunchLike;
  worktreeManager: {
    getProjectMainBranch(projectPath: string): Promise<string>;
    getHeadCommit(projectPath: string): Promise<string>;
  };
  /** SHA-pinned arm session via the shared createQuickSessionCore path. */
  createArmSession: (o: {
    projectId: number;
    baseCommittish: string;
    nameHint: string;
  }) => Promise<{ sessionId: string; worktreePath: string }>;
  taskChangeRouter: ExperimentsTaskChangeLike;
  /** FULL session-delete path (cancels hosted runs + removes worktree). NEVER a bare worktree-remove. */
  dismissSession: (sessionId: string) => Promise<void>;
  /** Git-neutral run cancel (cancelRunHandler). */
  cancelRun: (runId: string) => Promise<void>;
  /** Slice A registry reads/writes. */
  getVariant: (variantId: string) => WorkflowVariantRow | null;
  getWorkflow: (workflowId: string) => { id: string; name: string } | null;
  getProjectPath: (projectId: number) => string | null;
  setVariantStatus: (variantId: string, status: WorkflowVariantStatus) => void;
  setVariantWeight: (variantId: string, weight: number) => void;
  /** Optional: resolve the pairwise decision review item (slice C). Fail-soft when absent. */
  resolveReviewItem?: (reviewItemId: string) => void;
  /**
   * Optional (slice C): re-drive the pairwise snapshot + enqueue for an experiment
   * (PairwiseJudgeWorker.maybeSnapshotAndEnqueue). Used by rerunComparison after
   * deleting the stale comparison row. AWAITABLE — rerunComparison awaits it so the
   * fresh comparison row exists before it reads back eval_status (a fire-and-forget
   * snapshot would let the read race the INSERT and report a spurious 'absent').
   * Fail-soft when absent (pre-slice-C boot).
   */
  pairwiseMaybeSnapshot?: (experimentId: string) => Promise<void>;
}

let experimentsDeps: ExperimentsDeps | null = null;

/** Wire the real collaborators for the experiments router (called once at boot). */
export function setExperimentsDeps(deps: ExperimentsDeps): void {
  experimentsDeps = deps;
}

function requireDeps(): ExperimentsDeps {
  if (!experimentsDeps) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'experiment dependencies not wired yet. Call setExperimentsDeps() at boot.',
    });
  }
  return experimentsDeps;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface SeedIdeaFields {
  title: string;
  summary: string | null;
  body: string | null;
  scope: 'small' | 'large' | null;
  attachmentsJson: string | null;
}

/** Read the seed idea's copyable fields; null when the idea is missing/decomposed/foreign. */
function readSeedIdea(db: DatabaseLike, ideaId: string, projectId: number): SeedIdeaFields | null {
  const row = db
    .prepare(
      'SELECT title, summary, body, scope, attachments, project_id, decomposed_at FROM ideas WHERE id = ?',
    )
    .get(ideaId) as
    | {
        title?: unknown;
        summary?: unknown;
        body?: unknown;
        scope?: unknown;
        attachments?: unknown;
        project_id?: unknown;
        decomposed_at?: unknown;
      }
    | undefined;
  if (!row) return null;
  if (row.project_id !== projectId) return null;
  if (row.decomposed_at !== null && row.decomposed_at !== undefined) return null;
  return {
    title: typeof row.title === 'string' ? row.title : 'Untitled',
    summary: typeof row.summary === 'string' ? row.summary : null,
    body: typeof row.body === 'string' ? row.body : null,
    scope: row.scope === 'small' || row.scope === 'large' ? row.scope : null,
    attachmentsJson: typeof row.attachments === 'string' ? row.attachments : null,
  };
}

/** Clone the seed idea for one arm (hidden + tagged); returns the clone id. */
async function cloneSeedIdea(
  deps: ExperimentsDeps,
  projectId: number,
  experimentId: string,
  seed: SeedIdeaFields,
): Promise<string> {
  let attachments: unknown = undefined;
  if (seed.attachmentsJson) {
    try {
      attachments = JSON.parse(seed.attachmentsJson);
    } catch {
      attachments = undefined;
    }
  }
  const result = await deps.taskChangeRouter.applyChange(projectId, {
    actor: 'orchestrator',
    entityType: 'idea',
    title: seed.title,
    summary: seed.summary,
    body: seed.body,
    scope: seed.scope,
    ...(Array.isArray(attachments) ? { attachments: attachments as never } : {}),
    experimentId,
    kind: 'experiment-seed-clone',
  });
  return result.taskId;
}

/** Read a run's status (null when missing). */
function runStatus(db: DatabaseLike, runId: string | null): string | null {
  if (!runId) return null;
  const row = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as
    | { status?: unknown }
    | undefined;
  return typeof row?.status === 'string' ? row.status : null;
}

/** Both arms settled (isExperimentArmSettled over both run statuses). */
function bothArmsSettled(db: DatabaseLike, exp: ExperimentRow): boolean {
  const a = runStatus(db, exp.run_a_id);
  const b = runStatus(db, exp.run_b_id);
  return a !== null && b !== null && isExperimentArmSettled(a) && isExperimentArmSettled(b);
}

/**
 * Resolve the pairwise decision review item (slice C wires the table). Fail-soft:
 * the experiment_comparisons table arrives in migration 050, so on a slice-B DB
 * the read throws "no such table" and this silently no-ops (schema-absence catch,
 * mirroring resolveRunFrozenSpec's isSchemaAbsenceError pattern).
 */
function resolveDecisionReviewItem(deps: ExperimentsDeps, experimentId: string): void {
  try {
    const row = deps.db
      .prepare('SELECT decision_review_item_id AS id FROM experiment_comparisons WHERE experiment_id = ?')
      .get(experimentId) as { id?: unknown } | undefined;
    if (row && typeof row.id === 'string' && row.id.length > 0 && deps.resolveReviewItem) {
      deps.resolveReviewItem(row.id);
    }
  } catch {
    // experiment_comparisons absent (pre-050) — nothing to resolve yet.
  }
}

/** Random branch-name hint for an arm worktree. */
function armNameHint(arm: ExperimentArm): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `ab-${rand}-${arm.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// startSideBySide (shared by rerun)
// ---------------------------------------------------------------------------

export interface StartInput {
  projectId: number;
  workflowId: string;
  variantAId: string;
  variantBId: string;
  seedIdeaId?: string;
  substrate?: CliSubstrate;
  permissionMode?: PermissionMode;
  rerunOfExperimentId?: string;
}

/** @internal exported for unit tests — the router calls it via requireDeps(). */
export async function startExperiment(deps: ExperimentsDeps, input: StartInput): Promise<StartSideBySideResult> {
  const { db } = deps;

  // 1. Validate project + both arms differ + each real-variant arm belongs to the
  //    workflow. Either arm may be the current-workflow baseline sentinel
  //    (BASELINE_VARIANT_SENTINEL) — that arm launches as baseline (variant_id NULL)
  //    and is NOT looked up in the variant registry — but BOTH cannot be baseline.
  const aIsBaseline = isBaselineArm(input.variantAId);
  const bIsBaseline = isBaselineArm(input.variantBId);
  if (input.variantAId === input.variantBId) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'the two arms must differ — at least one arm must be a variant (both cannot be the baseline)',
    });
  }
  const projectPath = deps.getProjectPath(input.projectId);
  if (!projectPath) {
    throw new TRPCError({ code: 'NOT_FOUND', message: `project ${input.projectId} not found` });
  }
  const workflow = deps.getWorkflow(input.workflowId);
  if (!workflow) {
    throw new TRPCError({ code: 'NOT_FOUND', message: `workflow ${input.workflowId} not found` });
  }
  // Skip the registry existence check for a baseline arm (no variant row backs it).
  const variantA = aIsBaseline ? null : deps.getVariant(input.variantAId);
  const variantB = bIsBaseline ? null : deps.getVariant(input.variantBId);
  if ((!aIsBaseline && !variantA) || (!bIsBaseline && !variantB)) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'one or both variants not found' });
  }
  if (
    (variantA && variantA.workflow_id !== input.workflowId) ||
    (variantB && variantB.workflow_id !== input.workflowId)
  ) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'a variant belongs to a different workflow' });
  }

  // 1b. Validate seed idea (if given).
  let seed: SeedIdeaFields | null = null;
  if (input.seedIdeaId) {
    seed = readSeedIdea(db, input.seedIdeaId, input.projectId);
    if (!seed) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `seed idea ${input.seedIdeaId} is missing, decomposed, or in another project`,
      });
    }
  }

  // 2. Resolve base ref + exact SHA ONCE (project root HEAD).
  const baseBranch = await deps.worktreeManager.getProjectMainBranch(projectPath);
  const baseSha = await deps.worktreeManager.getHeadCommit(projectPath);

  // 3. Create the two SHA-pinned arm sessions (A then B). If B fails before the
  //    experiments row exists, dismiss A + throw (clean — no row, no runs).
  const sessionA = await deps.createArmSession({
    projectId: input.projectId,
    baseCommittish: baseSha,
    nameHint: armNameHint('A'),
  });
  let sessionB: { sessionId: string; worktreePath: string };
  try {
    sessionB = await deps.createArmSession({
      projectId: input.projectId,
      baseCommittish: baseSha,
      nameHint: armNameHint('B'),
    });
  } catch (err) {
    await deps.dismissSession(sessionA.sessionId).catch(() => {});
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `failed to create arm B session: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // 4. Insert the experiments row (status='running').
  const exp = insertExperiment(db, {
    projectId: input.projectId,
    workflowId: input.workflowId,
    baseBranch,
    baseSha,
    variantAId: input.variantAId,
    variantBId: input.variantBId,
    sessionAId: sessionA.sessionId,
    sessionBId: sessionB.sessionId,
    seedIdeaId: input.seedIdeaId ?? null,
    rerunOfExperimentId: input.rerunOfExperimentId ?? null,
  });

  // Everything past here is compensated on failure via the rollback ladder.
  const rollback = async (detail: string): Promise<never> => {
    const cur = getExperiment(db, exp.id);
    if (cur?.run_a_id) await deps.cancelRun(cur.run_a_id).catch(() => {});
    if (cur?.run_b_id) await deps.cancelRun(cur.run_b_id).catch(() => {});
    await deps.dismissSession(sessionA.sessionId).catch(() => {});
    await deps.dismissSession(sessionB.sessionId).catch(() => {});
    // Sweep BOTH arms' entities UNCONDITIONALLY — decoupled from the run_id gate.
    // The seed clones are created in step 5 (cloneSeedIdea, no runId) BEFORE either
    // arm launches in step 6, so an arm can own a tagged (hidden) clone even when
    // its run was never stamped. deleteExperimentArmEntities sweeps the clone purely
    // via the seedCloneId branch (runId '' matches no run-created events, so nothing
    // else is touched), mirroring the boot-recovery sweepClones callback in index.ts.
    // Gating the sweep on run_id would orphan the clone forever: this ladder marks the
    // experiment 'abandoned', and recoverExperiments() only re-sweeps running/grading
    // rows — an abandoned experiment is never revisited.
    await deps.taskChangeRouter
      .deleteExperimentArmEntities(input.projectId, {
        experimentId: exp.id,
        runId: cur?.run_a_id ?? '',
        seedCloneId: cur?.seed_idea_clone_a_id,
      })
      .catch(() => {});
    await deps.taskChangeRouter
      .deleteExperimentArmEntities(input.projectId, {
        experimentId: exp.id,
        runId: cur?.run_b_id ?? '',
        seedCloneId: cur?.seed_idea_clone_b_id,
      })
      .catch(() => {});
    updateExperimentStatus(db, exp.id, 'abandoned');
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: detail });
  };

  try {
    // 5. Seed-clone per arm (idea-seeded only).
    let cloneA: string | null = null;
    let cloneB: string | null = null;
    if (seed) {
      cloneA = await cloneSeedIdea(deps, input.projectId, exp.id, seed);
      cloneB = await cloneSeedIdea(deps, input.projectId, exp.id, seed);
      setExperimentRuns(db, exp.id, { seedIdeaCloneAId: cloneA, seedIdeaCloneBId: cloneB });
    }

    // 6. Launch arm A then B (ideaId = the arm's clone; NEVER taskId/taskIds).
    const armA = await deps.runLauncher.launch(
      input.workflowId,
      projectPath,
      input.substrate,
      undefined,
      cloneA ?? undefined,
      sessionA.sessionId,
      input.permissionMode,
      undefined,
      undefined,
      input.projectId,
      undefined,
      undefined,
      undefined,
      undefined,
      // A baseline arm launches as baseline (variant_id NULL): pass `baseline: true`
      // so the launcher's VariantResolver returns null WITHOUT rotating. A real-variant
      // arm pins its variant explicitly. Both carry the experiment/arm stamp.
      aIsBaseline
        ? { baseline: true, experiment: { experimentId: exp.id, arm: 'A' } }
        : { requestedVariantId: input.variantAId, experiment: { experimentId: exp.id, arm: 'A' } },
    );
    setExperimentRuns(db, exp.id, { runAId: armA.runId });

    const armB = await deps.runLauncher.launch(
      input.workflowId,
      projectPath,
      input.substrate,
      undefined,
      cloneB ?? undefined,
      sessionB.sessionId,
      input.permissionMode,
      undefined,
      undefined,
      input.projectId,
      undefined,
      undefined,
      undefined,
      undefined,
      bIsBaseline
        ? { baseline: true, experiment: { experimentId: exp.id, arm: 'B' } }
        : { requestedVariantId: input.variantBId, experiment: { experimentId: exp.id, arm: 'B' } },
    );
    setExperimentRuns(db, exp.id, { runBId: armB.runId });

    return {
      experimentId: exp.id,
      armA: { runId: armA.runId, sessionId: sessionA.sessionId },
      armB: { runId: armB.runId, sessionId: sessionB.sessionId },
    };
  } catch (err) {
    return rollback(`side-by-side launch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// decide
// ---------------------------------------------------------------------------

/**
 * Reveal + reparent + clear-tag one arm's winner-created entities. A failure on
 * ANY op propagates (no per-op swallow) so decideExperiment can abort the promotion
 * BEFORE the destructive sweep — silently dropping a reveal here would let the
 * still-tagged winner entity be swept as though it were throwaway.
 */
async function revealWinnerEntities(
  deps: ExperimentsDeps,
  projectId: number,
  winnerRunId: string,
  originalIdeaId: string | null,
): Promise<void> {
  const reparent = originalIdeaId ? { originatingIdeaId: originalIdeaId } : {};
  for (const epicId of listRunCreatedEpicIds(deps.db, winnerRunId)) {
    await deps.taskChangeRouter.applyChange(projectId, {
      actor: 'orchestrator',
      entityType: 'epic',
      taskId: epicId,
      approved: true,
      clearExperiment: true,
      ...reparent,
      kind: 'experiment-promote',
    });
  }
  for (const taskId of listRunCreatedTaskIds(deps.db, winnerRunId)) {
    await deps.taskChangeRouter.applyChange(projectId, {
      actor: 'orchestrator',
      entityType: 'task',
      taskId,
      approved: true,
      clearExperiment: true,
      ...reparent,
      kind: 'experiment-promote',
    });
  }
  // Winner-created ideas (unseeded arms may mint their own idea) — reveal only.
  for (const ideaId of listRunCreatedIdeaIds(deps.db, winnerRunId)) {
    await deps.taskChangeRouter.applyChange(projectId, {
      actor: 'orchestrator',
      entityType: 'idea',
      taskId: ideaId,
      clearExperiment: true,
      kind: 'experiment-promote',
    });
  }
}

/** @internal exported for unit tests. */
export async function decideExperiment(
  deps: ExperimentsDeps,
  experimentId: string,
  winnerRunId: string | null,
): Promise<DecideResult> {
  const { db } = deps;
  const exp = getExperiment(db, experimentId);
  if (!exp) {
    throw new TRPCError({ code: 'NOT_FOUND', message: `experiment ${experimentId} not found` });
  }
  if (isExperimentSettled(exp.status)) {
    throw new TRPCError({ code: 'CONFLICT', message: `experiment ${experimentId} is already ${exp.status}` });
  }
  // decide REQUIRES both arms settled (the UI disables the CTAs until then).
  if (!bothArmsSettled(db, exp)) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'both arms must be settled (awaiting_review|completed|failed|canceled) before deciding',
    });
  }

  const now = new Date().toISOString();

  // Discard-both (winnerRunId null): sweep both arms, dismiss both sessions.
  if (winnerRunId === null) {
    if (exp.run_a_id) {
      await deps.taskChangeRouter.deleteExperimentArmEntities(exp.project_id, {
        experimentId,
        runId: exp.run_a_id,
        seedCloneId: exp.seed_idea_clone_a_id,
      });
    }
    if (exp.run_b_id) {
      await deps.taskChangeRouter.deleteExperimentArmEntities(exp.project_id, {
        experimentId,
        runId: exp.run_b_id,
        seedCloneId: exp.seed_idea_clone_b_id,
      });
    }
    updateExperimentStatus(db, experimentId, 'decided', {
      winnerRunId: null,
      winnerArm: null,
      decidedAt: now,
    });
    if (exp.session_a_id) await deps.dismissSession(exp.session_a_id).catch(() => {});
    if (exp.session_b_id) await deps.dismissSession(exp.session_b_id).catch(() => {});
    resolveDecisionReviewItem(deps, experimentId);
    return { experimentId, status: 'decided', winnerRunId: null };
  }

  // Winner path — resolve arm/loser.
  let winnerArm: ExperimentArm;
  let loserRunId: string | null;
  let winnerCloneId: string | null;
  let loserCloneId: string | null;
  if (winnerRunId === exp.run_a_id) {
    winnerArm = 'A';
    loserRunId = exp.run_b_id;
    winnerCloneId = exp.seed_idea_clone_a_id;
    loserCloneId = exp.seed_idea_clone_b_id;
  } else if (winnerRunId === exp.run_b_id) {
    winnerArm = 'B';
    loserRunId = exp.run_a_id;
    winnerCloneId = exp.seed_idea_clone_b_id;
    loserCloneId = exp.seed_idea_clone_a_id;
  } else {
    throw new TRPCError({ code: 'BAD_REQUEST', message: `winnerRunId ${winnerRunId} is not an arm of this experiment` });
  }

  const seeded = exp.seed_idea_id !== null;

  // PROMOTION PHASE (steps 1–2) — FAIL-CLOSED. The fold + reveal must fully
  // succeed before ANY destructive sweep runs, because step 3 hard-deletes every
  // winner-run-created entity whose experiment tag was NOT cleared. If a reveal
  // silently failed (as the removed per-op .catch swallows allowed), the still-
  // tagged winning work would be swept as though it were throwaway, with no retry
  // path (decide on a decided experiment throws CONFLICT). On any failure we abort
  // BEFORE the sweep, leaving status untouched (running/grading), no session
  // dismissal, and the decision review item unresolved. Both the fold (REPLACE
  // body) and each reveal (approved + clearExperiment + reparent) are idempotent —
  // a second decide after a fixed cause re-runs them as no-ops and completes.
  try {
    // 1. (seeded) REPLACE-fold the winner clone body into the ORIGINAL idea.
    if (seeded && exp.seed_idea_id && winnerCloneId) {
      const cloneRow = db.prepare('SELECT body FROM ideas WHERE id = ?').get(winnerCloneId) as
        | { body?: unknown }
        | undefined;
      const cloneBody = typeof cloneRow?.body === 'string' ? cloneRow.body : null;
      await deps.taskChangeRouter.applyChange(exp.project_id, {
        actor: 'orchestrator',
        entityType: 'idea',
        taskId: exp.seed_idea_id,
        fields: { body: cloneBody },
        kind: 'experiment-promote-fold',
      });
    }

    // 2. Reveal winner entities (reparent to original when seeded) + clear their tag.
    await revealWinnerEntities(deps, exp.project_id, winnerRunId, seeded ? exp.seed_idea_id : null);
  } catch (err) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `winner promotion failed (${
        err instanceof Error ? err.message : String(err)
      }); experiment left undecided — fix the cause and retry decide`,
    });
  }

  // 2b. Pre-sweep verification (belt-and-braces). The sweep in step 3 spares the
  //     winner entities SOLELY because their tag was cleared in step 2 — so verify
  //     that actually happened. If any winner-run-created epic/task/idea still
  //     carries this experiment's tag (a reveal that "succeeded" without clearing),
  //     abort with the SAME typed error rather than let the sweep destroy it. Same
  //     retry contract: status/dismissal/review-item all untouched.
  const stillTagged: string[] = [];
  const collectStillTagged = (table: 'epics' | 'tasks' | 'ideas', ids: string[]): void => {
    for (const id of ids) {
      const row = db.prepare(`SELECT experiment_id AS eid FROM ${table} WHERE id = ?`).get(id) as
        | { eid?: unknown }
        | undefined;
      if (row && row.eid === experimentId) stillTagged.push(id);
    }
  };
  collectStillTagged('epics', listRunCreatedEpicIds(db, winnerRunId));
  collectStillTagged('tasks', listRunCreatedTaskIds(db, winnerRunId));
  collectStillTagged('ideas', listRunCreatedIdeaIds(db, winnerRunId));
  if (stillTagged.length > 0) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `winner promotion failed (winner entities still experiment-tagged after reveal: ${stillTagged.join(
        ', ',
      )}); experiment left undecided — fix the cause and retry decide`,
    });
  }

  // 3. Discard the (now-orphan) winner clone. The winner's entities had their tag
  //    cleared in step 2, so deleteExperimentArmEntities spares them and sweeps
  //    ONLY the still-tagged clone.
  await deps.taskChangeRouter.deleteExperimentArmEntities(exp.project_id, {
    experimentId,
    runId: winnerRunId,
    seedCloneId: winnerCloneId,
  });

  // 4. Discard the whole loser arm.
  if (loserRunId) {
    await deps.taskChangeRouter.deleteExperimentArmEntities(exp.project_id, {
      experimentId,
      runId: loserRunId,
      seedCloneId: loserCloneId,
    });
  }

  // 5. Stamp the decision.
  updateExperimentStatus(db, experimentId, 'decided', {
    winnerRunId,
    winnerArm,
    decidedAt: now,
  });

  // 6. Dismiss the loser session; the winner session proceeds to normal merge close-out.
  const loserSessionId = winnerArm === 'A' ? exp.session_b_id : exp.session_a_id;
  if (loserSessionId) await deps.dismissSession(loserSessionId).catch(() => {});

  // 7. Resolve the pairwise decision review item (fail-soft; slice C table).
  resolveDecisionReviewItem(deps, experimentId);

  return { experimentId, status: 'decided', winnerRunId };
}

// ---------------------------------------------------------------------------
// abandon
// ---------------------------------------------------------------------------

/** @internal exported for unit tests. */
export async function abandonExperiment(deps: ExperimentsDeps, experimentId: string): Promise<DecideResult> {
  const { db } = deps;
  const exp = getExperiment(db, experimentId);
  if (!exp) {
    throw new TRPCError({ code: 'NOT_FOUND', message: `experiment ${experimentId} not found` });
  }
  if (isExperimentSettled(exp.status)) {
    throw new TRPCError({ code: 'CONFLICT', message: `experiment ${experimentId} is already ${exp.status}` });
  }

  // Cancel still-running arms FIRST, then dismiss both sessions via the FULL path
  // (which also cancels any hosted run — belt-and-braces).
  const statusA = runStatus(db, exp.run_a_id);
  const statusB = runStatus(db, exp.run_b_id);
  if (exp.run_a_id && statusA !== null && !isExperimentArmSettled(statusA)) {
    await deps.cancelRun(exp.run_a_id).catch(() => {});
  }
  if (exp.run_b_id && statusB !== null && !isExperimentArmSettled(statusB)) {
    await deps.cancelRun(exp.run_b_id).catch(() => {});
  }
  if (exp.session_a_id) await deps.dismissSession(exp.session_a_id).catch(() => {});
  if (exp.session_b_id) await deps.dismissSession(exp.session_b_id).catch(() => {});

  // Sweep both arms' entities.
  if (exp.run_a_id) {
    await deps.taskChangeRouter
      .deleteExperimentArmEntities(exp.project_id, {
        experimentId,
        runId: exp.run_a_id,
        seedCloneId: exp.seed_idea_clone_a_id,
      })
      .catch(() => {});
  }
  if (exp.run_b_id) {
    await deps.taskChangeRouter
      .deleteExperimentArmEntities(exp.project_id, {
        experimentId,
        runId: exp.run_b_id,
        seedCloneId: exp.seed_idea_clone_b_id,
      })
      .catch(() => {});
  }

  updateExperimentStatus(db, experimentId, 'abandoned');
  return { experimentId, status: 'abandoned', winnerRunId: null };
}

// ---------------------------------------------------------------------------
// Comparison reads (slice C) — assemble the compare-view payloads
// ---------------------------------------------------------------------------

/** Read the pairwise comparison row for an experiment (null when absent). */
function readComparisonRow(db: DatabaseLike, experimentId: string): ExperimentComparisonRow | null {
  const row = db
    .prepare('SELECT * FROM experiment_comparisons WHERE experiment_id = ?')
    .get(experimentId) as ExperimentComparisonRow | undefined;
  return row ?? null;
}

/** Build the aggregate verdict from a complete comparison row (null otherwise). */
function buildVerdict(row: ExperimentComparisonRow | null): PairwiseVerdict | null {
  if (!row || row.eval_status !== 'complete' || row.preference === null) return null;
  let perSample: PairwiseSample[] = [];
  if (row.per_sample_json) {
    try {
      const parsed = JSON.parse(row.per_sample_json);
      if (Array.isArray(parsed)) perSample = parsed as PairwiseSample[];
    } catch {
      perSample = [];
    }
  }
  return {
    preference: row.preference,
    confidence: row.confidence ?? 0,
    rationale: row.rationale ?? '',
    aCount: row.a_count,
    bCount: row.b_count,
    tieCount: row.tie_count,
    sampleCount: row.sample_count ?? perSample.length,
    perSample,
  };
}

/**
 * Human label for an arm's variant id: "Baseline" for the current-workflow
 * baseline sentinel, else the resolved variant label (falling back to the raw id
 * when the variant was deleted).
 */
function armVariantLabel(variantId: string, resolvedLabel: string | null): string {
  if (isBaselineArm(variantId)) return 'Baseline';
  return resolvedLabel ?? variantId;
}

/** The variant's live label; "Baseline" for a baseline arm, id when the variant was deleted. */
function variantLabel(deps: ExperimentsDeps, variantId: string): string {
  return armVariantLabel(variantId, deps.getVariant(variantId)?.label ?? null);
}

/** Assemble one arm's view (usage rollup + eval + findings + entity counts). */
function buildArmView(
  deps: ExperimentsDeps,
  runId: string | null,
  arm: ExperimentArm,
  variantId: string,
): ExperimentArmView {
  const { db } = deps;
  const label = variantLabel(deps, variantId);
  if (!runId) {
    return {
      runId: '',
      arm,
      variantLabel: label,
      status: 'pending',
      usage: null,
      evalSummary: null,
      findings: [],
      entitySummary: { ideas: 0, epics: 0, tasks: 0 },
    };
  }
  const usage = selectRunUsageRollups(db, [runId])[0] ?? null;
  const evalSummary = getRunEval(db, runId);
  const findings = selectRunFindings(db, runId);
  const entitySummary = {
    ideas: listRunCreatedIdeaIds(db, runId).length,
    epics: listRunCreatedEpicIds(db, runId).length,
    tasks: listRunCreatedTaskIds(db, runId).length,
  };
  return {
    runId,
    arm,
    variantLabel: label,
    status: runStatus(db, runId) ?? 'pending',
    usage,
    evalSummary,
    findings,
    entitySummary,
  };
}

/**
 * Stable grouping key chaining repeated head-to-heads into a dashboard series:
 * the same workflow + variant pair (order-independent). Reruns always reuse the
 * source's variant pair, so this groups an arbitrarily deep chain without walking
 * rerun_of_experiment_id.
 */
function seriesKey(workflowId: string, variantAId: string, variantBId: string): string {
  const pair = [variantAId, variantBId].sort().join('|');
  return `${workflowId}:${pair}`;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const experimentsRouter = router({
  startSideBySide: protectedProcedure
    .input(
      z.object({
        projectId: z.number().int().positive(),
        workflowId: z.string().min(1),
        variantAId: z.string().min(1),
        variantBId: z.string().min(1),
        seedIdeaId: z.string().min(1).optional(),
        substrate: z.enum(['sdk', 'interactive']).optional(),
        permissionMode: z.enum(['default', 'acceptEdits', 'auto', 'dontAsk']).optional(),
      }),
    )
    .mutation(async ({ input }): Promise<StartSideBySideResult> => {
      const deps = requireDeps();
      return startExperiment(deps, input);
    }),

  decide: protectedProcedure
    .input(
      z.object({
        experimentId: z.string().min(1),
        winnerRunId: z.string().min(1).nullable(),
      }),
    )
    .mutation(async ({ input }): Promise<DecideResult> => {
      const deps = requireDeps();
      return decideExperiment(deps, input.experimentId, input.winnerRunId);
    }),

  abandon: protectedProcedure
    .input(z.object({ experimentId: z.string().min(1) }))
    .mutation(async ({ input }): Promise<DecideResult> => {
      const deps = requireDeps();
      return abandonExperiment(deps, input.experimentId);
    }),

  /**
   * Repeat a settled head-to-head: a NEW experiment with the same workflow +
   * variant pair, an optional NEW seed idea, a FRESH base SHA, chained via
   * rerun_of_experiment_id. Requires the source settled.
   */
  rerun: protectedProcedure
    .input(z.object({ experimentId: z.string().min(1), seedIdeaId: z.string().min(1).optional() }))
    .mutation(async ({ input }): Promise<StartSideBySideResult> => {
      const deps = requireDeps();
      const src = getExperiment(deps.db, input.experimentId);
      if (!src) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `experiment ${input.experimentId} not found` });
      }
      if (!isExperimentSettled(src.status)) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: `experiment ${input.experimentId} must be decided/abandoned before rerun`,
        });
      }
      return startExperiment(deps, {
        projectId: src.project_id,
        workflowId: src.workflow_id,
        variantAId: src.variant_a_id,
        variantBId: src.variant_b_id,
        seedIdeaId: input.seedIdeaId,
        rerunOfExperimentId: src.id,
      });
    }),

  /**
   * Put both variants into rotation (status='active'). Requires the source
   * experiment settled. Optional per-variant weights (equal-weight by default).
   */
  switchToRotation: protectedProcedure
    .input(
      z.object({
        experimentId: z.string().min(1),
        weights: z
          .object({ a: z.number().int().min(0), b: z.number().int().min(0) })
          .optional(),
      }),
    )
    .mutation(async ({ input }): Promise<DecideResult> => {
      const deps = requireDeps();
      const exp = getExperiment(deps.db, input.experimentId);
      if (!exp) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `experiment ${input.experimentId} not found` });
      }
      if (!isExperimentSettled(exp.status)) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: `experiment ${input.experimentId} must be decided/abandoned before switching to rotation`,
        });
      }
      // Rotation activates BOTH arms as variants — a baseline arm has no variant
      // row to activate, so an experiment with a baseline arm cannot switch to
      // rotation. Reject up front (the compare-view button is also disabled).
      if (isBaselineArm(exp.variant_a_id) || isBaselineArm(exp.variant_b_id)) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message:
            'switching to rotation requires two real variants — create a variant from the current workflow first',
        });
      }
      deps.setVariantStatus(exp.variant_a_id, 'active');
      deps.setVariantStatus(exp.variant_b_id, 'active');
      if (input.weights) {
        deps.setVariantWeight(exp.variant_a_id, input.weights.a);
        deps.setVariantWeight(exp.variant_b_id, input.weights.b);
      }
      return { experimentId: exp.id, status: exp.status, winnerRunId: exp.winner_run_id };
    }),

  get: protectedProcedure
    .input(z.object({ experimentId: z.string().min(1) }))
    .query(async ({ input }): Promise<ExperimentRow | null> => {
      const deps = requireDeps();
      return getExperiment(deps.db, input.experimentId);
    }),

  listForProject: protectedProcedure
    .input(z.object({ projectId: z.number().int().positive() }))
    .query(async ({ input }): Promise<ExperimentRow[]> => {
      const deps = requireDeps();
      return listExperimentsForProject(deps.db, input.projectId);
    }),

  // -------------------------------------------------------------------------
  // Comparison reads (slice C) — additive; consumed by the compare view + dashboard
  // -------------------------------------------------------------------------

  /**
   * Assemble the full comparison payload for one experiment (per-arm status /
   * usage / eval / findings / entity counts + the pairwise verdict). Returns null
   * when the experiment does not exist.
   */
  getComparison: protectedProcedure
    .input(z.object({ experimentId: z.string().min(1) }))
    .query(async ({ input }): Promise<ExperimentComparisonPayload | null> => {
      const deps = requireDeps();
      const exp = getExperiment(deps.db, input.experimentId);
      if (!exp) return null;
      const comparison = readComparisonRow(deps.db, input.experimentId);
      const comparisonStatusValue: ComparisonStatus | 'absent' = comparison?.eval_status ?? 'absent';
      return {
        experimentId: exp.id,
        comparisonStatus: comparisonStatusValue,
        baseSha: comparison?.base_sha ?? exp.base_sha,
        snapshotAt: comparison?.snapshot_at ?? null,
        verdict: buildVerdict(comparison),
        armA: buildArmView(deps, exp.run_a_id, 'A', exp.variant_a_id),
        armB: buildArmView(deps, exp.run_b_id, 'B', exp.variant_b_id),
      };
    }),

  /**
   * The FROZEN per-arm diff texts (worktree-independent; works post-decide).
   * Returns null when no comparison row exists yet.
   */
  getComparisonDiffs: protectedProcedure
    .input(z.object({ experimentId: z.string().min(1) }))
    .query(async ({ input }): Promise<ExperimentComparisonDiffs | null> => {
      const deps = requireDeps();
      const exp = getExperiment(deps.db, input.experimentId);
      if (!exp) return null;
      const comparison = readComparisonRow(deps.db, input.experimentId);
      if (!comparison) return null;
      return {
        baseSha: comparison.base_sha,
        armA: {
          runId: comparison.run_id_a,
          label: variantLabel(deps, exp.variant_a_id),
          diff: comparison.diff_a_text ?? '',
        },
        armB: {
          runId: comparison.run_id_b,
          label: variantLabel(deps, exp.variant_b_id),
          diff: comparison.diff_b_text ?? '',
        },
      };
    }),

  /** Lightweight status probe (WorkflowSummaryPanel "View comparison" gate). */
  comparisonStatus: protectedProcedure
    .input(z.object({ experimentId: z.string().min(1) }))
    .query(async ({ input }): Promise<{ status: ComparisonStatus | 'absent' }> => {
      const deps = requireDeps();
      const row = deps.db
        .prepare('SELECT eval_status FROM experiment_comparisons WHERE experiment_id = ?')
        .get(input.experimentId) as { eval_status?: ComparisonStatus } | undefined;
      return { status: row?.eval_status ?? 'absent' };
    }),

  /**
   * Dashboard list rows (verdict + human decision + rerun-chain series key).
   * Optional projectId (nullable) + workflowId filters.
   */
  listForDashboard: protectedProcedure
    .input(
      z.object({
        projectId: z.number().int().positive().nullable().optional(),
        workflowId: z.string().min(1).optional(),
      }),
    )
    .query(async ({ input }): Promise<ExperimentSummary[]> => {
      const deps = requireDeps();
      const conds: string[] = [];
      const params: unknown[] = [];
      if (input.projectId !== null && input.projectId !== undefined) {
        conds.push('e.project_id = ?');
        params.push(input.projectId);
      }
      if (input.workflowId) {
        conds.push('e.workflow_id = ?');
        params.push(input.workflowId);
      }
      const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
      const rows = deps.db
        .prepare(
          `SELECT
             e.id AS experimentId, e.workflow_id AS workflowId, e.base_branch AS baseBranch,
             e.variant_a_id AS variantAId, e.variant_b_id AS variantBId,
             e.status AS status, e.winner_arm AS winnerArm, e.winner_run_id AS winnerRunId,
             e.decided_at AS decidedAt, e.created_at AS createdAt,
             e.rerun_of_experiment_id AS rerunOfExperimentId,
             va.label AS aLabel, vb.label AS bLabel,
             c.preference AS verdictPreference, c.confidence AS verdictConfidence
           FROM experiments e
           LEFT JOIN experiment_comparisons c ON c.experiment_id = e.id
           LEFT JOIN workflow_variants va ON va.id = e.variant_a_id
           LEFT JOIN workflow_variants vb ON vb.id = e.variant_b_id
           ${where}
           ORDER BY e.created_at DESC, e.id DESC`,
        )
        .all(...params) as Array<{
        experimentId: string;
        workflowId: string;
        baseBranch: string;
        variantAId: string;
        variantBId: string;
        status: ExperimentRow['status'];
        winnerArm: ExperimentArm | null;
        winnerRunId: string | null;
        decidedAt: string | null;
        createdAt: string;
        rerunOfExperimentId: string | null;
        aLabel: string | null;
        bLabel: string | null;
        verdictPreference: PairwisePreference | null;
        verdictConfidence: number | null;
      }>;

      return rows.map((row): ExperimentSummary => {
        const decision: ExperimentDecision | null =
          row.status !== 'decided'
            ? null
            : row.winnerArm === 'A'
              ? 'promote_a'
              : row.winnerArm === 'B'
                ? 'promote_b'
                : 'discard';
        return {
          experimentId: row.experimentId,
          workflowId: row.workflowId,
          baseBranch: row.baseBranch,
          variantAId: row.variantAId,
          variantBId: row.variantBId,
          armALabel: armVariantLabel(row.variantAId, row.aLabel),
          armBLabel: armVariantLabel(row.variantBId, row.bLabel),
          verdictPreference: row.verdictPreference,
          verdictConfidence: row.verdictConfidence,
          decision,
          status: row.status,
          decidedAt: row.decidedAt,
          createdAt: row.createdAt,
          rerunOfExperimentId: row.rerunOfExperimentId,
          seriesKey: seriesKey(row.workflowId, row.variantAId, row.variantBId),
        };
      });
    }),

  /**
   * Stale-diff recovery: delete the comparison row and re-snapshot + re-judge from
   * the arms' current worktrees (e.g. after a request-changes loop changed an
   * awaiting_review arm). Guard: the experiment must exist and still be
   * running|grading (decided/abandoned experiments have torn-down worktrees).
   */
  rerunComparison: protectedProcedure
    .input(z.object({ experimentId: z.string().min(1) }))
    .mutation(async ({ input }): Promise<{ experimentId: string; status: ComparisonStatus | 'absent' }> => {
      const deps = requireDeps();
      const exp = getExperiment(deps.db, input.experimentId);
      if (!exp) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `experiment ${input.experimentId} not found` });
      }
      if (exp.status !== 'running' && exp.status !== 'grading') {
        throw new TRPCError({
          code: 'CONFLICT',
          message: `experiment ${input.experimentId} must be running|grading to re-run the comparison`,
        });
      }
      // Clear any blocking decision review item minted for the OLD comparison
      // BEFORE deleting its row — decision_review_item_id lives only on that row,
      // so dropping it first would orphan the item (unresolvable forever: decide
      // resolves only the CURRENT row, and there is no FK/CASCADE). Fail-soft.
      resolveDecisionReviewItem(deps, input.experimentId);
      deps.db.prepare('DELETE FROM experiment_comparisons WHERE experiment_id = ?').run(input.experimentId);
      // AWAIT the re-snapshot so the fresh comparison row is inserted before we read
      // eval_status back — maybeSnapshotAndEnqueue captures both arms' diffs (git
      // I/O) before its INSERT, so a fire-and-forget call would let this SELECT race
      // the insert and return a spurious 'absent'.
      await deps.pairwiseMaybeSnapshot?.(input.experimentId);
      const row = deps.db
        .prepare('SELECT eval_status FROM experiment_comparisons WHERE experiment_id = ?')
        .get(input.experimentId) as { eval_status?: ComparisonStatus } | undefined;
      return { experimentId: input.experimentId, status: row?.eval_status ?? 'absent' };
    }),

  /**
   * Live "comparison ready" toast stream (all experiments). Emitted by the
   * PairwiseJudgeWorker when a comparison reaches a terminal status. Mirrors
   * events.onRunStatusChanged (eventToAsyncIterable over the module-level
   * experimentEvents emitter).
   */
  onComparisonReady: protectedProcedure.subscription(
    async function* ({ signal }): AsyncGenerator<ExperimentComparisonReadyEvent> {
      const abortSignal = signal ?? new AbortController().signal;
      const source = eventToAsyncIterable<ExperimentComparisonReadyEvent>(
        experimentEvents,
        'comparisonReady',
        abortSignal,
      );
      for await (const ev of source) {
        yield ev;
      }
    },
  ),
});
