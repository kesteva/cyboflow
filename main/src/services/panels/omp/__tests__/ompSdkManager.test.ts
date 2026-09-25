/**
 * Unit tests for OmpSdkManager.
 *
 * Everything here runs against a fake `OmpRpcClient` — no `omp` binary, no
 * process. The fake writes the gate's load sentinel from `start()` exactly as the
 * real extension does at import time, so the fail-closed handshake is exercised
 * on its real path rather than stubbed out.
 */
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionManager } from '../../../sessionManager';
import { createTestDb, seedRun } from '../../../../orchestrator/__test_fixtures__/orchestratorTestDb';
import { materializeForLevel } from '../../../../../../shared/tuning/workflowTuning';
import { resolveRunDeployableAgents } from '../../claude/agentOverlayWriter';
import { OMP_RAW_EVENT_TYPE } from '../ompRawEventSink';
import {
  assertOmpSdkSpawnFlags,
  OMP_TURN_TIMEOUT_MS,
  OmpSdkManager,
  type OmpRpcClientLike,
  type OmpSdkManagerDeps,
} from '../ompSdkManager';
import {
  OMP_RPC_UI_MODE_ARGS,
  type OmpAgentEndEvent,
  type OmpExtensionUiRequestEvent,
  type OmpExtensionUiResponse,
  type OmpRpcClientOptions,
  type OmpRpcEvent,
  type OmpTurnOutcome,
} from '../rpc';
import type { ClaudeSpawnerOptions } from '../../../../orchestrator/runExecutor';

vi.mock('../ompMcpConfigWriter', () => ({
  writeOmpMcpConfig: vi.fn(() => ({ configPath: '/tmp/worktree/.omp/mcp.json', wrote: true })),
  // ompAgentWriter's git-exclude step; the real one is covered by its own suite.
  ensureWorktreeExcludesOmpDir: vi.fn(),
}));
// A login-shell PATH probe would really spawn a shell; the merge itself is
// covered by the env assertions below.
vi.mock('../../../../utils/shellPath', () => ({
  getShellPath: () => '/opt/homebrew/bin:/usr/bin',
  findExecutableInPath: () => null,
}));

import { writeOmpMcpConfig } from '../ompMcpConfigWriter';

const GATE_PATH = '/app/main/src/services/panels/omp/gate/ompGateExtension.ts';
const SESSION_FILE = '/tmp/omp-sessions/panel-1/session-abc.jsonl';

interface TurnUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costTotal: number;
}

function assistantMessageEnd(turnIndex: number, usage: TurnUsage): OmpRpcEvent {
  return {
    type: 'message_end',
    message: {
      role: 'assistant',
      responseId: `resp-${turnIndex}`,
      model: 'claude-haiku-4-5',
      content: [{ type: 'text', text: `turn ${turnIndex}` }],
      usage: {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: usage.costTotal,
        },
      },
    },
  };
}

const DEFAULT_USAGE: TurnUsage = { input: 3, output: 4, cacheRead: 0, cacheWrite: 10, costTotal: 0.01 };

interface FakeClientConfig {
  /** Skip the sentinel write, i.e. an OMP whose gate never loaded. */
  writeSentinel?: boolean;
  /** Stamp a different run id into the sentinel. */
  sentinelRunId?: string;
  /** Per-turn usage; index 0 is the first turn on this client. */
  usagePerTurn?: TurnUsage[];
  /** Make the turn end in an error result. */
  errorTurn?: boolean;
  /** Resolve `runTurn` locally (a slash command), emitting no agent_end. */
  localTurn?: boolean;
  /** Extra events emitted before the terminal agent_end. */
  extraEvents?: OmpRpcEvent[];
  /** A blocking content dialog; runTurn waits until the host responds. */
  questionEvent?: OmpExtensionUiRequestEvent;
  /** Never settle `runTurn` until `releaseTurn` is called. */
  hangTurn?: boolean;
  sessionFile?: string | undefined;
  /**
   * The final assistant message's text in the terminal `agent_end`. `null` makes
   * that message TOOL-CALLS-ONLY (no text block), which is the shape that has to
   * fall through to the RPC fallback.
   */
  assistantText?: string | null;
  /** What `get_last_assistant_text` answers; omitted ⇒ the method is absent. */
  lastAssistantText?: string | null;
  /** Provider error text for an error turn. */
  errorMessage?: string;
}

class FakeOmpClient implements OmpRpcClientLike {
  readonly listeners = new Set<(event: OmpRpcEvent) => void>();
  readonly uiResponses: OmpExtensionUiResponse[] = [];
  readonly stop = vi.fn(async () => undefined);
  readonly abort = vi.fn(async () => {
    this.releaseTurn();
    return {};
  });
  readonly start = vi.fn(() => {
    if (this.config.writeSentinel === false) return;
    const sentinelPath = this.options.env?.CYBOFLOW_OMP_GATE_SENTINEL;
    if (!sentinelPath) return;
    fs.writeFileSync(
      sentinelPath,
      JSON.stringify({
        loadedAt: new Date().toISOString(),
        runId: this.config.sentinelRunId ?? this.options.env?.CYBOFLOW_RUN_ID ?? '',
        pid: 4242,
      }),
      'utf8',
    );
  });
  readonly handshake = vi.fn(async () => ({
    ready: {
      type: 'ready' as const,
      protocolVersion: 1,
      supportedProtocolVersions: [1, 2],
      maxFrameBytes: 1024,
      maxReassembledFrameBytes: 2048,
    },
    protocolVersion: 2,
  }));
  readonly getSessionStats = vi.fn(async () => ({ cost: 0.42, tokens: { total: 100 } }));
  readonly prompts: string[] = [];
  /**
   * Present only when the config names an answer, mirroring the optional member
   * on {@link OmpRpcClientLike} — an absent method is the "older transport" case
   * the manager must degrade through rather than throw on.
   */
  readonly getLastAssistantText?: () => Promise<string | null>;

  private turnIndex = 0;
  private release: (() => void) | null = null;
  private releaseUiRequest: (() => void) | null = null;

  constructor(
    readonly options: OmpRpcClientOptions,
    private readonly config: FakeClientConfig = {},
  ) {
    if ('lastAssistantText' in config) {
      const answer = config.lastAssistantText ?? null;
      this.getLastAssistantText = vi.fn(async () => answer);
    }
  }

