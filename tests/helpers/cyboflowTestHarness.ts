/**
 * cyboflowTestHarness.ts — Day-3 gate integration test harness.
 *
 * Encapsulates all orchestrator-internal wiring so the test body
 * (cyboflow-day3-gate.spec.ts) stays declarative.
 *
 * This harness MUST NOT be used in production code.
 */
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, HookCallback, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { WorkflowRegistry } from '../../main/src/orchestrator/workflowRegistry';
import { RunLauncher } from '../../main/src/orchestrator/runLauncher';
import { WorktreeManager } from '../../main/src/services/worktreeManager';
import { ApprovalRouter } from '../../main/src/orchestrator/approvalRouter';
import { RunQueueRegistry } from '../../main/src/orchestrator/RunQueueRegistry';
import type { DatabaseLike, LoggerLike } from '../../main/src/orchestrator/types';
import type { SoloFlowWorkflowName } from '../../shared/types/workflows';
import type { ApprovalDecision } from '../../shared/types/approval';

// ---------------------------------------------------------------------------
// DB schema — minimal tables needed for the gate test
// ---------------------------------------------------------------------------

const GATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS workflows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  workflow_path TEXT NOT NULL,
  permission_mode TEXT NOT NULL DEFAULT 'default',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(project_id, name)
);
CREATE INDEX IF NOT EXISTS idx_workflows_project_id ON workflows(project_id);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'starting', 'running', 'awaiting_review', 'stuck', 'completed', 'failed', 'canceled')),
  permission_mode_snapshot TEXT NOT NULL,
  worktree_path TEXT,
  branch_name TEXT,
  policy_json TEXT,
  stuck_at DATETIME,
  stuck_reason TEXT,
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workflow_id) REFERENCES workflows(id)
);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status_created ON workflow_runs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_id ON workflow_runs(workflow_id);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_input_json TEXT NOT NULL,
  tool_use_id TEXT NOT NULL,
  rationale TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'timed_out')),
  decided_at DATETIME,
  decided_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id)
);
CREATE INDEX IF NOT EXISTS idx_approvals_status_created ON approvals(status, created_at);

CREATE TABLE IF NOT EXISTS raw_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id)
);
CREATE INDEX IF NOT EXISTS idx_raw_events_run_id ON raw_events(run_id, id);
`;

// ---------------------------------------------------------------------------
// Null logger (suppresses noise during tests)
// ---------------------------------------------------------------------------

const nullLogger: LoggerLike = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// ---------------------------------------------------------------------------
// CyboflowTestHarness interface
// ---------------------------------------------------------------------------

export interface CyboflowTestHarness {
  launchPair(args: {
    projectPath: string;
    workflowA: SoloFlowWorkflowName;
    workflowB: SoloFlowWorkflowName;
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

// ---------------------------------------------------------------------------
// createHarness
// ---------------------------------------------------------------------------

export async function createHarness(): Promise<CyboflowTestHarness> {
  // In-memory SQLite DB
  const db = new Database(':memory:');
  db.exec(GATE_SCHEMA);

  // Adapt better-sqlite3 to DatabaseLike interface
  const dbLike: DatabaseLike = {
    prepare: (sql: string) => db.prepare(sql),
    transaction: <T>(fn: (...args: unknown[]) => T) => db.transaction(fn) as (...args: unknown[]) => T,
  };

  const runQueueRegistry = new RunQueueRegistry();
  const approvalRouter = new ApprovalRouter(
    dbLike,
    (runId: string) => runQueueRegistry.getOrCreate(runId),
  );
  // Initialize singleton for any code that calls ApprovalRouter.getInstance()
  ApprovalRouter.initialize(
    dbLike,
    (runId: string) => runQueueRegistry.getOrCreate(runId),
  );

  const workflowRegistry = new WorkflowRegistry(dbLike, nullLogger);
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
        const q = query({ prompt, options: { ...sdkOptions, abortController } });
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
      workflowFixturesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-gate-wf-'));
      const tmpDir = workflowFixturesDir;
      const wfPathA = path.join(tmpDir, `${workflowA}.md`);
      const wfPathB = path.join(tmpDir, `${workflowB}.md`);
      fs.writeFileSync(wfPathA, `# ${workflowA} workflow\n`, 'utf-8');
      fs.writeFileSync(wfPathB, `# ${workflowB} workflow\n`, 'utf-8');

      // Use project_id=1 for this harness (no projects table in gate schema)
      const PROJECT_ID = 1;

      workflowRegistry.seed(PROJECT_ID, [
        { name: workflowA, path: wfPathA },
        { name: workflowB, path: wfPathB },
      ]);

      const workflows = (
        db
          .prepare('SELECT id, name FROM workflows WHERE project_id = ? ORDER BY name')
          .all(PROJECT_ID) as Array<{ id: number; name: string }>
      );

      const wfRowA = workflows.find((w) => w.name === workflowA);
      const wfRowB = workflows.find((w) => w.name === workflowB);
      if (!wfRowA || !wfRowB) {
        throw new Error(`launchPair: could not find seeded workflow rows for ${workflowA}/${workflowB}`);
      }

      // RunLauncher (no MCP config writer — the gate uses SDK PreToolUse, not a bridge)
      const runLauncher = new RunLauncher(dbLike, workflowRegistry, worktreeManager, nullLogger);

      const [launchA, launchB] = await Promise.all([
        runLauncher.launch(wfRowA.id, projectPath),
        runLauncher.launch(wfRowB.id, projectPath),
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

      // Close the DB
      db.close();
    },
  };

  return harness;
}
