/**
 * Runtime coverage of the monitor live-directive seam (RunExecutor.addUserSkip /
 * setStepGuidance) end-to-end through the REAL RunExecutor — the unit tests only
 * exercise the WorkflowController against a FakeHost, so this is the sole proof
 * that a directive mutated on RunExecutor is threaded BY REFERENCE into the real
 * DefaultProgrammaticRunner → WorkflowController (loop-head skip) + SpawnStepRunner
 * (per-step guidance thunk), backed by a fakeSdk spawner over a migration-replay DB.
 *
 *   1. SKIP  — addUserSkip a not-yet-run REQUIRED step BEFORE the walk reaches it;
 *              the controller records step_results outcome 'skipped', ADVANCES
 *              (does not fail), and the fake SDK is never asked to execute it.
 *   2. STEER — setStepGuidance BEFORE the step spawns; the fake SDK receives a
 *              prompt carrying the marker under a '## Operator guidance' section.
 *
 * Mirrors programmaticDag.itest.ts's harness (real runner + real DB + fakeSdk
 * recording spawner).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { DatabaseService } from '../../../database/database';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import { makeSpyLogger } from '../../__test_fixtures__/loggerLikeSpy';
import { DefaultProgrammaticRunner } from '../../programmatic/defaultProgrammaticRunner';
import { ReviewQueueHumanGate } from '../../programmatic/humanGate';
import { MonitorRegistry } from '../../programmatic/monitor';
import type { StepReporter } from '../../programmatic/programmaticRunHost';
import { HumanStepManager } from '../../humanStepManager';
import { reviewItemChangeEvents, reviewItemProjectChannel } from '../../reviewItemRouter';
import { buildStepTransitionEvent } from '../../stepTransitionBridge';
import { StepResultStore } from '../../stepResultStore';
import { RunExecutor } from '../../runExecutor';
import type {
  ClaudeSpawnerLike,
  ClaudeSpawnerOptions,
  ProgrammaticRunner,
  WorkflowRegistryLike,
} from '../../runExecutor';
import type {
  WorkflowDefinition,
  WorkflowRow,
  WorkflowRunRow,
} from '../../../../../shared/types/workflows';
import {
  makeFakeQuery,
  sdkSystemInit,
  sdkAssistantText,
  sdkResultSuccess,
  type FakeQueryParams,
} from '../../../test/fakes/fakeSdk';

// ---------------------------------------------------------------------------
// Migration-replay temp DB (full current app schema: workflow_runs, step_results).
// ---------------------------------------------------------------------------

interface TestDb {
  service: DatabaseService;
  db: ReturnType<DatabaseService['getDb']>;
  dir: string;
}

function buildMigrationDb(): TestDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-mondir-db-'));
  const service = new DatabaseService(path.join(dir, 'mondir.db'));
  service.initialize();
  const db = service.getDb();
  db.prepare('INSERT OR IGNORE INTO projects (id, name, path) VALUES (1, ?, ?)').run(
    'mondir',
    '/tmp/mondir',
  );
  return { service, db, dir };
}

function teardownDb(t: TestDb): void {
  t.db.close();
  fs.rmSync(t.dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// A simple 3-step linear all-agent workflow carried in spec_json.
// ---------------------------------------------------------------------------

const WORKFLOW_NAME = 'monitor-directives-smoke';

function linearDef(): WorkflowDefinition {
  return {
    id: WORKFLOW_NAME,
    phases: [
      {
        id: 'main',
        label: 'Main',
        color: '#3b6dd6',
        steps: [
          { id: 'draft', name: 'Draft', agent: 'implement', mcps: [], retries: 0 },
          { id: 'middle', name: 'Middle', agent: 'implement', mcps: [], retries: 0 },
          { id: 'finalize', name: 'Finalize', agent: 'implement', mcps: [], retries: 0 },
        ],
      },
    ],
  };
}

/** Seed workflows + workflow_runs rows so the reporter's current_step_id advance is observable. */
function seedWorkflowAndRun(db: TestDb['db'], runId: string, specJson: string): string {
  const workflowId = `wf-${randomUUID()}`;
  db.prepare(`INSERT INTO workflows (id, project_id, name, spec_json) VALUES (?, 1, ?, ?)`).run(
    workflowId,
    WORKFLOW_NAME,
    specJson,
  );
  db.prepare(
    `INSERT INTO workflow_runs
       (id, workflow_id, project_id, status, worktree_path, permission_mode_snapshot, execution_model)
     VALUES (?, ?, 1, 'running', '/tmp/mondir-wt', 'auto', 'programmatic')`,
  ).run(runId, workflowId);
  return workflowId;
}

