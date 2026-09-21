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
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  handleStepCompletion,
  handleRunStart,
  handleEntityWrite,
  handleVisualArtifactsScan,
  setRunArtifactsDirResolver,
} from '../autoMintArtifacts';
import { ArtifactRouter, artifactChangeEvents } from '../artifactRouter';
import { TaskChangeRouter, taskChangeEvents } from '../taskChangeRouter';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';

// ---------------------------------------------------------------------------
// Test DB builder: projects + 006 + 011 + 014 + 015 + 016 + 017 + 022 + 024 +
// 028 + 035 + 042 (022 brings sprint_batches/sprint_batch_tasks +
// workflow_runs.batch_id for the standalone-sprint batch->idea resolution path;
// 042 collapses the board to 4 stages and adds ideas.decomposed_at, which
// readEntity now SELECTs).
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
  db.exec(readFileSync(join(migDir, '042_collapse_board.sql'), 'utf-8'));
  // 045 widens the artifacts.atype CHECK to include 'arch-design'.
  db.exec(readFileSync(join(migDir, '045_arch_design_atype.sql'), 'utf-8'));
  // 060 adds workflow_runs.seed_idea_ids (multi-idea planner batch); 061 widens the
  // artifacts.atype CHECK to include 'approve-ideas'; 062 relaxes idea-spec identity
  // to (run_id, atype, source_ref) so a run can hold one idea-spec per idea.
  db.exec(readFileSync(join(migDir, '061_run_seed_idea_ids.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '062_approve_ideas_atype.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '063_per_idea_spec_artifacts.sql'), 'utf-8'));
  // 070 adds the 'approve-designs' atype to the CHECK and makes 'arch-design'
  // per-entity (one-per-(run, atype, source_ref)) alongside idea-spec.
  db.exec(readFileSync(join(migDir, '073_approve_designs_and_per_idea_arch.sql'), 'utf-8'));
  // workflow_runs.session_id (migration 019) — added directly here; migration 019
  // itself backfills from the Crystal-legacy `sessions` table, which this entity
  // test DB doesn't create. ArtifactRouter's emitChange resolves this column on
  // every write, so it must exist even though these tests don't assert on it.
  db.exec('ALTER TABLE workflow_runs ADD COLUMN session_id TEXT');
  // artifacts.revision (migration 082) — ArtifactRouter bumps it on an
  // enrich-with-deltas (the re-mint / verdict-preserve paths exercised here);
  // add the additive column since this DB hand-picks a subset predating 082.
  db.exec('ALTER TABLE artifacts ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
  // 091 widens the atype CHECK to include 'eval-report' (system-minted by the
  // ad-hoc code-review eval); auto-mint never writes it, but the table shape must
  // match production. Applied AFTER the revision ALTER above — 091's recreate
  // copies `revision`, so the column must exist first.
  db.exec(readFileSync(join(migDir, '091_eval_report_atype.sql'), 'utf-8'));
  // 099 widens the atype CHECK again to include 'idea-summary' (the per-idea
  // ledger-status hub) and makes it per-entity, alongside idea-spec/arch-design.
  // Applied AFTER 091 for the same "recreate carries only what it names" reason
  // 091 documents about running after 089.
  db.exec(readFileSync(join(migDir, '102_idea_summary_atype.sql'), 'utf-8'));
  // artifacts.reported_at (migration 141) — the LAST report's instant, which
  // ArtifactRouter's create path now names in both its INSERT and its enrich
  // UPDATE. Added directly (like the columns above) since this DB hand-picks a
  // migration subset predating 141; MUST come after every atype-CHECK recreate
  // above, since a recreate carries only the columns it names.
  db.exec('ALTER TABLE artifacts ADD COLUMN reported_at TEXT');
  // Migration 059: category (feature|bug|chore) — an unconditional column in
  // insertEntity/readEntity now (mirrors priority), so every create needs it.
  db.exec(readFileSync(join(migDir, '059_entity_category.sql'), 'utf-8'));
  // 098 (idea_components ledger, standalone/no-FK) — resolveIdeaComponents'
  // ledger-row SELECT hits this table unconditionally (not fail-soft, unlike
  // its run-linkage arms), so idea-summary's content gate needs it to exist.
  db.exec(readFileSync(join(migDir, '101_idea_component_ledger.sql'), 'utf-8'));
  // approved_designs (082's read model) feeds the 'prototype' component's
  // derivation, also queried unconditionally. Migration 082 itself ALTERs the
  // legacy Crystal `sessions` table (ADD COLUMN design_idea_id) which this
  // entity-only test DB never creates, so — mirroring the session_id/revision
  // inline-ALTER precedent just above — this stubs ONLY the columns
  // resolveIdeaComponentsBatch actually SELECTs, instead of running the full
  // migration file.
  db.exec(`
    CREATE TABLE approved_designs (
      idea_id TEXT NOT NULL,
      project_id INTEGER NOT NULL,
      superseded_at DATETIME
    );
  `);
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

/**
 * Stamp the multi-idea seed (migration 061): seed_idea_ids = JSON array, with
 * seed_idea_id dual-written as ids[0] (the production dual-write invariant).
 */
function setSeedIdeaIds(db: Database.Database, runId: string, ideaIds: string[]): void {
  db.prepare('UPDATE workflow_runs SET seed_idea_ids = ?, seed_idea_id = ? WHERE id = ?').run(
    JSON.stringify(ideaIds),
    ideaIds[0] ?? null,
    runId,
  );
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
    const { taskId: epicB } = await router.applyChange(1, {
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
    // A directly-linked task (idea-needs-epic allows ONE epic-less task per idea).
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
      parentEpicId: epicB,
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

    // One idea-spec + one decomposed-stories + one idea-summary (the idea's
    // epics/stories components are derived-complete, clearing the content
    // gate) = 3 rows total, no duplicates.
    expect(artifactCount(db, 'run-sprint-idem')).toBe(3);
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

  it('mints ONE COMBINED idea-spec for a multi-idea batch (decomposed-stories pattern), anchored on the first idea', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);
    const router = TaskChangeRouter.getInstance();

    seedPlannerRun(db, 'run-batch');
    // Two seeded ideas, each with spec content so the content gate passes.
    const { taskId: ideaA } = await router.applyChange(1, {
      actor: 'agent:cyboflow-context',
      entityType: 'idea',
      title: 'Idea Alpha',
      summary: 'spec A',
      runId: 'run-batch',
    });
    const { taskId: ideaB } = await router.applyChange(1, {
      actor: 'agent:cyboflow-context',
      entityType: 'idea',
      title: 'Idea Beta',
      summary: 'spec B',
      runId: 'run-batch',
    });
    // seed_idea_ids drives the multi-mint (dual-writes seed_idea_id = ideaA).
    setSeedIdeaIds(db, 'run-batch', [ideaA, ideaB]);

    await handleEntityWrite(adapter, 'run-batch', 'idea');

    const specs = db
      .prepare(
        `SELECT source_ref, label, payload_json FROM artifacts
          WHERE run_id = 'run-batch' AND atype = 'idea-spec'`,
      )
      .all() as Array<{ source_ref: string; label: string; payload_json: string | null }>;
    expect(specs).toHaveLength(1);
    // Anchored on the FIRST owned idea; label counts content-bearing ideas;
    // payload marks the renderer's combined branch.
    expect(specs[0].source_ref).toBe(ideaA);
    expect(specs[0].label).toBe('Idea specs · 2 ideas');
    expect(JSON.parse(specs[0].payload_json ?? '{}')).toEqual({ combined: true });
  });

  it('CONVERTS the single per-idea spec row into the combined tab when the batch grows past one idea', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);
    const router = TaskChangeRouter.getInstance();

    seedPlannerRun(db, 'run-grow');
    const { taskId: ideaA } = await router.applyChange(1, {
      actor: 'agent:cyboflow-context',
      entityType: 'idea',
      title: 'Idea Alpha',
      summary: 'spec A',
      runId: 'run-grow',
    });
    setSeedIdeaIds(db, 'run-grow', [ideaA]);
    await handleEntityWrite(adapter, 'run-grow', 'idea');

    // Single-idea moment: the familiar per-idea tab.
    const single = readArtifact(db, 'run-grow', 'idea-spec');
    expect(single!.source_ref).toBe(ideaA);
    expect(single!.label).toBe('Idea Alpha');

    const { taskId: ideaB } = await router.applyChange(1, {
      actor: 'agent:cyboflow-context',
      entityType: 'idea',
      title: 'Idea Beta',
      summary: 'spec B',
      runId: 'run-grow',
    });
    setSeedIdeaIds(db, 'run-grow', [ideaA, ideaB]);
    await handleEntityWrite(adapter, 'run-grow', 'idea');

    // The (run_id, atype, source_ref) UPSERT adopted ideaA's row in place —
    // still exactly one artifact, now the combined tab.
    const specs = db
      .prepare(`SELECT source_ref, label FROM artifacts WHERE run_id = 'run-grow' AND atype = 'idea-spec'`)
      .all() as Array<{ source_ref: string; label: string }>;
    expect(specs).toHaveLength(1);
    expect(specs[0].source_ref).toBe(ideaA);
    expect(specs[0].label).toBe('Idea specs · 2 ideas');
  });

  // -------------------------------------------------------------------------
  // decomposed-stories — RUN-SCOPED combined count across ALL owned ideas
  // (batch fix, IDEA-009): ONE artifact per run, but its label/count now
  // reflects every owned idea's decomposition, not just the first.
  // -------------------------------------------------------------------------

  it('combines the epic/task count across ALL owned ideas and appends "across K ideas" for a multi-idea batch', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);
    const router = TaskChangeRouter.getInstance();

    seedPlannerRun(db, 'run-batch2');
    const { taskId: ideaA } = await router.applyChange(1, {
      actor: 'agent:cyboflow-context',
      entityType: 'idea',
      title: 'Idea Alpha',
      summary: 'spec A',
      runId: 'run-batch2',
    });
    const { taskId: ideaB } = await router.applyChange(1, {
      actor: 'agent:cyboflow-context',
      entityType: 'idea',
      title: 'Idea Beta',
      summary: 'spec B',
      runId: 'run-batch2',
    });
    // Idea A: one epic with two tasks under it (1 epic, 2 tasks).
    const { taskId: epicA } = await router.applyChange(1, {
      actor: 'orchestrator',
      entityType: 'epic',
      title: 'Epic A',
      originatingIdeaId: ideaA,
      runId: 'run-batch2',
    });
    await router.applyChange(1, {
      actor: 'orchestrator',
      entityType: 'task',
      title: 'Task under Epic A (1)',
      parentEpicId: epicA,
      runId: 'run-batch2',
    });
    await router.applyChange(1, {
      actor: 'orchestrator',
      entityType: 'task',
      title: 'Task under Epic A (2)',
      parentEpicId: epicA,
      runId: 'run-batch2',
    });
    // Idea B: a single-task idea keeps its one task directly off the idea
    // (idea-needs-epic allows exactly one epic-less task) — 0 epics, 1 task.
    await router.applyChange(1, {
      actor: 'orchestrator',
      entityType: 'task',
      title: 'Direct task',
      originatingIdeaId: ideaB,
      runId: 'run-batch2',
    });
    // seed_idea_ids drives the multi-idea resolution (dual-writes seed_idea_id = ideaA).
    setSeedIdeaIds(db, 'run-batch2', [ideaA, ideaB]);

    await handleEntityWrite(adapter, 'run-batch2', 'task');

    // ONE decomposed-stories artifact for the run (identity unchanged), sourceRef
    // = the FIRST owned idea, label = the COMBINED count across both ideas
    // (1 epic + 0 epics = 1 epic; 2 tasks + 1 task = 3 tasks), plus the
    // multi-idea suffix.
    const stories = readArtifact(db, 'run-batch2', 'decomposed-stories');
    expect(stories).toBeDefined();
    expect(stories!.source_ref).toBe(ideaA);
    expect(stories!.label).toBe('1 epic, 3 tasks across 2 ideas');
    // Still exactly one row per (run, atype) — no per-idea proliferation.
    expect(
      db
        .prepare(`SELECT COUNT(*) AS n FROM artifacts WHERE run_id = 'run-batch2' AND atype = 'decomposed-stories'`)
        .get() as { n: number },
    ).toEqual({ n: 1 });
  });

  it('content gate still skips when the COMBINED count across every owned idea is zero', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);
    const router = TaskChangeRouter.getInstance();

    seedPlannerRun(db, 'run-batch-empty');
    const { taskId: ideaA } = await router.applyChange(1, {
      actor: 'agent:cyboflow-context',
      entityType: 'idea',
      title: 'Idea Alpha',
      summary: 'spec A',
      runId: 'run-batch-empty',
    });
    const { taskId: ideaB } = await router.applyChange(1, {
      actor: 'agent:cyboflow-context',
      entityType: 'idea',
      title: 'Idea Beta',
      summary: 'spec B',
      runId: 'run-batch-empty',
    });
    // Neither idea has been decomposed yet — combined count is 0 across both.
    setSeedIdeaIds(db, 'run-batch-empty', [ideaA, ideaB]);

    await handleEntityWrite(adapter, 'run-batch-empty', 'task');

    expect(readArtifact(db, 'run-batch-empty', 'decomposed-stories')).toBeUndefined();
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

    // A multi-task idea groups its tasks under an epic (idea-needs-epic invariant),
    // so the count grows epic + task-under-epic as the decomposition fills in.
    const { taskId: epicId } = await router.applyChange(1, {
      actor: 'orchestrator',
      entityType: 'epic',
      title: 'Epic',
      originatingIdeaId: ideaId,
      runId: 'run-ew-refresh',
    });
    await router.applyChange(1, {
      actor: 'orchestrator',
      entityType: 'task',
      title: 'T1',
      parentEpicId: epicId,
      runId: 'run-ew-refresh',
    });
    await handleEntityWrite(adapter, 'run-ew-refresh', 'task');
    expect(readArtifact(db, 'run-ew-refresh', 'decomposed-stories')!.label).toBe('1 epic, 1 task');

    await router.applyChange(1, {
      actor: 'orchestrator',
      entityType: 'task',
      title: 'T2',
      parentEpicId: epicId,
      runId: 'run-ew-refresh',
    });
    await handleEntityWrite(adapter, 'run-ew-refresh', 'task');

    // Still ONE decomposed-stories row (UPSERT), but the label now reflects the
    // live count. A second row exists — idea-summary, whose 'epics'/'stories'
    // components are now derived-complete — so the run total is 2, not 1.
    expect(artifactCount(db, 'run-ew-refresh')).toBe(2);
    expect(readArtifact(db, 'run-ew-refresh', 'decomposed-stories')!.label).toBe('1 epic, 2 tasks');
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

    // First task created with no lineage — auto-stamped with the seed idea (the
    // legal single epic-less task). Its board/stage seed the raw sibling below.
    const { taskId: t1 } = await router.applyChange(1, {
      actor: 'agent:cyboflow-decompose',
      entityType: 'task',
      title: 'T1',
      runId: 'run-d2',
    });
    const t1row = db
      .prepare('SELECT board_id AS b, stage_id AS s FROM tasks WHERE id = ?')
      .get(t1) as { b: string; s: string };
    // The idea-needs-epic invariant now REJECTS a second epic-less task through the
    // chokepoint. Legacy DBs (and any pre-invariant decomposition) may still hold
    // that shape, so insert the sibling RAW to prove the read-side count still
    // surfaces BOTH directly-linked tasks.
    db.prepare(
      `INSERT INTO tasks (id, project_id, ref, title, body, board_id, stage_id, parent_epic_id, originating_idea_id, created_at)
       VALUES ('tsk_direct2', 1, 'TASK-9002', 'T2', 'b', ?, ?, NULL, ?, '2026-01-02T00:00:02.000Z')`,
    ).run(t1row.b, t1row.s, ideaId);

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

