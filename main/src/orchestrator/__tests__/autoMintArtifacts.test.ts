/**
 * Unit tests for autoMintArtifacts.handleStepCompletion — the orchestrator-side
 * auto-mint hook invoked from stepTransitionBridge on step completion.
 *
 * Covered:
 *  - planner 'context' step (outputArtifact atype='idea-spec') mints an idea-spec
 *    artifact whose sourceRef = the run's seed idea id, label = the idea title,
 *    stepOrigin = 'Plan · get context', mode='template', payload_json=NULL.
 *  - a run owning NO resolvable idea is FAIL-SOFT: no throw, no artifact minted.
 *  - planner 'tasks' step (outputArtifact atype='decomposed-stories') mints a
 *    decomposed-stories artifact whose label encodes the epic + task counts and
 *    whose sourceRef = the idea id.
 *  - a step with NO outputArtifact ('approve-idea') mints nothing.
 *  - an unknown run id is FAIL-SOFT (no throw, no mint).
 *  - terminal-status gate (H-automint-1): a FAILED or CANCELED run does NOT mint
 *    the templated artifact on the synthesized lifecycle 'done'; a 'completed'
 *    run still mints.
 *  - workflow-name gate (H-automint-2): a NON-planner workflow whose step
 *    declares a templated atype ('idea-spec') does NOT mint.
 *  - idempotency (H-automint-3): two 'context' completions yield ONE artifacts
 *    row and exactly ONE 'created' entity_event (no second 'created', no-delta
 *    re-derive appends no 'updated').
 *
 * DB: in-memory better-sqlite3 with migrations
 * 006/011/014/015/016/017/022/024/028/035 applied (mirrors reviewItemRouter.test.ts
 * buildDb + 017 seed-idea + 022 sprint_batch_tasks + 035 artifacts; 024/028 are
 * pulled in because the TaskChangeRouter create chokepoint writes the
 * ideas.attachments column). Entities are seeded through TaskChangeRouter so the
 * entity_events 'created' rows exist (the run-created-idea union read by
 * listRunOwnedIdeaIds), AND seed_idea_id (planner/ship) or a sprint_batch_tasks
 * link (standalone sprint) ties the run to its idea.
 *
 * Also covers handleRunStart — the run-start baseline path for sprint/ship that
 * mints idea-spec + decomposed-stories from the run's resolved idea (via the
 * sprint batch for a standalone sprint), gated to sprint/ship + non-terminal.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { handleStepCompletion, handleRunStart, handleEntityWrite } from '../autoMintArtifacts';
import { ArtifactRouter, artifactChangeEvents } from '../artifactRouter';
import { TaskChangeRouter, taskChangeEvents } from '../taskChangeRouter';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';

// ---------------------------------------------------------------------------
// Test DB builder: projects + 006 + 011 + 014 + 015 + 016 + 017 + 022 + 024 +
// 028 + 035 (022 brings sprint_batches/sprint_batch_tasks + workflow_runs.batch_id
// for the standalone-sprint batch->idea resolution path).
// ---------------------------------------------------------------------------

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj', '/tmp/p1');

  const migDir = join(__dirname, '..', '..', 'database', 'migrations');
  db.exec(readFileSync(join(migDir, '006_cyboflow_schema.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '011_workflow_step_tracking.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '014_native_tasks.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '015_entity_model_rebuild.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '016_review_items.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '017_run_seed_idea.sql'), 'utf-8'));
  // 024 (archived_at) + 028 (ideas.attachments) are required because the
  // TaskChangeRouter create chokepoint writes the ideas.attachments column.
  db.exec(readFileSync(join(migDir, '022_sprint_batches.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '024_archive_in_place.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '028_idea_attachments.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '035_artifacts.sql'), 'utf-8'));
  return db;
}

/**
 * Seed a built-in 'planner' run row. Seeded BEFORE entities so any entity
 * created with this runId satisfies the entity_events.run_id FK
 * (-> workflow_runs.id). seed_idea_id is stamped later via setSeedIdea.
 */
function seedPlannerRun(db: Database.Database, runId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-p', 1, 'planner', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
     VALUES (?, 'wf-p', 1, 'running', 'default')`,
  ).run(runId);
}

/** Stamp seed_idea_id on an existing run (migration 017). */
function setSeedIdea(db: Database.Database, runId: string, ideaId: string): void {
  db.prepare('UPDATE workflow_runs SET seed_idea_id = ? WHERE id = ?').run(ideaId, runId);
}

/** Stamp a lifecycle status on an existing run (mirrors transitionToFailed/Canceled). */
function setRunStatus(db: Database.Database, runId: string, status: string): void {
  db.prepare('UPDATE workflow_runs SET status = ? WHERE id = ?').run(status, runId);
}

/**
 * Seed a NON-planner CUSTOM workflow run whose single step declares an
 * outputArtifact of the (planner-only) `atype`. Used to assert the workflow-name
 * guard: a non-planner step declaring a templated atype must NOT mint. The run
 * row is seeded BEFORE entities so the entity_events.run_id FK holds.
 */
function seedCustomRunWithArtifactStep(
  db: Database.Database,
  runId: string,
  atype: 'idea-spec' | 'decomposed-stories',
): void {
  const specJson = JSON.stringify({
    id: 'my-custom-flow',
    phases: [
      {
        id: 'phase-1',
        label: 'Phase 1',
        color: '#3b6dd6',
        steps: [
          {
            id: 'context',
            name: 'Get context',
            agent: 'cyboflow-context',
            outputArtifact: { atype, label: 'Idea spec' },
          },
        ],
      },
    ],
  });
  db.prepare(
    `INSERT INTO workflows (id, project_id, name, spec_json) VALUES ('wf-custom', 1, 'my-custom-flow', ?)`,
  ).run(specJson);
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
     VALUES (?, 'wf-custom', 1, 'running', 'default')`,
  ).run(runId);
}

