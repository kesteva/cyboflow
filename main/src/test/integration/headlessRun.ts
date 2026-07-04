/**
 * headlessRun — the Tier-3 (mocked-SDK integration) harness.
 *
 * It boots the real orchestrator stack over a migration-replay temp-file DB —
 * the SAME assembly `tests/helpers/cyboflowTestHarness.ts` (M5) uses internally —
 * with ONLY the SDK `query()` faked (via the shared `fakeSdk` runId-keyed
 * registry). A real `git init` worktree hosts each run; the real
 * `WorkflowRegistry` / `RunLauncher` / `ApprovalRouter` and the real
 * `TypedEventNarrowing` + `MessageProjection` read pipeline all execute.
 *
 * DEVIATIONS from the plan's M6 Tier-3 sketch (code won — see M5):
 *  - The plan wanted the *real* `RunExecutor` + `ClaudeCodeManager` beneath the
 *    fake `query()`. The sanctioned base (M5 `cyboflowTestHarness`) instead drives
 *    the injected `query()` directly through a hand-rolled spawn loop (a
 *    `PreToolUse`-hook / `canUseTool` shim + a `raw_events` recorder), sidestepping
 *    the full `RunExecutor`/`ClaudeCodeManager` construction. This harness mirrors
 *    that M5 shape (single-run, plus DB-read accessors the M5 public API omits) so
 *    it "builds on M5" faithfully. Consequence: the fake events are written to
 *    `raw_events` verbatim (not via `RawEventsSink`); the honesty checks
 *    (`countUnknownNarrowedEvents`, `getUnifiedMessages`) run the REAL
 *    `TypedEventNarrowing`/`MessageProjection` over those stored payloads at
 *    READ time — the same narrowing, just on the read side.
 *  - The SDK seam is DEPENDENCY-INJECTED (`queryFn`), not a module `vi.mock`. A
 *    scenario author never touches `vi.mock`: they pass a `fakeSdk` scenario to
 *    `startRun`. `integration.setup.ts` still installs a defensive throwing module
 *    mock so any accidental *real* SDK call fails loudly.
 *  - Permission steps are driven through `options.canUseTool` (what `fakeSdk`'s
 *    `.requestPermission()` invokes), mapped ApprovalDecision → PermissionResult
 *    exactly as `ClaudeCodeManager.makeCanUseTool` does — NOT the M5 `PreToolUse`
 *    hook (the fake generator fires `canUseTool`, never a hook).
 *
 * This file MUST NOT be used in production code.
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type {
  Options,
  PermissionResult,
  CanUseTool,
} from '@anthropic-ai/claude-agent-sdk';
import { WorkflowRegistry } from '../../orchestrator/workflowRegistry';
import { RunLauncher } from '../../orchestrator/runLauncher';
import type {
  OrchSocketProvider,
  BridgeScriptResolver,
  NodeResolver,
} from '../../orchestrator/runLauncher';
import { McpConfigWriter } from '../../orchestrator/mcpConfigWriter';
import { WorktreeManager } from '../../services/worktreeManager';
import { ApprovalRouter } from '../../orchestrator/approvalRouter';
import { DatabaseService } from '../../database/database';
import { dbAdapter } from '../../orchestrator/__test_fixtures__/dbAdapter';
import { makeSpyLogger } from '../../orchestrator/__test_fixtures__/loggerLikeSpy';
import { selectRunUnifiedMessages } from '../../orchestrator/runUnifiedMessagesListing';
import { TypedEventNarrowing } from '../../services/streamParser';
import type { DatabaseLike, LoggerLike } from '../../orchestrator/types';
import type { CyboflowWorkflowName } from '../../../../shared/types/workflows';
import type { UnifiedMessage } from '../../../../shared/types/unifiedMessage';
import {
  makeFakeQueryFromRegistry,
  type ScenarioSource,
  type FakeQueryFn,
} from '../fakes/fakeSdk';

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

export interface StartRunOptions {
  /** A real git worktree the caller created (e.g. `git init` in a temp dir). */
  projectPath: string;
  /** Which built-in workflow this run belongs to. */
  workflow: CyboflowWorkflowName;
  /** The prompt handed to the (faked) SDK — unused by the fake but recorded. */
  prompt: string;
  /**
   * The scripted SDK behaviour for this run. Any `fakeSdk` `ScenarioSource`:
   * a `scenario()` builder, a `readonly SDKMessage[]`, or a `FakeQueryFn`.
   * Registered under the run's minted id, so concurrent runs stay independent.
   */
  scenario: ScenarioSource;
}

