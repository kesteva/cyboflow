/**
 * Tier-3 mocked-SDK integration — crash-safe RESUME of a stranded programmatic run.
 *
 * A programmatic run that died mid-walk leaves its `workflow_runs` row at
 * status='running' with a `current_step_id` pointer and per-step `step_results`,
 * but NO in-process executor. This drives the REAL boot-recovery path end to end:
 *
 *   1. Seed a stranded programmatic run (status='running', execution_model=
 *      'programmatic', current_step_id='step-b') + a step_results row marking
 *      'step-a' done — the DB state a crash after step-a leaves behind.
 *   2. Run the REAL `recoverActiveStateOrphans(db, runQueues)` (the boot-recovery
 *      entry point): it RESETS the orphan to 'starting' (NOT force-failed, because
 *      it is programmatic) and returns it in `programmaticToResume` carrying the
 *      coarse `currentStepId` resume pointer + the fine `completedStepIds` read from
 *      step_results.
 *   3. Re-drive via the pending-resume mechanism (the same values RunExecutor
 *      threads as `resumeFromStepId` + `completedStepIds`) on the REAL
 *      DefaultProgrammaticRunner with a fakeSdk-backed spawner — the walk skips the
 *      already-completed step, resumes from the pointer, and rests cleanly.
 *
 * Asserts, against real code behaviour:
 *   - recovery reset status 'running' → 'starting' and returned exactly one
 *     programmatic run to resume with the right currentStepId + completedStepIds;
 *   - the re-drive did NOT re-spawn the pre-resume/completed step 'step-a';
 *   - it DID spawn from the resume point onward (step-b, step-c) and current_step_id
 *     advanced to the terminal step;
 *   - ZERO of the fakeSdk-produced raw_events narrow to `{ kind:'__unknown__' }`.
 *
 * DEVIATION (code won): "strand mid-walk (end the fake stream without a result)"
 * is represented by SEEDING the post-crash DB state directly — which is precisely
 * the orphan condition recoverActiveStateOrphans detects (status + registry-miss),
 * since a real crash removes the in-process executor entirely (no stream to end).
 * Builds on the `programmaticIntegration.test.ts` + `runRecovery.test.ts`
 * precedents; no harness edit.
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
import { recoverActiveStateOrphans } from '../../runRecovery';
import { RunQueueRegistry } from '../../RunQueueRegistry';
import { TypedEventNarrowing } from '../../../services/streamParser';
import type {
  ClaudeSpawnerLike,
  ClaudeSpawnerOptions,
  ProgrammaticRunContext,
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
// Migration-replay temp DB (full current app schema).
// ---------------------------------------------------------------------------

interface TestDb {
  service: DatabaseService;
  db: ReturnType<DatabaseService['getDb']>;
  dir: string;
}

function buildMigrationDb(): TestDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-crashresume-db-'));
  const service = new DatabaseService(path.join(dir, 'resume.db'));
  service.initialize();
  const db = service.getDb();
  db.prepare('INSERT OR IGNORE INTO projects (id, name, path) VALUES (1, ?, ?)').run(
    'crashresume',
    '/tmp/crashresume',
  );
  return { service, db, dir };
}

function teardownDb(t: TestDb): void {
  t.db.close();
  fs.rmSync(t.dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// A 3-agent-step DAG (custom def carried in spec_json).
// ---------------------------------------------------------------------------

const WORKFLOW_NAME = 'crash-resume-flow';
const WORKFLOW_ID = 'wf-crashresume';

function threeStepDef(): WorkflowDefinition {
  return {
    id: WORKFLOW_NAME,
    phases: [
      {
        id: 'main',
        label: 'Main',
        color: '#3b6dd6',
        steps: [
          { id: 'step-a', name: 'Step A', agent: 'implement', mcps: [], retries: 0 },
          { id: 'step-b', name: 'Step B', agent: 'implement', mcps: [], retries: 0 },
          { id: 'step-c', name: 'Step C', agent: 'verifier', mcps: [], retries: 0 },
        ],
      },
    ],
  };
}

/** Seed a run stranded mid-walk: status='running', on step-b, with step-a done. */
function seedStrandedRun(db: TestDb['db'], runId: string): string {
  const specJson = JSON.stringify(threeStepDef());
  db.prepare(
    `INSERT INTO workflows (id, project_id, name, spec_json) VALUES (?, 1, ?, ?)`,
  ).run(WORKFLOW_ID, WORKFLOW_NAME, specJson);
  db.prepare(
    `INSERT INTO workflow_runs
       (id, workflow_id, project_id, status, worktree_path, permission_mode_snapshot,
        execution_model, current_step_id)
     VALUES (?, ?, 1, 'running', '/tmp/crashresume-wt', 'auto', 'programmatic', 'step-b')`,
  ).run(runId, WORKFLOW_ID);
  // step-a completed before the crash (persisted done).
  db.prepare(
    `INSERT INTO step_results (run_id, step_id, phase_id, outcome, attempts)
     VALUES (?, 'step-a', 'main', 'done', 1)`,
  ).run(runId);
  return specJson;
}