/**
 * Seed a built-in 'sprint' run with a `batch_id` (migration 022). A standalone
 * sprint has a NULL seed_idea_id and creates no ideas — it links to its idea only
 * through the tasks in its sprint batch (linkBatchTask below).
 */
function seedSprintRun(db: Database.Database, runId: string, batchId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-s', 1, 'sprint', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, batch_id)
     VALUES (?, 'wf-s', 1, 'running', 'default', ?)`,
  ).run(runId, batchId);
}

/**
 * Seed a built-in 'ship' run with a stamped seed_idea_id (ship seeds its idea like
 * planner; resolveOriginatingIdeaId resolves it via the owned-ideas path).
 */
function seedShipRun(db: Database.Database, runId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-ship', 1, 'ship', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
     VALUES (?, 'wf-ship', 1, 'running', 'default')`,
  ).run(runId);
}

/** Link a task into a sprint batch (sprint_batch_tasks, migration 022). */
function linkBatchTask(db: Database.Database, batchId: string, taskId: string): void {
  db.prepare('INSERT INTO sprint_batch_tasks (batch_id, task_id) VALUES (?, ?)').run(batchId, taskId);
}

interface EntityEventRow {
  kind: string;
}

/** All entity_events rows of entity_type='artifact' for a given artifact id, oldest-first. */
function readArtifactEvents(db: Database.Database, artifactId: string): EntityEventRow[] {
  return db
    .prepare(
      `SELECT kind FROM entity_events
        WHERE entity_type = 'artifact' AND entity_id = ?
        ORDER BY seq ASC`,
    )
    .all(artifactId) as EntityEventRow[];
}

interface ArtifactIdRow {
  id: string;
}

/** Resolve the single artifact id for a (run, atype), or undefined. */
function readArtifactId(db: Database.Database, runId: string, atype: string): string | undefined {
  const row = db
    .prepare('SELECT id FROM artifacts WHERE run_id = ? AND atype = ?')
    .get(runId, atype) as ArtifactIdRow | undefined;
  return row?.id;
}

interface ArtifactRow {
  atype: string;
  label: string;
  source_ref: string | null;
  step_origin: string | null;
  mode: string;
  payload_json: string | null;
  is_new: number;
}

function readArtifact(db: Database.Database, runId: string, atype: string): ArtifactRow | undefined {
  return db
    .prepare(
      `SELECT atype, label, source_ref, step_origin, mode, payload_json, is_new
         FROM artifacts WHERE run_id = ? AND atype = ?`,
    )
    .get(runId, atype) as ArtifactRow | undefined;
}

function artifactCount(db: Database.Database, runId: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM artifacts WHERE run_id = ?').get(runId) as { n: number }).n;
}