export interface HeadlessRunHandle {
  readonly runId: string;
  readonly worktreePath: string;
  /**
   * Settles when this run's fake generator drains and the run reaches a terminal
   * status (`completed` / `failed`). Await this for a sleep-free rest-state wait on
   * scenarios that do NOT pause on a permission. Scenarios that DO pause never
   * settle `done` until approved — use `waitForAwaitingReview` + `approve` first.
   */
  readonly done: Promise<void>;
}

/** A `review_items` row projected for assertions. */
export interface ReviewItemRow {
  id: string;
  run_id: string | null;
  kind: 'finding' | 'permission' | 'decision' | 'human_task';
  status: 'pending' | 'resolved' | 'dismissed';
  blocking: number;
  title: string;
}

export interface HeadlessHarness {
  /** Launch ONE run wired to its `fakeSdk` scenario; kicks off the fake stream. */
  startRun(opts: StartRunOptions): Promise<HeadlessRunHandle>;

  /** Current `workflow_runs.status` (throws if the run is unknown). */
  getStatus(runId: string): string;

  /** Number of `raw_events` rows recorded for the run. */
  getRawEventCount(runId: string): number;

  /** Parsed `raw_events.payload_json`, oldest-first. */
  getRawEventPayloads(runId: string): unknown[];

  /**
   * Count stored events that the REAL `TypedEventNarrowing` narrows to the
   * `{ kind: '__unknown__' }` catch-all — the honesty check: well-formed fake
   * events must be ZERO here.
   */
  countUnknownNarrowedEvents(runId: string): number;

  /** Re-project the run's stored events through the real narrow+project pipeline. */
  getUnifiedMessages(runId: string): UnifiedMessage[];

  /** `review_items` rows for the run (optionally filtered by kind). */
  getReviewItems(runId: string, kind?: ReviewItemRow['kind']): ReviewItemRow[];

  /**
   * Poll until the run rests at `awaiting_review` with a pending approval, then
   * return that approval id. Used by permission scenarios (whose `canUseTool`
   * blocks the generator until `approve` is called).
   */
  waitForAwaitingReview(runId: string, timeoutMs?: number): Promise<{ approvalId: string }>;

  /** Resolve a pending approval so a paused permission scenario resumes. */
  approve(runId: string, approvalId: string, decision: 'allow' | 'deny'): Promise<void>;

  /** Abort any live runs, reset the ApprovalRouter singleton, close + delete the DB. */
  teardown(): Promise<void>;
}

