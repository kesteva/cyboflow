/**
 * cyboflowTestHarness.ts — Day-3 gate integration test harness.
 *
 * Encapsulates all orchestrator-internal wiring so the test body
 * (cyboflow-day3-gate.spec.ts) stays declarative.
 *
 * This harness MUST NOT be used in production code.
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  Options,
  HookCallback,
  PreToolUseHookInput,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { WorkflowRegistry } from '../../main/src/orchestrator/workflowRegistry';
import { RunLauncher } from '../../main/src/orchestrator/runLauncher';
import type { OrchSocketProvider, BridgeScriptResolver, NodeResolver } from '../../main/src/orchestrator/runLauncher';
import { McpConfigWriter } from '../../main/src/orchestrator/mcpConfigWriter';
import { WorktreeManager } from '../../main/src/services/worktreeManager';
import { ApprovalRouter } from '../../main/src/orchestrator/approvalRouter';
import { DatabaseService } from '../../main/src/database/database';
import type { CyboflowWorkflowName } from '../../shared/types/workflows';
import type { ApprovalDecision } from '../../shared/types/approval';
import { dbAdapter } from '../../main/src/orchestrator/__test_fixtures__/dbAdapter';
import { makeSpyLogger } from '../../main/src/orchestrator/__test_fixtures__/loggerLikeSpy';

// ---------------------------------------------------------------------------
// Injectable SDK query — the single seam a caller substitutes a fake at.
// ---------------------------------------------------------------------------

/**
 * The SDK `query()` shape the harness invokes. Structurally identical to
 * fakeSdk's `FakeQueryFn` (`main/src/test/fakes/fakeSdk.ts`) so a later milestone
 * can plug a per-run fake (e.g. `makeFakeQueryFromRegistry`, which dispatches off
 * the run id the harness stamps into `options.env.CYBOFLOW_RUN_ID`) with no
 * adapter. `options` is REQUIRED (production always passes it) and the return is a
 * plain `AsyncGenerator<SDKMessage, void>` — the type the SDK `Query` interface
 * extends and the only surface the harness async-iterates. The real
 * `@anthropic-ai/claude-agent-sdk` `query` is assignable to this (its `options` is
 * optional and its `Query` return extends the generator).
 */
export type HarnessQueryFn = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options: Options;
}) => AsyncGenerator<SDKMessage, void>;

export interface CreateHarnessOptions {
  /**
   * Substitute the SDK `query()`. Defaults to the real
   * `@anthropic-ai/claude-agent-sdk` `query` — so `createHarness()` with no args
   * exercises a live `claude` exactly as before. Pass a fake (per-run dispatch is
   * trivial via the stamped `CYBOFLOW_RUN_ID`) to drive the harness deterministically.
   */
  query?: HarnessQueryFn;
}

// ---------------------------------------------------------------------------
// Spy logger — calls array is unused by the harness itself but available to
// harness-extending tests.
// ---------------------------------------------------------------------------

const harnessLogger = makeSpyLogger();

// ---------------------------------------------------------------------------
// CyboflowTestHarness interface
// ---------------------------------------------------------------------------

export interface CyboflowTestHarness {
  launchPair(args: {
    projectPath: string;
    workflowA: CyboflowWorkflowName;
    workflowB: CyboflowWorkflowName;
    promptA: string;
    promptB: string;
  }): Promise<{ runIdA: string; runIdB: string }>;

  waitForAwaitingReview(runId: string, timeoutMs?: number): Promise<{ approvalId: string }>;

  approveRun(runId: string, approvalId: string, decision: 'allow' | 'deny'): Promise<void>;

  getStatus(runId: string): string;

  getStreamEventCount(runId: string): number;

  teardown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal harness state
// ---------------------------------------------------------------------------

interface ActiveRun {
  runId: string;
  worktreePath: string;
  abortController: AbortController;
  queryDone: Promise<void>;
}

/** process.env (undefined values stripped) plus `CYBOFLOW_RUN_ID = runId`. */
function envWithRunId(runId: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  env.CYBOFLOW_RUN_ID = runId;
  return env;
}

/**
 * Insert a minimal session row hosting one run and return its id. `worktree_path`
 * points at the project's git worktree so RunLauncher.resolveSessionHostedWorktree
 * can resolve a branch + HEAD from it. Only the NOT-NULL columns are populated;
 * every other session column takes its schema default.
 */
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
  ).run(sessionId, `${nameHint} session`, `${nameHint} gate run`, nameHint, worktreePath, projectId);
  return sessionId;
}