describe('autoMintArtifacts.handleStepCompletion', () => {
  afterEach(() => {
    ArtifactRouter._resetForTesting();
    artifactChangeEvents.removeAllListeners();
    TaskChangeRouter._resetForTesting();
    taskChangeEvents.removeAllListeners();
  });

  // -------------------------------------------------------------------------
  // idea-spec — 'context' step
  // -------------------------------------------------------------------------

  it("mints an idea-spec for the 'context' step (sourceRef = seed idea, label = title, template/null payload)", async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    // Seed the run first (so the entity_events.run_id FK holds), then create the
    // idea via the chokepoint attributed to the run, then stamp seed_idea_id —
    // so both the seed_idea_id path AND the run-created-idea union resolve it.
    seedPlannerRun(db, 'run-p');
    const { taskId: ideaId } = await TaskChangeRouter.getInstance().applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      title: 'Realtime habit streaks',
      // CONTENT GATE: idea-spec only mints when the idea has body/summary.
      summary: 'Track streaks live.',
      runId: 'run-p',
    });
    setSeedIdea(db, 'run-p', ideaId);

    await handleStepCompletion(adapter, 'run-p', 'context');

    const art = readArtifact(db, 'run-p', 'idea-spec');
    expect(art).toBeDefined();
    expect(art!.atype).toBe('idea-spec');
    expect(art!.source_ref).toBe(ideaId);
    expect(art!.label).toBe('Realtime habit streaks');
    expect(art!.step_origin).toBe('Plan · get context');
    // Templated artifact: content re-derived on read → mode 'template', payload null.
    expect(art!.mode).toBe('template');
    expect(art!.payload_json).toBeNull();
    expect(art!.is_new).toBe(1);
  });

  it('falls back to the idea ref for the idea-spec label when the title is empty', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    seedPlannerRun(db, 'run-p');
    const { taskId: ideaId } = await TaskChangeRouter.getInstance().applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      title: 'Temp',
      summary: 'has content so the gate passes',
      runId: 'run-p',
    });
    // Blank out the title so the label falls back to the ref.
    db.prepare("UPDATE ideas SET title = '' WHERE id = ?").run(ideaId);
    const ref = (db.prepare('SELECT ref FROM ideas WHERE id = ?').get(ideaId) as { ref: string }).ref;
    setSeedIdea(db, 'run-p', ideaId);

    await handleStepCompletion(adapter, 'run-p', 'context');

    const art = readArtifact(db, 'run-p', 'idea-spec');
    expect(art).toBeDefined();
    expect(art!.label).toBe(ref);
  });

  // -------------------------------------------------------------------------
  // fail-soft — no resolvable idea
  // -------------------------------------------------------------------------

  it('is fail-soft when the run owns no resolvable idea (no throw, no mint)', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    seedPlannerRun(db, 'run-noidea');

    await expect(handleStepCompletion(adapter, 'run-noidea', 'context')).resolves.toBeUndefined();
    expect(artifactCount(db, 'run-noidea')).toBe(0);
  });

  // -------------------------------------------------------------------------
  // decomposed-stories — 'tasks' step
  // -------------------------------------------------------------------------

  it("mints decomposed-stories for the 'tasks' step with epic + task counts in the label", async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);
    const router = TaskChangeRouter.getInstance();

    seedPlannerRun(db, 'run-p');
    const { taskId: ideaId } = await router.applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      title: 'Idea with children',
      runId: 'run-p',
    });
    // 2 epics off the idea.
    const { taskId: epicA } = await router.applyChange(1, {
      actor: 'orchestrator',
      entityType: 'epic',
      title: 'Epic A',
      originatingIdeaId: ideaId,
      runId: 'run-p',
    });
    await router.applyChange(1, {
      actor: 'orchestrator',
      entityType: 'epic',
      title: 'Epic B',
      originatingIdeaId: ideaId,
      runId: 'run-p',
    });
    // 2 tasks under epic A (via parent_epic_id) + 1 task directly off the idea
    // (originating_idea_id) = 3 distinct tasks.
    await router.applyChange(1, {
      actor: 'orchestrator',
      entityType: 'task',
      title: 'Task 1',
      parentEpicId: epicA,
      runId: 'run-p',
    });
    await router.applyChange(1, {
      actor: 'orchestrator',
      entityType: 'task',
      title: 'Task 2',
      parentEpicId: epicA,
      runId: 'run-p',
    });
    await router.applyChange(1, {
      actor: 'orchestrator',
      entityType: 'task',
      title: 'Task 3',
      originatingIdeaId: ideaId,
      runId: 'run-p',
    });

    setSeedIdea(db, 'run-p', ideaId);

    await handleStepCompletion(adapter, 'run-p', 'tasks');

    const art = readArtifact(db, 'run-p', 'decomposed-stories');
    expect(art).toBeDefined();
    expect(art!.atype).toBe('decomposed-stories');
    expect(art!.source_ref).toBe(ideaId);
    expect(art!.label).toBe('2 epics, 3 tasks');
    expect(art!.step_origin).toBe('Refine · decompose into tasks');
    expect(art!.mode).toBe('template');
    expect(art!.payload_json).toBeNull();
  });

  it('singularizes the decomposed-stories label for a single epic and single task', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);
    const router = TaskChangeRouter.getInstance();

    seedPlannerRun(db, 'run-p');
    const { taskId: ideaId } = await router.applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      title: 'Solo idea',
      runId: 'run-p',
    });
    const { taskId: epic } = await router.applyChange(1, {
      actor: 'orchestrator',
      entityType: 'epic',
      title: 'Only epic',
      originatingIdeaId: ideaId,
      runId: 'run-p',
    });
    await router.applyChange(1, {
      actor: 'orchestrator',
      entityType: 'task',
      title: 'Only task',
      parentEpicId: epic,
      runId: 'run-p',
    });
    setSeedIdea(db, 'run-p', ideaId);

    await handleStepCompletion(adapter, 'run-p', 'tasks');

    const art = readArtifact(db, 'run-p', 'decomposed-stories');
    expect(art!.label).toBe('1 epic, 1 task');
  });

  // -------------------------------------------------------------------------
  // no outputArtifact / unknown run — no mint
  // -------------------------------------------------------------------------

  it("mints nothing for a step without outputArtifact ('approve-idea')", async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    seedPlannerRun(db, 'run-p');
    const { taskId: ideaId } = await TaskChangeRouter.getInstance().applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      title: 'Idea',
      runId: 'run-p',
    });
    setSeedIdea(db, 'run-p', ideaId);

    await handleStepCompletion(adapter, 'run-p', 'approve-idea');

    expect(artifactCount(db, 'run-p')).toBe(0);
  });

  it('is fail-soft for an unknown run id (no throw, no mint)', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    await expect(handleStepCompletion(adapter, 'no-such-run', 'context')).resolves.toBeUndefined();
    expect((db.prepare('SELECT COUNT(*) AS n FROM artifacts').get() as { n: number }).n).toBe(0);
  });

  // -------------------------------------------------------------------------
  // terminal-status gate (finding H-automint-1) — failed/canceled run does NOT
  // mint the templated artifact on the synthesized lifecycle 'done'.
  // -------------------------------------------------------------------------

  it("does NOT mint idea-spec when the run has already FAILED (synthesized 'context' done)", async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    seedPlannerRun(db, 'run-failed');
    const { taskId: ideaId } = await TaskChangeRouter.getInstance().applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      title: 'Realtime habit streaks',
      runId: 'run-failed',
    });
    setSeedIdea(db, 'run-failed', ideaId);
    // The failed lifecycle transition stamps status='failed' BEFORE the
    // synthesized emitStep(runId,'done') fires — so it is terminal here.
    setRunStatus(db, 'run-failed', 'failed');

    await expect(handleStepCompletion(adapter, 'run-failed', 'context')).resolves.toBeUndefined();
    expect(artifactCount(db, 'run-failed')).toBe(0);
  });

  it("does NOT mint idea-spec when the run has already CANCELED (synthesized 'context' done)", async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    seedPlannerRun(db, 'run-canceled');
    const { taskId: ideaId } = await TaskChangeRouter.getInstance().applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      title: 'Realtime habit streaks',
      runId: 'run-canceled',
    });
    setSeedIdea(db, 'run-canceled', ideaId);
    setRunStatus(db, 'run-canceled', 'canceled');

    await expect(handleStepCompletion(adapter, 'run-canceled', 'context')).resolves.toBeUndefined();
    expect(artifactCount(db, 'run-canceled')).toBe(0);
  });

  it("STILL mints idea-spec when the run is 'completed' (a completed run produced its artifact)", async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    seedPlannerRun(db, 'run-done');
    const { taskId: ideaId } = await TaskChangeRouter.getInstance().applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      title: 'Realtime habit streaks',
      summary: 'Track streaks live.',
      runId: 'run-done',
    });
    setSeedIdea(db, 'run-done', ideaId);
    setRunStatus(db, 'run-done', 'completed');

    await handleStepCompletion(adapter, 'run-done', 'context');

    const art = readArtifact(db, 'run-done', 'idea-spec');
    expect(art).toBeDefined();
    expect(art!.source_ref).toBe(ideaId);
  });

  // -------------------------------------------------------------------------
  // workflow-name gate (finding H-automint-2) — a NON-planner workflow whose
  // step declares a templated atype must NOT mint against the run's owned ideas.
  // -------------------------------------------------------------------------

  it('does NOT mint idea-spec for a NON-planner workflow declaring atype idea-spec', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    seedCustomRunWithArtifactStep(db, 'run-custom', 'idea-spec');
    // The custom run still OWNS an idea (so the only thing keeping it from
    // minting is the workflow-name guard, not a missing idea).
    const { taskId: ideaId } = await TaskChangeRouter.getInstance().applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      title: 'Idea owned by a custom run',
      runId: 'run-custom',
    });
    setSeedIdea(db, 'run-custom', ideaId);

    await expect(handleStepCompletion(adapter, 'run-custom', 'context')).resolves.toBeUndefined();
    expect(artifactCount(db, 'run-custom')).toBe(0);
  });

  // -------------------------------------------------------------------------
  // idempotency (finding H-automint-3) — a re-derive UPSERTs the SAME artifact
  // row and logs NO second 'created' entity_event (no-delta on unchanged label).
  // -------------------------------------------------------------------------

  it("is idempotent: two 'context' completions yield ONE artifact row and exactly ONE 'created' event", async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    seedPlannerRun(db, 'run-idem');
    const { taskId: ideaId } = await TaskChangeRouter.getInstance().applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      title: 'Realtime habit streaks',
      summary: 'Track streaks live.',
      runId: 'run-idem',
    });
    setSeedIdea(db, 'run-idem', ideaId);

    await handleStepCompletion(adapter, 'run-idem', 'context');
    await handleStepCompletion(adapter, 'run-idem', 'context');

    // Exactly one artifacts row for (run, atype).
    expect(artifactCount(db, 'run-idem')).toBe(1);
    const artifactId = readArtifactId(db, 'run-idem', 'idea-spec');
    expect(artifactId).toBeDefined();

    // The second re-derive is a no-delta UPSERT (label unchanged) → it appends NO
    // new entity_event, so there is exactly ONE 'created' row and NO 'updated' row.
    const events = readArtifactEvents(db, artifactId!);
    expect(events.length).toBe(1);
    expect(events[0].kind).toBe('created');
    expect(events.filter((e) => e.kind === 'updated').length).toBe(0);
  });
});