  onEvent(listener: (event: OmpRpcEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: OmpRpcEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  async getState(): Promise<{ sessionFile?: string }> {
    const sessionFile =
      'sessionFile' in this.config ? this.config.sessionFile : SESSION_FILE;
    return sessionFile === undefined ? {} : { sessionFile };
  }

  respondToExtensionUi(response: OmpExtensionUiResponse): void {
    this.uiResponses.push(response);
    this.releaseUiRequest?.();
    this.releaseUiRequest = null;
  }

  releaseTurn(): void {
    this.release?.();
    this.release = null;
  }

  async runTurn(message: string): Promise<OmpTurnOutcome> {
    const index = this.turnIndex++;
    this.prompts.push(message);
    if (this.config.hangTurn) {
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
    for (const event of this.config.extraEvents ?? []) this.emit(event);
    if (this.config.questionEvent) {
      this.emit(this.config.questionEvent);
      await new Promise<void>((resolve) => {
        this.releaseUiRequest = resolve;
      });
    }
    if (this.config.localTurn) return { completion: 'local' };

    const usage = this.config.usagePerTurn?.[index] ?? DEFAULT_USAGE;
    this.emit(assistantMessageEnd(index, usage));
    // `assistantText: null` is the TOOL-CALLS-ONLY final message; anything else
    // (including the default) carries a text block.
    const finalText =
      'assistantText' in this.config ? this.config.assistantText : 'done';
    const agentEnd: OmpAgentEndEvent = {
      type: 'agent_end',
      isTerminal: true,
      messages: this.config.errorTurn
        ? [
            {
              role: 'assistant',
              content: [],
              stopReason: 'error',
              errorMessage: this.config.errorMessage ?? 'omp turn blew up',
            },
          ]
        : [
            {
              role: 'assistant',
              content:
                finalText === null || finalText === undefined
                  ? [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: {} }]
                  : [{ type: 'text', text: finalText }],
            },
          ],
    };
    this.emit(agentEnd);
    return { completion: 'agent_end', agentEnd };
  }
}

const AGENT_INVOCATIONS_DDL = `
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
`;

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(AGENT_INVOCATIONS_DDL);
  db.exec(`
    CREATE TABLE raw_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

/**
 * The `agent_result` rows RawEventsSink persists verbatim — the exact payload
 * insightsQueries' run-cost rollup scans for `total_cost_usd` (raw_events.ts:571).
 * Distinct from `ResultRecord`/`results[]` below, which reads the
 * adapter-converted 'output' stream instead (already `total_cost_usd`-shaped
 * via agentStreamAdapter, so it can't catch a raw_events-only regression).
 */
function readPersistedAgentResults(db: Database.Database, runId: string): Array<Record<string, unknown>> {
  return (
    db
      .prepare("SELECT payload_json FROM raw_events WHERE run_id = ? AND event_type = 'agent_result' ORDER BY id")
      .all(runId) as Array<{ payload_json: string }>
  ).map((row) => JSON.parse(row.payload_json) as Record<string, unknown>);
}

interface ResultRecord {
  total_cost_usd?: number;
  usage?: Record<string, number>;
  is_error: boolean;
  session_id?: string;
  result?: string;
}

interface Harness {
  manager: OmpSdkManager;
  clients: FakeOmpClient[];
  results: ResultRecord[];
  errors: string[];
  sessionDirRoot: string;
}

function makeManager(
  db: Database.Database,
  config: FakeClientConfig | ((index: number) => FakeClientConfig) = {},
  overrides: Partial<OmpSdkManagerDeps> & { inPlace?: boolean } = {},
): Harness {
  const clients: FakeOmpClient[] = [];
  const sessionDirRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-sessions-'));
  tempDirs.push(sessionDirRoot);
  const sessionManager = {
    getDbSession: () => ({ in_place: overrides.inPlace === true }),
  } as unknown as SessionManager;

  const manager = new OmpSdkManager(sessionManager, undefined, undefined, db, {
    createClient: (options) => {
      const client = new FakeOmpClient(
        options,
        typeof config === 'function' ? config(clients.length) : config,
      );
      clients.push(client);
      return client;
    },
    resolveExecutable: async () => ({ executablePath: '/usr/local/bin/omp', version: '17.3.3' }),
    resolveGateExtensionPath: () => GATE_PATH,
    sessionDirRoot: () => sessionDirRoot,
    modelCatalogProbe: { getCatalog: vi.fn(), shutdown: vi.fn(async () => undefined) } as never,
    sentinelWaitMs: 60,
    ...overrides,
  });
  manager.setCyboflowMcpRuntimeConfig({
    orchSocketPath: '/tmp/cyboflow-orch.sock',
    bridgeScriptPath: '/app/cyboflowMcpServer.js',
    nodeExecutablePath: '/usr/local/bin/node',
  });

  const results: ResultRecord[] = [];
  manager.on('output', (event: { data: unknown }) => {
    const data = event.data as { type?: string } & ResultRecord;
    if (data.type === 'result') results.push(data);
  });
  const errors: string[] = [];
  manager.on('error', (event: { error: string }) => errors.push(event.error));
  return { manager, clients, results, errors, sessionDirRoot };
}

function turn(overrides: Partial<ClaudeSpawnerOptions> = {}): ClaudeSpawnerOptions {
  return {
    panelId: 'panel-1',
    sessionId: 'session-1',
    runId: 'run-1',
    worktreePath: '/tmp/worktree',
    prompt: 'go',
    ...overrides,
  };
}

/**
 * Wait until `count` fake clients have been constructed.
 *
 * `spawnCliProcess` awaits the executable probe before it builds the transport,
 * so a concurrent-lane test that inspects `clients` on the same tick sees an
 * empty array. Polls rather than awaiting the spawn promise itself: the point of
 * these tests is the state WHILE both turns are still in flight.
 */
async function waitForClients(clients: FakeOmpClient[], count: number): Promise<void> {
  for (let attempt = 0; attempt < 200 && clients.length < count; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(clients).toHaveLength(count);
}

/** Per-spawn `--session-dir` roots created by `makeManager`, removed after each test. */
const tempDirs: string[] = [];

/**
 * A DB carrying a REAL run: `run-1` walks the built-in sprint definition, so
 * `resolveRunDeployableAgents` resolves the sprint roles exactly as it does live
 * (the in-memory {@link createDb} has no workflow tables, so it resolves none).
 * `setSpec` edits that definition in place — the run has no frozen revision, so
 * the live spec is what the resolver reads.
 */
function createSprintRunDb(): {
  db: Database.Database;
  setSpec: (edit: (definition: Record<string, unknown>) => void) => void;
} {
  const db = createTestDb();
  db.exec(AGENT_INVOCATIONS_DDL);
  const { workflowId } = seedRun(db, { id: 'run-1', workflowName: 'sprint' });
  const setSpec = (edit: (definition: Record<string, unknown>) => void): void => {
    const definition = JSON.parse(materializeForLevel('sprint', '', 'standard')) as Record<string, unknown>;
    edit(definition);
    db.prepare('UPDATE workflows SET spec_json = ? WHERE id = ?').run(JSON.stringify(definition), workflowId);
  };
  setSpec(() => undefined);
  return { db, setSpec };
}

function makeWorktree(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-worktree-'));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  vi.mocked(writeOmpMcpConfig).mockClear();
});

afterEach(() => {
  delete process.env.CYBOFLOW_DISABLE_OMP_WARM;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('OmpSdkManager — the spawn', () => {
  it('spawns rpc-ui with the gate, the session dir, and the locked-down flags', async () => {
    const db = createDb();
    try {
      const { manager, clients } = makeManager(db);
      await manager.spawnCliProcess(turn({ model: 'anthropic/claude-haiku-4-5', reasoningEffort: 'low' }));

      const { options } = clients[0];
      // `--mode rpc` would leave OMP with no UI context, and an always-ask
      // session there cannot run a single write-tier tool.
      expect(options.modeArgs).toEqual(OMP_RPC_UI_MODE_ARGS);
      const args = options.args ?? [];
      expect(args).toEqual([
        '--approval-mode',
        'always-ask',
        '--no-extensions',
        '--no-skills',
        '--no-title',
        '-e',
        GATE_PATH,
        '--session-dir',
        expect.stringContaining('panel-1') as unknown as string,
        '--model',
        'anthropic/claude-haiku-4-5',
        '--thinking',
        'low',
      ]);
      expect(options.cwd).toBe('/tmp/worktree');
      await manager.killAllProcesses();
    } finally {
      db.close();
    }
  });

  it('maps dontAsk onto yolo and drops a model/effort the provider does not own', async () => {
    const db = createDb();
    try {
      const { manager, clients } = makeManager(db);
      await manager.spawnCliProcess(
        turn({
          agentPermissionMode: 'dontAsk',
          // A Claude alias: `normalizeAgentModelSelection` drops it for OMP.
          model: 'opus',
          // Claude-only effort level, outside OMP's scale.
          reasoningEffort: 'none',
        }),
      );

      const args = clients[0].options.args ?? [];
      expect(args.slice(0, 2)).toEqual(['--approval-mode', 'yolo']);
      expect(args).not.toContain('--model');
      expect(args).not.toContain('--thinking');
      await manager.killAllProcesses();
    } finally {
      db.close();
    }
  });

  it('injects the run env the gate and the MCP bridge read', async () => {
    const db = createDb();
    try {
      const { manager, clients } = makeManager(db);
      await manager.spawnCliProcess(turn({ agentPermissionMode: 'acceptEdits' }));

      const env = clients[0].options.env ?? {};
      expect(env.CYBOFLOW_RUN_ID).toBe('run-1');
      expect(env.CYBOFLOW_ORCH_SOCKET).toBe('/tmp/cyboflow-orch.sock');
      expect(env.CYBOFLOW_RUN_ARTIFACTS_DIR).toContain('run-1');
      expect(env.CYBOFLOW_OMP_GATE_SENTINEL).toBeTruthy();
      expect(env.PATH).toContain('/opt/homebrew/bin');
      expect(env.CYBOFLOW_MANAGED_TEST_CONCURRENCY).toBe('1');
      // Scoped to the MCP server entry in .omp/mcp.json, never inherited by every
      // subprocess the agent spawns.
      expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();

      const gateConfig = JSON.parse(env.CYBOFLOW_OMP_GATE_CONFIG ?? '{}') as {
        permissionMode: string;
        editTools: string[];
        denyTaskTool: boolean;
        cyboflowMcpToolNames: string[];
      };
      expect(gateConfig.permissionMode).toBe('acceptEdits');
      expect(gateConfig.editTools).toContain('write');
      // False since the subagent hook-scope premise was measured — see
      // ompGateConfigBuilder's doc block. What this assertion is really here
      // for is that the field is CARRIED into the spawn env at all.
      expect(gateConfig.denyTaskTool).toBe(false);
      expect(gateConfig.cyboflowMcpToolNames).toContain('mcp__cyboflow_report_finding');
      await manager.killAllProcesses();
    } finally {
      db.close();
    }
  });

  it('writes .omp/mcp.json for a worktree session and skips it in place', async () => {
    const db = createDb();
    try {
      const worktree = makeManager(db);
      await worktree.manager.spawnCliProcess(turn());
      expect(writeOmpMcpConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          worktreeRoot: '/tmp/worktree',
          nodeExecutablePath: '/usr/local/bin/node',
          bridgeScriptPath: '/app/cyboflowMcpServer.js',
        }),
      );
      await worktree.manager.killAllProcesses();

      vi.mocked(writeOmpMcpConfig).mockClear();
      const inPlace = makeManager(db, {}, { inPlace: true });
      await inPlace.manager.spawnCliProcess(turn({ panelId: 'panel-2' }));
      expect(writeOmpMcpConfig).not.toHaveBeenCalled();
      // …and the gate is told our MCP tools cannot occur in this session.
      const gateConfig = JSON.parse(
        inPlace.clients[0].options.env?.CYBOFLOW_OMP_GATE_CONFIG ?? '{}',
      ) as { cyboflowMcpToolNames: string[] };
      expect(gateConfig.cyboflowMcpToolNames).toEqual([]);
      await inPlace.manager.killAllProcesses();
    } finally {
      db.close();
    }
  });

  it('assertOmpSdkSpawnFlags refuses argv missing the gate or the session dir', () => {
    const complete = [
      '--approval-mode',
      'always-ask',
      '--no-extensions',
      '--no-skills',
      '-e',
      GATE_PATH,
      '--session-dir',
      '/tmp/x',
    ];
    expect(() => assertOmpSdkSpawnFlags(complete)).not.toThrow();
    expect(() => assertOmpSdkSpawnFlags(complete.filter((a) => a !== '-e'))).toThrow(/-e/);
    expect(() => assertOmpSdkSpawnFlags(complete.filter((a) => a !== '--session-dir'))).toThrow(
      /--session-dir/,
    );
    expect(() => assertOmpSdkSpawnFlags(complete.filter((a) => a !== '--no-extensions'))).toThrow(
      /--no-extensions/,
    );
  });
});

describe('OmpSdkManager — the fail-closed gate handshake', () => {
  it('refuses the session and stops the child when no sentinel is written', async () => {
    const db = createDb();
    try {
      const { manager, clients, errors } = makeManager(db, { writeSentinel: false });

      await expect(manager.spawnCliProcess(turn())).rejects.toThrow(/gate failed to load/);
      // The child is stopped by the refusal itself and again by the teardown;
      // what matters is that it does not survive.
      expect(clients[0].stop).toHaveBeenCalled();
      expect(clients[0].prompts).toEqual([]);
      expect(errors.some((message) => /UNGATED/.test(message))).toBe(true);
    } finally {
      db.close();
    }
  });

  it('refuses a sentinel written for a different run', async () => {
    const db = createDb();
    try {
      const { manager, clients } = makeManager(db, { sentinelRunId: 'some-other-run' });

      await expect(manager.spawnCliProcess(turn())).rejects.toThrow(/names run some-other-run/);
      expect(clients[0].prompts).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('refuses in dontAsk too — the gate still enforces disallowedTools there', async () => {
    const db = createDb();
    try {
      const { manager } = makeManager(db, { writeSentinel: false });
      await expect(
        manager.spawnCliProcess(turn({ agentPermissionMode: 'dontAsk' })),
      ).rejects.toThrow(/gate failed to load/);
    } finally {
      db.close();
    }
  });

  it('removes the sentinel file when the session closes', async () => {
    const db = createDb();
    try {
      const { manager, clients } = makeManager(db);
      await manager.spawnCliProcess(turn());
      const sentinelPath = clients[0].options.env?.CYBOFLOW_OMP_GATE_SENTINEL ?? '';
      expect(fs.existsSync(sentinelPath)).toBe(true);

      await manager.killAllProcesses();
      expect(fs.existsSync(sentinelPath)).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe('OmpSdkManager — the turn contract', () => {
  it('emits spawned/session-info/init/result and records the invocation', async () => {
    const db = createDb();
    try {
      const { manager, clients, results } = makeManager(db);
      const spawned = vi.fn();
      const exited = vi.fn();
      manager.on('spawned', spawned);
      manager.on('exit', exited);

      await manager.spawnCliProcess(turn());

      expect(spawned).toHaveBeenCalledOnce();
      expect(exited).toHaveBeenCalledWith(
        expect.objectContaining({ panelId: 'panel-1', exitCode: 0 }),
      );
      expect(clients[0].prompts).toEqual(['go']);
      expect(results).toHaveLength(1);
      expect(results[0].is_error).toBe(false);
      // Even the FIRST turn's result carries the session id: the projector is
      // rebuilt once the cold handshake resolves it.
      expect(results[0].session_id).toBe(SESSION_FILE);

      // The raw_events row (not the adapter-converted `results[]` stream above)
      // must carry BOTH keys: cost_usd for existing consumers, total_cost_usd
      // because that is the only key insightsQueries' rollup scans.
      const persisted = readPersistedAgentResults(db, 'run-1');
      expect(persisted).toHaveLength(1);
      expect(persisted[0].cost_usd).toBeCloseTo(DEFAULT_USAGE.costTotal, 10);
      expect(persisted[0].total_cost_usd).toBe(persisted[0].cost_usd);

      const invocation = db
        .prepare('SELECT agent_provider, agent_runtime, external_session_id, panel_id FROM agent_invocations')
        .get() as Record<string, string>;
      expect(invocation).toMatchObject({
        agent_provider: 'omp',
        agent_runtime: 'omp-sdk',
        external_session_id: SESSION_FILE,
        panel_id: 'panel-1',
      });
      await manager.killAllProcesses();
    } finally {
      db.close();
    }
  });

  it('persists RPC events to raw_events and answers OMP approval prompts', async () => {
    const db = createDb();
    try {
      const { manager, clients } = makeManager(db, {
        extraEvents: [
          { type: 'turn_start' },
          { type: 'message_update', assistantMessageEvent: { type: 'text_delta' } },
          {
            type: 'extension_ui_request',
            id: 'ui-9',
            method: 'select',
            title: 'Allow tool: bash\nCommand: ls',
            options: ['Approve', 'Deny'],
          },
        ],
      });
      await manager.spawnCliProcess(turn());

      const persisted = db
        .prepare('SELECT payload_json FROM raw_events WHERE event_type = ? ORDER BY id')
        .all(OMP_RAW_EVENT_TYPE) as Array<{ payload_json: string }>;
      const types = persisted.map((row) => (JSON.parse(row.payload_json) as { type: string }).type);
      expect(types).toContain('turn_start');
      expect(types).toContain('agent_end');
      expect(types).not.toContain('message_update');

      // The gate already vetted the call; the redundant prompt is auto-approved.
      expect(clients[0].uiResponses).toEqual([
        { type: 'extension_ui_response', id: 'ui-9', value: 'Approve' },
      ]);
      await manager.killAllProcesses();
    } finally {
      db.close();
    }
  });

  it('routes an OMP content picker through QuestionRouter and resumes the turn with the answer', async () => {
    const db = createDb();
    try {
      const title = 'Where should the Blog card link?';
      const { manager, clients } = makeManager(db, {
        questionEvent: {
          type: 'extension_ui_request',
          id: 'question-1',
          method: 'select',
          title,
          options: ['/changelog (Recommended)', '/blog', 'Other (type your own)'],
        },
      });
      const requestQuestion = vi.fn(async () => ({
        answers: { [title]: '/changelog (Recommended)' },
      }));
      manager.setQuestionRouterProvider(() => ({ requestQuestion }));

      await manager.spawnCliProcess(turn());

      expect(requestQuestion).toHaveBeenCalledWith(
        'run-1',
        'question-1',
        [expect.objectContaining({ question: title })],
        expect.any(Function),
      );
      expect(clients[0].uiResponses).toEqual([{
        type: 'extension_ui_response',
        id: 'question-1',
        value: '/changelog (Recommended)',
      }]);
      await manager.killAllProcesses();
    } finally {
      db.close();
    }
  });

  it('replaces OMP user-interrupt text when Cyboflow question routing caused the cancellation', async () => {
    const db = createDb();
    try {
      const { manager, results, errors } = makeManager(db, {
        questionEvent: {
          type: 'extension_ui_request',
          id: 'question-2',
          method: 'select',
          title: 'Pick one',
          options: ['A', 'B'],
        },
        errorTurn: true,
        errorMessage: 'Interrupted by user',
      });
      manager.setQuestionRouterProvider(() => ({
        requestQuestion: vi.fn(async () => {
          throw new Error('run is not active');
        }),
      }));

      await expect(manager.spawnCliProcess(turn())).rejects.toThrow(/question routing failed/i);
      expect(results).toHaveLength(1);
      expect(results[0].result).toContain('OMP question routing failed');
      expect(results[0].result).not.toBe('Interrupted by user');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('run is not active');
    } finally {
      db.close();
    }
  });

  it('fails the turn and emits one failure result when the agent ends in error', async () => {
    const db = createDb();
    try {
      const { manager, results, errors } = makeManager(db, { errorTurn: true });

      await expect(manager.spawnCliProcess(turn())).rejects.toThrow(/omp turn blew up/);
      expect(results).toHaveLength(1);
      expect(results[0].is_error).toBe(true);
      expect(errors).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('closes a locally-resolved prompt with a synthetic success result', async () => {
    const db = createDb();
    try {
      const { manager, results } = makeManager(db, { localTurn: true });
      await manager.spawnCliProcess(turn({ prompt: '/help' }));

      expect(results).toHaveLength(1);
      expect(results[0].is_error).toBe(false);

      // A local completion never sees a message_end, so cost is unknown —
      // neither key should appear (a stray total_cost_usd: 0 would corrupt
      // insightsQueries' SUM as a real, if zero, data point).
      const persisted = readPersistedAgentResults(db, 'run-1');
      expect(persisted).toHaveLength(1);
      expect(persisted[0].cost_usd).toBeUndefined();
      expect(persisted[0].total_cost_usd).toBeUndefined();
      await manager.killAllProcesses();
    } finally {
      db.close();
    }
  });

  it('interrupts an in-flight turn with the RPC abort, not a process kill', async () => {
    const db = createDb();
    try {
      const { manager, clients } = makeManager(db, { hangTurn: true });
      const spawn = manager.spawnCliProcess(turn());
      await vi.waitFor(() => expect(clients[0]?.prompts).toHaveLength(1));
      expect(manager.hasTurnInFlightForSession('session-1')).toBe(true);

      await manager.killProcess('panel-1');
      await spawn;

      expect(clients[0].abort).toHaveBeenCalledOnce();
      expect(clients[0].stop).toHaveBeenCalledOnce();
      expect(manager.hasTurnInFlightForSession('session-1')).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe('OmpSdkManager — warm reuse', () => {
  it('reuses the parked session for a matching resume-continuation', async () => {
    const db = createDb();
    try {
      const { manager, clients } = makeManager(db);
      await manager.spawnCliProcess(turn({ prompt: 'first' }));
      expect(clients).toHaveLength(1);

      await manager.spawnCliProcess(turn({ prompt: 'second', resumeSessionId: SESSION_FILE }));

      expect(clients).toHaveLength(1); // no cold respawn
      expect(clients[0].start).toHaveBeenCalledOnce(); // cold-only
      expect(clients[0].handshake).toHaveBeenCalledOnce(); // cold-only
      expect(clients[0].prompts).toEqual(['first', 'second']);

      const rows = db.prepare('SELECT COUNT(*) AS c FROM agent_invocations').get() as { c: number };
      expect(rows.c).toBe(2); // a fresh invocation row per logical turn

      await manager.killAllProcesses();
      expect(clients[0].stop).toHaveBeenCalledOnce();
    } finally {
      db.close();
    }
  });

  it('cold-respawns a same-key turn that is not a resume', async () => {
    const db = createDb();
    try {
      const { manager, clients } = makeManager(db);
      await manager.spawnCliProcess(turn({ prompt: 'first' }));
      await manager.spawnCliProcess(turn({ prompt: 'second' }));
      expect(clients).toHaveLength(2);
      await manager.killAllProcesses();
    } finally {
      db.close();
    }
  });

  it('cold-respawns when a spawn-baked input changes (the model)', async () => {
    const db = createDb();
    try {
      const { manager, clients } = makeManager(db);
      await manager.spawnCliProcess(turn({ model: 'anthropic/claude-haiku-4-5' }));
      await manager.spawnCliProcess(
        turn({ model: 'openai/gpt-5.6-sol', resumeSessionId: SESSION_FILE }),
      );
      expect(clients).toHaveLength(2);
      // The conversation is not lost — the cold respawn resumes the same session.
      expect(clients[1].options.args).toContain('--resume');
      expect(clients[1].options.args).toContain(SESSION_FILE);
      await manager.killAllProcesses();
    } finally {
      db.close();
    }
  });

  it('cold-respawns a resume that names a different session file', async () => {
    const db = createDb();
    try {
      const { manager, clients } = makeManager(db);
      await manager.spawnCliProcess(turn());
      await manager.spawnCliProcess(turn({ resumeSessionId: '/tmp/some/other-session.jsonl' }));
      expect(clients).toHaveLength(2);
      await manager.killAllProcesses();
    } finally {
      db.close();
    }
  });

  it('never parks when the kill switch is set', async () => {
    const db = createDb();
    try {
      process.env.CYBOFLOW_DISABLE_OMP_WARM = '1';
      const { manager, clients } = makeManager(db);
      await manager.spawnCliProcess(turn({ prompt: 'first' }));
      expect(clients[0].stop).toHaveBeenCalledOnce();

      await manager.spawnCliProcess(turn({ prompt: 'second', resumeSessionId: SESSION_FILE }));
      expect(clients).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it('never parks a fan-out lane spawn', async () => {
    const db = createDb();
    try {
      const { manager, clients } = makeManager(db);
      await manager.spawnCliProcess(turn({ spawnKey: 'run-1:TASK-007' }));
      expect(clients[0].stop).toHaveBeenCalledOnce();
      await manager.spawnCliProcess(
        turn({ spawnKey: 'run-1:TASK-007', resumeSessionId: SESSION_FILE }),
      );
      expect(clients).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it('closes (never parks) a failed turn', async () => {
    const db = createDb();
    try {
      const { manager, clients } = makeManager(db, { errorTurn: true });
      await expect(manager.spawnCliProcess(turn())).rejects.toThrow();
      expect(clients[0].stop).toHaveBeenCalledOnce();
    } finally {
      db.close();
    }
  });

  it.each([
    ['panel id', 'panel-1'],
    ['run id', 'run-1'],
  ])('closes a parked session when killed by %s', async (_label, identity) => {
    const db = createDb();
    try {
      const { manager, clients } = makeManager(db);
      await manager.spawnCliProcess(turn());
      expect(clients[0].stop).not.toHaveBeenCalled(); // parked, still alive

      await manager.killProcess(identity);
      expect(clients[0].stop).toHaveBeenCalledOnce();
    } finally {
      db.close();
    }
  });
});

describe('OmpSdkManager — usage accounting', () => {
  /**
   * The proposal's mandated accounting test (§5.1). `get_session_stats` is
   * CUMULATIVE, so stamping it per turn would record A + (A+B) + (A+B+C) across a
   * warm session and `insightsQueries` would sum THAT. Each result must carry only
   * its own turn's delta — including the turn after a restart-resume, which
   * cold-spawns a fresh process whose accumulator starts empty.
   */
  it('stamps each turn with its own delta across a warm session and a restart-resume', async () => {
    const db = createDb();
    const perTurn: TurnUsage[] = [
      { input: 10, output: 5, cacheRead: 1, cacheWrite: 100, costTotal: 0.01 },
      { input: 20, output: 7, cacheRead: 2, cacheWrite: 0, costTotal: 0.02 },
      { input: 30, output: 9, cacheRead: 3, cacheWrite: 0, costTotal: 0.04 },
    ];
    const restartUsage: TurnUsage = { input: 40, output: 11, cacheRead: 4, cacheWrite: 0, costTotal: 0.08 };
    try {
      const { manager, clients, results } = makeManager(db, (index) =>
        index === 0 ? { usagePerTurn: perTurn } : { usagePerTurn: [restartUsage] },
      );

      await manager.spawnCliProcess(turn({ prompt: 'one' }));
      await manager.spawnCliProcess(turn({ prompt: 'two', resumeSessionId: SESSION_FILE }));
      await manager.spawnCliProcess(turn({ prompt: 'three', resumeSessionId: SESSION_FILE }));
      expect(clients).toHaveLength(1); // three warm turns on one child

      // Restart recovery: a fresh manager (new process) resumes by session path.
      await manager.killAllProcesses();
      const restarted = makeManager(db, { usagePerTurn: [restartUsage] });
      await restarted.manager.spawnCliProcess(
        turn({ prompt: 'four', resumeSessionId: SESSION_FILE }),
      );
      await restarted.manager.killAllProcesses();

      const recorded = [...results, ...restarted.results];
      expect(recorded).toHaveLength(4);

      const expected = [...perTurn, restartUsage];
      recorded.forEach((result, index) => {
        expect(result.total_cost_usd).toBeCloseTo(expected[index].costTotal, 10);
        expect(result.usage).toEqual({
          input_tokens: expected[index].input,
          output_tokens: expected[index].output,
          cache_read_input_tokens: expected[index].cacheRead,
          cache_creation_input_tokens: expected[index].cacheWrite,
        });
      });

      // The invariant itself: what a downstream sum would compute equals the sum
      // of the per-turn deltas — never a re-summed cumulative rollup.
      const summed = recorded.reduce((total, result) => total + (result.total_cost_usd ?? 0), 0);
      expect(summed).toBeCloseTo(
        expected.reduce((total, usage) => total + usage.costTotal, 0),
        10,
      );
      expect(summed).toBeCloseTo(0.15, 10);
    } finally {
      db.close();
    }
  });

  it('never sources a turn from the cumulative session stats', async () => {
    const db = createDb();
    try {
      const { manager, clients, results } = makeManager(db);
      await manager.spawnCliProcess(turn());

      // Read once per turn as a debug cross-check…
      expect(clients[0].getSessionStats).toHaveBeenCalledOnce();
      // …and its (deliberately mismatched) rollup never reaches the result.
      expect(results[0].total_cost_usd).toBeCloseTo(DEFAULT_USAGE.costTotal, 10);
      expect(results[0].total_cost_usd).not.toBeCloseTo(0.42, 10);
      await manager.killAllProcesses();
    } finally {
      db.close();
    }
  });
});

/**
 * The typed step-output channel (`CliSpawnOutcome.resultText`) — the Phase-2
 * headline: the workflow controller parses a code-review verdict, a task-verify
 * PASS/FAIL, and the visual-verification fence out of this string, and every one
 * of those paths is DEAD for a substrate that returns nothing (which is why they
 * are dead on codex-sdk). These arms pin where the value comes from, because the
 * two sources answer different questions: the `agent_end` frame is THIS turn's,
 * the RPC call is the SESSION's most recent.
 */
describe('OmpSdkManager — resultText (typed step output)', () => {
  it('returns the final assistant text from the turn`s own terminal agent_end', async () => {
    const db = createDb();
    try {
      const { manager } = makeManager(db, { assistantText: '## Verdict\nPASS' });

      const outcome = await manager.spawnCliProcess(turn());

      expect(outcome).toEqual({ resultText: '## Verdict\nPASS' });
      await manager.killAllProcesses();
    } finally {
      db.close();
    }
  });