// ---------------------------------------------------------------------------
// createHarness
// ---------------------------------------------------------------------------

export async function createHarness(options: CreateHarnessOptions = {}): Promise<CyboflowTestHarness> {
  // Real migration-replay: a fresh temp-file DB run through the production
  // DatabaseService.initialize() (schema.sql + every NNN_*.sql migration, in
  // order, PLUS the imperatively-created `projects`/`sessions` tables that the
  // .sql files never declare). This replaces the drifted GATE_SCHEMA fixture with
  // the exact schema WorkflowRegistry.createRun / RunLauncher.launch write against
  // (substrate, execution_model, model, eval_enabled, session_id, spec_hash, …).
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-gate-db-'));
  const dbService = new DatabaseService(path.join(dbDir, 'gate.db'));
  dbService.initialize();
  const db = dbService.getDb();

  // The SDK query seam (default: the real SDK query).
  const queryFn: HarnessQueryFn = options.query ?? query;

  // Adapt better-sqlite3 to DatabaseLike interface
  const dbLike = dbAdapter(db);

  const approvalRouter = new ApprovalRouter(dbLike);
  // Initialize singleton for any code that calls ApprovalRouter.getInstance()
  ApprovalRouter.initialize(dbLike);

  const workflowRegistry = new WorkflowRegistry(dbLike, harnessLogger);
  const worktreeManager = new WorktreeManager();

  // Active runs: keyed by runId
  const activeRuns = new Map<string, ActiveRun>();

  // ---------------------------------------------------------------------------
  // Raw event recorder — appends events to raw_events table
  // ---------------------------------------------------------------------------
  function recordEvent(runId: string, event: unknown): void {
    try {
      const eventType =
        (event !== null && typeof event === 'object' && 'type' in event)
          ? String((event as Record<string, unknown>).type)
          : 'unknown';
      db.prepare(
        'INSERT INTO raw_events (run_id, event_type, payload_json) VALUES (?, ?, ?)',
      ).run(runId, eventType, JSON.stringify(event));
    } catch {
      // Ignore insertion errors (e.g., foreign key constraint if run was cleaned up)
    }
  }

  // ---------------------------------------------------------------------------
  // spawnSdkRun — runs query() in the background with PreToolUse hook wired
  // to the ApprovalRouter. Returns a promise that settles when the run ends.
  // ---------------------------------------------------------------------------
  function spawnSdkRun(runId: string, worktreePath: string, prompt: string): {
    abortController: AbortController;
    queryDone: Promise<void>;
  } {
    const abortController = new AbortController();

    // Set status to 'running' before the SDK query starts
    db.prepare(
      "UPDATE workflow_runs SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).run(runId);

    const preToolUseHook: HookCallback = async (input, _toolUseId, _ctx) => {
      const pretool = input as PreToolUseHookInput;
      let decision: ApprovalDecision;
      try {
        decision = await approvalRouter.requestApproval(
          runId,
          pretool.tool_name,
          pretool.tool_input as Record<string, unknown>,
          () => {},
        );
      } catch (err) {
        // If requestApproval fails (e.g., run was already canceled), deny.
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'deny' as const,
            permissionDecisionReason: err instanceof Error ? err.message : String(err),
          },
        };
      }

      if (decision.behavior === 'allow') {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'allow' as const,
            ...(decision.updatedInput ? { updatedInput: decision.updatedInput } : {}),
          },
        };
      }
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny' as const,
          ...(decision.message ? { permissionDecisionReason: decision.message } : {}),
        },
      };
    };

    const sdkOptions: Options = {
      cwd: worktreePath,
      includePartialMessages: true,
      // Stamp the run id into the subprocess env so an injected registry-backed
      // fake (fakeSdk.makeFakeQueryFromRegistry) can dispatch per run. A superset
      // of process.env — behaviorally identical for the real claude spawn, which
      // otherwise inherits the same env.
      env: envWithRunId(runId),
      hooks: {
        PreToolUse: [{ hooks: [preToolUseHook] }],
      },
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
      },
    };

    const queryDone = (async () => {
      try {
        const q = queryFn({ prompt, options: { ...sdkOptions, abortController } });
        for await (const event of q) {
          if (abortController.signal.aborted) break;
          recordEvent(runId, event);
        }
        // Mark completed if not already in a terminal state
        const row = db
          .prepare('SELECT status FROM workflow_runs WHERE id = ?')
          .get(runId) as { status: string } | undefined;
        if (row && !['completed', 'failed', 'canceled'].includes(row.status)) {
          db.prepare(
            "UPDATE workflow_runs SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          ).run(runId);
        }
      } catch (err) {
        if (!abortController.signal.aborted) {
          db.prepare(
            "UPDATE workflow_runs SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          ).run(runId);
        }
      } finally {
        activeRuns.delete(runId);
      }
    })();

    return { abortController, queryDone };
  }

  // ---------------------------------------------------------------------------
  // Implementation
  // ---------------------------------------------------------------------------

  let workflowFixturesDir: string | null = null;

  const harness: CyboflowTestHarness = {
    async launchPair({ projectPath, workflowA, workflowB, promptA, promptB }) {
      // Write minimal workflow .md files to temp paths (no permission_mode frontmatter → default)
      // Manual lifecycle (not withTempDir) because the dir must survive across launchPair/teardown.
      // See main/src/__test_fixtures__/tmp.ts for the per-test withTempDir pattern.
      workflowFixturesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-gate-wf-'));
      const tmpDir = workflowFixturesDir;
      const wfPathA = path.join(tmpDir, `${workflowA}.md`);
      const wfPathB = path.join(tmpDir, `${workflowB}.md`);
      fs.writeFileSync(wfPathA, `# ${workflowA} workflow\n`, 'utf-8');
      fs.writeFileSync(wfPathB, `# ${workflowB} workflow\n`, 'utf-8');

      // Under the real migration-replay schema `workflows.project_id` carries a FK
      // to `projects(id)` (the GATE_SCHEMA fixture deliberately omitted it), so a
      // parent project row must exist before seeding workflows. Idempotent insert
      // keyed on the projectPath (projects.path is UNIQUE).
      const PROJECT_ID = 1;
      db.prepare(
        'INSERT OR IGNORE INTO projects (id, name, path) VALUES (?, ?, ?)',
      ).run(PROJECT_ID, 'cyboflow-gate', projectPath);

      workflowRegistry.seed(PROJECT_ID, [
        { name: workflowA, path: wfPathA },
        { name: workflowB, path: wfPathB },
      ]);

      const workflows = (
        db
          .prepare('SELECT id, name FROM workflows WHERE project_id = ? ORDER BY name')
          .all(PROJECT_ID) as Array<{ id: string; name: string }>
      );

      const wfRowA = workflows.find((w) => w.name === workflowA);
      const wfRowB = workflows.find((w) => w.name === workflowB);
      if (!wfRowA || !wfRowB) {
        throw new Error(`launchPair: could not find seeded workflow rows for ${workflowA}/${workflowB}`);
      }

      // RunLauncher — stub MCP collaborators: the gate uses SDK PreToolUse, not a bridge,
      // so MCP config writes are no-ops.  All 4 collaborators are required by the constructor.
      const stubOrchSocketProvider: OrchSocketProvider = { getSocketPath: () => '' };
      const stubBridgeScriptResolver: BridgeScriptResolver = { getScriptPath: () => '' };
      const stubNodeResolver: NodeResolver = { getNodePath: async () => process.execPath };
      const stubMcpConfigWriter = new McpConfigWriter();
      const runLauncher = new RunLauncher(
        dbLike, workflowRegistry, worktreeManager, harnessLogger,
        stubMcpConfigWriter, stubOrchSocketProvider, stubBridgeScriptResolver, stubNodeResolver,
      );

      // Every run is session-hosted (permission-mode redesign slice 1b): launch
      // now REQUIRES a sessionId and reuses that session's existing worktree
      // (resolveSessionHostedWorktree reads sessions.worktree_path). Seed one
      // session per run pointed at the project's git worktree so the two runs are
      // independent (the one-running-at-a-time guard is per session) yet share the
      // git repo the day-3 prompts operate on.
      const sessionIdA = seedSession(db, PROJECT_ID, projectPath, workflowA);
      const sessionIdB = seedSession(db, PROJECT_ID, projectPath, workflowB);

      const [launchA, launchB] = await Promise.all([
        runLauncher.launch(wfRowA.id, projectPath, undefined, undefined, undefined, sessionIdA),
        runLauncher.launch(wfRowB.id, projectPath, undefined, undefined, undefined, sessionIdB),
      ]);

      // Spawn both SDK queries concurrently
      const runA = spawnSdkRun(launchA.runId, launchA.worktreePath, promptA);
      const runB = spawnSdkRun(launchB.runId, launchB.worktreePath, promptB);

      activeRuns.set(launchA.runId, {
        runId: launchA.runId,
        worktreePath: launchA.worktreePath,
        abortController: runA.abortController,
        queryDone: runA.queryDone,
      });
      activeRuns.set(launchB.runId, {
        runId: launchB.runId,
        worktreePath: launchB.worktreePath,
        abortController: runB.abortController,
        queryDone: runB.queryDone,
      });

      return { runIdA: launchA.runId, runIdB: launchB.runId };
    },

    async waitForAwaitingReview(runId: string, timeoutMs = 60_000): Promise<{ approvalId: string }> {
      const deadline = Date.now() + timeoutMs;

      while (Date.now() < deadline) {
        const row = db
          .prepare(
            `SELECT wr.status, a.id AS approval_id
             FROM workflow_runs wr
             LEFT JOIN approvals a ON a.run_id = wr.id AND a.status = 'pending'
             WHERE wr.id = ?
             LIMIT 1`,
          )
          .get(runId) as { status: string; approval_id: string | null } | undefined;

        if (!row) {
          throw new Error(`waitForAwaitingReview: run ${runId} not found in DB`);
        }

        if (row.status === 'failed' || row.status === 'canceled') {
          throw new Error(
            `waitForAwaitingReview: run ${runId} reached terminal status '${row.status}' ` +
            `before ever reaching 'awaiting_review'`,
          );
        }

        if (row.status === 'awaiting_review' && row.approval_id) {
          return { approvalId: row.approval_id };
        }

        await new Promise((r) => setTimeout(r, 200));
      }

      const row = db
        .prepare('SELECT status FROM workflow_runs WHERE id = ?')
        .get(runId) as { status: string } | undefined;

      throw new Error(
        `waitForAwaitingReview: timed out after ${timeoutMs}ms waiting for run ${runId} ` +
        `to reach 'awaiting_review'. Current status: ${row?.status ?? 'unknown'}`,
      );
    },

    async approveRun(runId: string, approvalId: string, decision: 'allow' | 'deny'): Promise<void> {
      await approvalRouter.respond(approvalId, {
        behavior: decision,
        ...(decision === 'deny' ? { message: 'denied by test harness' } : {}),
      });
    },

    getStatus(runId: string): string {
      const row = db
        .prepare('SELECT status FROM workflow_runs WHERE id = ?')
        .get(runId) as { status: string } | undefined;
      if (!row) throw new Error(`getStatus: run ${runId} not found`);
      return row.status;
    },

    getStreamEventCount(runId: string): number {
      const row = db
        .prepare('SELECT COUNT(*) AS cnt FROM raw_events WHERE run_id = ?')
        .get(runId) as { cnt: number };
      return row.cnt;
    },

    async teardown(): Promise<void> {
      // Abort any still-active runs
      const abortPromises: Promise<void>[] = [];
      for (const run of activeRuns.values()) {
        run.abortController.abort();
        abortPromises.push(run.queryDone.catch(() => {}));
      }
      await Promise.all(abortPromises);
      activeRuns.clear();

      // Clean up workflow-fixture tmp dir created in launchPair
      if (workflowFixturesDir) {
        fs.rmSync(workflowFixturesDir, { recursive: true, force: true });
        workflowFixturesDir = null;
      }

      // Reset the ApprovalRouter singleton so subsequent test runs start clean
      ApprovalRouter._resetForTesting();

      // Close the DB and remove its temp directory (migration-replay uses a
      // file-backed DB, unlike the old :memory: harness — without this every
      // gate run leaks a cyboflow-gate-db-* dir in the OS tmpdir).
      db.close();
      fs.rmSync(dbDir, { recursive: true, force: true });
    },
  };

  return harness;
}
