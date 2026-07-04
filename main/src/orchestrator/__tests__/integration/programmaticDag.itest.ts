/**
 * Tier-3 mocked-SDK integration — PROGRAMMATIC execution-model DAG walk.
 *
 * Drives the REAL programmatic engine — DefaultProgrammaticRunner → real
 * WorkflowController → real SpawnStepRunner (step spawns backed by the shared
 * `fakeSdk` query) → real ProgrammaticRunHost → real ReviewQueueHumanGate over the
 * REAL HumanStepManager + REAL reviewItemChangeEvents — against a migration-replay
 * temp DB (the current app schema, so review_items / step_results / execution_model
 * all exist). ONLY the SDK boundary is faked: each agent step's spawn runs a
 * fakeSdk scenario and records its SDKMessages verbatim into `raw_events`.
 *
 * The scripted DAG is the minimal spawn → human-gate → spawn shape:
 *   draft (agent) → review (pure human gate) → finalize (agent)
 *
 * Asserts, against real code behaviour:
 *   1. both AGENT steps spawn (the pure gate never spawns) — 2 spawns;
 *   2. the human gate co-writes a BLOCKING review_items row and, while it is open,
 *      the run is PAUSED — current_step_id is still the gate step, NOT `finalize`
 *      (advancement is blocked until the human resolves);
 *   3. after the gate resolves, current_step_id advances to the terminal step;
 *   4. ZERO of the fakeSdk-produced raw_events narrow to `{ kind:'__unknown__' }`
 *      (the honesty check — the step_transition timeline rows the reporter writes
 *      are a derived projection, excluded from the SDK-event honesty scope).
 *
 * DEVIATIONS from the plan / task brief (code won):
 *  - The plan/brief say the human gate writes `review_items(kind='human_task')`.
 *    The REAL code (HumanStepManager.openHumanGate → coWriteDecisionReviewItem)
 *    writes `kind='decision'` with `source='gate:human-step:<stepId>'`. Asserted
 *    against the real kind/source.
 *  - The M6a `headlessRun` harness drives a hand-rolled spawn loop, NOT the
 *    programmatic WorkflowController, so this scenario builds directly on the
 *    `programmaticIntegration.test.ts` precedent (real runner + DB) with a
 *    fakeSdk-backed recording spawner added — no harness edit.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-progdag-db-'));
  const service = new DatabaseService(path.join(dir, 'prog.db'));
  service.initialize();
  const db = service.getDb();
  db.prepare('INSERT OR IGNORE INTO projects (id, name, path) VALUES (1, ?, ?)').run(
    'progdag',
    '/tmp/progdag',
  );
  return { service, db, dir };
}

function teardownDb(t: TestDb): void {
  t.db.close();
  fs.rmSync(t.dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// The minimal spawn → gate → spawn DAG (custom def carried in spec_json).
// ---------------------------------------------------------------------------

const WORKFLOW_NAME = 'prog-dag-flow';

function dagDef(): WorkflowDefinition {
  return {
    id: WORKFLOW_NAME,
    phases: [
      {
        id: 'main',
        label: 'Main',
        color: '#3b6dd6',
        steps: [
          { id: 'draft', name: 'Draft', agent: 'implement', mcps: [], retries: 0 },
          // Pure human gate — agent 'human' (HUMAN_GATE_AGENT) ⇒ no spawn, opens a gate.
          { id: 'review', name: 'Review', agent: 'human', mcps: [], retries: 0, human: true },
          { id: 'finalize', name: 'Finalize', agent: 'verifier', mcps: [], retries: 0 },
        ],
      },
    ],
  };
}

function seedWorkflowAndRun(db: TestDb['db'], runId: string): { specJson: string } {
  const specJson = JSON.stringify(dagDef());
  const workflowId = `wf-${randomUUID()}`;
  db.prepare(
    `INSERT INTO workflows (id, project_id, name, spec_json) VALUES (?, 1, ?, ?)`,
  ).run(workflowId, WORKFLOW_NAME, specJson);
  db.prepare(
    `INSERT INTO workflow_runs
       (id, workflow_id, project_id, status, worktree_path, permission_mode_snapshot, execution_model)
     VALUES (?, ?, 1, 'running', '/tmp/progdag-wt', 'auto', 'programmatic')`,
  ).run(runId, workflowId);
  return { specJson };
}

function ctxFor(runId: string, specJson: string): ProgrammaticRunContext {
  const workflow: WorkflowRow = {
    id: 'wf-progdag',
    project_id: 1,
    name: WORKFLOW_NAME,
    workflow_path: null,
    permission_mode: 'default',
    spec_json: specJson,
    created_at: 'now',
  };
  const run: WorkflowRunRow = {
    id: runId,
    workflow_id: 'wf-progdag',
    project_id: 1,
    status: 'running',
    permission_mode_snapshot: 'auto',
    worktree_path: '/tmp/progdag-wt',
    branch_name: null,
    execution_model: 'programmatic',
    created_at: 'now',
    updated_at: 'now',
  };
  return {
    runId,
    panelId: runId,
    sessionId: runId,
    worktreePath: '/tmp/progdag-wt',
    run,
    workflow,
    agentPermissionMode: 'auto',
    signal: new AbortController().signal,
    injectEvent: () => {},
  };
}

// ---------------------------------------------------------------------------
// fakeSdk-backed recording spawner: each agent step's spawn runs a fakeSdk
// scenario and records every SDKMessage into raw_events (verbatim, event_type =
// message.type) — exactly the shape ClaudeCodeManager's RawEventsSink writes.
// ---------------------------------------------------------------------------

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
        sdkAssistantText(`agent turn for ${o.prompt.slice(0, 24)}`),
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

/** Count fakeSdk raw_events (event_type ≠ 'step_transition') that narrow to __unknown__. */
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