function ctxFor(
  runId: string,
  specJson: string,
  resume: { resumeFromStepId?: string; completedStepIds?: ReadonlySet<string> },
): ProgrammaticRunContext {
  const workflow: WorkflowRow = {
    id: WORKFLOW_ID,
    project_id: 1,
    name: WORKFLOW_NAME,
    workflow_path: null,
    permission_mode: 'default',
    spec_json: specJson,
    created_at: 'now',
  };
  const run: WorkflowRunRow = {
    id: runId,
    workflow_id: WORKFLOW_ID,
    project_id: 1,
    status: 'running',
    permission_mode_snapshot: 'auto',
    worktree_path: '/tmp/crashresume-wt',
    branch_name: null,
    execution_model: 'programmatic',
    current_step_id: 'step-b',
    created_at: 'now',
    updated_at: 'now',
  };
  return {
    runId,
    panelId: runId,
    sessionId: runId,
    worktreePath: '/tmp/crashresume-wt',
    run,
    workflow,
    agentPermissionMode: 'auto',
    signal: new AbortController().signal,
    injectEvent: () => {},
    ...(resume.resumeFromStepId ? { resumeFromStepId: resume.resumeFromStepId } : {}),
    ...(resume.completedStepIds ? { completedStepIds: resume.completedStepIds } : {}),
  };
}

function makeRecordingSpawner(
  db: TestDb['db'],
): ClaudeSpawnerLike & { calls: ClaudeSpawnerOptions[] } {
  const calls: ClaudeSpawnerOptions[] = [];
  const emptyOptions: Options = {};
  return {
    calls,
    async spawnCliProcess(o: ClaudeSpawnerOptions): Promise<void> {
      calls.push(o);
      const runId = o.runId ?? o.panelId;
      const events = [
        sdkSystemInit({ cwd: o.worktreePath }),
        sdkAssistantText(`resumed agent turn for ${o.prompt.slice(0, 24)}`),
        sdkResultSuccess(),
      ];
      const params: FakeQueryParams = { prompt: o.prompt, options: emptyOptions };
      const q = makeFakeQuery(events)(params);
      for await (const ev of q) {
        db.prepare(
          'INSERT INTO raw_events (run_id, event_type, payload_json) VALUES (?, ?, ?)',
        ).run(runId, ev.type, JSON.stringify(ev));
      }
    },
    abort: async () => {},
  };
}

