/**
 * autoMintArtifacts — the orchestrator-side auto-mint hook for run artifacts.
 *
 * When a workflow step whose `WorkflowStep.outputArtifact` is set completes
 * (status='done'), the step-transition path calls `handleStepCompletion`, which
 * derives the artifact's identity from the entity DB and mints it through the
 * single ArtifactRouter chokepoint (op='create' UPSERTs by (runId, atype), so a
 * re-derive is idempotent). For TEMPLATED artifacts (idea-spec,
 * decomposed-stories) the CONTENT is re-derived on READ from the entity DB —
 * `payload_json` stays null; only the label/sourceRef/stepOrigin metadata is
 * minted here.
 *
 * FAIL-SOFT CONTRACT: this runs inside the step-transition path, which must NEVER
 * be broken by an observational side-effect. The entire body is wrapped in
 * try/catch; any failure (missing run row, no resolvable seed idea, ArtifactRouter
 * not initialized, a thrown query) is logged via the optional logger and SWALLOWED.
 * `handleStepCompletion` never throws and never rejects with a meaningful error to
 * the caller.
 *
 * Standalone-typecheck invariant: this file must NOT import from 'electron',
 * 'better-sqlite3', or any concrete service in main/src/services/* — it reaches
 * the DB only through the narrow DatabaseLike surface, mirroring
 * stepTransitionBridge.ts / runEntityOwnership.ts. ArtifactRouter is reached via
 * its singleton (already initialized at boot from main/src/index.ts).
 */
import { ArtifactRouter } from './artifactRouter';
import { listRunOwnedIdeaIds } from './runEntityOwnership';
import type { DatabaseLike, LoggerLike } from './types';
import { resolveWorkflowDefinition, type WorkflowStep } from '../../../shared/types/workflows';

// ---------------------------------------------------------------------------
// Step-origin labels (human-readable provenance shown on the artifact tab)
// ---------------------------------------------------------------------------

/** Phase·step provenance string stamped onto each auto-minted artifact. */
const STEP_ORIGIN: Record<string, string> = {
  context: 'Plan · get context',
  tasks: 'Refine · decompose into tasks',
};

// ---------------------------------------------------------------------------
// Internal row shapes (narrow projections — no `any`)
// ---------------------------------------------------------------------------

interface RunRow {
  projectId: number | null;
}

interface IdeaRow {
  ref: string | null;
  title: string | null;
}

// ---------------------------------------------------------------------------
// Definition / step resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the run's EFFECTIVE workflow definition and locate the step by id in
 * its flat step list. Mirrors the resolution in stepTransitionBridge.isValidStepId
 * / mcpQueryHandler.handleReportStep (resolveWorkflowDefinition is the runtime
 * source of truth that fully overrides the static WORKFLOW_DEFINITIONS seed).
 * Returns null when the run row is missing, the definition cannot be resolved, or
 * the step id is absent.
 */
function resolveStep(db: DatabaseLike, runId: string, stepId: string): WorkflowStep | null {
  const runRow = db
    .prepare(
      `SELECT w.name AS workflowName, w.spec_json AS specJson
         FROM workflow_runs r
         JOIN workflows w ON w.id = r.workflow_id
        WHERE r.id = ?`,
    )
    .get(runId) as { workflowName?: unknown; specJson?: unknown } | undefined;
  if (!runRow || typeof runRow.workflowName !== 'string') return null;

  const specJson = typeof runRow.specJson === 'string' ? runRow.specJson : null;
  const def = resolveWorkflowDefinition(runRow.workflowName, specJson);
  if (def === null) return null;

  return def.phases.flatMap((p) => p.steps).find((s) => s.id === stepId) ?? null;
}

/** Resolve the run's owning project id (workflow_runs.project_id), or null. */
function resolveProjectId(db: DatabaseLike, runId: string): number | null {
  const row = db
    .prepare('SELECT project_id AS projectId FROM workflow_runs WHERE id = ?')
    .get(runId) as RunRow | undefined;
  if (!row) return null;
  return typeof row.projectId === 'number' ? row.projectId : null;
}

/**
 * Resolve the single idea this run originates from for artifact derivation:
 * the FIRST of the run's owned ideas (seed_idea_id UNION run-created ideas, via
 * listRunOwnedIdeaIds). Returns null when the run owns no resolvable idea.
 */
function resolveOriginatingIdeaId(db: DatabaseLike, runId: string): string | null {
  const ownedIds = listRunOwnedIdeaIds(db, runId);
  return ownedIds.length > 0 ? ownedIds[0] : null;
}

// ---------------------------------------------------------------------------
// Per-atype derivation + mint
// ---------------------------------------------------------------------------

/**
 * idea-spec: label = the idea's title (falling back to its ref); sourceRef =
 * ideaId. Content is re-derived on read (mode 'template') so payloadJson is left
 * null. No resolvable idea → fail-soft (logs + returns without minting).
 */
async function mintIdeaSpec(
  db: DatabaseLike,
  runId: string,
  projectId: number,
  step: WorkflowStep,
  logger?: LoggerLike,
): Promise<void> {
  const ideaId = resolveOriginatingIdeaId(db, runId);
  if (ideaId === null) {
    logger?.debug('[autoMintArtifacts] idea-spec skipped — run owns no resolvable idea', { runId });
    return;
  }

  const ideaRow = db
    .prepare('SELECT ref AS ref, title AS title FROM ideas WHERE id = ?')
    .get(ideaId) as IdeaRow | undefined;
  if (!ideaRow) {
    logger?.debug('[autoMintArtifacts] idea-spec skipped — idea row not found', { runId, ideaId });
    return;
  }

  const title = typeof ideaRow.title === 'string' && ideaRow.title.length > 0 ? ideaRow.title : null;
  const ref = typeof ideaRow.ref === 'string' && ideaRow.ref.length > 0 ? ideaRow.ref : null;
  const label = title ?? ref ?? step.outputArtifact!.label;

  await ArtifactRouter.getInstance().apply(projectId, {
    op: 'create',
    runId,
    atype: 'idea-spec',
    label,
    sourceRef: ideaId,
    stepOrigin: STEP_ORIGIN[step.id] ?? null,
    isNew: true,
    actor: 'orchestrator',
  });
}