// ===========================================================================
// handleRunStart — the run-start baseline path (sprint / ship).
// ===========================================================================

describe('autoMintArtifacts.handleRunStart (sprint/ship baseline)', () => {
  afterEach(() => {
    ArtifactRouter._resetForTesting();
    artifactChangeEvents.removeAllListeners();
    TaskChangeRouter._resetForTesting();
    taskChangeEvents.removeAllListeners();
  });

  /**
   * Seed an idea + a 2-epic / 3-task decomposition OWNED BY A PLANNER run, and
   * return the idea + the three task ids. A sprint run under test does NOT own
   * these (its seed_idea_id is null and it created nothing), so it reaches the
   * idea only via its sprint batch — exercising resolveRunBatchIdeaId.
   */
  async function seedDecomposedIdea(
    db: Database.Database,
    ownerRunId: string,
  ): Promise<{ ideaId: string; taskIds: string[] }> {
    seedPlannerRun(db, ownerRunId);
    const router = TaskChangeRouter.getInstance();
    const { taskId: ideaId } = await router.applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      title: 'Add a simple sandbox website',
      // CONTENT GATE: idea-spec needs body/summary to mint.
      summary: 'A small sandbox site.',
      runId: ownerRunId,
    });
    const { taskId: epicA } = await router.applyChange(1, {
      actor: 'orchestrator',
      entityType: 'epic',
      title: 'Epic A',
      originatingIdeaId: ideaId,
      runId: ownerRunId,
    });
    await router.applyChange(1, {
      actor: 'orchestrator',
      entityType: 'epic',
      title: 'Epic B',
      originatingIdeaId: ideaId,
      runId: ownerRunId,
    });
    const t1 = await router.applyChange(1, {
      actor: 'orchestrator',
      entityType: 'task',
      title: 'Task 1',
      parentEpicId: epicA,
      runId: ownerRunId,
    });
    const t2 = await router.applyChange(1, {
      actor: 'orchestrator',
      entityType: 'task',
      title: 'Task 2',
      originatingIdeaId: ideaId,
      runId: ownerRunId,
    });
    const t3 = await router.applyChange(1, {
      actor: 'orchestrator',
      entityType: 'task',
      title: 'Task 3',
      originatingIdeaId: ideaId,
      runId: ownerRunId,
    });
    return { ideaId, taskIds: [t1.taskId, t2.taskId, t3.taskId] };
  }

  // -------------------------------------------------------------------------
  // standalone sprint — idea resolved via the sprint batch
  // -------------------------------------------------------------------------

  it('mints idea-spec + decomposed-stories for a standalone sprint via its batch idea', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    const { ideaId, taskIds } = await seedDecomposedIdea(db, 'run-plan');
    seedSprintRun(db, 'run-sprint', 'batch-1');
    for (const tid of taskIds) linkBatchTask(db, 'batch-1', tid);

    await handleRunStart(adapter, 'run-sprint');

    const spec = readArtifact(db, 'run-sprint', 'idea-spec');
    expect(spec).toBeDefined();
    expect(spec!.source_ref).toBe(ideaId);
    expect(spec!.label).toBe('Add a simple sandbox website');
    expect(spec!.step_origin).toBe('Sprint · run start');
    expect(spec!.mode).toBe('template');
    expect(spec!.payload_json).toBeNull();

    const stories = readArtifact(db, 'run-sprint', 'decomposed-stories');
    expect(stories).toBeDefined();
    expect(stories!.source_ref).toBe(ideaId);
    expect(stories!.label).toBe('2 epics, 3 tasks');
    expect(stories!.step_origin).toBe('Sprint · run start');
  });

  it("resolves the sprint idea via the run's task_id when the batch has no tasks", async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    const { ideaId, taskIds } = await seedDecomposedIdea(db, 'run-plan');
    // A batch with NO linked tasks, but the run carries a single task_id whose
    // originating idea is the one to resolve (resolveRunBatchIdeaId fallback 2).
    seedSprintRun(db, 'run-taskid', 'batch-empty');
    db.prepare('UPDATE workflow_runs SET task_id = ? WHERE id = ?').run(taskIds[0], 'run-taskid');

    await handleRunStart(adapter, 'run-taskid');

    expect(readArtifact(db, 'run-taskid', 'idea-spec')!.source_ref).toBe(ideaId);
    expect(readArtifact(db, 'run-taskid', 'decomposed-stories')!.source_ref).toBe(ideaId);
  });

  // -------------------------------------------------------------------------
  // ship — idea resolved via the owned (seed_idea_id) path
  // -------------------------------------------------------------------------

  it('mints idea-spec (NOT decomposed-stories) for a ship run with no decomposition yet', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    seedShipRun(db, 'run-ship');
    const { taskId: ideaId } = await TaskChangeRouter.getInstance().applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      title: 'Ship this idea',
      summary: 'Ship it end-to-end.',
      runId: 'run-ship',
    });
    setSeedIdea(db, 'run-ship', ideaId);

    await handleRunStart(adapter, 'run-ship');

    const spec = readArtifact(db, 'run-ship', 'idea-spec');
    expect(spec).toBeDefined();
    expect(spec!.source_ref).toBe(ideaId);
    expect(spec!.label).toBe('Ship this idea');
    expect(spec!.step_origin).toBe('Ship · run start');
    // CONTENT GATE: no epics/tasks yet → decomposed-stories is SKIPPED at start.
    expect(readArtifact(db, 'run-ship', 'decomposed-stories')).toBeUndefined();
  });

  it('mints BOTH baselines for a ship run that already has a decomposition', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    seedShipRun(db, 'run-ship-decomp');
    const router = TaskChangeRouter.getInstance();
    const { taskId: ideaId } = await router.applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      title: 'Ship with stories',
      summary: 'Has a decomposition.',
      runId: 'run-ship-decomp',
    });
    await router.applyChange(1, {
      actor: 'orchestrator',
      entityType: 'task',
      title: 'A direct task',
      originatingIdeaId: ideaId,
      runId: 'run-ship-decomp',
    });
    setSeedIdea(db, 'run-ship-decomp', ideaId);

    await handleRunStart(adapter, 'run-ship-decomp');

    expect(readArtifact(db, 'run-ship-decomp', 'idea-spec')).toBeDefined();
    const stories = readArtifact(db, 'run-ship-decomp', 'decomposed-stories');
    expect(stories).toBeDefined();
    expect(stories!.label).toBe('0 epics, 1 task');
  });

  // -------------------------------------------------------------------------
  // planner — run-start mints the templated baselines too (the agent never
  // reports a step 'done', so the step-completion path never fires; this is the
  // deterministic source of the planner idea-spec / decomposed-stories tabs).
  // -------------------------------------------------------------------------

  it('mints idea-spec (NOT decomposed-stories) for a SEEDED planner run with no decomposition', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    seedPlannerRun(db, 'run-pl');
    const { taskId: ideaId } = await TaskChangeRouter.getInstance().applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      title: 'Planner idea',
      summary: 'A planner idea with a spec.',
      runId: 'run-pl',
    });
    setSeedIdea(db, 'run-pl', ideaId);

    await handleRunStart(adapter, 'run-pl');

    const spec = readArtifact(db, 'run-pl', 'idea-spec');
    expect(spec).toBeDefined();
    expect(spec!.source_ref).toBe(ideaId);
    expect(spec!.label).toBe('Planner idea');
    expect(spec!.step_origin).toBe('Plan · run start');
    expect(spec!.mode).toBe('template');
    expect(spec!.payload_json).toBeNull();
    // CONTENT GATE: no decomposition yet → decomposed-stories is SKIPPED at start.
    expect(readArtifact(db, 'run-pl', 'decomposed-stories')).toBeUndefined();
  });

  it('mints idea-spec for a planner run whose idea was CREATED during the run (no seed_idea_id)', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    // Raw-prompt planner: the idea is created during 'context' (owned via
    // entity_events.run_id), never stamped as seed_idea_id. resolveOriginatingIdeaId
    // resolves it through listRunOwnedIdeaIds, so handleRunStart finds it.
    seedPlannerRun(db, 'run-pl-created');
    const { taskId: ideaId } = await TaskChangeRouter.getInstance().applyChange(1, {
      actor: 'agent:cyboflow-context',
      entityType: 'idea',
      title: 'Created-in-run idea',
      summary: 'Created during context.',
      runId: 'run-pl-created',
    });

    await handleRunStart(adapter, 'run-pl-created');

    expect(readArtifact(db, 'run-pl-created', 'idea-spec')!.source_ref).toBe(ideaId);
    // No decomposition yet → content-gated skip.
    expect(readArtifact(db, 'run-pl-created', 'decomposed-stories')).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // terminal gate — a failed/canceled sprint does not mint
  // -------------------------------------------------------------------------

  it('does NOT mint a baseline when the sprint run has already FAILED', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    const { taskIds } = await seedDecomposedIdea(db, 'run-plan');
    seedSprintRun(db, 'run-sprint-failed', 'batch-f');
    for (const tid of taskIds) linkBatchTask(db, 'batch-f', tid);
    setRunStatus(db, 'run-sprint-failed', 'failed');

    await expect(handleRunStart(adapter, 'run-sprint-failed')).resolves.toBeUndefined();
    expect(artifactCount(db, 'run-sprint-failed')).toBe(0);
  });

  // -------------------------------------------------------------------------
  // fail-soft — sprint that resolves no idea / unknown run
  // -------------------------------------------------------------------------

  it('is fail-soft when a sprint run resolves no idea (empty batch, no task_id)', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    seedSprintRun(db, 'run-sprint-empty', 'batch-empty');

    await expect(handleRunStart(adapter, 'run-sprint-empty')).resolves.toBeUndefined();
    expect(artifactCount(db, 'run-sprint-empty')).toBe(0);
  });

  it('is fail-soft for an unknown run id (no throw, no mint)', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    await expect(handleRunStart(adapter, 'no-such-run')).resolves.toBeUndefined();
    expect((db.prepare('SELECT COUNT(*) AS n FROM artifacts').get() as { n: number }).n).toBe(0);
  });

  // -------------------------------------------------------------------------
  // idempotency — two run-start calls yield ONE row per atype
  // -------------------------------------------------------------------------

  it('is idempotent: two run-start calls yield ONE artifact row per atype', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    const { taskIds } = await seedDecomposedIdea(db, 'run-plan');
    seedSprintRun(db, 'run-sprint-idem', 'batch-i');
    for (const tid of taskIds) linkBatchTask(db, 'batch-i', tid);

    await handleRunStart(adapter, 'run-sprint-idem');
    await handleRunStart(adapter, 'run-sprint-idem');

    // One idea-spec + one decomposed-stories = 2 rows total, no duplicates.
    expect(artifactCount(db, 'run-sprint-idem')).toBe(2);
    const specId = readArtifactId(db, 'run-sprint-idem', 'idea-spec');
    const specEvents = readArtifactEvents(db, specId!);
    expect(specEvents.length).toBe(1);
    expect(specEvents[0].kind).toBe('created');
  });
});