/** The in-memory run/workflow rows the RunExecutor's registry stub returns. */
function registryFor(runId: string, workflowId: string, specJson: string): WorkflowRegistryLike {
  const run: WorkflowRunRow = {
    id: runId,
    workflow_id: workflowId,
    project_id: 1,
    status: 'running',
    permission_mode_snapshot: 'auto',
    worktree_path: '/tmp/mondir-wt',
    branch_name: null,
    execution_model: 'programmatic',
    created_at: 'now',
    updated_at: 'now',
  };
  const workflow: WorkflowRow = {
    id: workflowId,
    project_id: 1,
    name: WORKFLOW_NAME,
    workflow_path: null,
    permission_mode: 'default',
    spec_json: specJson,
    created_at: 'now',
  };
  return { getRunById: () => run, getById: () => workflow };
}

// ---------------------------------------------------------------------------
// fakeSdk-backed recording spawner: every agent step's spawn drives a fakeSdk
// scenario (the SDK boundary) and records the ClaudeSpawnerOptions it received,
// so we can assert which step prompts the fake SDK was — and was NOT — asked to run.
// ---------------------------------------------------------------------------

function makeRecordingSpawner(): ClaudeSpawnerLike & { calls: ClaudeSpawnerOptions[] } {
  const calls: ClaudeSpawnerOptions[] = [];
  const emptyOptions: Options = {};
  return {
    calls,
    async spawnCliProcess(o: ClaudeSpawnerOptions): Promise<void> {
      calls.push(o);
      const events = [
        sdkSystemInit({ cwd: o.worktreePath }),
        sdkAssistantText(`agent turn for ${o.prompt.slice(0, 24)}`),
        sdkResultSuccess(),
      ];
      const params: FakeQueryParams = { prompt: o.prompt, options: emptyOptions };
      const q = makeFakeQuery(events)(params);
      // Drain the fake generator (the SDK boundary) — a resolved spawn ⇒ step ok.
      for await (const _ev of q) {
        void _ev;
      }
    },
    abort: async () => {},
  };
}

/** Build a real DefaultProgrammaticRunner + a real RunExecutor over the given DB. */
function bootExecutor(
  t: TestDb,
  registry: WorkflowRegistryLike,
): {
  executor: RunExecutor;
  spawner: ReturnType<typeof makeRecordingSpawner>;
  store: StepResultStore;
} {
  const adapter = dbAdapter(t.db);
  const logger = makeSpyLogger();
  const store = new StepResultStore(t.db);
  const mgr = HumanStepManager.initialize(adapter);
  const spawner = makeRecordingSpawner();
  const reporter: StepReporter = {
    report: (rid, sid, status) => void buildStepTransitionEvent(rid, sid, status, adapter, logger),
  };
  const gate = new ReviewQueueHumanGate(mgr, reviewItemChangeEvents, reviewItemProjectChannel);
  const runner: ProgrammaticRunner = new DefaultProgrammaticRunner({
    spawner,
    reporter,
    gate,
    stepResultRecorder: (runId, report) =>
      store.record({
        runId,
        stepId: report.stepId,
        phaseId: report.phaseId,
        outcome: report.outcome,
        attempts: report.attempts,
        ...(report.error !== undefined ? { error: report.error } : {}),
      }),
    logger,
  });
  const executor = new RunExecutor(
    spawner, // orchestrated spawner slot (unused on the programmatic path)
    registry,
    logger,
    undefined, // promptReader (never called on the programmatic path)
    undefined, // lifecycleTransitions
    undefined, // publisher
    undefined, // db
    undefined, // source
    undefined, // stepEmitter
    undefined, // taskStageDeriver
    undefined, // ideaBodyReader
    undefined, // sprintLaneTaskIds
    runner, // programmaticRunner (slot 13)
  );
  return { executor, spawner, store };
}