function countUnknownSdkEvents(db: TestDb['db'], runId: string): number {
  const narrower = new TypedEventNarrowing();
  const rows = db
    .prepare(
      "SELECT payload_json AS p FROM raw_events WHERE run_id = ? AND event_type != 'step_transition'",
    )
    .all(runId) as Array<{ p: string }>;
  let unknown = 0;
  for (const { p } of rows) {
    const narrowed = narrower.narrow(JSON.parse(p) as unknown);
    if ('kind' in narrowed && narrowed.kind === '__unknown__') unknown++;
  }
  return unknown;
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

afterEach(() => {
  HumanStepManager._resetForTesting();
  reviewItemChangeEvents.removeAllListeners();
  MonitorRegistry._resetForTesting();
});

describe('Tier-3 programmatic: crash-safe resume re-drives a stranded run to a clean rest', () => {
  it('recovery resets the orphan, then pending-resume skips completed steps and completes', async () => {
    const t = buildMigrationDb();
    try {
      const runId = `run-${randomUUID()}`;
      const specJson = seedStrandedRun(t.db, runId);
      const adapter = dbAdapter(t.db);
      const logger = makeSpyLogger();

      // (1) Boot recovery — empty registry ⇒ the seeded run is an orphan.
      const runQueues = new RunQueueRegistry();
      const result = recoverActiveStateOrphans(adapter, runQueues);

      // A programmatic orphan is RESET (not force-failed) and returned to resume.
      expect(result.runningRecovered).toBe(0); // programmatic ⇒ not counted as force-failed
      expect(result.programmaticToResume).toHaveLength(1);
      const toResume = result.programmaticToResume[0];
      expect(toResume.id).toBe(runId);
      expect(toResume.currentStepId).toBe('step-b');
      expect(toResume.completedStepIds).toEqual(['step-a']);

      // Status was reset running → starting (the resume pointer preserved).
      const afterRecovery = t.db
        .prepare('SELECT status, current_step_id AS s FROM workflow_runs WHERE id = ?')
        .get(runId) as { status: string; s: string | null };
      expect(afterRecovery.status).toBe('starting');
      expect(afterRecovery.s).toBe('step-b');

      // (2) Re-drive exactly as RunExecutor.executeProgrammatic does: flip
      //     starting → running (pre_spawn), then run the controller threading the
      //     recovery's resume pointer + completed step ids (setPendingResumeStep /
      //     setPendingCompletedSteps equivalents).
      t.db.prepare("UPDATE workflow_runs SET status = 'running' WHERE id = ?").run(runId);

      const spawner = makeRecordingSpawner(t.db);
      HumanStepManager.initialize(adapter);
      const reporter: StepReporter = {
        report: (rid, sid, status) => void buildStepTransitionEvent(rid, sid, status, adapter, logger),
      };
      const gate = new ReviewQueueHumanGate(
        HumanStepManager.getInstance(),
        reviewItemChangeEvents,
        reviewItemProjectChannel,
      );
      const runner = new DefaultProgrammaticRunner({ spawner, reporter, gate, logger });

      await expect(
        runner.run(
          ctxFor(runId, specJson, {
            resumeFromStepId: toResume.currentStepId ?? undefined,
            completedStepIds: new Set(toResume.completedStepIds),
          }),
        ),
      ).resolves.toBeUndefined();

      // (3a) The completed / pre-resume step 'step-a' was NOT re-spawned.
      const prompts = spawner.calls.map((c) => c.prompt);
      expect(prompts.some((p) => p.includes('`step-a`'))).toBe(false);
      // The resume point onward DID spawn.
      expect(prompts.some((p) => p.includes('`step-b`'))).toBe(true);
      expect(prompts.some((p) => p.includes('`step-c`'))).toBe(true);
      expect(spawner.calls).toHaveLength(2);

      // (3b) The walk reached the terminal step (clean rest).
      const finalStep = t.db
        .prepare('SELECT current_step_id AS s FROM workflow_runs WHERE id = ?')
        .get(runId) as { s: string | null };
      expect(finalStep.s).toBe('step-c');

      // (4) Honesty check — 2 re-spawns × 3 events = 6 SDK raw_events, none __unknown__.
      const sdkCount = (
        t.db
          .prepare(
            "SELECT COUNT(*) AS n FROM raw_events WHERE run_id = ? AND event_type != 'step_transition'",
          )
          .get(runId) as { n: number }
      ).n;
      expect(sdkCount).toBe(6);
      expect(countUnknownSdkEvents(t.db, runId)).toBe(0);
    } finally {
      teardownDb(t);
    }
  });
});