// ===========================================================================
// CONTENT GATE — no empty artifact ever appears.
// ===========================================================================

describe('autoMintArtifacts content gate (no empty mints)', () => {
  afterEach(() => {
    ArtifactRouter._resetForTesting();
    artifactChangeEvents.removeAllListeners();
    TaskChangeRouter._resetForTesting();
    taskChangeEvents.removeAllListeners();
  });

  it('does NOT mint idea-spec for a bare idea (no body, no summary)', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    seedPlannerRun(db, 'run-bare');
    const { taskId: ideaId } = await TaskChangeRouter.getInstance().applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      title: 'Bare idea',
      runId: 'run-bare',
    });
    setSeedIdea(db, 'run-bare', ideaId);

    await handleStepCompletion(adapter, 'run-bare', 'context');
    expect(readArtifact(db, 'run-bare', 'idea-spec')).toBeUndefined();
  });

  it('mints idea-spec when the idea has ONLY a body (no summary)', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    seedPlannerRun(db, 'run-body');
    const { taskId: ideaId } = await TaskChangeRouter.getInstance().applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      title: 'Idea with body only',
      body: '# Spec\n\nSome detail.',
      runId: 'run-body',
    });
    setSeedIdea(db, 'run-body', ideaId);

    await handleStepCompletion(adapter, 'run-body', 'context');
    expect(readArtifact(db, 'run-body', 'idea-spec')).toBeDefined();
  });

  it('does NOT mint decomposed-stories when the idea has no decomposition (count 0)', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    seedPlannerRun(db, 'run-nodecomp');
    const { taskId: ideaId } = await TaskChangeRouter.getInstance().applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      title: 'Undecomposed idea',
      summary: 'no children yet',
      runId: 'run-nodecomp',
    });
    setSeedIdea(db, 'run-nodecomp', ideaId);

    await handleStepCompletion(adapter, 'run-nodecomp', 'tasks');
    expect(readArtifact(db, 'run-nodecomp', 'decomposed-stories')).toBeUndefined();
  });
});

