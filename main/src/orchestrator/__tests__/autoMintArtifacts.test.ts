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
 *
 * DB: in-memory better-sqlite3 with migrations 006/011/014/015/016/017/024/028/029
 * applied (mirrors reviewItemRouter.test.ts buildDb + 017 seed-idea + 029
 * artifacts; 024/028 are pulled in because the TaskChangeRouter create chokepoint
 * writes the ideas.attachments column). Entities are seeded through TaskChangeRouter so the entity_events
 * 'created' rows exist (the run-created-idea union read by listRunOwnedIdeaIds),
 * AND seed_idea_id is stamped on the run.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { handleStepCompletion } from '../autoMintArtifacts';
import { ArtifactRouter, artifactChangeEvents } from '../artifactRouter';
import { TaskChangeRouter, taskChangeEvents } from '../taskChangeRouter';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';

// ---------------------------------------------------------------------------
// Test DB builder: projects + 006 + 011 + 014 + 015 + 016 + 017 + 029.
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
  db.exec(readFileSync(join(migDir, '024_archive_in_place.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '028_idea_attachments.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '029_artifacts.sql'), 'utf-8'));
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
});