export interface CreateHeadlessHarnessOptions {
  /** Structured logger threaded into the registry/read pipeline (default: spy). */
  logger?: LoggerLike;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface ActiveRun {
  abortController: AbortController;
  done: Promise<void>;
}

/** process.env (undefined stripped) + `CYBOFLOW_RUN_ID = runId`. */
function envWithRunId(runId: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  env.CYBOFLOW_RUN_ID = runId;
  return env;
}

/** Insert a minimal session row hosting one run; returns its id. */
function seedSession(
  db: Database.Database,
  projectId: number,
  worktreePath: string,
  nameHint: string,
): string {
  const sessionId = `sess-${randomUUID()}`;
  db.prepare(
    `INSERT INTO sessions (id, name, initial_prompt, worktree_name, worktree_path, project_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(sessionId, `${nameHint} session`, `${nameHint} run`, nameHint, worktreePath, projectId);
  return sessionId;
}

// ---------------------------------------------------------------------------
// createHeadlessHarness
// ---------------------------------------------------------------------------

export async function createHeadlessHarness(
  opts: CreateHeadlessHarnessOptions = {},
): Promise<HeadlessHarness> {
  const logger = opts.logger ?? makeSpyLogger();

  // Migration-replay temp-file DB: schema.sql + every NNN_*.sql migration in
  // order, plus the imperative projects/sessions tables — the exact schema
  // WorkflowRegistry.createRun / RunLauncher.launch write against.
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-headless-db-'));
  const dbService = new DatabaseService(path.join(dbDir, 'headless.db'));
  dbService.initialize();
  const db = dbService.getDb();
  const dbLike: DatabaseLike = dbAdapter(db);

  const approvalRouter = new ApprovalRouter(dbLike);
  ApprovalRouter.initialize(dbLike);

  const workflowRegistry = new WorkflowRegistry(dbLike, logger);
  const worktreeManager = new WorktreeManager();

  // The ONE SDK seam: a runId-keyed registry of fake scenarios. `startRun`
  // registers each run's scenario BEFORE spawning; the fake dispatches off the
  // stamped CYBOFLOW_RUN_ID (throws loudly on an unknown id).
  const scenarioRegistry = new Map<string, ScenarioSource>();
  const queryFn: FakeQueryFn = makeFakeQueryFromRegistry(scenarioRegistry);

  const activeRuns = new Map<string, ActiveRun>();
  const workflowFixtureDirs: string[] = [];

  // -------------------------------------------------------------------------
  // raw_events recorder (verbatim — matches M5 cyboflowTestHarness)
  // -------------------------------------------------------------------------
  function recordEvent(runId: string, event: unknown): void {
    try {
      const eventType =
        event !== null && typeof event === 'object' && 'type' in event
          ? String((event as Record<string, unknown>).type)
          : 'unknown';
      db.prepare(
        'INSERT INTO raw_events (run_id, event_type, payload_json) VALUES (?, ?, ?)',
      ).run(runId, eventType, JSON.stringify(event));
    } catch {
      // Ignore insertion errors (e.g. the run was already cleaned up).
    }
  }

  // -------------------------------------------------------------------------
  // canUseTool — maps ApprovalDecision → PermissionResult, exactly as
  // ClaudeCodeManager.makeCanUseTool (claudeCodeManager.ts:1704-1728). The fake
  // scenario's `.requestPermission()` invokes THIS; the awaited verdict blocks the
  // generator until `approve()` resolves the pending approval.
  // -------------------------------------------------------------------------
  function makeCanUseTool(runId: string): CanUseTool {
    return async (toolName, input, _opts): Promise<PermissionResult> => {
      try {
        const decision = await approvalRouter.requestApproval(
          runId,
          toolName,
          input,
          () => {},
        );
        return decision.behavior === 'allow'
          ? { behavior: 'allow', updatedInput: decision.updatedInput ?? input }
          : { behavior: 'deny', message: decision.message ?? 'Denied by reviewer' };
      } catch (err) {
        return { behavior: 'deny', message: err instanceof Error ? err.message : String(err) };
      }
    };
  }

  // -------------------------------------------------------------------------
  // spawnFakeRun — run the fake query() in the background, recording events.
  // -------------------------------------------------------------------------
  function spawnFakeRun(runId: string, worktreePath: string, prompt: string): ActiveRun {
    const abortController = new AbortController();

    db.prepare(
      "UPDATE workflow_runs SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).run(runId);

    const sdkOptions: Options = {
      cwd: worktreePath,
      includePartialMessages: true,
      env: envWithRunId(runId),
      canUseTool: makeCanUseTool(runId),
      systemPrompt: { type: 'preset', preset: 'claude_code' },
    };

    const done = (async () => {
      try {
        const q = queryFn({ prompt, options: { ...sdkOptions, abortController } });
        for await (const event of q) {
          if (abortController.signal.aborted) break;
          recordEvent(runId, event);
        }
        const row = db
          .prepare('SELECT status FROM workflow_runs WHERE id = ?')
          .get(runId) as { status: string } | undefined;
        if (row && !['completed', 'failed', 'canceled'].includes(row.status)) {
          db.prepare(
            "UPDATE workflow_runs SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          ).run(runId);
        }
      } catch {
        if (!abortController.signal.aborted) {
          db.prepare(
            "UPDATE workflow_runs SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          ).run(runId);
        }
      } finally {
        activeRuns.delete(runId);
      }
    })();

    return { abortController, done };
  }

  // -------------------------------------------------------------------------
  // Read helpers
  // -------------------------------------------------------------------------
  function readRawPayloads(runId: string): unknown[] {
    const rows = db
      .prepare(
        'SELECT payload_json AS payloadJson FROM raw_events WHERE run_id = ? ORDER BY created_at ASC, id ASC',
      )
      .all(runId) as Array<{ payloadJson: string }>;
    return rows.map((r) => {
      try {
        return JSON.parse(r.payloadJson) as unknown;
      } catch {
        return null;
      }
    });
  }

  const harness: HeadlessHarness = {
    async startRun({ projectPath, workflow, prompt, scenario }) {
      // Global-workflow FK: a project row must exist before seeding workflows.
      const PROJECT_ID = 1;
      db.prepare('INSERT OR IGNORE INTO projects (id, name, path) VALUES (?, ?, ?)').run(
        PROJECT_ID,
        'cyboflow-headless',
        projectPath,
      );

      // Minimal workflow .md on disk (no frontmatter → default permission mode).
      const wfDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-headless-wf-'));
      workflowFixtureDirs.push(wfDir);
      const wfPath = path.join(wfDir, `${workflow}.md`);
      fs.writeFileSync(wfPath, `# ${workflow} workflow\n`, 'utf-8');
      workflowRegistry.seed(PROJECT_ID, [{ name: workflow, path: wfPath }]);

      const wfRow = db
        .prepare('SELECT id FROM workflows WHERE project_id = ? AND name = ? LIMIT 1')
        .get(PROJECT_ID, workflow) as { id: string } | undefined;
      if (!wfRow) throw new Error(`startRun: seeded workflow row for ${workflow} not found`);

      // RunLauncher — stub the MCP collaborators (the fake never spawns a bridge).
      const stubOrchSocketProvider: OrchSocketProvider = { getSocketPath: () => '' };
      const stubBridgeScriptResolver: BridgeScriptResolver = { getScriptPath: () => '' };
      const stubNodeResolver: NodeResolver = { getNodePath: async () => process.execPath };
      const runLauncher = new RunLauncher(
        dbLike,
        workflowRegistry,
        worktreeManager,
        logger,
        new McpConfigWriter(),
        stubOrchSocketProvider,
        stubBridgeScriptResolver,
        stubNodeResolver,
      );

      // Session-hosted (permission-mode redesign slice 1b): launch REQUIRES a
      // sessionId and reuses that session's worktree (= the project git dir).
      const sessionId = seedSession(db, PROJECT_ID, projectPath, workflow);
      const launch = await runLauncher.launch(
        wfRow.id,
        projectPath,
        undefined,
        undefined,
        undefined,
        sessionId,
      );

      // Register the scenario under the minted run id, THEN spawn — so the
      // registry-backed fake resolves it off the stamped CYBOFLOW_RUN_ID.
      scenarioRegistry.set(launch.runId, scenario);
      const run = spawnFakeRun(launch.runId, launch.worktreePath, prompt);
      activeRuns.set(launch.runId, run);

      return { runId: launch.runId, worktreePath: launch.worktreePath, done: run.done };
    },

    getStatus(runId) {
      const row = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as
        | { status: string }
        | undefined;
      if (!row) throw new Error(`getStatus: run ${runId} not found`);
      return row.status;
    },

    getRawEventCount(runId) {
      const row = db
        .prepare('SELECT COUNT(*) AS cnt FROM raw_events WHERE run_id = ?')
        .get(runId) as { cnt: number };
      return row.cnt;
    },

    getRawEventPayloads(runId) {
      return readRawPayloads(runId);
    },

    countUnknownNarrowedEvents(runId) {
      const narrower = new TypedEventNarrowing({ verbose: (m: string) => logger.debug(m) });
      let count = 0;
      for (const payload of readRawPayloads(runId)) {
        const narrowed = narrower.narrow(payload);
        if ('kind' in narrowed && narrowed.kind === '__unknown__') count++;
      }
      return count;
    },

    getUnifiedMessages(runId) {
      return selectRunUnifiedMessages(dbLike, runId, logger);
    },

    getReviewItems(runId, kind) {
      const base =
        'SELECT id, run_id, kind, status, blocking, title FROM review_items WHERE run_id = ?';
      const rows = kind
        ? (db.prepare(`${base} AND kind = ? ORDER BY created_at ASC, id ASC`).all(runId, kind) as ReviewItemRow[])
        : (db.prepare(`${base} ORDER BY created_at ASC, id ASC`).all(runId) as ReviewItemRow[]);
      return rows;
    },

    async waitForAwaitingReview(runId, timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const row = db
          .prepare(
            `SELECT wr.status, a.id AS approval_id
             FROM workflow_runs wr
             LEFT JOIN approvals a ON a.run_id = wr.id AND a.status = 'pending'
             WHERE wr.id = ? LIMIT 1`,
          )
          .get(runId) as { status: string; approval_id: string | null } | undefined;
        if (!row) throw new Error(`waitForAwaitingReview: run ${runId} not found`);
        if (row.status === 'failed' || row.status === 'canceled') {
          throw new Error(
            `waitForAwaitingReview: run ${runId} reached terminal '${row.status}' before awaiting_review`,
          );
        }
        if (row.status === 'awaiting_review' && row.approval_id) {
          return { approvalId: row.approval_id };
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`waitForAwaitingReview: timed out after ${timeoutMs}ms for run ${runId}`);
    },

    async approve(runId, approvalId, decision) {
      await approvalRouter.respond(approvalId, {
        behavior: decision,
        ...(decision === 'deny' ? { message: 'denied by headless harness' } : {}),
      });
    },

    async teardown() {
      const pending: Promise<void>[] = [];
      for (const run of activeRuns.values()) {
        run.abortController.abort();
        pending.push(run.done.catch(() => {}));
      }
      await Promise.all(pending);
      activeRuns.clear();
      scenarioRegistry.clear();

      for (const dir of workflowFixtureDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      workflowFixtureDirs.length = 0;

      ApprovalRouter._resetForTesting();
      db.close();
      fs.rmSync(dbDir, { recursive: true, force: true });
    },
  };

  return harness;
}