  it('falls back to the RPC last-assistant-text when the final message is tool calls only', async () => {
    const db = createDb();
    try {
      const { manager, clients } = makeManager(db, {
        assistantText: null,
        lastAssistantText: 'FAIL: the acceptance criteria are unmet',
      });

      const outcome = await manager.spawnCliProcess(turn());

      expect(outcome).toEqual({ resultText: 'FAIL: the acceptance criteria are unmet' });
      expect(clients[0].getLastAssistantText).toHaveBeenCalledOnce();
      await manager.killAllProcesses();
    } finally {
      db.close();
    }
  });

  it('never consults the RPC fallback when the frame already answered', async () => {
    // The fallback is SESSION-scoped, not turn-scoped: on a warm session it can
    // still hold the PREVIOUS turn's answer, so preferring it would let one
    // step's verdict be read as the next step's.
    const db = createDb();
    try {
      const { manager, clients } = makeManager(db, {
        assistantText: 'this turn',
        lastAssistantText: 'a stale earlier turn',
      });

      const outcome = await manager.spawnCliProcess(turn());

      expect(outcome).toEqual({ resultText: 'this turn' });
      expect(clients[0].getLastAssistantText).not.toHaveBeenCalled();
      await manager.killAllProcesses();
    } finally {
      db.close();
    }
  });

