/**
 * Integration tests for workflow step tracking on the INTERACTIVE substrate
 * (IDEA-013 S6 / TASK-811).
 *
 * This slice adds ONE real seam — the prompt-body PREPEND of the TASK-803
 * step-reporting instruction onto the initial prompt written to PTY stdin —
 * and otherwise VERIFIES that IDEA-029's MCP-driven tracking chain advances the
 * Workflow Progress panel IDENTICALLY on the interactive substrate. No tracking
 * pipeline is built here: the report_step advance flows through the SAME
 * DB→stepTransitionEvents→mergeTransition chain the SDK path uses
 * (buildStepTransitionEvent / getPhaseState), which this test exercises directly.
 *
 * Fixture style mirrors interactiveClaudeManager.test.ts (stub IPty + fake
 * TranscriptSource + in-memory better-sqlite3 DB + spy logger) and the
 * orchestrator DB fixtures used by stepTransitionBridge / runs.getPhaseState
 * tests. Zero real `claude` spawn, zero real FS tail.
 *
 * Covered (per test_strategy.targets):
 *  (1) Env + prepend — env.CYBOFLOW_RUN_ID === workflow_runs.id (NOT the
 *      discovered Claude session UUID); the first PTY stdin write begins with the
 *      buildStepReportingAppend text immediately followed by the prompt body.
 *  (2) MCP-driven advance, stream-independent — with the fake TranscriptSource
 *      STOPPED/never-started (zero onLine events), a report_step transition still
 *      advances current_step_id, emits exactly one 'transition' event, and
 *      getPhaseState returns stepStates with that step 'running' / prior 'done'.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../../../orchestrator/__test_fixtures__/orchestratorTestDb';
import { dbAdapter } from '../../../../orchestrator/__test_fixtures__/dbAdapter';
import { makeSpyLogger } from '../../../../orchestrator/__test_fixtures__/loggerLikeSpy';
import { ApprovalRouter } from '../../../../orchestrator/approvalRouter';
import { QuestionRouter } from '../../../../orchestrator/questionRouter';
import { stepTransitionEvents } from '../../../../orchestrator/trpc/routers/events';
import { buildStepTransitionEvent } from '../../../../orchestrator/stepTransitionBridge';
import { appRouter } from '../../../../orchestrator/trpc/router';
import { createContext } from '../../../../orchestrator/trpc/context';
import { buildStepReportingAppend } from '../../../../orchestrator/prompts/step-reporting-instructions';
import {
  resolveWorkflowDefinition,
  type WorkflowStepTransitionEvent,
} from '../../../../../../shared/types/workflows';
import { InteractiveClaudeManager } from '../interactiveClaudeManager';
import type { SessionManager } from '../../../sessionManager';
import type { ConfigManager } from '../../../configManager';
import type { Logger } from '../../../../utils/logger';
import type {
  TranscriptSource,
  OnLineCallback,
  OnTurnEndCallback,
} from '../transcript/transcriptSource';

// ---------------------------------------------------------------------------
// Stub IPty — records writes; fires onExit on demand.
// ---------------------------------------------------------------------------

interface ExitListener {
  (e: { exitCode: number; signal?: number }): void;
}

class FakePty {
  // pid 0 (falsy) so AbstractCliManager.killProcess takes the simple
  // process.kill() fallback and never runs the real `ps`/`kill` shell calls.
  readonly pid = 0;
  readonly process = 'claude';
  readonly cols = 80;
  readonly rows = 30;
  readonly handleFlowControl = false;
  readonly writes: string[] = [];
  private exitListeners: ExitListener[] = [];

  onData = (_cb: (d: string) => void): { dispose(): void } => ({ dispose: () => undefined });

  onExit = (cb: ExitListener): { dispose(): void } => {
    this.exitListeners.push(cb);
    return { dispose: () => undefined };
  };

  write(data: string): void {
    this.writes.push(data);
  }

  resize(): void {
    // no-op
  }

  clear(): void {
    // no-op
  }

  kill(): void {
    // no-op
  }

  pause(): void {
    // no-op
  }

  resume(): void {
    // no-op
  }

  on(): void {
    // no-op
  }

  fireExit(exitCode: number): void {
    for (const cb of this.exitListeners) cb({ exitCode });
  }
}

// ---------------------------------------------------------------------------
// Fake TranscriptSource — captures onLine; the test NEVER pushes a line, proving
// the step advance is MCP-driven (report_step), not transcript-derived.
// ---------------------------------------------------------------------------

class FakeTranscriptSource implements TranscriptSource {
  onLine: OnLineCallback | undefined;
  onTurnEnd: OnTurnEndCallback | undefined;
  stopped = false;
  started = false;
  private uuid: string | undefined;

  constructor(uuid?: string) {
    this.uuid = uuid;
  }

  async start(onLine: OnLineCallback, onTurnEnd?: OnTurnEndCallback): Promise<void> {
    this.onLine = onLine;
    this.onTurnEnd = onTurnEnd;
    this.started = true;
  }

  stop(): void {
    this.stopped = true;
  }

  async waitForFirstLine(_timeoutMs: number): Promise<void> {
    // Discovery succeeds immediately in tests.
  }

  getSessionUuid(): string | undefined {
    return this.uuid;
  }
}

// ---------------------------------------------------------------------------
// Testable subclass — replaces the real-I/O hooks (PTY spawn, availability,
// transcript factory, system env) with fakes and CAPTURES the env passed to the
// inherited spawnPtyProcess seam so the test can assert CYBOFLOW_RUN_ID. The
// production class never redeclares the inherited base PTY machinery.
// ---------------------------------------------------------------------------

class TestableInteractiveClaudeManager extends InteractiveClaudeManager {
  readonly ptys: FakePty[] = [];
  readonly fakeSources: FakeTranscriptSource[] = [];
  nextSessionUuid: string | undefined;
  capturedEnv: { [key: string]: string } | undefined;
  /** Captured argv — the initial prompt now rides claude's positional arg, not a PTY write. */
  capturedArgs: string[] | undefined;

  protected override async testCliAvailability(): Promise<{ available: boolean; error?: string; version?: string; path?: string }> {
    return { available: true, version: '1.0.0', path: '/fake/bin/claude' };
  }

  protected override async getCliExecutablePath(): Promise<string> {
    return '/fake/bin/claude';
  }

  protected override async getSystemEnvironment(): Promise<{ [key: string]: string }> {
    return { PATH: '/usr/bin' };
  }

  protected override async spawnPtyProcess(
    _command: string,
    args: string[],
    _cwd: string,
    env: { [key: string]: string },
  ): Promise<import('@homebridge/node-pty-prebuilt-multiarch').IPty> {
    this.capturedEnv = env;
    this.capturedArgs = args;
    const fake = new FakePty();
    this.ptys.push(fake);
    return fake as unknown as import('@homebridge/node-pty-prebuilt-multiarch').IPty;
  }

  protected override createTranscriptSource(): TranscriptSource {
    const src = new FakeTranscriptSource(this.nextSessionUuid);
    this.fakeSources.push(src);
    return src;
  }
}

