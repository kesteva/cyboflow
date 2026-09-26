import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type { SessionManager } from '../../../sessionManager';
import type { AgentUsage } from '../../../../../../shared/types/agentStream';
import { CodexSdkManager } from '../codexSdkManager';
import { CodexUsageTotals } from '../appServer/usageAccumulator';
import type { TokenUsageBreakdown } from '../appServer/protocol';
import {
  codexNotification as n,
  codexUsage,
  createFakeCodexAppServer,
  type FakeCodexAppServerClient,
  type FakeCodexAppServerOptions,
} from '../../../../test/fakes/fakeCodexAppServer';
import { rollupRunUsage } from '../../../../orchestrator/runUsageRollup';

// The fold itself is not under test here — only that a drain which outlived
// the run's terminal seam asks for the materialized row to be re-rolled.
vi.mock('../../../../orchestrator/runUsageRollup', () => ({ rollupRunUsage: vi.fn() }));

const ROOT = 'root-thread';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, claude_session_id TEXT, updated_at TEXT);
    CREATE TABLE agent_invocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_invocation_id TEXT NOT NULL UNIQUE,
      run_id TEXT NOT NULL,
      step_id TEXT,
      agent_provider TEXT NOT NULL,
      agent_runtime TEXT NOT NULL,
      model TEXT,
      external_session_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      panel_id TEXT
    );
    CREATE TABLE raw_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      dedup_key TEXT
    );
    CREATE UNIQUE INDEX idx_raw_events_dedup ON raw_events(dedup_key) WHERE dedup_key IS NOT NULL;
    CREATE TABLE codex_invocation_turns (
      agent_invocation_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      codex_turn_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (agent_invocation_id, codex_turn_id)
    );
  `);
  db.prepare("INSERT INTO workflow_runs (id, updated_at) VALUES ('run-1', CURRENT_TIMESTAMP)").run();
  return db;
}

function makeManager(db: Database.Database, options: FakeCodexAppServerOptions) {
  const fake = createFakeCodexAppServer({ threadId: ROOT, ...options });
  const manager = new CodexSdkManager(
    {} as SessionManager,
    undefined,
    undefined,
    db,
    fake.factory,
    () => ({
      executablePath: '/app/codex/bin/codex',
      pathDir: '/app/codex/codex-path',
      version: '0.156.1',
      target: 'aarch64-apple-darwin',
    }),
    '0.1.test',
  );
  manager.setCyboflowMcpRuntimeConfig({
    orchSocketPath: '/tmp/cyboflow-orch.sock',
    bridgeScriptPath: '/app/cyboflowMcpServer.js',
    nodeExecutablePath: '/usr/local/bin/node',
  });
  manager.setApprovalRouterProvider(() => ({
    requestApproval: vi.fn(async () => ({ behavior: 'allow' as const })),
    clearPendingForSource: vi.fn(),
  }));
  manager.setQuestionRouterProvider(() => ({
    requestQuestion: vi.fn(async () => ({ answers: {} })),
    clearPendingForRun: vi.fn(),
  }));
  manager.on('error', () => undefined);
  const client = (): FakeCodexAppServerClient => {
    const first = fake.clients[0];
    if (!first) throw new Error('no client built');
    return first;
  };
  return { manager, client };
}

function laneTurn(overrides: Record<string, unknown> = {}): Parameters<CodexSdkManager['spawnCliProcess']>[0] {
  return {
    panelId: 'run-1',
    sessionId: 'run-1',
    runId: 'run-1',
    worktreePath: '/tmp/worktree',
    prompt: 'go',
    model: 'gpt-root',
    spawnKey: 'lane-1',
    ...overrides,
  } as Parameters<CodexSdkManager['spawnCliProcess']>[0];
}

interface UsageRow {
  dedupKey: string;
  payload: {
    thread_id: string;
    parent_thread_id: string | null;
    invocation_id: string | null;
    model_inferred: boolean;
    message: { model: string; usage: Required<AgentUsage> };
  };
}

function usageRows(db: Database.Database): Map<string, UsageRow['payload']> {
  const rows = db
    .prepare(`SELECT dedup_key AS dedupKey, payload_json AS payloadJson FROM raw_events
               WHERE event_type = 'subagent_usage' ORDER BY id`)
    .all() as Array<{ dedupKey: string; payloadJson: string }>;
  return new Map(rows.map((row) => [row.dedupKey, JSON.parse(row.payloadJson) as UsageRow['payload']]));
}

function agentResultUsages(db: Database.Database): AgentUsage[] {
  const rows = db
    .prepare("SELECT payload_json AS payloadJson FROM raw_events WHERE event_type = 'agent_result' ORDER BY id")
    .all() as Array<{ payloadJson: string }>;
  return rows.map((row) => (JSON.parse(row.payloadJson) as { usage: AgentUsage }).usage);
}

function invocationId(db: Database.Database): string {
  const row = db.prepare('SELECT agent_invocation_id AS id FROM agent_invocations ORDER BY id DESC LIMIT 1').get() as { id: string };
  return row.id;
}

function expected(...usages: TokenUsageBreakdown[]): AgentUsage | undefined {
  const totals = new CodexUsageTotals();
  for (const usage of usages) totals.add(usage);
  return totals.snapshot();
}

function sumUsage(usages: Array<AgentUsage | undefined>): Required<AgentUsage> {
  const out: Required<AgentUsage> = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: 0,
  };
  for (const usage of usages) {
    out.input_tokens += usage?.input_tokens ?? 0;
    out.output_tokens += usage?.output_tokens ?? 0;
    out.cache_read_input_tokens += usage?.cache_read_input_tokens ?? 0;
    out.cache_creation_input_tokens += usage?.cache_creation_input_tokens ?? 0;
    out.reasoning_output_tokens += usage?.reasoning_output_tokens ?? 0;
  }
  return out;
}

const ROOT_A = codexUsage(100, 10, 40, 20, 3);
const ROOT_B = codexUsage(200, 5, 150, 0, 1);
const CHILD_A = codexUsage(80, 8, 30);
const CHILD_LATE = codexUsage(60, 6, 10, 5);
const GRAND_A = codexUsage(50, 4, 0, 10, 2);

/**
 * Root spawns `child-1` (model gpt-child), which spawns `grand-1` with no model.
 * The root finishes while child-1 is still running; the test drives the rest.
 */
function rootWithChildAndGrandchild({ client, turnId }: { client: FakeCodexAppServerClient; turnId: string }): void {
  client.notify(n.turnStarted(ROOT, turnId));
  client.notify(n.spawnAgent(ROOT, turnId, ['child-1'], 'gpt-child', 'item/started'));
  client.notify(n.turnStarted('child-1', 'child-turn'));
  client.notify(n.spawnAgent('child-1', 'child-turn', ['grand-1'], null));
  client.notify(n.turnStarted('grand-1', 'grand-turn'));
  client.notify(n.rawResponse(ROOT, turnId, 'root-a', ROOT_A));
  client.notify(n.tokenUsage(ROOT, turnId, ROOT_A, ROOT_A));
  client.notify(n.rawResponse('child-1', 'child-turn', 'child-a', CHILD_A));
  client.notify(n.tokenUsage('child-1', 'child-turn', CHILD_A, CHILD_A));
  client.notify(n.rawResponse('grand-1', 'grand-turn', 'grand-a', GRAND_A));
  client.notify(n.tokenUsage('grand-1', 'grand-turn', GRAND_A, GRAND_A));
  client.notify(n.turnCompleted('grand-1', 'grand-turn'));
  client.notify(n.rawResponse(ROOT, turnId, 'root-b', ROOT_B));
  client.notify(n.agentMessage(ROOT, turnId, 'root done'));
  client.notify(n.turnCompleted(ROOT, turnId));
}

describe('CodexSdkManager per-response usage accounting', () => {
  it('writes one root agent_result and one codex-subagent row per descendant, disjoint and exact', async () => {
    const db = createDb();
    try {
      const { manager, client } = makeManager(db, { onTurnStart: rootWithChildAndGrandchild });

      const outcome = await manager.spawnCliProcess(laneTurn());

      // The step outcome resolved at the root terminal — while child-1 still
      // runs, the client stays up for the drain.
      expect(outcome).toEqual({ resultText: 'root done' });
      expect(client().stopCalls).toBe(0);

      // A child response inside the drain re-upserts that child's row.
      client().notify(n.rawResponse('child-1', 'child-turn', 'child-late', CHILD_LATE));
      client().notify(n.tokenUsage('child-1', 'child-turn', { ...CHILD_A, ...codexUsage(140, 14, 40, 5) }, CHILD_LATE));
      expect(client().stopCalls).toBe(0);
      client().notify(n.turnCompleted('child-1', 'child-turn'));
      await vi.waitFor(() => expect(client().stopCalls).toBe(1));

      const inv = invocationId(db);
      const rows = usageRows(db);
      expect([...rows.keys()].sort()).toEqual([
        `codex-subagent:${inv}:child-1`,
        `codex-subagent:${inv}:grand-1`,
      ]);
      const child = rows.get(`codex-subagent:${inv}:child-1`);
      const grand = rows.get(`codex-subagent:${inv}:grand-1`);
      expect(child).toMatchObject({
        type: 'subagent_usage',
        provider: 'codex',
        thread_id: 'child-1',
        parent_thread_id: ROOT,
        invocation_id: inv,
        model_inferred: false,
        message: { model: 'gpt-child', usage: expected(CHILD_A, CHILD_LATE) },
      });
      // No spawn model: the parent's (child-1's) model, flagged inferred.
      expect(grand).toMatchObject({
        thread_id: 'grand-1',
        parent_thread_id: 'child-1',
        model_inferred: true,
        message: { model: 'gpt-child', usage: expected(GRAND_A) },
      });

      const results = agentResultUsages(db);
      expect(results).toEqual([expected(ROOT_A, ROOT_B)]);

      // Root + descendants == every rawResponse/completed, with no overlap.
      expect(sumUsage([results[0], child?.message.usage, grand?.message.usage]))
        .toEqual(sumUsage([expected(ROOT_A, ROOT_B, CHILD_A, CHILD_LATE, GRAND_A)]));
    } finally {
      db.close();
    }
  });

  it('records the invocation\'s Codex turn when turn/start returns', async () => {
    const db = createDb();
    try {
      const { manager } = makeManager(db, {
        onTurnStart: ({ client, turnId }) => {
          client.notify(n.rawResponse(ROOT, turnId, 'r1', ROOT_A));
          client.notify(n.turnCompleted(ROOT, turnId));
        },
      });
      await manager.spawnCliProcess(laneTurn());
      expect(db.prepare('SELECT agent_invocation_id AS inv, run_id AS runId, thread_id AS threadId, codex_turn_id AS turnId FROM codex_invocation_turns').all())
        .toEqual([{ inv: invocationId(db), runId: 'run-1', threadId: ROOT, turnId: 'turn-1' }]);
    } finally {
      db.close();
    }
  });

  it('counts an unregistered thread\'s usage in a codex-unattributed row', async () => {
    const db = createDb();
    try {
      const { manager, client } = makeManager(db, {
        onTurnStart: ({ client: c, turnId }) => {
          c.notify(n.rawResponse('stranger', 'stranger-turn', 's1', CHILD_A));
          c.notify(n.rawResponse('stranger', 'stranger-turn', 's2', GRAND_A));
          c.notify(n.rawResponse(ROOT, turnId, 'r1', ROOT_A));
          c.notify(n.turnCompleted(ROOT, turnId));
        },
      });
      await manager.spawnCliProcess(laneTurn());
      expect(client().stopCalls).toBe(1); // nothing owed: closed without a drain wait
      expect(usageRows(db).get('codex-unattributed:run-1:stranger')).toMatchObject({
        thread_id: 'stranger',
        parent_thread_id: null,
        invocation_id: null,
        model_inferred: true,
        message: { model: 'gpt-root', usage: expected(CHILD_A, GRAND_A) },
      });
      expect(agentResultUsages(db)).toEqual([expected(ROOT_A)]);
    } finally {
      db.close();
    }
  });

  it('attributes a buffered response once its thread registers', async () => {
    const db = createDb();
    try {
      const { manager } = makeManager(db, {
        onTurnStart: ({ client, turnId }) => {
          // The child's first response outruns the spawn item that registers it.
          client.notify(n.rawResponse('child-1', 'child-turn', 'c1', CHILD_A));
          client.notify(n.spawnAgent(ROOT, turnId, ['child-1'], 'gpt-child'));
          client.notify(n.turnCompleted('child-1', 'child-turn'));
          client.notify(n.turnCompleted(ROOT, turnId));
        },
      });
      await manager.spawnCliProcess(laneTurn());
      const rows = usageRows(db);
      expect([...rows.keys()]).toEqual([`codex-subagent:${invocationId(db)}:child-1`]);
      expect(rows.get(`codex-subagent:${invocationId(db)}:child-1`)?.message.usage).toEqual(expected(CHILD_A));
    } finally {
      db.close();
    }
  });

  it('cancellation stops the client at once, with no drain', async () => {
    const db = createDb();
    try {
      let started!: () => void;
      const running = new Promise<void>((resolve) => { started = resolve; });
      const { manager, client } = makeManager(db, {
        onTurnStart: ({ client: c, turnId }) => {
          c.notify(n.spawnAgent(ROOT, turnId, ['child-1'], 'gpt-child'));
          c.notify(n.turnStarted('child-1', 'child-turn'));
          c.notify(n.rawResponse('child-1', 'child-turn', 'c1', CHILD_A));
          started();
        },
      });
      const spawn = manager.spawnCliProcess(laneTurn());
      await running;
      await manager.killProcess('run-1');
      await expect(spawn).resolves.toBeUndefined();
      expect(client().stopCalls).toBe(1);
      // Everything received before the stop is counted; nothing arrives after.
      expect(usageRows(db).get(`codex-subagent:${invocationId(db)}:child-1`)?.message.usage).toEqual(expected(CHILD_A));
      expect(client().notify(n.rawResponse('child-1', 'child-turn', 'c2', CHILD_LATE))).toBe(false);
    } finally {
      db.close();
    }
  });

  it('kill during a drain cuts it short and settles', async () => {
    const db = createDb();
    try {
      const { manager, client } = makeManager(db, { onTurnStart: rootWithChildAndGrandchild });
      await manager.spawnCliProcess(laneTurn());
      expect(client().stopCalls).toBe(0);
      await manager.killAllProcesses();
      expect(client().stopCalls).toBe(1);
    } finally {
      db.close();
    }
  });

  it('carries the parent model with model_inferred when the spawn names none', async () => {
    const db = createDb();
    try {
      const { manager } = makeManager(db, {
        onTurnStart: ({ client, turnId }) => {
          client.notify(n.spawnAgent(ROOT, turnId, ['child-1'], null));
          client.notify(n.rawResponse('child-1', 'child-turn', 'c1', CHILD_A));
          client.notify(n.turnCompleted('child-1', 'child-turn'));
          client.notify(n.turnCompleted(ROOT, turnId));
        },
      });
      await manager.spawnCliProcess(laneTurn());
      expect(usageRows(db).get(`codex-subagent:${invocationId(db)}:child-1`)).toMatchObject({
        model_inferred: true,
        message: { model: 'gpt-root' },
      });
    } finally {
      db.close();
    }
  });

  it('tops up a root request whose response never arrived, at settlement only', async () => {
    const db = createDb();
    try {
      const { manager } = makeManager(db, {
        onTurnStart: ({ client, turnId }) => {
          client.notify(n.rawResponse(ROOT, turnId, 'r1', ROOT_A));
          client.notify(n.tokenUsage(ROOT, turnId, ROOT_A, ROOT_A));
          // A duplicate emission (unchanged total) is not a request.
          client.notify(n.tokenUsage(ROOT, turnId, ROOT_A, ROOT_A));
          const total = { ...ROOT_A, totalTokens: ROOT_A.totalTokens + ROOT_B.totalTokens, inputTokens: 300 };
          client.notify(n.tokenUsage(ROOT, turnId, total, ROOT_B));
          client.notify(n.turnCompleted(ROOT, turnId));
        },
      });
      await manager.spawnCliProcess(laneTurn());
      expect(agentResultUsages(db)).toEqual([expected(ROOT_A)]);
      expect(usageRows(db).get('codex-usage-topup:run-1:root-thread')).toMatchObject({
        thread_id: ROOT,
        invocation_id: null,
        model_inferred: false,
        message: { model: 'gpt-root', usage: expected(ROOT_B) },
      });
    } finally {
      db.close();
    }
  });

  it('sends a warm parked entry\'s late descendant response to the unattributed row', async () => {
    const db = createDb();
    try {
      const { manager, client } = makeManager(db, {
        onTurnStart: ({ client: c, turnId }) => {
          c.notify(n.spawnAgent(ROOT, turnId, ['child-1'], 'gpt-child'));
          c.notify(n.rawResponse('child-1', 'child-turn', 'c1', CHILD_A));
          c.notify(n.turnCompleted('child-1', 'child-turn'));
          c.notify(n.turnCompleted(ROOT, turnId));
        },
      });
      // Not a lane (no spawnKey): the process parks warm after its drain.
      await manager.spawnCliProcess(laneTurn({ spawnKey: undefined }));
      expect(client().stopCalls).toBe(0);
      client().notify(n.rawResponse('child-1', 'child-turn-2', 'c2', CHILD_LATE));
      const rows = usageRows(db);
      expect(rows.get(`codex-subagent:${invocationId(db)}:child-1`)?.message.usage).toEqual(expected(CHILD_A));
      expect(rows.get('codex-unattributed:run-1:child-1')).toMatchObject({
        parent_thread_id: ROOT,
        model_inferred: false,
        message: { model: 'gpt-child', usage: expected(CHILD_LATE) },
      });
      await manager.killAllProcesses();
    } finally {
      db.close();
    }
  });

  it('re-rolls an already materialized run_usage when a late descendant row lands in the drain', async () => {
    const db = createDb();
    try {
      vi.mocked(rollupRunUsage).mockClear();
      db.exec("CREATE TABLE run_usage (run_id TEXT PRIMARY KEY)");
      const { manager, client } = makeManager(db, { onTurnStart: rootWithChildAndGrandchild });
      await manager.spawnCliProcess(laneTurn());
      // The run's terminal seam fires while child-1 is still draining.
      db.prepare("INSERT INTO run_usage (run_id) VALUES ('run-1')").run();
      client().notify(n.rawResponse('child-1', 'child-turn', 'child-late', CHILD_LATE));
      expect(rollupRunUsage).not.toHaveBeenCalled(); // only at settlement
      client().notify(n.turnCompleted('child-1', 'child-turn'));
      await vi.waitFor(() => expect(client().stopCalls).toBe(1));
      await vi.waitFor(() => expect(rollupRunUsage).toHaveBeenCalledTimes(1));
      expect(vi.mocked(rollupRunUsage).mock.calls[0][1]).toBe('run-1');
    } finally {
      db.close();
    }
  });

  it('leaves run_usage to the terminal seam when it has not fired yet', async () => {
    const db = createDb();
    try {
      vi.mocked(rollupRunUsage).mockClear();
      db.exec("CREATE TABLE run_usage (run_id TEXT PRIMARY KEY)");
      const { manager, client } = makeManager(db, { onTurnStart: rootWithChildAndGrandchild });
      await manager.spawnCliProcess(laneTurn());
      client().notify(n.rawResponse('child-1', 'child-turn', 'child-late', CHILD_LATE));
      client().notify(n.turnCompleted('child-1', 'child-turn'));
      await vi.waitFor(() => expect(client().stopCalls).toBe(1));
      expect(rollupRunUsage).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });
});