// ===========================================================================
// arch-design — the templated architecture-design artifact (planner + ship).
// Mints content-gated on the SHARED extractArchDesignSection: only when the
// idea body carries a non-empty '## Architecture design' section.
// ===========================================================================

const ARCH_BODY =
  '# Idea\n\nIntro.\n\n## Architecture design\n\nUse a worker queue.\n\n## Rollout\n\nLater.';

/**
 * Seed a run whose workflow is NAMED `name` but whose spec_json declares an
 * 'architecture' step with outputArtifact atype='arch-design' (spec_json fully
 * overrides the built-in definition at resolve time). Exercises the
 * handleStepCompletion arch-design branch + its ARCH_DESIGN_WORKFLOWS gate.
 */
function seedRunWithArchStep(db: Database.Database, runId: string, name: string): void {
  const specJson = JSON.stringify({
    id: `${name}-arch-spec`,
    phases: [
      {
        id: 'refine',
        label: 'Refine',
        color: '#2d7a8a',
        steps: [
          {
            id: 'architecture',
            name: 'Architecture design',
            agent: 'cyboflow-architect',
            outputArtifact: { atype: 'arch-design', label: 'Architecture design' },
          },
        ],
      },
    ],
  });
  db.prepare(
    `INSERT INTO workflows (id, project_id, name, spec_json) VALUES (?, 1, ?, ?)`,
  ).run(`wf-arch-${runId}`, name, specJson);
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
     VALUES (?, ?, 1, 'running', 'default')`,
  ).run(runId, `wf-arch-${runId}`);
}

describe('autoMintArtifacts arch-design', () => {
  afterEach(() => {
    ArtifactRouter._resetForTesting();
    artifactChangeEvents.removeAllListeners();
    TaskChangeRouter._resetForTesting();
    taskChangeEvents.removeAllListeners();
  });

  it("mints arch-design on an 'idea' write for a PLANNER run when the body has the section", async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    seedPlannerRun(db, 'run-arch-p');
    const { taskId: ideaId } = await TaskChangeRouter.getInstance().applyChange(1, {
      actor: 'agent:cyboflow-context',
      entityType: 'idea',
      title: 'Idea with an arch section',
      body: ARCH_BODY,
      runId: 'run-arch-p',
    });

    await handleEntityWrite(adapter, 'run-arch-p', 'idea');

    const art = readArtifact(db, 'run-arch-p', 'arch-design');
    expect(art).toBeDefined();
    expect(art!.atype).toBe('arch-design');
    expect(art!.label).toBe('Architecture design');
    expect(art!.source_ref).toBe(ideaId);
    expect(art!.step_origin).toBe('Refine · architecture design');
    // Templated: content re-derived on read → mode 'template', payload null.
    expect(art!.mode).toBe('template');
    expect(art!.payload_json).toBeNull();
    expect(art!.is_new).toBe(1);
  });

  it("mints arch-design on an 'idea' write for a SHIP run too", async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    seedShipRun(db, 'run-arch-ship');
    const { taskId: ideaId } = await TaskChangeRouter.getInstance().applyChange(1, {
      actor: 'agent:cyboflow-context',
      entityType: 'idea',
      title: 'Ship idea with arch',
      body: ARCH_BODY,
      runId: 'run-arch-ship',
    });

    await handleEntityWrite(adapter, 'run-arch-ship', 'idea');

    const art = readArtifact(db, 'run-arch-ship', 'arch-design');
    expect(art).toBeDefined();
    expect(art!.source_ref).toBe(ideaId);
  });

  it('is content-gated: an idea write WITHOUT the section mints idea-spec but NOT arch-design', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    seedPlannerRun(db, 'run-arch-none');
    await TaskChangeRouter.getInstance().applyChange(1, {
      actor: 'agent:cyboflow-context',
      entityType: 'idea',
      title: 'Idea without arch',
      body: '# Idea\n\n## Problem\n\nNo architecture section here.',
      runId: 'run-arch-none',
    });

    await handleEntityWrite(adapter, 'run-arch-none', 'idea');

    expect(readArtifact(db, 'run-arch-none', 'idea-spec')).toBeDefined();
    expect(readArtifact(db, 'run-arch-none', 'arch-design')).toBeUndefined();
  });

  it('mints arch-design at RUN START when the idea body already carries the section', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    seedShipRun(db, 'run-arch-start');
    const { taskId: ideaId } = await TaskChangeRouter.getInstance().applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      title: 'Pre-designed idea',
      body: ARCH_BODY,
      runId: 'run-arch-start',
    });
    setSeedIdea(db, 'run-arch-start', ideaId);

    await handleRunStart(adapter, 'run-arch-start');

    const art = readArtifact(db, 'run-arch-start', 'arch-design');
    expect(art).toBeDefined();
    expect(art!.source_ref).toBe(ideaId);
    expect(art!.step_origin).toBe('Ship · run start');
  });

  it('does NOT mint arch-design at run start when the section is absent (content-gated no-op)', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    seedShipRun(db, 'run-arch-start-none');
    const { taskId: ideaId } = await TaskChangeRouter.getInstance().applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      title: 'No section',
      summary: 'Just a summary.',
      runId: 'run-arch-start-none',
    });
    setSeedIdea(db, 'run-arch-start-none', ideaId);

    await handleRunStart(adapter, 'run-arch-start-none');

    expect(readArtifact(db, 'run-arch-start-none', 'idea-spec')).toBeDefined();
    expect(readArtifact(db, 'run-arch-start-none', 'arch-design')).toBeUndefined();
  });

  it("mints arch-design on the 'architecture' step completion for a PLANNER run", async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    seedRunWithArchStep(db, 'run-arch-step', 'planner');
    const { taskId: ideaId } = await TaskChangeRouter.getInstance().applyChange(1, {
      actor: 'agent:cyboflow-context',
      entityType: 'idea',
      title: 'Step-minted arch',
      body: ARCH_BODY,
      runId: 'run-arch-step',
    });
    setSeedIdea(db, 'run-arch-step', ideaId);

    await handleStepCompletion(adapter, 'run-arch-step', 'architecture');

    const art = readArtifact(db, 'run-arch-step', 'arch-design');
    expect(art).toBeDefined();
    expect(art!.source_ref).toBe(ideaId);
    expect(art!.mode).toBe('template');
    expect(art!.payload_json).toBeNull();
  });

  it("mints arch-design on the 'architecture' step completion for a SHIP run", async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    seedRunWithArchStep(db, 'run-arch-step-ship', 'ship');
    const { taskId: ideaId } = await TaskChangeRouter.getInstance().applyChange(1, {
      actor: 'agent:cyboflow-context',
      entityType: 'idea',
      title: 'Ship step-minted arch',
      body: ARCH_BODY,
      runId: 'run-arch-step-ship',
    });
    setSeedIdea(db, 'run-arch-step-ship', ideaId);

    await handleStepCompletion(adapter, 'run-arch-step-ship', 'architecture');

    expect(readArtifact(db, 'run-arch-step-ship', 'arch-design')).toBeDefined();
  });

  it('does NOT mint arch-design on step completion for a NON-planner/ship workflow', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    seedRunWithArchStep(db, 'run-arch-custom', 'my-custom-flow');
    const { taskId: ideaId } = await TaskChangeRouter.getInstance().applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      title: 'Custom-run idea with arch',
      body: ARCH_BODY,
      runId: 'run-arch-custom',
    });
    setSeedIdea(db, 'run-arch-custom', ideaId);

    await expect(handleStepCompletion(adapter, 'run-arch-custom', 'architecture')).resolves.toBeUndefined();
    expect(readArtifact(db, 'run-arch-custom', 'arch-design')).toBeUndefined();
  });

  it('does NOT mint arch-design on step completion when the run has already FAILED', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    seedRunWithArchStep(db, 'run-arch-failed', 'planner');
    const { taskId: ideaId } = await TaskChangeRouter.getInstance().applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      title: 'Failed-run arch',
      body: ARCH_BODY,
      runId: 'run-arch-failed',
    });
    setSeedIdea(db, 'run-arch-failed', ideaId);
    setRunStatus(db, 'run-arch-failed', 'failed');

    await expect(handleStepCompletion(adapter, 'run-arch-failed', 'architecture')).resolves.toBeUndefined();
    expect(readArtifact(db, 'run-arch-failed', 'arch-design')).toBeUndefined();
  });

  it('is idempotent: two entity-write fires yield ONE arch-design row and one created event', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    seedPlannerRun(db, 'run-arch-idem');
    await TaskChangeRouter.getInstance().applyChange(1, {
      actor: 'agent:cyboflow-context',
      entityType: 'idea',
      title: 'Idempotent arch',
      body: ARCH_BODY,
      runId: 'run-arch-idem',
    });

    await handleEntityWrite(adapter, 'run-arch-idem', 'idea');
    await handleEntityWrite(adapter, 'run-arch-idem', 'idea');

    const rows = db
      .prepare("SELECT COUNT(*) AS n FROM artifacts WHERE run_id = 'run-arch-idem' AND atype = 'arch-design'")
      .get() as { n: number };
    expect(rows.n).toBe(1);
    const artId = readArtifactId(db, 'run-arch-idem', 'arch-design')!;
    const events = readArtifactEvents(db, artId).map((e) => e.kind);
    expect(events).toEqual(['created']);
  });
});

// ---------------------------------------------------------------------------
// handleVisualArtifactsScan — the screenshots auto-mint safety-net scan
// ---------------------------------------------------------------------------

describe('autoMintArtifacts.handleVisualArtifactsScan', () => {
  const tmpDirs: string[] = [];

  /** Make a fresh temp dir, register it for cleanup, and write the given files. */
  function makeRunDir(files: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'cyboflow-shots-'));
    tmpDirs.push(dir);
    for (const name of files) writeFileSync(join(dir, name), 'x');
    return dir;
  }

  /** Inject a resolver that maps EVERY runId to the one temp dir under test. */
  function useDir(dir: string): void {
    setRunArtifactsDirResolver(() => dir);
  }

  afterEach(() => {
    setRunArtifactsDirResolver(null); // restore standalone default (scan no-ops)
    ArtifactRouter._resetForTesting();
    artifactChangeEvents.removeAllListeners();
    TaskChangeRouter._resetForTesting();
    taskChangeEvents.removeAllListeners();
    for (const dir of tmpDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  });

  it('mints a screenshots artifact from on-disk PNGs for a sprint run (sorted basenames, isNew=0, provenance)', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);
    seedSprintRun(db, 'run-s', 'batch-1');
    useDir(makeRunDir(['detail.png', 'home.png'])); // unsorted on disk

    await handleVisualArtifactsScan(adapter, 'run-s');

    const art = readArtifact(db, 'run-s', 'screenshots');
    expect(art).toBeDefined();
    expect(art!.atype).toBe('screenshots');
    expect(art!.label).toBe('2 screenshots');
    expect(art!.step_origin).toBe('Sprint · visual-verify');
    expect(art!.is_new).toBe(0); // background scan never pulses/steals focus
    expect(JSON.parse(art!.payload_json!)).toEqual({ fileNames: ['detail.png', 'home.png'] });
  });

  it('ignores non-image files and sorts the basenames', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);
    seedSprintRun(db, 'run-s', 'batch-1');
    useDir(makeRunDir(['z.png', 'notes.txt', 'a.jpg', 'manifest.json']));

    await handleVisualArtifactsScan(adapter, 'run-s');

    const art = readArtifact(db, 'run-s', 'screenshots');
    expect(art).toBeDefined();
    expect(JSON.parse(art!.payload_json!)).toEqual({ fileNames: ['a.jpg', 'z.png'] });
    expect(art!.label).toBe('2 screenshots');
  });

  it('is a no-op when the run dir has no image files', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);
    seedSprintRun(db, 'run-s', 'batch-1');
    useDir(makeRunDir(['README.md']));

    await handleVisualArtifactsScan(adapter, 'run-s');

    expect(artifactCount(db, 'run-s')).toBe(0);
  });

  it('is a no-op (no throw) when the run dir does not exist', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);
    seedSprintRun(db, 'run-s', 'batch-1');
    setRunArtifactsDirResolver(() => join(tmpdir(), 'cyboflow-shots-does-not-exist-zzz'));

    await expect(handleVisualArtifactsScan(adapter, 'run-s')).resolves.toBeUndefined();
    expect(artifactCount(db, 'run-s')).toBe(0);
  });

  it('is a no-op when the resolver is not wired (standalone default)', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);
    seedSprintRun(db, 'run-s', 'batch-1');
    // No useDir() call — resolver stays null (afterEach reset / module default).

    await handleVisualArtifactsScan(adapter, 'run-s');

    expect(artifactCount(db, 'run-s')).toBe(0);
  });

  it('does NOT mint for a non-visual workflow (planner)', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);
    seedPlannerRun(db, 'run-p');
    useDir(makeRunDir(['home.png']));

    await handleVisualArtifactsScan(adapter, 'run-p');

    expect(readArtifactId(db, 'run-p', 'screenshots')).toBeUndefined();
  });

  it('does NOT mint when the run is in a terminal failed/canceled state', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);
    seedSprintRun(db, 'run-s', 'batch-1');
    setRunStatus(db, 'run-s', 'failed');
    useDir(makeRunDir(['home.png']));

    await handleVisualArtifactsScan(adapter, 'run-s');

    expect(readArtifactId(db, 'run-s', 'screenshots')).toBeUndefined();
  });

  it('mints for a ship run too', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);
    seedShipRun(db, 'run-ship');
    useDir(makeRunDir(['shot.png']));

    await handleVisualArtifactsScan(adapter, 'run-ship');

    const art = readArtifact(db, 'run-ship', 'screenshots');
    expect(art).toBeDefined();
    expect(art!.label).toBe('1 screenshot'); // singular
    expect(art!.step_origin).toBe('Ship · visual-verify');
  });

  it('R7: PRESERVES an existing verdict block (with baselineKey) across a re-mint (banner survives a step transition)', async () => {
    // Regression (fails on pre-R7 code): the verdict-delivery hook enriched the
    // screenshots artifact with `{ fileNames, verdict }`; the next step 'running'
    // transition fires this safety-net scan, which re-mints from the PNGs on disk.
    // Before the fix it wrote plain `{ fileNames }` and ArtifactRouter's wholesale
    // payload replace ERASED the verdict (banner + Accept button data vanished). It
    // must now merge: fresh fileNames + the preserved verdict block.
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);
    seedSprintRun(db, 'run-s', 'batch-1');

    // The verdict-delivery hook already enriched the SAME artifact.
    await ArtifactRouter.getInstance().apply(1, {
      op: 'create',
      runId: 'run-s',
      atype: 'screenshots',
      label: '1 screenshot',
      payloadJson: JSON.stringify({
        fileNames: ['home.png'],
        verdict: {
          status: 'pass',
          confidence: 0.95,
          issues: [],
          feedback: 'looks right',
          judgedFileNames: ['home.png'],
          baselineUsed: false,
          model: 'fake',
          baselineKey: 'landing-page',
        },
      }),
      actor: 'orchestrator',
    });

    // A later step transition fires the scan; the PNGs on disk now include a new one.
    useDir(makeRunDir(['detail.png', 'home.png']));
    await handleVisualArtifactsScan(adapter, 'run-s');

    const art = readArtifact(db, 'run-s', 'screenshots');
    expect(art).toBeDefined();
    const payload = JSON.parse(art!.payload_json!) as {
      fileNames: string[];
      verdict?: { status: string; baselineKey?: string };
    };
    // fileNames are UNIONED (§5.9 atomic merge): the stored 'home.png' first, then
    // the newly-seen 'detail.png' — the scan never shrinks the set, and the router
    // reads+merges the stored payload inside its queue (no read-then-create race) …
    expect(payload.fileNames).toEqual(['home.png', 'detail.png']);
    // … and the verdict block (banner + Accept button's baselineKey) SURVIVES.
    expect(payload.verdict?.status).toBe('pass');
    expect(payload.verdict?.baselineKey).toBe('landing-page');
  });

  it('R7: a scan with no pre-existing verdict writes a byte-identical { fileNames } payload (no regression)', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);
    seedSprintRun(db, 'run-s', 'batch-1');
    useDir(makeRunDir(['home.png']));

    await handleVisualArtifactsScan(adapter, 'run-s');

    const art = readArtifact(db, 'run-s', 'screenshots');
    expect(art).toBeDefined();
    // No verdict key when none pre-existed — byte-identical to the pre-R7 payload.
    expect(art!.payload_json).toBe(JSON.stringify({ fileNames: ['home.png'] }));
  });

  it('is idempotent: re-scanning the same files yields ONE row and exactly ONE created event', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);
    seedSprintRun(db, 'run-s', 'batch-1');
    useDir(makeRunDir(['home.png']));

    await handleVisualArtifactsScan(adapter, 'run-s');
    await handleVisualArtifactsScan(adapter, 'run-s');

    expect(artifactCount(db, 'run-s')).toBe(1);
    const id = readArtifactId(db, 'run-s', 'screenshots')!;
    const events = readArtifactEvents(db, id).map((e) => e.kind);
    // A second scan with the SAME sorted fileNames produces byte-identical payload
    // and is_new is unchanged → no delta → no 'updated' event spam.
    expect(events).toEqual(['created']);
  });
});

// ---------------------------------------------------------------------------
// Per-idea arch-design + JOINT batch-gate artifacts (approve-ideas / approve-designs)
// ---------------------------------------------------------------------------

const mkArchBody = (n: string): string =>
  `# ${n}\n\nsome intro\n\n## Architecture design\n\nThe ${n} architecture.\n`;

describe('autoMintArtifacts — per-idea arch-design + joint batch gates', () => {
  afterEach(() => {
    ArtifactRouter._resetForTesting();
    artifactChangeEvents.removeAllListeners();
    TaskChangeRouter._resetForTesting();
    taskChangeEvents.removeAllListeners();
  });

  async function seedTwoIdeaBatch(
    db: Database.Database,
    runId: string,
    opts?: { bodyA?: string; bodyB?: string; summaryA?: string; summaryB?: string },
  ): Promise<{ ideaA: string; ideaB: string; refA: string; refB: string }> {
    seedPlannerRun(db, runId);
    const router = TaskChangeRouter.getInstance();
    const { taskId: ideaA } = await router.applyChange(1, {
      actor: 'agent:cyboflow-context',
      entityType: 'idea',
      title: 'Idea Alpha',
      summary: opts?.summaryA ?? 'spec A',
      ...(opts?.bodyA !== undefined ? { body: opts.bodyA } : {}),
      runId,
    });
    const { taskId: ideaB } = await router.applyChange(1, {
      actor: 'agent:cyboflow-context',
      entityType: 'idea',
      title: 'Idea Beta',
      summary: opts?.summaryB ?? 'spec B',
      ...(opts?.bodyB !== undefined ? { body: opts.bodyB } : {}),
      runId,
    });
    setSeedIdeaIds(db, runId, [ideaA, ideaB]);
    const refOf = (id: string): string =>
      (db.prepare('SELECT ref FROM ideas WHERE id = ?').get(id) as { ref: string }).ref;
    return { ideaA, ideaB, refA: refOf(ideaA), refB: refOf(ideaB) };
  }

  it('mints ONE arch-design PER idea whose body carries a design section (per-entity)', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    const { ideaA, ideaB } = await seedTwoIdeaBatch(db, 'run-arch', {
      bodyA: mkArchBody('Alpha'),
      bodyB: mkArchBody('Beta'),
    });

    await handleEntityWrite(adapter, 'run-arch', 'idea');

    const archs = db
      .prepare(`SELECT source_ref FROM artifacts WHERE run_id = 'run-arch' AND atype = 'arch-design' ORDER BY source_ref`)
      .all() as Array<{ source_ref: string }>;
    expect(archs).toHaveLength(2);
    expect(archs.map((a) => a.source_ref).sort()).toEqual([ideaA, ideaB].sort());
  });

  it('skips arch-design for an idea with no design section (content gate, per idea)', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    // Only Alpha has an architecture section; Beta has none.
    const { ideaA } = await seedTwoIdeaBatch(db, 'run-arch1', {
      bodyA: mkArchBody('Alpha'),
      bodyB: '# Beta\n\njust prose, no design section\n',
    });

    await handleEntityWrite(adapter, 'run-arch1', 'idea');

    const archs = db
      .prepare(`SELECT source_ref FROM artifacts WHERE run_id = 'run-arch1' AND atype = 'arch-design'`)
      .all() as Array<{ source_ref: string }>;
    expect(archs).toHaveLength(1);
    expect(archs[0].source_ref).toBe(ideaA);
  });

  it('mints the JOINT approve-ideas artifact for a multi-idea batch (one row per idea)', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    const { refA, refB } = await seedTwoIdeaBatch(db, 'run-ai');

    await handleEntityWrite(adapter, 'run-ai', 'idea');

    const art = readArtifact(db, 'run-ai', 'approve-ideas');
    expect(art).toBeDefined();
    expect(art!.label).toBe('Approve ideas');
    const payload = JSON.parse(art!.payload_json!) as { ideas: Array<{ ref: string; title: string }> };
    expect(payload.ideas.map((i) => i.ref).sort()).toEqual([refA, refB].sort());
    expect(payload.ideas.map((i) => i.title).sort()).toEqual(['Idea Alpha', 'Idea Beta']);
  });

  it('does NOT mint approve-ideas for a single-idea planner run', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    seedPlannerRun(db, 'run-solo');
    const { taskId: ideaId } = await TaskChangeRouter.getInstance().applyChange(1, {
      actor: 'agent:cyboflow-context',
      entityType: 'idea',
      title: 'Solo',
      summary: 'just one',
      runId: 'run-solo',
    });
    setSeedIdea(db, 'run-solo', ideaId);

    await handleEntityWrite(adapter, 'run-solo', 'idea');

    expect(readArtifact(db, 'run-solo', 'approve-ideas')).toBeUndefined();
  });

  it('mints the JOINT approve-designs artifact when >1 idea has a design (one row per design)', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    const { refA, refB } = await seedTwoIdeaBatch(db, 'run-ad', {
      bodyA: mkArchBody('Alpha'),
      bodyB: mkArchBody('Beta'),
    });

    await handleEntityWrite(adapter, 'run-ad', 'idea');

    const art = readArtifact(db, 'run-ad', 'approve-designs');
    expect(art).toBeDefined();
    expect(art!.label).toBe('Approve designs');
    const payload = JSON.parse(art!.payload_json!) as { designs: Array<{ ref: string }> };
    expect(payload.designs.map((d) => d.ref).sort()).toEqual([refA, refB].sort());
  });

  it('does NOT mint approve-designs when only ONE idea has a design section', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    await seedTwoIdeaBatch(db, 'run-ad1', {
      bodyA: mkArchBody('Alpha'),
      bodyB: '# Beta\n\nno design yet\n',
    });

    await handleEntityWrite(adapter, 'run-ad1', 'idea');

    expect(readArtifact(db, 'run-ad1', 'approve-designs')).toBeUndefined();
  });

  it('does NOT mint the joint batch gates for a non-planner (sprint) run', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    // A standalone sprint owns no ideas and is not a planning flow — the batch
    // gates are planner-only. handleEntityWrite no-ops for sprint anyway
    // (CONTENT_DRIVEN_WORKFLOWS excludes it), so assert nothing minted.
    seedSprintRun(db, 'run-sp', 'batch-x');
    await handleEntityWrite(adapter, 'run-sp', 'idea');

    expect(readArtifact(db, 'run-sp', 'approve-ideas')).toBeUndefined();
    expect(readArtifact(db, 'run-sp', 'approve-designs')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// idea-summary — the per-idea ledger-status hub (migration 102)
// ---------------------------------------------------------------------------

describe('autoMintArtifacts idea-summary', () => {
  afterEach(() => {
    ArtifactRouter._resetForTesting();
    artifactChangeEvents.removeAllListeners();
    TaskChangeRouter._resetForTesting();
    taskChangeEvents.removeAllListeners();
  });

  /** Seed one explicit idea_components ledger row (migration 101). */
  function seedLedgerRow(
    db: Database.Database,
    ideaId: string,
    projectId: number,
    component: string,
    state: 'complete' | 'incomplete' | 'skipped',
    staleAt: string | null = null,
  ): void {
    db.prepare(
      `INSERT INTO idea_components
         (idea_id, project_id, component, state, source, stale_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'manual', ?, datetime('now'), datetime('now'))`,
    ).run(ideaId, projectId, component, state, staleAt);
  }

  it('does NOT mint idea-summary for a bare stub idea (all-incomplete ledger, content gate)', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    seedPlannerRun(db, 'run-sum-bare');
    const { taskId: ideaId } = await TaskChangeRouter.getInstance().applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      title: 'Bare stub',
      runId: 'run-sum-bare',
    });
    setSeedIdea(db, 'run-sum-bare', ideaId);

    await handleRunStart(adapter, 'run-sum-bare');

    expect(readArtifact(db, 'run-sum-bare', 'idea-summary')).toBeUndefined();
  });

  it('mints idea-summary once the idea-spec component is derived-complete (non-empty summary/body)', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    seedPlannerRun(db, 'run-sum-spec');
    const { taskId: ideaId } = await TaskChangeRouter.getInstance().applyChange(1, {
      actor: 'agent:cyboflow-context',
      entityType: 'idea',
      title: 'Has a spec',
      body: '## Idea spec\n\nSome real content.',
      runId: 'run-sum-spec',
    });

    await handleEntityWrite(adapter, 'run-sum-spec', 'idea');

    const art = readArtifact(db, 'run-sum-spec', 'idea-summary');
    expect(art).toBeDefined();
    expect(art!.label).toBe('Idea summary');
    expect(art!.source_ref).toBe(ideaId);
    expect(art!.step_origin).toBe('Plan · idea summary');
    // Templated: content re-derived on read → mode 'template', payload null.
    expect(art!.mode).toBe('template');
    expect(art!.payload_json).toBeNull();
    expect(art!.is_new).toBe(1);
  });

  it('mints idea-summary from an explicit ledger row alone (a manual "skipped" component is meaningful)', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    seedPlannerRun(db, 'run-sum-skip');
    const { taskId: ideaId } = await TaskChangeRouter.getInstance().applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      title: 'Skipped prototype',
      runId: 'run-sum-skip',
    });
    setSeedIdea(db, 'run-sum-skip', ideaId);
    // Nothing derivable yet, but a human explicitly skipped 'prototype'.
    seedLedgerRow(db, ideaId, 1, 'prototype', 'skipped');

    await handleRunStart(adapter, 'run-sum-skip');

    expect(readArtifact(db, 'run-sum-skip', 'idea-summary')).toBeDefined();
  });

  it('mints idea-summary from a "needs review" (stale) component alone', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    seedPlannerRun(db, 'run-sum-stale');
    const { taskId: ideaId } = await TaskChangeRouter.getInstance().applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      title: 'Needs review',
      runId: 'run-sum-stale',
    });
    setSeedIdea(db, 'run-sum-stale', ideaId);
    seedLedgerRow(db, ideaId, 1, 'architecture', 'incomplete', '2026-08-01T00:00:00.000Z');

    await handleRunStart(adapter, 'run-sum-stale');

    expect(readArtifact(db, 'run-sum-stale', 'idea-summary')).toBeDefined();
  });

  it('mints idea-summary at RUN START for a SPRINT run (its only mint opportunity)', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    // A pre-decomposed idea (owned by a PRIOR planner run) whose tasks are
    // linked into this sprint's batch — mirrors seedDecomposedIdea's shape
    // (that helper is scoped to the handleRunStart describe block above).
    seedPlannerRun(db, 'run-sum-plan');
    const router = TaskChangeRouter.getInstance();
    const { taskId: ideaId } = await router.applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      title: 'Pre-decomposed idea',
      summary: 'already planned',
      runId: 'run-sum-plan',
    });
    const { taskId: epicId } = await router.applyChange(1, {
      actor: 'orchestrator',
      entityType: 'epic',
      title: 'Epic',
      originatingIdeaId: ideaId,
      runId: 'run-sum-plan',
    });
    const { taskId: taskId } = await router.applyChange(1, {
      actor: 'orchestrator',
      entityType: 'task',
      title: 'Task',
      parentEpicId: epicId,
      runId: 'run-sum-plan',
    });
    seedSprintRun(db, 'run-sum-sprint', 'batch-sum');
    linkBatchTask(db, 'batch-sum', taskId);

    await handleRunStart(adapter, 'run-sum-sprint');

    const art = readArtifact(db, 'run-sum-sprint', 'idea-summary');
    expect(art).toBeDefined();
    expect(art!.source_ref).toBe(ideaId);
    expect(art!.step_origin).toBe('Sprint · run start');
  });

  it('does NOT refresh idea-summary via handleEntityWrite for a SPRINT run (content-driven only for planner/ship)', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    // A standalone sprint owns no ideas via seed_idea_id, so handleEntityWrite's
    // own CONTENT_DRIVEN_WORKFLOWS gate already excludes it — this pins that
    // idea-summary specifically never appears via THIS seam for sprint.
    seedSprintRun(db, 'run-sum-sprint-ew', 'batch-y');
    await handleEntityWrite(adapter, 'run-sum-sprint-ew', 'idea');

    expect(readArtifact(db, 'run-sum-sprint-ew', 'idea-summary')).toBeUndefined();
  });

  it('mints idea-summary on an epic/task write too (epics/stories components changed)', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    seedPlannerRun(db, 'run-sum-ew-task');
    const router = TaskChangeRouter.getInstance();
    const { taskId: ideaId } = await router.applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      title: 'Idea',
      runId: 'run-sum-ew-task',
    });
    const { taskId: epicId } = await router.applyChange(1, {
      actor: 'orchestrator',
      entityType: 'epic',
      title: 'Epic',
      originatingIdeaId: ideaId,
      runId: 'run-sum-ew-task',
    });
    await router.applyChange(1, {
      actor: 'orchestrator',
      entityType: 'task',
      title: 'T1',
      parentEpicId: epicId,
      runId: 'run-sum-ew-task',
    });

    await handleEntityWrite(adapter, 'run-sum-ew-task', 'task');

    const art = readArtifact(db, 'run-sum-ew-task', 'idea-summary');
    expect(art).toBeDefined();
    expect(art!.source_ref).toBe(ideaId);
    expect(art!.step_origin).toBe('Plan · idea summary');
  });

  it('is idempotent: two entity-write fires yield ONE idea-summary row and one created event', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    seedPlannerRun(db, 'run-sum-idem');
    await TaskChangeRouter.getInstance().applyChange(1, {
      actor: 'agent:cyboflow-context',
      entityType: 'idea',
      title: 'Idempotent summary',
      // The ledger's 'idea-spec' component derives from the BODY's '## Idea
      // spec' heading (extractIdeaSpecSection) — NOT the summary field (that's
      // the idea-spec ARTIFACT's own, separate, content gate).
      body: '## Idea spec\n\nhas content',
      runId: 'run-sum-idem',
    });

    await handleEntityWrite(adapter, 'run-sum-idem', 'idea');
    await handleEntityWrite(adapter, 'run-sum-idem', 'idea');

    const rows = db
      .prepare("SELECT COUNT(*) AS n FROM artifacts WHERE run_id = 'run-sum-idem' AND atype = 'idea-summary'")
      .get() as { n: number };
    expect(rows.n).toBe(1);
    const artId = readArtifactId(db, 'run-sum-idem', 'idea-summary')!;
    const events = readArtifactEvents(db, artId).map((e) => e.kind);
    expect(events).toEqual(['created']);
  });

  it('mints ONE COMBINED idea-summary for a multi-idea planner batch, not one tab per idea', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    seedPlannerRun(db, 'run-sum-batch');
    const router = TaskChangeRouter.getInstance();
    const { taskId: ideaA } = await router.applyChange(1, {
      actor: 'agent:cyboflow-context',
      entityType: 'idea',
      title: 'Idea Alpha',
      // See the idempotency test above: the ledger's 'idea-spec' component
      // derives from the body's '## Idea spec' heading, not a bare summary.
      body: '## Idea spec\n\nspec A',
      runId: 'run-sum-batch',
    });
    // Idea Beta is a bare stub — no body/summary, no ledger row. It still gets a
    // ROW on the combined matrix (five "not started" cells is real information
    // about the batch), so it COUNTS toward the label even though it would never
    // have earned a hub tab of its own.
    const { taskId: ideaB } = await router.applyChange(1, {
      actor: 'agent:cyboflow-context',
      entityType: 'idea',
      title: 'Idea Beta',
      runId: 'run-sum-batch',
    });
    setSeedIdeaIds(db, 'run-sum-batch', [ideaA, ideaB]);

    await handleEntityWrite(adapter, 'run-sum-batch', 'idea');

    const summaries = db
      .prepare(
        `SELECT source_ref, label, payload_json FROM artifacts
          WHERE run_id = 'run-sum-batch' AND atype = 'idea-summary'`,
      )
      .all() as Array<{ source_ref: string; label: string; payload_json: string | null }>;
    expect(summaries).toHaveLength(1);
    // sourceRef anchors on the FIRST owned idea so a row minted while the batch
    // was still size 1 is ADOPTED in place by the (run_id, atype, source_ref)
    // UPSERT (see the adoption test below).
    expect(summaries[0].source_ref).toBe(ideaA);
    expect(summaries[0].label).toBe('Idea summaries · 2 ideas');
    expect(JSON.parse(summaries[0].payload_json!)).toEqual({ combined: true });
    expect(summaries[0].source_ref).not.toBe(ideaB);
  });

  it('ADOPTS the single-idea hub row in place when the batch grows to two ideas', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    seedPlannerRun(db, 'run-sum-adopt');
    const router = TaskChangeRouter.getInstance();
    const { taskId: ideaA } = await router.applyChange(1, {
      actor: 'agent:cyboflow-context',
      entityType: 'idea',
      title: 'Idea Alpha',
      body: '## Idea spec\n\nspec A',
      runId: 'run-sum-adopt',
    });
    setSeedIdeaIds(db, 'run-sum-adopt', [ideaA]);
    await handleEntityWrite(adapter, 'run-sum-adopt', 'idea');

    const before = readArtifact(db, 'run-sum-adopt', 'idea-summary');
    const beforeId = readArtifactId(db, 'run-sum-adopt', 'idea-summary');
    expect(before!.label).toBe('Idea summary');
    expect(before!.payload_json).toBeNull();
    expect(beforeId).toBeDefined();

    // The planner mints its second idea; the batch is now size 2.
    const { taskId: ideaB } = await router.applyChange(1, {
      actor: 'agent:cyboflow-context',
      entityType: 'idea',
      title: 'Idea Beta',
      body: '## Idea spec\n\nspec B',
      runId: 'run-sum-adopt',
    });
    setSeedIdeaIds(db, 'run-sum-adopt', [ideaA, ideaB]);
    await handleEntityWrite(adapter, 'run-sum-adopt', 'idea');

    const rows = db
      .prepare(
        `SELECT id, label, payload_json FROM artifacts
          WHERE run_id = 'run-sum-adopt' AND atype = 'idea-summary'`,
      )
      .all() as Array<{ id: string; label: string; payload_json: string | null }>;
    // ONE row, the SAME row — converted, never orphaned beside a new one.
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(beforeId);
    expect(rows[0].label).toBe('Idea summaries · 2 ideas');
    expect(JSON.parse(rows[0].payload_json!)).toEqual({ combined: true });
  });

  it('does NOT mint the combined tab while NO idea in the batch has a meaningful ledger', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    seedPlannerRun(db, 'run-sum-batch-bare');
    const router = TaskChangeRouter.getInstance();
    const { taskId: ideaA } = await router.applyChange(1, {
      actor: 'agent:cyboflow-context',
      entityType: 'idea',
      title: 'Bare Alpha',
      runId: 'run-sum-batch-bare',
    });
    const { taskId: ideaB } = await router.applyChange(1, {
      actor: 'agent:cyboflow-context',
      entityType: 'idea',
      title: 'Bare Beta',
      runId: 'run-sum-batch-bare',
    });
    setSeedIdeaIds(db, 'run-sum-batch-bare', [ideaA, ideaB]);

    await handleEntityWrite(adapter, 'run-sum-batch-bare', 'idea');

    expect(readArtifact(db, 'run-sum-batch-bare', 'idea-summary')).toBeUndefined();
  });

  it('counts only NON-ARCHIVED ideas in the combined label', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    TaskChangeRouter.initialize(adapter);
    ArtifactRouter.initialize(adapter);

    seedPlannerRun(db, 'run-sum-batch-arch');
    const router = TaskChangeRouter.getInstance();
    const { taskId: ideaA } = await router.applyChange(1, {
      actor: 'agent:cyboflow-context',
      entityType: 'idea',
      title: 'Kept Alpha',
      body: '## Idea spec\n\nspec A',
      runId: 'run-sum-batch-arch',
    });
    const { taskId: ideaB } = await router.applyChange(1, {
      actor: 'agent:cyboflow-context',
      entityType: 'idea',
      title: 'Archived Beta',
      body: '## Idea spec\n\nspec B',
      runId: 'run-sum-batch-arch',
    });
    setSeedIdeaIds(db, 'run-sum-batch-arch', [ideaA, ideaB]);
    // The renderer drops archived ideas, so the label must agree with the rows.
    db.prepare("UPDATE ideas SET archived_at = datetime('now') WHERE id = ?").run(ideaB);

    await handleEntityWrite(adapter, 'run-sum-batch-arch', 'idea');

    const art = readArtifact(db, 'run-sum-batch-arch', 'idea-summary');
    expect(art!.label).toBe('Idea summaries · 1 idea');
    expect(JSON.parse(art!.payload_json!)).toEqual({ combined: true });
  });

  it('is fail-soft for an unknown run id (no throw, no mint)', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    ArtifactRouter.initialize(adapter);

    await expect(handleRunStart(adapter, 'no-such-run')).resolves.toBeUndefined();
    await expect(handleEntityWrite(adapter, 'no-such-run', 'idea')).resolves.toBeUndefined();
    expect((db.prepare('SELECT COUNT(*) AS n FROM artifacts').get() as { n: number }).n).toBe(0);
  });
});