  it('resolves null — never throws — when neither source has any text', async () => {
    const db = createDb();
    try {
      const { manager } = makeManager(db, { assistantText: null, lastAssistantText: null });

      const outcome = await manager.spawnCliProcess(turn());

      expect(outcome).toEqual({ resultText: null });
      await manager.killAllProcesses();
    } finally {
      db.close();
    }
  });

  it('resolves null when the transport has no last-assistant-text call at all', async () => {
    // `getLastAssistantText` is optional on OmpRpcClientLike; an absent method
    // means no fallback, not a failed turn.
    const db = createDb();
    try {
      const { manager } = makeManager(db, { assistantText: null });

      const outcome = await manager.spawnCliProcess(turn());

      expect(outcome).toEqual({ resultText: null });
      await manager.killAllProcesses();
    } finally {
      db.close();
    }
  });

  it('does not resolve an outcome at all for a failed turn (it rejects)', async () => {
    // A controller that read a half-finished agent's last words as a verdict
    // would be worse than reading nothing, so the failure path never produces one.
    const db = createDb();
    try {
      const { manager } = makeManager(db, { errorTurn: true, lastAssistantText: 'partial work' });

      await expect(manager.spawnCliProcess(turn())).rejects.toThrow(/omp turn blew up/);
    } finally {
      db.close();
    }
  });
});