describe('Tier-3 programmatic: spawn → human gate → spawn walks the real DAG', () => {
  it('spawns both agent steps, blocks at the gate, advances after resolution, clean SDK events', async () => {
    const t = buildMigrationDb();
    try {
      const runId = `run-${randomUUID()}`;
      const { specJson } = seedWorkflowAndRun(t.db, runId);
      const adapter = dbAdapter(t.db);
      const logger = makeSpyLogger();

      const mgr = HumanStepManager.initialize(adapter);
      const spawner = makeRecordingSpawner(t.db);
      const reporter: StepReporter = {
        report: (rid, sid, status) => void buildStepTransitionEvent(rid, sid, status, adapter, logger),
      };
      const gate = new ReviewQueueHumanGate(mgr, reviewItemChangeEvents, reviewItemProjectChannel);

      // Background human: when the gate's review item is created, capture the run's
      // current_step_id (proving advancement is still blocked at the gate step),
      // then approve it. Deferred to a later macrotask (as a real reviewer is) so
      // the co-write transaction has committed before we resolve.
      let midGateStepId: string | null = null;
      const approver = (payload: unknown): void => {
        const p = payload as { reviewItemId?: string; action?: string };
        if (p?.action === 'created' && p.reviewItemId) {
          const row = t.db
            .prepare('SELECT current_step_id AS s FROM workflow_runs WHERE id = ?')
            .get(runId) as { s: string | null };
          midGateStepId = row.s;
          const id = p.reviewItemId;
          setTimeout(() => void mgr.resolveHumanGate(runId, id, 'user', 'approve'), 0);
        }
      };
      reviewItemChangeEvents.on(reviewItemProjectChannel(1), approver);

      const runner = new DefaultProgrammaticRunner({ spawner, reporter, gate, logger });
      await expect(runner.run(ctxFor(runId, specJson))).resolves.toBeUndefined();

      // 1. Exactly the two AGENT steps spawned; the pure gate never spawned.
      expect(spawner.calls).toHaveLength(2);
      const prompts = spawner.calls.map((c) => c.prompt);
      expect(prompts.some((p) => p.includes('`draft`'))).toBe(true);
      expect(prompts.some((p) => p.includes('`finalize`'))).toBe(true);
      expect(prompts.some((p) => p.includes('`review`'))).toBe(false);

      // 2. The gate co-wrote ONE blocking decision item; while it was open the run
      //    was paused AT the gate step (advancement blocked).
      const reviewRows = t.db
        .prepare('SELECT kind, source, status FROM review_items WHERE run_id = ?')
        .all(runId) as Array<{ kind: string; source: string; status: string }>;
      expect(reviewRows).toHaveLength(1);
      expect(reviewRows[0].kind).toBe('decision');
      expect(reviewRows[0].source).toBe('gate:human-step:review');
      expect(reviewRows[0].status).toBe('resolved');
      expect(midGateStepId).toBe('review');

      // 3. current_step_id advanced past the gate to the terminal step.
      const finalStep = t.db
        .prepare('SELECT current_step_id AS s FROM workflow_runs WHERE id = ?')
        .get(runId) as { s: string | null };
      expect(finalStep.s).toBe('finalize');

      // 4. Honesty check — every fakeSdk builder survived the REAL narrowing.
      //    2 spawns × 3 events = 6 SDK raw_events, none __unknown__.
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