// ---------------------------------------------------------------------------
// Mock SessionManager + ConfigManager + helpers
// ---------------------------------------------------------------------------

interface MockDb {
  updateSession: MockInstance;
}

function createMockSessionManager(
  overrides?: Partial<Omit<SessionManager, 'db'>> & { db?: MockDb },
): SessionManager {
  return {
    getDbSession: vi.fn(() => undefined),
    getPanelClaudeSessionId: vi.fn(() => undefined),
    getProjectById: vi.fn(() => undefined),
    updateSession: vi.fn(),
    db: { updateSession: vi.fn() },
    ...overrides,
  } as unknown as SessionManager;
}

function createMockConfigManager(): ConfigManager {
  return {
    getConfig: vi.fn(() => ({ claudeExecutablePath: undefined })),
  } as unknown as ConfigManager;
}

/**
 * Manager-facing logger spy. The production `Logger` surface the manager (and its
 * inherited base PTY machinery) call includes `verbose`, which the bridge-facing
 * `LoggerLike` from makeSpyLogger() does not — so we supply a verbose-capable spy
 * here and keep makeSpyLogger() for the bridge LoggerLike argument. Every method
 * is a vi.fn() so the manager's optional-logger threading is exercised, never
 * omitted (CLAUDE.md optional-logger rule).
 */