// ===========================================================================
// handleEntityWrite — content-driven mint fired off each MCP entity write.
// ===========================================================================

describe('autoMintArtifacts.handleEntityWrite', () => {
  afterEach(() => {
    ArtifactRouter._resetForTesting();
    artifactChangeEvents.removeAllListeners();
    TaskChangeRouter._resetForTesting();
    taskChangeEvents.removeAllListeners();
  });

  it("mints idea-spec on an 'idea' write for a planner run (step_origin = Plan · idea spec)", async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    seedPlannerRun(db, 'run-ew');
    const { taskId: ideaId } = await TaskChangeRouter.getInstance().applyChange(1, {
      actor: 'agent:cyboflow-context',
      entityType: 'idea',
      title: 'A content-driven idea',
      summary: 'with a spec',
      runId: 'run-ew',
    });

    await handleEntityWrite(adapter, 'run-ew', 'idea');

    const spec = readArtifact(db, 'run-ew', 'idea-spec');
    expect(spec).toBeDefined();
    expect(spec!.source_ref).toBe(ideaId);
    expect(spec!.step_origin).toBe('Plan · idea spec');
  });

  it("mints decomposed-stories on a 'task' write (step_origin = Plan · decomposition)", async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    seedPlannerRun(db, 'run-ew2');
    const router = TaskChangeRouter.getInstance();
    const { taskId: ideaId } = await router.applyChange(1, {
      actor: 'agent:cyboflow-context',
      entityType: 'idea',
      title: 'Idea',
      summary: 's',
      runId: 'run-ew2',
    });
    await router.applyChange(1, {
      actor: 'orchestrator',
      entityType: 'task',
      title: 'Direct task',
      originatingIdeaId: ideaId,
      runId: 'run-ew2',
    });

    await handleEntityWrite(adapter, 'run-ew2', 'task');

    const stories = readArtifact(db, 'run-ew2', 'decomposed-stories');
    expect(stories).toBeDefined();
    expect(stories!.source_ref).toBe(ideaId);
    expect(stories!.label).toBe('0 epics, 1 task');
    expect(stories!.step_origin).toBe('Plan · decomposition');
  });

  it("mints decomposed-stories on an 'epic' write", async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    seedPlannerRun(db, 'run-ew3');
    const router = TaskChangeRouter.getInstance();
    const { taskId: ideaId } = await router.applyChange(1, {
      actor: 'agent:cyboflow-context',
      entityType: 'idea',
      title: 'Idea',
      summary: 's',
      runId: 'run-ew3',
    });
    await router.applyChange(1, {
      actor: 'orchestrator',
      entityType: 'epic',
      title: 'Epic 1',
      originatingIdeaId: ideaId,
      runId: 'run-ew3',
    });

    await handleEntityWrite(adapter, 'run-ew3', 'epic');

    const stories = readArtifact(db, 'run-ew3', 'decomposed-stories');
    expect(stories).toBeDefined();
    expect(stories!.label).toBe('1 epic, 0 tasks');
  });

  it('is content-gated: a task write before any decomposition mints nothing, then mints once a task exists', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    seedPlannerRun(db, 'run-ew-gate');
    const router = TaskChangeRouter.getInstance();
    const { taskId: ideaId } = await router.applyChange(1, {
      actor: 'agent:cyboflow-context',
      entityType: 'idea',
      title: 'Idea',
      summary: 's',
      runId: 'run-ew-gate',
    });

    // No tasks yet → fire on 'task' is a content-gated no-op.
    await handleEntityWrite(adapter, 'run-ew-gate', 'task');
    expect(readArtifact(db, 'run-ew-gate', 'decomposed-stories')).toBeUndefined();

    // Add a task, then fire again → now it mints.
    await router.applyChange(1, {
      actor: 'orchestrator',
      entityType: 'task',
      title: 'T',
      originatingIdeaId: ideaId,
      runId: 'run-ew-gate',
    });
    await handleEntityWrite(adapter, 'run-ew-gate', 'task');
    expect(readArtifact(db, 'run-ew-gate', 'decomposed-stories')).toBeDefined();
  });

  it('refreshes the decomposed-stories count label as tasks are added (idempotent UPSERT)', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    seedPlannerRun(db, 'run-ew-refresh');
    const router = TaskChangeRouter.getInstance();
    const { taskId: ideaId } = await router.applyChange(1, {
      actor: 'agent:cyboflow-context',
      entityType: 'idea',
      title: 'Idea',
      summary: 's',
      runId: 'run-ew-refresh',
    });

    await router.applyChange(1, {
      actor: 'orchestrator',
      entityType: 'task',
      title: 'T1',
      originatingIdeaId: ideaId,
      runId: 'run-ew-refresh',
    });
    await handleEntityWrite(adapter, 'run-ew-refresh', 'task');
    expect(readArtifact(db, 'run-ew-refresh', 'decomposed-stories')!.label).toBe('0 epics, 1 task');

    await router.applyChange(1, {
      actor: 'orchestrator',
      entityType: 'task',
      title: 'T2',
      originatingIdeaId: ideaId,
      runId: 'run-ew-refresh',
    });
    await handleEntityWrite(adapter, 'run-ew-refresh', 'task');

    // Still ONE row (UPSERT), but the label now reflects the live count.
    expect(artifactCount(db, 'run-ew-refresh')).toBe(1);
    expect(readArtifact(db, 'run-ew-refresh', 'decomposed-stories')!.label).toBe('0 epics, 2 tasks');
  });

  it('does NOT mint for a SPRINT run (only planner/ship are content-driven)', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    // A sprint run owning an idea with content — handleEntityWrite still skips it
    // (sprint mints its baselines at run start, not per entity write).
    const router = TaskChangeRouter.getInstance();
    seedPlannerRun(db, 'run-owner');
    const { taskId: ideaId } = await router.applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      title: 'Idea',
      summary: 's',
      runId: 'run-owner',
    });
    const { taskId } = await router.applyChange(1, {
      actor: 'orchestrator',
      entityType: 'task',
      title: 'T',
      originatingIdeaId: ideaId,
      runId: 'run-owner',
    });
    seedSprintRun(db, 'run-sprint-ew', 'batch-ew');
    linkBatchTask(db, 'batch-ew', taskId);

    await handleEntityWrite(adapter, 'run-sprint-ew', 'task');
    expect(artifactCount(db, 'run-sprint-ew')).toBe(0);
  });

  it('is fail-soft for an unknown run id (no throw, no mint)', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    await expect(handleEntityWrite(adapter, 'no-such-run', 'idea')).resolves.toBeUndefined();
    expect((db.prepare('SELECT COUNT(*) AS n FROM artifacts').get() as { n: number }).n).toBe(0);
  });
});