/**
 * Count an idea's epics + tasks. Mirrors TaskChangeRouter.collectDeleteCascade:
 * epics by originating_idea_id; tasks reachable directly (originating_idea_id)
 * UNION via a child epic (parent_epic_id IN epics), deduped.
 */
function countDecomposition(
  db: DatabaseLike,
  projectId: number,
  ideaId: string,
): { epicCount: number; taskCount: number } {
  const epics = db
    .prepare('SELECT id AS id FROM epics WHERE originating_idea_id = ? AND project_id = ?')
    .all(ideaId, projectId) as Array<{ id: unknown }>;
  const epicIds = epics
    .map((r) => r.id)
    .filter((id): id is string => typeof id === 'string');

  const taskIds = new Set<string>();

  const directTasks = db
    .prepare('SELECT id AS id FROM tasks WHERE originating_idea_id = ? AND project_id = ?')
    .all(ideaId, projectId) as Array<{ id: unknown }>;
  for (const r of directTasks) {
    if (typeof r.id === 'string') taskIds.add(r.id);
  }

  if (epicIds.length > 0) {
    const placeholders = epicIds.map(() => '?').join(',');
    const epicTasks = db
      .prepare(`SELECT id AS id FROM tasks WHERE parent_epic_id IN (${placeholders})`)
      .all(...epicIds) as Array<{ id: unknown }>;
    for (const r of epicTasks) {
      if (typeof r.id === 'string') taskIds.add(r.id);
    }
  }

  return { epicCount: epicIds.length, taskCount: taskIds.size };
}

/** Pluralize a noun by count (1 epic / 2 epics). Plain concatenation — no nested template literals. */
function pluralize(count: number, noun: string): string {
  return String(count) + ' ' + noun + (count === 1 ? '' : 's');
}

/**
 * decomposed-stories: label = short epic/task count string, e.g. "2 epics, 9
 * tasks". sourceRef = ideaId. Content is re-derived on read (mode 'template') so
 * payloadJson is left null. No resolvable idea → fail-soft.
 */
async function mintDecomposedStories(
  db: DatabaseLike,
  runId: string,
  projectId: number,
  step: WorkflowStep,
  logger?: LoggerLike,
): Promise<void> {
  const ideaId = resolveOriginatingIdeaId(db, runId);
  if (ideaId === null) {
    logger?.debug('[autoMintArtifacts] decomposed-stories skipped — run owns no resolvable idea', {
      runId,
    });
    return;
  }

  const { epicCount, taskCount } = countDecomposition(db, projectId, ideaId);
  // Build the label with plain string concatenation (no nested template literals).
  const label = pluralize(epicCount, 'epic') + ', ' + pluralize(taskCount, 'task');

  await ArtifactRouter.getInstance().apply(projectId, {
    op: 'create',
    runId,
    atype: 'decomposed-stories',
    label,
    sourceRef: ideaId,
    stepOrigin: STEP_ORIGIN[step.id] ?? null,
    isNew: true,
    actor: 'orchestrator',
  });
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Auto-mint the artifact a completed step produces, if any.
 *
 * Called from stepTransitionBridge AFTER a step_transition row is persisted, ONLY
 * for status='done'. Resolves the run's effective workflow definition, finds the
 * step by id; if `step.outputArtifact` is undefined, returns. Otherwise derives
 * the artifact identity from the entity DB and mints it via the ArtifactRouter
 * chokepoint (templated types leave payloadJson null — content is re-derived on
 * read).
 *
 * FAIL-SOFT: the whole body is wrapped in try/catch — any failure logs via
 * `logger` and returns. NEVER throws (the caller is in the step-transition path).
 *
 * @param db     Narrow DatabaseLike interface.
 * @param runId  The workflow_runs.id whose step just completed.
 * @param stepId The id of the completed step.
 * @param logger Optional LoggerLike for warn/debug-level fail-soft logging.
 */
export async function handleStepCompletion(
  db: DatabaseLike,
  runId: string,
  stepId: string,
  logger?: LoggerLike,
): Promise<void> {
  try {
    const step = resolveStep(db, runId, stepId);
    if (step === null || step.outputArtifact === undefined) return; // no artifact-producing step

    const projectId = resolveProjectId(db, runId);
    if (projectId === null) {
      logger?.debug('[autoMintArtifacts] skipped — no project_id for run', { runId, stepId });
      return;
    }

    if (step.outputArtifact.atype === 'idea-spec') {
      await mintIdeaSpec(db, runId, projectId, step, logger);
    } else if (step.outputArtifact.atype === 'decomposed-stories') {
      await mintDecomposedStories(db, runId, projectId, step, logger);
    }
    // Other atypes (screenshots/ui-prototype/generic) are not auto-minted from a
    // step completion in this milestone — they are agent/user canvas writes.
  } catch (err) {
    const msg = `[autoMintArtifacts] auto-mint failed for runId=${runId} stepId=${stepId} (fail-soft): ${
      err instanceof Error ? err.message : String(err)
    }`;
    if (logger) {
      logger.warn(msg, { runId, stepId });
    } else {
      console.warn(msg);
    }
  }
}