function createManagerLoggerSpy(): Pick<Logger, 'verbose' | 'info' | 'warn' | 'error'> {
  return {
    verbose: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Pick<Logger, 'verbose' | 'info' | 'warn' | 'error'>;
}

/** Poll until predicate() is true, draining microtasks + timers each tick. */
async function waitFor(predicate: () => boolean, maxTicks = 200): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error('waitFor: predicate never became true');
}

/**
 * Create an in-memory DB with the full cyboflow schema + the current_step_id
 * column (migration 011). Mirrors stepTransitionBridge.test.ts /
 * runs.getPhaseState integration tests — orchestratorTestDb.ts is files_readonly,
 * so the ALTER is inlined here.
 */
function createTestDbWithStepTracking(): Database.Database {
  const db = createTestDb();
  db.exec('ALTER TABLE workflow_runs ADD COLUMN current_step_id TEXT');
  return db;
}

/**
 * Seed a workflow + workflow_run pair for a given SoloFlow workflow name and
 * spec_json. Returns { workflowId, runId }.
 */
function seedRunWithWorkflow(
  db: Database.Database,
  runId: string,
  workflowName: string,
  specJson = '{}',
): { workflowId: string; runId: string } {
  const workflowId = `wf-${runId}`;
  db.prepare(
    `INSERT INTO workflows (id, project_id, name, spec_json) VALUES (?, 1, ?, ?)`,
  ).run(workflowId, workflowName, specJson);
  db.prepare(
    `INSERT INTO workflow_runs
       (id, workflow_id, project_id, worktree_path, status, policy_json, current_step_id)
     VALUES (?, ?, 1, '/tmp/test', 'running', '{}', NULL)`,
  ).run(runId, workflowId);
  return { workflowId, runId };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InteractiveClaudeManager — workflow step tracking (TASK-811)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDbWithStepTracking();
    ApprovalRouter.initialize(dbAdapter(db));
    QuestionRouter.initialize(dbAdapter(db));
  });

  afterEach(() => {
    ApprovalRouter._resetForTesting();
    QuestionRouter._resetForTesting();
    stepTransitionEvents.removeAllListeners('transition');
    db.close();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // (1) Env carries CYBOFLOW_RUN_ID = workflow_runs.id; instruction is prepended
  //     to the prompt body written to PTY stdin.
  // -------------------------------------------------------------------------
  describe('env + prompt-body prepend', () => {
    it('sets CYBOFLOW_RUN_ID to the workflow run id (NOT the Claude session UUID) and prepends the step-reporting instruction to the first PTY stdin write', async () => {
      const runId = 'run-sprint-track-01';
      const sessionUuid = 'claude-session-uuid-distinct-from-run';
      seedRunWithWorkflow(db, runId, 'sprint');

      // The session row carries run_id = the real workflow_runs.id (TASK-800
      // binding). The discovered transcript filename yields a DIFFERENT uuid.
      const sm = createMockSessionManager({
        getDbSession: vi.fn(() => ({ run_id: runId })) as unknown as SessionManager['getDbSession'],
      });
      const mgr = new TestableInteractiveClaudeManager(
        sm,
        createManagerLoggerSpy() as unknown as Logger,
        createMockConfigManager(),
        db,
      );
      // CYBOFLOW_RUN_ID / CYBOFLOW_ORCH_SOCKET are only injected when an
      // orchestrator socket has been set (mirrors the SDK setOrchSocketPath seam).
      mgr.setOrchSocketPath('/tmp/orch.sock');
      mgr.nextSessionUuid = sessionUuid;

      const prompt = 'Implement TASK-XYZ end to end.';
      const spawn = mgr.spawnCliProcess({
        panelId: runId,
        sessionId: 'sess-track-01',
        worktreePath: '/tmp/wt-track',
        prompt,
      });
      await waitFor(() => mgr.ptys.length > 0 && mgr.capturedArgs !== undefined);

      // Env carries the real run id, distinct from the discovered session UUID.
      expect(mgr.capturedEnv?.CYBOFLOW_RUN_ID).toBe(runId);
      expect(mgr.capturedEnv?.CYBOFLOW_RUN_ID).not.toBe(sessionUuid);
      expect(mgr.capturedEnv?.CYBOFLOW_ORCH_SOCKET).toBe('/tmp/orch.sock');

      // The initial prompt rides claude's POSITIONAL argv (last arg): the
      // step-reporting append, a blank line, then the prompt body. The expected
      // append is built from the run's RESOLVED definition (dynamic step-id model).
      const expectedAppend = buildStepReportingAppend(resolveWorkflowDefinition('sprint', '{}'));
      expect(expectedAppend.length).toBeGreaterThan(0);

      const promptArg = mgr.capturedArgs?.[mgr.capturedArgs.length - 1] ?? '';
      expect(promptArg.startsWith(expectedAppend)).toBe(true);
      expect(promptArg).toBe(`${expectedAppend}\n\n${prompt}`);
      // The instruction names cyboflow_report_step and lists the run's step ids.
      expect(promptArg).toContain('cyboflow_report_step');
      expect(promptArg).toContain('`implement`');

      mgr.ptys[0].fireExit(0);
      await new Promise((r) => setTimeout(r, 600));
      await spawn;
    });

    it('prepends NOTHING for a non-SoloFlow workflow (fail-soft empty append)', async () => {
      const runId = 'run-custom-track-01';
      // A non-SoloFlow name with no usable spec_json resolves to a null
      // definition → buildStepReportingAppend('') → prompt sent unchanged.
      seedRunWithWorkflow(db, runId, 'not-a-soloflow-workflow');

      const sm = createMockSessionManager({
        getDbSession: vi.fn(() => ({ run_id: runId })) as unknown as SessionManager['getDbSession'],
      });
      const mgr = new TestableInteractiveClaudeManager(
        sm,
        createManagerLoggerSpy() as unknown as Logger,
        createMockConfigManager(),
        db,
      );
      mgr.setOrchSocketPath('/tmp/orch.sock');

      const prompt = 'Do the custom thing.';
      const spawn = mgr.spawnCliProcess({
        panelId: runId,
        sessionId: 'sess-custom-01',
        worktreePath: '/tmp/wt-custom',
        prompt,
      });
      await waitFor(() => mgr.ptys.length > 0 && mgr.capturedArgs !== undefined);

      // No step-reporting text — the prompt rides argv verbatim (no append).
      const promptArg = mgr.capturedArgs?.[mgr.capturedArgs.length - 1] ?? '';
      expect(promptArg).toBe(prompt);
      expect(promptArg).not.toContain('cyboflow_report_step');

      mgr.ptys[0].fireExit(0);
      await new Promise((r) => setTimeout(r, 600));
      await spawn;
    });
  });

  // -------------------------------------------------------------------------
  // (2) MCP-driven advance, stream-independent: with the TranscriptSource
  //     never pushing a line, a report_step transition advances current_step_id,
  //     emits exactly one 'transition' event, and getPhaseState reflects it.
  // -------------------------------------------------------------------------
  describe('MCP-driven advance is stream-independent', () => {
    it('advances current_step_id + getPhaseState via the report_step chain while the TranscriptSource emits ZERO panel events', async () => {
      const runId = 'run-sprint-advance-01';
      seedRunWithWorkflow(db, runId, 'sprint');

      const sm = createMockSessionManager({
        getDbSession: vi.fn(() => ({ run_id: runId })) as unknown as SessionManager['getDbSession'],
      });
      const mgr = new TestableInteractiveClaudeManager(
        sm,
        createManagerLoggerSpy() as unknown as Logger,
        createMockConfigManager(),
        db,
      );
      mgr.setOrchSocketPath('/tmp/orch.sock');

      // Count panel 'output' events that originate from a transcript line. The
      // spawn path emits one session_info descriptor at start; we drop that and
      // assert NO further output events fire (the source never pushes a line).
      const outputs: unknown[] = [];
      mgr.on('output', (evt) => outputs.push(evt));

      const spawn = mgr.spawnCliProcess({
        panelId: runId,
        sessionId: 'sess-advance-01',
        worktreePath: '/tmp/wt-advance',
        prompt: 'go',
      });
      await waitFor(() => mgr.fakeSources.length > 0 && mgr.fakeSources[0].started);

      // STOP the TranscriptSource so the tail cannot drive any advance, then drop
      // the spawn-time session_info descriptor. From here, zero transcript lines.
      mgr.fakeSources[0].stop();
      outputs.length = 0;

      // Capture step-transition emits to prove exactly one fires.
      const emitted: WorkflowStepTransitionEvent[] = [];
      stepTransitionEvents.on('transition', (ev: WorkflowStepTransitionEvent) => emitted.push(ev));

      // Pre-state: no step is active.
      const before = db
        .prepare('SELECT current_step_id FROM workflow_runs WHERE id = ?')
        .get(runId) as { current_step_id: string | null } | undefined;
      expect(before?.current_step_id).toBeNull();

      // Drive a report_step transition through the SHARED chain (the same
      // buildStepTransitionEvent the SDK path and TASK-802's handleReportStep
      // call). 'write-tests' is the second flat sprint step — a valid, non-initial
      // id so prior steps ('implement') must read 'done'.
      const logger = makeSpyLogger();
      const advanceTo = 'write-tests';
      const event = buildStepTransitionEvent(runId, advanceTo, 'running', dbAdapter(db), logger);

      // (a) current_step_id was written.
      const after = db
        .prepare('SELECT current_step_id FROM workflow_runs WHERE id = ?')
        .get(runId) as { current_step_id: string | null } | undefined;
      expect(after?.current_step_id).toBe(advanceTo);

      // (b) exactly one 'transition' event was emitted, with the right shape.
      expect(event).not.toBeNull();
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({ runId, stepId: advanceTo, status: 'running' });

      // (c) getPhaseState reflects the advance — IDENTICAL in shape to the SDK
      // assertion: the advanced step is 'running', prior steps 'done', later
      // steps 'pending'. Driven through the same tRPC procedure the renderer uses.
      const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
      const phase = await caller.cyboflow.runs.getPhaseState({ runId });
      expect(phase.currentStepId).toBe(advanceTo);

      const byId = new Map(phase.stepStates.map((s) => [s.stepId, s.status]));
      expect(byId.get('implement')).toBe('done');
      expect(byId.get('write-tests')).toBe('running');
      expect(byId.get('code-review')).toBe('pending');

      // (d) the transcript tail fired ZERO panel events for that advance — the
      // advance is MCP-driven, not stream-derived (stream-independence assertion).
      expect(outputs).toHaveLength(0);
      expect(mgr.fakeSources[0].stopped).toBe(true);

      mgr.ptys[0].fireExit(0);
      await new Promise((r) => setTimeout(r, 600));
      await spawn;
    });
  });
});