describe('OmpSdkManager — the system-prompt suffix', () => {
  it('maps systemPromptAppend onto --append-system-prompt', async () => {
    const db = createDb();
    try {
      const { manager, clients } = makeManager(db);
      await manager.spawnCliProcess(turn({ systemPromptAppend: 'You are in a cyboflow worktree.' }));

      expect(clients[0].options.args).toContain('--append-system-prompt');
      expect(clients[0].options.args).toContain('You are in a cyboflow worktree.');
      await manager.killAllProcesses();
    } finally {
      db.close();
    }
  });

  it('omits the flag entirely for an absent or blank suffix', async () => {
    const db = createDb();
    try {
      const { manager, clients } = makeManager(db);
      await manager.spawnCliProcess(turn());
      await manager.killAllProcesses();
      expect(clients[0].options.args).not.toContain('--append-system-prompt');

      const blank = makeManager(db);
      await blank.manager.spawnCliProcess(turn({ systemPromptAppend: '   ' }));
      await blank.manager.killAllProcesses();
      expect(blank.clients[0].options.args).not.toContain('--append-system-prompt');
    } finally {
      db.close();
    }
  });

  it('cold-respawns a warm session when the suffix changes (it is spawn-baked)', async () => {
    // The suffix is argv, so a parked child is still running the OLD one. If the
    // fingerprint missed it, a resume would silently keep the previous system
    // prompt for the rest of the session.
    const db = createDb();
    try {
      const { manager, clients } = makeManager(db);
      await manager.spawnCliProcess(turn({ systemPromptAppend: 'first' }));
      expect(clients).toHaveLength(1);

      await manager.spawnCliProcess(
        turn({ systemPromptAppend: 'second', resumeSessionId: SESSION_FILE }),
      );

      expect(clients).toHaveLength(2);
      await manager.killAllProcesses();
    } finally {
      db.close();
    }
  });
});