// ===========================================================================
// FIX D regression — a task created by the planner with NO explicit lineage is
// stamped with the run's seed idea (originating_idea_id), so the small-idea
// decomposition (tasks directly under the idea, no epics) is VISIBLE/counted.
// ===========================================================================

describe('decomposed task lineage (FIX D)', () => {
  afterEach(() => {
    ArtifactRouter._resetForTesting();
    artifactChangeEvents.removeAllListeners();
    TaskChangeRouter._resetForTesting();
    taskChangeEvents.removeAllListeners();
  });

  it("stamps originating_idea_id from the run's seed idea on a task created with no lineage", async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    seedPlannerRun(db, 'run-d');
    const router = TaskChangeRouter.getInstance();
    const { taskId: ideaId } = await router.applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      title: 'Add a simple sandbox website',
      summary: 'small idea',
      runId: 'run-d',
    });
    setSeedIdea(db, 'run-d', ideaId);

    // The planner creates a task with NO parentEpicId and NO originatingIdeaId
    // (exactly the small-idea decomposition path that was previously invisible).
    const { taskId } = await router.applyChange(1, {
      actor: 'agent:cyboflow-decompose',
      entityType: 'task',
      title: 'Build the sandbox page',
      runId: 'run-d',
    });

    // The create chokepoint stamped the run's seed idea onto the task.
    const row = db
      .prepare('SELECT originating_idea_id AS oid, parent_epic_id AS pid FROM tasks WHERE id = ?')
      .get(taskId) as { oid: string | null; pid: string | null };
    expect(row.oid).toBe(ideaId);
    expect(row.pid).toBeNull();
  });

  it('counts the directly-linked task in decomposed-stories (label reflects it)', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    seedPlannerRun(db, 'run-d2');
    const router = TaskChangeRouter.getInstance();
    const { taskId: ideaId } = await router.applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      title: 'Small idea',
      summary: 's',
      runId: 'run-d2',
    });
    setSeedIdea(db, 'run-d2', ideaId);

    // Two tasks created with no lineage — both stamped with the seed idea.
    await router.applyChange(1, { actor: 'agent:cyboflow-decompose', entityType: 'task', title: 'T1', runId: 'run-d2' });
    await router.applyChange(1, { actor: 'agent:cyboflow-decompose', entityType: 'task', title: 'T2', runId: 'run-d2' });

    await handleStepCompletion(adapter, 'run-d2', 'tasks');

    const art = readArtifact(db, 'run-d2', 'decomposed-stories');
    expect(art).toBeDefined();
    // 0 epics but 2 tasks directly under the idea (previously this was "0 tasks").
    expect(art!.label).toBe('0 epics, 2 tasks');
  });

  it('does NOT stamp the seed idea when the caller passed an explicit originatingIdeaId', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    seedPlannerRun(db, 'run-d3');
    const router = TaskChangeRouter.getInstance();
    // Seed idea = the run's seed; a SECOND idea is the explicit target.
    const { taskId: seedIdeaId } = await router.applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      title: 'Seed idea',
      summary: 's',
      runId: 'run-d3',
    });
    const { taskId: otherIdeaId } = await router.applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      title: 'Other idea',
      summary: 's',
      runId: 'run-d3',
    });
    setSeedIdea(db, 'run-d3', seedIdeaId);

    const { taskId } = await router.applyChange(1, {
      actor: 'orchestrator',
      entityType: 'task',
      title: 'Explicitly-linked task',
      originatingIdeaId: otherIdeaId,
      runId: 'run-d3',
    });

    const row = db
      .prepare('SELECT originating_idea_id AS oid FROM tasks WHERE id = ?')
      .get(taskId) as { oid: string | null };
    // The explicit link wins — the seed-idea stamp only fills a NULL.
    expect(row.oid).toBe(otherIdeaId);
  });

  it('leaves originating_idea_id NULL for a task created outside any run (no seed)', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    // No runId on the change → the stamp branch is skipped entirely.
    const { taskId } = await TaskChangeRouter.getInstance().applyChange(1, {
      actor: 'user',
      entityType: 'task',
      title: 'Orphan task',
    });
    const row = db
      .prepare('SELECT originating_idea_id AS oid FROM tasks WHERE id = ?')
      .get(taskId) as { oid: string | null };
    expect(row.oid).toBeNull();
  });
});
