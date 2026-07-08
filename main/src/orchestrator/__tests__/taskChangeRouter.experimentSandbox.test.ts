/**
 * TaskChangeRouter — A/B experiment sandbox (migration 049).
 *
 * Covers: create-tag + pending landing, the BIDIRECTIONAL update guard, the
 * orchestrator-only clearExperiment reveal, the causedByRunId attribution scalar,
 * and deleteExperimentArmEntities (experiment-gated hard-delete with epic-cascade
 * child-sparing).
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TaskChangeRouter, TaskChangeError } from '../taskChangeRouter';
import { ReviewItemRouter } from '../reviewItemRouter';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);`);
  db.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj', '/tmp/p1');
  const migDir = join(__dirname, '..', '..', 'database', 'migrations');
  for (const f of [
    '006_cyboflow_schema.sql',
    '011_workflow_step_tracking.sql',
    '014_native_tasks.sql',
    '015_entity_model_rebuild.sql',
    '016_review_items.sql',
    '024_archive_in_place.sql',
    '028_idea_attachments.sql',
  ]) {
    db.exec(readFileSync(join(migDir, f), 'utf-8'));
  }
  db.exec('ALTER TABLE ideas ADD COLUMN decomposed_at TEXT;');
  db.exec('ALTER TABLE epics ADD COLUMN approved_at TEXT;');
  db.exec('ALTER TABLE tasks ADD COLUMN approved_at TEXT;');
  db.exec('ALTER TABLE workflow_runs ADD COLUMN plan_approved_at TEXT;');
  // migration 048 (experiment_id + experiment_arm on runs) + 049 (sandbox tag +
  // attribution) + 053 (experiment_arm on entities).
  db.exec('ALTER TABLE workflow_runs ADD COLUMN experiment_id TEXT;');
  db.exec('ALTER TABLE workflow_runs ADD COLUMN experiment_arm TEXT;');
  for (const t of ['ideas', 'epics', 'tasks']) {
    db.exec(`ALTER TABLE ${t} ADD COLUMN experiment_id TEXT;`);
    db.exec(`ALTER TABLE ${t} ADD COLUMN experiment_arm TEXT;`);
    db.exec(`ALTER TABLE ${t} ADD COLUMN caused_by_run_id TEXT;`);
  }
  return db;
}

/**
 * Seed a workflow_runs row (optionally experiment-tagged). A tagged run defaults
 * to arm 'A' unless one is given, so the existing single-arm tests keep passing
 * under the arm-scoped guard (a run with a null arm can never edit its own tagged
 * entity — arm null fails closed).
 */