/**
 * An OMP orchestrator delegates to `cyboflow-<key>` through OMP's task tool, which
 * resolves project agents from `<worktree>/.omp/agents/`. These arms pin that the
 * run's resolved roles land there, where OMP reads them.
 */
describe('OmpSdkManager — cyboflow roles as OMP project agents', () => {
  it('registers the run`s roles in the worktree on a cold spawn', async () => {
    const { db } = createSprintRunDb();
    try {
      const worktreePath = makeWorktree();
      const { manager } = makeManager(db);
      await manager.spawnCliProcess(turn({ worktreePath }));

      const agentsDir = path.join(worktreePath, '.omp', 'agents');
      const implement = fs.readFileSync(path.join(agentsDir, 'cyboflow-implement.md'), 'utf8');
      expect(implement.startsWith('---\nname: "cyboflow-implement"\n')).toBe(true);
      // The body is the run's RESOLVED role prompt — the one the Claude overlay writes.
      const resolved = resolveRunDeployableAgents(db, 'run-1').find((a) => a.agentKey === 'implement');
      expect(resolved?.systemPrompt.length).toBeGreaterThan(0);
      expect(implement.endsWith(`---\n\n${resolved?.systemPrompt ?? '<unresolved>'}`)).toBe(true);

      // Only the roles the sprint binds — never another flow's.
      const files = fs.readdirSync(agentsDir);
      expect(files).toEqual(expect.arrayContaining(['cyboflow-code-review.md', 'cyboflow-task-verify.md']));
      expect(files).not.toContain('cyboflow-interview.md');
      await manager.killAllProcesses();
    } finally {
      db.close();
    }
  });

  it('registers nothing for an in-place session', async () => {
    const { db } = createSprintRunDb();
    try {
      const worktreePath = makeWorktree();
      const inPlace = makeManager(db, {}, { inPlace: true });
      await inPlace.manager.spawnCliProcess(turn({ worktreePath }));
      await inPlace.manager.killAllProcesses();
      expect(fs.existsSync(path.join(worktreePath, '.omp'))).toBe(false);

      // Control: the same run and directory as a worktree session does register.
      const worktree = makeManager(db);
      await worktree.manager.spawnCliProcess(turn({ panelId: 'panel-2', worktreePath }));
      await worktree.manager.killAllProcesses();
      expect(fs.existsSync(path.join(worktreePath, '.omp', 'agents', 'cyboflow-implement.md'))).toBe(true);
    } finally {
      db.close();
    }
  });

  it('cold-respawns a warm session when a role prompt changes, and rewrites the role', async () => {
    // OMP may read its agents once at process start, and only the cold path
    // writes them — so a changed role must not ride a parked child.
    const { db, setSpec } = createSprintRunDb();
    try {
      const worktreePath = makeWorktree();
      const implementPath = path.join(worktreePath, '.omp', 'agents', 'cyboflow-implement.md');
      const { manager, clients } = makeManager(db);
      await manager.spawnCliProcess(turn({ worktreePath, prompt: 'first' }));

      // Control: an unchanged role set keeps the parked child.
      await manager.spawnCliProcess(turn({ worktreePath, prompt: 'second', resumeSessionId: SESSION_FILE }));
      expect(clients).toHaveLength(1);

      setSpec((definition) => {
        const configs = (definition.agentConfigs ?? {}) as Record<string, Record<string, unknown>>;
        configs.implement = { ...(configs.implement ?? {}), promptAddendum: 'Always run the linter.' };
        definition.agentConfigs = configs;
      });
      await manager.spawnCliProcess(turn({ worktreePath, prompt: 'third', resumeSessionId: SESSION_FILE }));

      expect(clients).toHaveLength(2);
      expect(clients[1].options.args).toContain('--resume');
      expect(fs.readFileSync(implementPath, 'utf8')).toContain('Always run the linter.');
      await manager.killAllProcesses();
    } finally {
      db.close();
    }
  });
});