afterEach(() => {
  HumanStepManager._resetForTesting();
  reviewItemChangeEvents.removeAllListeners();
  MonitorRegistry._resetForTesting();
});

describe('SMOKE: monitor live-directive seam through the real RunExecutor', () => {
  it('SKIP: addUserSkip of a not-yet-run required step records skipped, advances, and is never spawned', async () => {
    const t = buildMigrationDb();
    try {
      const runId = `run-${randomUUID()}`;
      const specJson = JSON.stringify(linearDef());
      const workflowId = seedWorkflowAndRun(t.db, runId, specJson);
      const { executor, spawner, store } = bootExecutor(t, registryFor(runId, workflowId, specJson));

      // Operator skips the MIDDLE step BEFORE the walk starts (the controller loop
      // head re-reads the run's directives, so a not-yet-reached step is skipped).
      executor.addUserSkip(runId, 'middle');

      // Drive to terminal. A failed run throws; resolves ⇒ normal terminal rest.
      await expect(executor.execute(runId)).resolves.toBeUndefined();

      // (a) step_results row for 'middle' has outcome 'skipped'.
      const middleResult = store.listForRun(runId).find((r) => r.stepId === 'middle');
      expect(middleResult).toBeDefined();
      expect(middleResult?.outcome).toBe('skipped');

      // (b) the fake SDK was asked to run ONLY draft + finalize — never 'middle'.
      const prompts = spawner.calls.map((c) => c.prompt);
      expect(spawner.calls).toHaveLength(2);
      expect(prompts.some((p) => p.includes('`draft`'))).toBe(true);
      expect(prompts.some((p) => p.includes('`finalize`'))).toBe(true);
      expect(prompts.some((p) => p.includes('`middle`'))).toBe(false);

      // (c) a REQUIRED skipped step ADVANCES: draft + finalize settled 'done', and
      //     the run's current_step_id advanced past the gate to the terminal step.
      const results = store.listForRun(runId);
      expect(results.find((r) => r.stepId === 'draft')?.outcome).toBe('done');
      expect(results.find((r) => r.stepId === 'finalize')?.outcome).toBe('done');
      const finalStep = t.db
        .prepare('SELECT current_step_id AS s FROM workflow_runs WHERE id = ?')
        .get(runId) as { s: string | null };
      expect(finalStep.s).toBe('finalize');
    } finally {
      teardownDb(t);
    }
  });

  it('STEER: setStepGuidance is appended to that step’s composed prompt under "## Operator guidance"', async () => {
    const t = buildMigrationDb();
    try {
      const runId = `run-${randomUUID()}`;
      const specJson = JSON.stringify(linearDef());
      const workflowId = seedWorkflowAndRun(t.db, runId, specJson);
      const { executor, spawner } = bootExecutor(t, registryFor(runId, workflowId, specJson));

      // Operator steers the FINALIZE step BEFORE it spawns (SpawnStepRunner's
      // per-step stepGuidance thunk re-reads the run's directives each turn).
      executor.setStepGuidance(runId, 'finalize', 'SMOKE_GUIDANCE_MARKER');

      await expect(executor.execute(runId)).resolves.toBeUndefined();

      // The prompt the fake SDK received for 'finalize' carries the marker under
      // the '## Operator guidance' section header.
      const finalizePrompt = spawner.calls.map((c) => c.prompt).find((p) => p.includes('`finalize`'));
      expect(finalizePrompt).toBeDefined();
      expect(finalizePrompt).toContain('SMOKE_GUIDANCE_MARKER');
      expect(finalizePrompt).toContain('## Operator guidance');

      // Control: an un-steered step (draft) carries NO guidance section.
      const draftPrompt = spawner.calls.map((c) => c.prompt).find((p) => p.includes('`draft`'));
      expect(draftPrompt).toBeDefined();
      expect(draftPrompt).not.toContain('## Operator guidance');
    } finally {
      teardownDb(t);
    }
  });
});