function seedRun(
  db: Database.Database,
  runId: string,
  experimentId: string | null,
  arm?: 'A' | 'B',
): void {
  const armVal = arm ?? (experimentId !== null ? 'A' : null);
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'sprint', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, experiment_id, experiment_arm)
     VALUES (?, 'wf-1', 1, 'running', 'default', ?, ?)`,
  ).run(runId, experimentId, armVal);
}

function expField(db: Database.Database, table: string, id: string, col: string): unknown {
  return (db.prepare(`SELECT ${col} AS v FROM ${table} WHERE id = ?`).get(id) as { v: unknown }).v;
}

describe('TaskChangeRouter — experiment sandbox (migration 049)', () => {
  afterEach(() => {
    TaskChangeRouter._resetForTesting();
    ReviewItemRouter._resetForTesting();
  });

  it('create by an experiment run stamps experiment_id; epic/task land PENDING, idea tagged', async () => {
    const db = buildDb();
    seedRun(db, 'runX', 'exp-1');
    const router = TaskChangeRouter.initialize(dbAdapter(db));

    const idea = await router.applyChange(1, { actor: 'agent:planner', entityType: 'idea', title: 'I', runId: 'runX' });
    const epic = await router.applyChange(1, { actor: 'agent:planner', entityType: 'epic', title: 'E', runId: 'runX' });
    const task = await router.applyChange(1, { actor: 'agent:planner', entityType: 'task', title: 'T', runId: 'runX' });

    expect(expField(db, 'ideas', idea.taskId, 'experiment_id')).toBe('exp-1');
    expect(expField(db, 'epics', epic.taskId, 'experiment_id')).toBe('exp-1');
    expect(expField(db, 'tasks', task.taskId, 'experiment_id')).toBe('exp-1');
    // Epic/task land PENDING (approved_at NULL) even though sprint is not plan-gated.
    expect(expField(db, 'epics', epic.taskId, 'approved_at')).toBeNull();
    expect(expField(db, 'tasks', task.taskId, 'approved_at')).toBeNull();
  });

  it('explicit change.experimentId stamps a clone with no runId', async () => {
    const db = buildDb();
    const router = TaskChangeRouter.initialize(dbAdapter(db));
    const clone = await router.applyChange(1, {
      actor: 'orchestrator', entityType: 'idea', title: 'clone', experimentId: 'exp-9',
    });
    expect(expField(db, 'ideas', clone.taskId, 'experiment_id')).toBe('exp-9');
  });

  it('update guard: an experiment run may edit ITS OWN entity, not a foreign/main-board one', async () => {
    const db = buildDb();
    seedRun(db, 'runA', 'exp-1');
    seedRun(db, 'runB', 'exp-2');
    const router = TaskChangeRouter.initialize(dbAdapter(db));

    // exp-1's own task (created by runA) — editable by runA.
    const own = await router.applyChange(1, { actor: 'agent:planner', entityType: 'task', title: 'own', runId: 'runA' });
    await expect(
      router.applyChange(1, { actor: 'agent:planner', taskId: own.taskId, fields: { title: 'own2' }, runId: 'runA' }),
    ).resolves.toBeTruthy();

    // A main-board (untagged) idea — runA is denied.
    const mainIdea = await router.applyChange(1, { actor: 'user', entityType: 'idea', title: 'main' });
    await expect(
      router.applyChange(1, { actor: 'agent:planner', taskId: mainIdea.taskId, fields: { title: 'x' }, runId: 'runA' }),
    ).rejects.toMatchObject({ code: 'experiment_sandboxed' } as Partial<TaskChangeError>);

    // exp-2's task — runA (exp-1) is denied.
    const otherExpTask = await router.applyChange(1, { actor: 'agent:planner', entityType: 'task', title: 'other', runId: 'runB' });
    await expect(
      router.applyChange(1, { actor: 'agent:planner', taskId: otherExpTask.taskId, fields: { title: 'y' }, runId: 'runA' }),
    ).rejects.toMatchObject({ code: 'experiment_sandboxed' });
  });

  it('update guard: an UNTAGGED actor (user) cannot edit a hidden experiment entity', async () => {
    const db = buildDb();
    seedRun(db, 'runA', 'exp-1');
    const router = TaskChangeRouter.initialize(dbAdapter(db));
    const tagged = await router.applyChange(1, { actor: 'agent:planner', entityType: 'idea', title: 'hidden', runId: 'runA' });
    await expect(
      router.applyChange(1, { actor: 'user', taskId: tagged.taskId, fields: { title: 'peek' } }),
    ).rejects.toMatchObject({ code: 'experiment_sandboxed' });
  });

  it('orchestrator bypasses the guard (promote/fold path)', async () => {
    const db = buildDb();
    seedRun(db, 'runA', 'exp-1');
    const router = TaskChangeRouter.initialize(dbAdapter(db));
    const tagged = await router.applyChange(1, { actor: 'agent:planner', entityType: 'idea', title: 'hidden', runId: 'runA' });
    await expect(
      router.applyChange(1, { actor: 'orchestrator', taskId: tagged.taskId, fields: { title: 'promoted' } }),
    ).resolves.toBeTruthy();
  });

  it('clearExperiment (orchestrator-only) sets experiment_id NULL + mints an event', async () => {
    const db = buildDb();
    seedRun(db, 'runA', 'exp-1');
    const router = TaskChangeRouter.initialize(dbAdapter(db));
    const epic = await router.applyChange(1, { actor: 'agent:planner', entityType: 'epic', title: 'E', runId: 'runA' });

    const before = (db.prepare('SELECT COUNT(*) AS n FROM entity_events WHERE entity_id = ?').get(epic.taskId) as { n: number }).n;
    await router.applyChange(1, { actor: 'orchestrator', entityType: 'epic', taskId: epic.taskId, approved: true, clearExperiment: true });
    expect(expField(db, 'epics', epic.taskId, 'experiment_id')).toBeNull();
    expect(expField(db, 'epics', epic.taskId, 'approved_at')).not.toBeNull();
    const after = (db.prepare('SELECT COUNT(*) AS n FROM entity_events WHERE entity_id = ?').get(epic.taskId) as { n: number }).n;
    expect(after).toBeGreaterThan(before);

    // A non-orchestrator clearExperiment is rejected.
    seedRun(db, 'runB', 'exp-2');
    const t2 = await router.applyChange(1, { actor: 'agent:planner', entityType: 'idea', title: 'X', runId: 'runB' });
    await expect(
      router.applyChange(1, { actor: 'agent:planner', taskId: t2.taskId, clearExperiment: true, runId: 'runB' }),
    ).rejects.toMatchObject({ code: 'forbidden_stage' });
  });

  it('causedByRunId scalar update mints an event', async () => {
    const db = buildDb();
    seedRun(db, 'blamed', null);
    const router = TaskChangeRouter.initialize(dbAdapter(db));
    const idea = await router.applyChange(1, { actor: 'user', entityType: 'idea', title: 'regression' });
    await router.applyChange(1, { actor: 'user', taskId: idea.taskId, causedByRunId: 'blamed' });
    expect(expField(db, 'ideas', idea.taskId, 'caused_by_run_id')).toBe('blamed');
  });

  it('deleteExperimentArmEntities sweeps the arm (epic cascade + orphan task + clone), gated on experiment_id', async () => {
    const db = buildDb();
    seedRun(db, 'runA', 'exp-1');
    const router = TaskChangeRouter.initialize(dbAdapter(db));

    // Orchestrator-created seed clone (no runId).
    const clone = await router.applyChange(1, { actor: 'orchestrator', entityType: 'idea', title: 'clone', experimentId: 'exp-1' });
    // Run-created epic + child task + orphan task, all tagged exp-1.
    const epic = await router.applyChange(1, { actor: 'agent:planner', entityType: 'epic', title: 'E', runId: 'runA' });
    const child = await router.applyChange(1, { actor: 'agent:planner', entityType: 'task', title: 'C', parentEpicId: epic.taskId, runId: 'runA' });
    const orphan = await router.applyChange(1, { actor: 'agent:planner', entityType: 'task', title: 'O', runId: 'runA' });

    // A DIFFERENT project/main-board idea must be spared (not part of exp-1).
    const mainIdea = await router.applyChange(1, { actor: 'user', entityType: 'idea', title: 'keep' });

    await router.deleteExperimentArmEntities(1, { experimentId: 'exp-1', runId: 'runA', seedCloneId: clone.taskId });

    const gone = (t: string, id: string) => db.prepare(`SELECT 1 FROM ${t} WHERE id = ?`).get(id) === undefined;
    expect(gone('epics', epic.taskId)).toBe(true);
    expect(gone('tasks', child.taskId)).toBe(true);
    expect(gone('tasks', orphan.taskId)).toBe(true);
    expect(gone('ideas', clone.taskId)).toBe(true);
    // Main-board idea survives.
    expect(gone('ideas', mainIdea.taskId)).toBe(false);
  });

  it('deleteExperimentArmEntities SPARES a run-created epic whose child was revealed (tag cleared)', async () => {
    const db = buildDb();
    seedRun(db, 'runW', 'exp-1');
    const router = TaskChangeRouter.initialize(dbAdapter(db));
    const epic = await router.applyChange(1, { actor: 'agent:planner', entityType: 'epic', title: 'E', runId: 'runW' });
    const child = await router.applyChange(1, { actor: 'agent:planner', entityType: 'task', title: 'C', parentEpicId: epic.taskId, runId: 'runW' });
    // Reveal the child (clear its tag) as decide would for a winner.
    await router.applyChange(1, { actor: 'orchestrator', entityType: 'task', taskId: child.taskId, approved: true, clearExperiment: true });

    // Sweeping the arm must NOT destroy the revealed child; the epic is spared.
    await router.deleteExperimentArmEntities(1, { experimentId: 'exp-1', runId: 'runW' });
    const gone = (t: string, id: string) => db.prepare(`SELECT 1 FROM ${t} WHERE id = ?`).get(id) === undefined;
    expect(gone('tasks', child.taskId)).toBe(false);
    expect(gone('epics', epic.taskId)).toBe(false);
  });

  describe('arm scoping (migration 053)', () => {
    it('create by an experiment run stamps experiment_arm from the run', async () => {
      const db = buildDb();
      seedRun(db, 'runA', 'exp-1', 'A');
      seedRun(db, 'runB', 'exp-1', 'B');
      const router = TaskChangeRouter.initialize(dbAdapter(db));

      const a = await router.applyChange(1, { actor: 'agent:planner', entityType: 'task', title: 'a', runId: 'runA' });
      const b = await router.applyChange(1, { actor: 'agent:planner', entityType: 'task', title: 'b', runId: 'runB' });
      expect(expField(db, 'tasks', a.taskId, 'experiment_arm')).toBe('A');
      expect(expField(db, 'tasks', b.taskId, 'experiment_arm')).toBe('B');
    });

    it('explicit change.experimentArm stamps a per-arm seed clone (no runId)', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const clone = await router.applyChange(1, {
        actor: 'orchestrator', entityType: 'idea', title: 'clone', experimentId: 'exp-9', experimentArm: 'B',
      });
      expect(expField(db, 'ideas', clone.taskId, 'experiment_arm')).toBe('B');
    });

    it('update guard DENIES editing the SIBLING arm (same experiment, different arm)', async () => {
      const db = buildDb();
      seedRun(db, 'runA', 'exp-1', 'A');
      seedRun(db, 'runB', 'exp-1', 'B');
      const router = TaskChangeRouter.initialize(dbAdapter(db));

      // Arm B creates a task; arm A (same experiment) must NOT be able to edit it —
      // the pre-053 guard allowed this because both share experiment_id 'exp-1'.
      const bTask = await router.applyChange(1, { actor: 'agent:planner', entityType: 'task', title: 'bWork', runId: 'runB' });
      await expect(
        router.applyChange(1, { actor: 'agent:planner', taskId: bTask.taskId, fields: { title: 'hijack' }, runId: 'runA' }),
      ).rejects.toMatchObject({ code: 'experiment_sandboxed' } as Partial<TaskChangeError>);

      // Arm B may still edit its OWN task (control — the guard is not over-broad).
      await expect(
        router.applyChange(1, { actor: 'agent:planner', taskId: bTask.taskId, fields: { title: 'bWork2' }, runId: 'runB' }),
      ).resolves.toBeTruthy();
    });

    it('add-dependency guard DENIES an edge touching the SIBLING arm task', async () => {
      const db = buildDb();
      seedRun(db, 'runA', 'exp-1', 'A');
      seedRun(db, 'runB', 'exp-1', 'B');
      const router = TaskChangeRouter.initialize(dbAdapter(db));

      const aTask = await router.applyChange(1, { actor: 'agent:planner', entityType: 'task', title: 'aWork', runId: 'runA' });
      const aTask2 = await router.applyChange(1, { actor: 'agent:planner', entityType: 'task', title: 'aWork2', runId: 'runA' });
      const bTask = await router.applyChange(1, { actor: 'agent:planner', entityType: 'task', title: 'bWork', runId: 'runB' });

      // Arm A wiring an edge to arm B's task (prereq in the sibling arm) — denied.
      await expect(
        router.applyChange(1, {
          actor: 'agent:planner', taskId: aTask.taskId, dependsOnTaskId: bTask.taskId, runId: 'runA',
        }),
      ).rejects.toMatchObject({ code: 'experiment_sandboxed' } as Partial<TaskChangeError>);

      // A within-arm edge (both endpoints arm A) is allowed (control).
      await expect(
        router.applyChange(1, {
          actor: 'agent:planner', taskId: aTask.taskId, dependsOnTaskId: aTask2.taskId, runId: 'runA',
        }),
      ).resolves.toBeTruthy();
    });

    it('promote reveal (clearExperiment) also clears experiment_arm', async () => {
      const db = buildDb();
      seedRun(db, 'runA', 'exp-1', 'A');
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const epic = await router.applyChange(1, { actor: 'agent:planner', entityType: 'epic', title: 'E', runId: 'runA' });
      expect(expField(db, 'epics', epic.taskId, 'experiment_arm')).toBe('A');

      await router.applyChange(1, {
        actor: 'orchestrator', entityType: 'epic', taskId: epic.taskId, approved: true, clearExperiment: true,
      });
      expect(expField(db, 'epics', epic.taskId, 'experiment_id')).toBeNull();
      expect(expField(db, 'epics', epic.taskId, 'experiment_arm')).toBeNull();
    });
  });
});