/**
 * T1 sprint fan-out runs SEVERAL per-step agents concurrently in ONE worktree,
 * against ONE panel id — the lanes are told apart by `spawnKey` alone. Every
 * per-spawn resource therefore has to be keyed on THAT, not on the panel.
 */
describe('OmpSdkManager — concurrent fan-out lanes', () => {
  it('runs two lanes as two children with distinct session dirs and gate sentinels', async () => {
    const db = createDb();
    try {
      const { manager, clients } = makeManager(db, { hangTurn: true });

      const laneA = manager.spawnCliProcess(turn({ spawnKey: 'run-1:TASK-001', prompt: 'lane A' }));
      const laneB = manager.spawnCliProcess(turn({ spawnKey: 'run-1:TASK-002', prompt: 'lane B' }));

      // Both children are live at once — neither lane serialized behind the other
      // on the shared panel id.
      await waitForClients(clients, 2);

      const [dirA, dirB] = clients.map((c) => {
        const args = c.options.args ?? [];
        return args[args.indexOf('--session-dir') + 1];
      });
      expect(dirA).not.toBe(dirB);
      expect(dirA).toContain('run-1-TASK-001');
      expect(dirB).toContain('run-1-TASK-002');

      const sentinelA = clients[0].options.env?.CYBOFLOW_OMP_GATE_SENTINEL;
      const sentinelB = clients[1].options.env?.CYBOFLOW_OMP_GATE_SENTINEL;
      expect(sentinelA).toBeDefined();
      expect(sentinelB).toBeDefined();
      expect(sentinelA).not.toBe(sentinelB);

      // Each lane's prompt went to its OWN child rather than both to one.
      expect(clients[0].prompts).toEqual(['lane A']);
      expect(clients[1].prompts).toEqual(['lane B']);

      // The turns resolve INDEPENDENTLY: releasing B settles B while A is still
      // in flight, which is what a fan-out wave depends on.
      clients[1].releaseTurn();
      await expect(laneB).resolves.toEqual({ resultText: 'done' });

      clients[0].releaseTurn();
      await expect(laneA).resolves.toEqual({ resultText: 'done' });
      await manager.killAllProcesses();
    } finally {
      db.close();
    }
  });

  it('still refuses a SECOND spawn on the same key while one is in flight', async () => {
    // The per-key reservation is what keeps two turns off one child; widening
    // the keying to spawnKey must not have widened that.
    const db = createDb();
    try {
      const { manager, clients } = makeManager(db, { hangTurn: true });
      const inFlight = manager.spawnCliProcess(turn({ spawnKey: 'run-1:TASK-001' }));
      await waitForClients(clients, 1);

      await expect(manager.spawnCliProcess(turn({ spawnKey: 'run-1:TASK-001' }))).rejects.toThrow(
        /already running for spawn run-1:TASK-001/,
      );

      clients[0].releaseTurn();
      await inFlight;
      await manager.killAllProcesses();
    } finally {
      db.close();
    }
  });

  it('keeps a chat panel`s session dir keyed to its panel (spawnKey defaults to panelId)', async () => {
    // The non-fan-out path must be byte-identical: a chat panel's resume target
    // is its session dir, and re-keying it would orphan every existing session.
    const db = createDb();
    try {
      const { manager, clients } = makeManager(db);
      await manager.spawnCliProcess(turn());

      const args = clients[0].options.args ?? [];
      expect(args[args.indexOf('--session-dir') + 1]).toContain('panel-1');
      await manager.killAllProcesses();
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The turn ceiling
// ---------------------------------------------------------------------------

describe('OmpSdkManager — the turn ceiling', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('names itself as the cause instead of reporting OMP\'s "Interrupted by user"', async () => {
    vi.useFakeTimers();
    const db = createDb();
    try {
      // `hangTurn` parks the turn; the ceiling's own `abort()` releases it, and
      // the fake then ends the turn the way OMP really does — an error result
      // reading "Interrupted by user", which is the text under test.
      const { manager, results, clients } = makeManager(db, {
        hangTurn: true,
        errorTurn: true,
        errorMessage: 'Interrupted by user',
      });

      const spawned = manager.spawnCliProcess(turn());
      const settled = spawned.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(OMP_TURN_TIMEOUT_MS);
      const outcome = await settled;

      expect(clients[0].abort).toHaveBeenCalledOnce();
      expect(results).toHaveLength(1);
      expect(results[0].is_error).toBe(true);
      expect(results[0].result).not.toBe('Interrupted by user');
      expect(results[0].result).toContain('NOT a user interrupt');
      expect(results[0].result).toContain('30-minute');
      // The wall-clock property is the one a reader has to know to act on this.
      expect(results[0].result).toContain('human tool approvals');
      expect(String(outcome)).toContain('NOT a user interrupt');
    } finally {
      db.close();
    }
  });

  it('leaves a real user interrupt attributed to the user', async () => {
    const db = createDb();
    try {
      const { manager, results } = makeManager(db, {
        errorTurn: true,
        errorMessage: 'Interrupted by user',
      });

      await expect(manager.spawnCliProcess(turn())).rejects.toThrow(/interrupted by user/i);
      expect(results).toHaveLength(1);
      expect(results[0].result).toBe('Interrupted by user');
    } finally {
      db.close();
    }
  });
});
