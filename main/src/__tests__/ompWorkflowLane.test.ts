/**
 * The `omp-sdk` T1 workflow lane, end to end across the real seams.
 *
 * Phase 2 promotes OMP from a quick-session runtime to a workflow one, and the
 * promotion is only real if a per-step spawn actually travels
 * `SpawnStepRunner → SubstrateDispatchFacade → OmpSdkManager` and comes back
 * with the step's typed output. Each of those three has its own unit suite; what
 * none of them can prove alone is that the CHAIN holds — which manager the
 * facade picks for a per-step runtime override, whether the spawn options
 * survive the hop, and whether `resultText` makes it back to the value
 * `WorkflowController` reads (`workflowController.ts` — `result.resultText` on
 * the `ok` path).
 *
 * That last one is the headline: `codex-sdk` resolves `void`, so the
 * controller's code-review-verdict, task-verify-FAIL and visual-fence paths are
 * dead on Codex. They are live here, and this file is what says so.
 *
 * Everything is real except the OMP transport: a fake `OmpRpcClientLike` stands
 * in for the `omp --mode rpc-ui` child, writing the gate's load sentinel from
 * `start()` exactly as the real extension does at import time — so the
 * fail-closed handshake runs on its real path rather than being stubbed out.
 */
import Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AbstractCliManager } from '../services/panels/cli/AbstractCliManager';
import { SubstrateDispatchFacade } from '../services/substrateDispatchFacade';
import { OmpSdkManager, type OmpRpcClientLike } from '../services/panels/omp/ompSdkManager';
import type { SessionManager } from '../services/sessionManager';
import type {
  OmpRpcClientOptions,
  OmpRpcEvent,
  OmpTurnOutcome,
} from '../services/panels/omp/rpc';
import { SpawnStepRunner } from '../orchestrator/programmatic/spawnStepRunner';
import type { ControllerStepContext } from '../orchestrator/programmatic/types';
import type { ClaudeSpawnerOptions, WorkflowRegistryLike } from '../orchestrator/runExecutor';
import type { WorkflowStep } from '../../../shared/types/workflows';
import type { OmpGateConfig } from '../services/panels/omp/gate/ompGateTypes';
import { makeSpyLogger } from '../orchestrator/__test_fixtures__/loggerLikeSpy';

vi.mock('../services/panels/omp/ompMcpConfigWriter', () => ({
  writeOmpMcpConfig: vi.fn(() => ({ configPath: '/tmp/worktree/.omp/mcp.json', wrote: true })),
}));
// A login-shell PATH probe would really spawn a shell.
vi.mock('../utils/shellPath', () => ({
  getShellPath: () => '/usr/bin',
  findExecutableInPath: () => null,
}));

const GATE_PATH = '/app/gate/ompGateExtension.ts';

/**
 * The minimum of `OmpRpcClientLike` this chain drives. Deliberately NOT shared
 * with `ompSdkManager.test.ts`'s richer fake: that one models usage deltas,
 * error turns and warm reuse, none of which this file asserts, and coupling the
 * two would make either suite's fixture edits ripple into the other.
 */
class FakeOmpClient implements OmpRpcClientLike {
  readonly listeners = new Set<(event: OmpRpcEvent) => void>();
  readonly prompts: string[] = [];
  readonly stop = vi.fn(async () => undefined);
  readonly abort = vi.fn(async () => ({}));
  readonly getSessionStats = vi.fn(async () => ({ cost: 0, tokens: { total: 0 } }));
  readonly getLastAssistantText = vi.fn(async () => null);
  readonly handshake = vi.fn(async () => ({
    ready: {
      type: 'ready' as const,
      protocolVersion: 1,
      supportedProtocolVersions: [1],
      maxFrameBytes: 1024,
      maxReassembledFrameBytes: 2048,
    },
    protocolVersion: 1,
  }));
  readonly start = vi.fn(() => {
    const sentinelPath = this.options.env?.CYBOFLOW_OMP_GATE_SENTINEL;
    if (!sentinelPath || !this.writeSentinel) return;
    fs.writeFileSync(
      sentinelPath,
      JSON.stringify({
        loadedAt: new Date().toISOString(),
        runId: this.options.env?.CYBOFLOW_RUN_ID ?? '',
        pid: 1234,
      }),
      'utf8',
    );
  });

  constructor(
    readonly options: OmpRpcClientOptions,
    private readonly finalText: string,
    /** false ⇒ the gate extension never loaded, so the session must be refused. */
    private readonly writeSentinel = true,
  ) {}

  onEvent(listener: (event: OmpRpcEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async getState(): Promise<{ sessionFile?: string }> {
    return { sessionFile: '/tmp/omp-sessions/s.jsonl' };
  }

  respondToExtensionUi(): void {}

  async runTurn(message: string): Promise<OmpTurnOutcome> {
    this.prompts.push(message);
    const agentEnd = {
      type: 'agent_end' as const,
      isTerminal: true,
      messages: [
        { role: 'assistant' as const, content: [{ type: 'text' as const, text: this.finalText }] },
      ],
    };
    for (const listener of [...this.listeners]) listener(agentEnd);
    return { completion: 'agent_end', agentEnd };
  }
}

/** A Claude-lane stand-in: the facade refuses to build without its fallback lane. */
class ClaudeSpy extends EventEmitter {
  readonly spawnCalls: ClaudeSpawnerOptions[] = [];
  async spawnCliProcess(options: ClaudeSpawnerOptions): Promise<void> {
    this.spawnCalls.push(options);
  }
  async killProcess(): Promise<void> {}
}

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
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
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

const tempDirs: string[] = [];
const openDbs: Database.Database[] = [];

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  runner: SpawnStepRunner;
  clients: FakeOmpClient[];
  claude: ClaudeSpy;
  ompManager: OmpSdkManager;
}

/**
 * The real chain: a `SpawnStepRunner` whose spawner is a real
 * `SubstrateDispatchFacade` serving a real `OmpSdkManager` on the `omp-sdk`
 * lane. The RUN row is stamped Claude on purpose — the per-step override is what
 * must redirect this one spawn, which is the mixed-provider case the facade's
 * `resolveManagerForSpawn` exists for.
 */
function makeHarness(
  stepAgent: {
    runtime?: 'omp-sdk' | 'claude-sdk';
    providerModel?: string;
    effort?: 'low' | 'max';
  },
  finalText = '## Verdict\nPASS',
  runnerOverrides: Partial<ConstructorParameters<typeof SpawnStepRunner>[1]> = {},
  writeSentinel = true,
): Harness {
  const db = createDb();
  openDbs.push(db);
  const sessionDirRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-lane-'));
  tempDirs.push(sessionDirRoot);

  const clients: FakeOmpClient[] = [];
  const ompManager = new OmpSdkManager(
    { getDbSession: () => ({ in_place: false }) } as unknown as SessionManager,
    undefined,
    undefined,
    db,
    {
      createClient: (options) => {
        const client = new FakeOmpClient(options, finalText, writeSentinel);
        clients.push(client);
        return client;
      },
      resolveExecutable: async () => ({ executablePath: '/usr/local/bin/omp', version: '17.3.3' }),
      resolveGateExtensionPath: () => GATE_PATH,
      sessionDirRoot: () => sessionDirRoot,
      modelCatalogProbe: { getCatalog: vi.fn(), shutdown: vi.fn(async () => undefined) } as never,
      sentinelWaitMs: 60,
    },
  );
  ompManager.setCyboflowMcpRuntimeConfig({
    orchSocketPath: '/tmp/orch.sock',
    bridgeScriptPath: '/app/cyboflowMcpServer.js',
    nodeExecutablePath: '/usr/local/bin/node',
  });

  const claude = new ClaudeSpy();
  // The run row says CLAUDE: the per-step override is the only thing that can
  // send this spawn to OMP.
  const registry: WorkflowRegistryLike = {
    getRunById: () => ({ id: 'run-1', substrate: 'sdk', agent_provider: 'claude', agent_runtime: 'claude-sdk' }),
    resolveEffectiveTuningLevel: () => null,
  } as unknown as WorkflowRegistryLike;

  const facade = new SubstrateDispatchFacade({
    managers: [
      { lane: 'claude-sdk', manager: claude as unknown as AbstractCliManager },
      { lane: 'omp-sdk', manager: ompManager },
    ],
    registry,
    logger: makeSpyLogger(),
  });

  const runner = new SpawnStepRunner(facade, {
    panelId: 'run-1',
    sessionId: 'run-1',
    runId: 'run-1',
    worktreePath: '/tmp/worktree',
    workflowName: 'sprint',
    disallowedTools: ['mcp__cyboflow__cyboflow_request_verification'],
    resolveStepAgent: () => stepAgent,
    ...runnerOverrides,
  });

  return { runner, clients, claude, ompManager };
}

const STEP: WorkflowStep = { id: 'code-review', name: 'Code review', agent: 'code-review' } as WorkflowStep;
const CTX: ControllerStepContext = { runId: 'run-1', phaseId: 'execute', stepIndex: 0, attempt: 1 };

function argOf(client: FakeOmpClient, flag: string): string | undefined {
  const args = client.options.args ?? [];
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function gateConfigOf(client: FakeOmpClient): OmpGateConfig {
  return JSON.parse(client.options.env?.CYBOFLOW_OMP_GATE_CONFIG ?? '{}') as OmpGateConfig;
}

describe('omp-sdk workflow lane — the typed step-output channel', () => {
  it('delivers the OMP turn`s final assistant text as the step result the controller parses', async () => {
    const { runner, ompManager } = makeHarness({ runtime: 'omp-sdk' }, '## Verdict\nBLOCKED');

    const result = await runner.runStep(STEP, CTX);

    // This exact shape is what WorkflowController reads on the `ok` path before
    // handing the text to parseCodeReviewVerdict / parseTaskVerifyVerdict /
    // parseVisualTaskSection. `codex-sdk` yields `resultText: null` here.
    expect(result).toEqual({ status: 'ok', resultText: '## Verdict\nBLOCKED' });
    await ompManager.killAllProcesses();
  });

  it('reports a refused OMP session as a failed step with NO resultText to parse', async () => {
    // No gate sentinel ⇒ the manager refuses an ungated session and the spawn
    // rejects. The step must come back `failed` with the field ABSENT: a
    // controller that saw `resultText: ''` here would parse a verdict out of a
    // turn that never ran.
    const { runner, ompManager } = makeHarness({ runtime: 'omp-sdk' }, 'unused', {}, false);

    const result = await runner.runStep(STEP, CTX);

    expect(result.status).toBe('failed');
    expect('resultText' in result).toBe(false);
    expect(result.status === 'failed' && result.error).toMatch(/gate failed to load/);
    await ompManager.killAllProcesses();
  });
});

describe('omp-sdk workflow lane — per-step spawn plumbing', () => {
  it('routes the spawn to the OMP manager, not the run`s Claude lane', async () => {
    const { runner, clients, claude, ompManager } = makeHarness({ runtime: 'omp-sdk' });

    await runner.runStep(STEP, CTX);

    expect(clients).toHaveLength(1);
    expect(claude.spawnCalls).toEqual([]);
    await ompManager.killAllProcesses();
  });

  it('leaves an unpinned step on the run`s Claude lane', async () => {
    // The negative half: without a per-step runtime the facade must fall back to
    // the run row, or every step of every run would follow the last override.
    const { runner, clients, claude, ompManager } = makeHarness({});

    await runner.runStep(STEP, CTX);

    expect(clients).toEqual([]);
    expect(claude.spawnCalls).toHaveLength(1);
    await ompManager.killAllProcesses();
  });

  it('carries the per-agent providerModel onto --model', async () => {
    const { runner, clients, ompManager } = makeHarness({
      runtime: 'omp-sdk',
      providerModel: 'anthropic/claude-haiku-4-5',
    });

    await runner.runStep(STEP, CTX);

    expect(argOf(clients[0], '--model')).toBe('anthropic/claude-haiku-4-5');
    await ompManager.killAllProcesses();
  });

  it('normalizes the per-agent effort onto OMP`s --thinking scale', async () => {
    const { runner, clients, ompManager } = makeHarness({ runtime: 'omp-sdk', effort: 'max' });

    await runner.runStep(STEP, CTX);

    expect(argOf(clients[0], '--thinking')).toBe('max');
    await ompManager.killAllProcesses();
  });

  it('carries the run`s systemPromptAppend onto --append-system-prompt', async () => {
    const { runner, clients, ompManager } = makeHarness({ runtime: 'omp-sdk' }, 'ok');
    // The step runner does not thread a suffix itself, so drive the seam the run
    // executor uses: the spawn option the facade forwards verbatim.
    await runner.runStep(STEP, CTX);
    expect(clients[0].options.args).not.toContain('--append-system-prompt');

    await ompManager.spawnCliProcess({
      panelId: 'run-1',
      sessionId: 'run-1',
      runId: 'run-1',
      worktreePath: '/tmp/worktree',
      prompt: 'go',
      systemPromptAppend: 'Cyboflow worktree rules apply.',
    });
    expect(argOf(clients[1], '--append-system-prompt')).toBe('Cyboflow worktree rules apply.');
    await ompManager.killAllProcesses();
  });

  it('translates the step`s disallowedTools into the gate config the extension reads', async () => {
    // The gate is the SOLE policy engine for an OMP session, so a deny list that
    // stopped at the spawn seam would be a silently-ungated tool.
    const { runner, clients, ompManager } = makeHarness({ runtime: 'omp-sdk' });

    await runner.runStep(STEP, CTX);

    // Claude's `mcp__<server>__<tool>` becomes OMP's single-underscore form.
    expect(gateConfigOf(clients[0]).disallowedTools).toEqual([
      'mcp__cyboflow_request_verification',
    ]);
    await ompManager.killAllProcesses();
  });

  it('sets the run env the cyboflow MCP bridge and the artifacts dir need', async () => {
    const { runner, clients, ompManager } = makeHarness({ runtime: 'omp-sdk' });

    await runner.runStep(STEP, CTX);

    const env = clients[0].options.env ?? {};
    expect(env.CYBOFLOW_RUN_ID).toBe('run-1');
    expect(env.CYBOFLOW_ORCH_SOCKET).toBe('/tmp/orch.sock');
    expect(env.CYBOFLOW_RUN_ARTIFACTS_DIR).toContain('run-1');
    await ompManager.killAllProcesses();
  });

  it('renders the step prompt with the OMP runtime-adapter envelope', async () => {
    // The T1 step prompt tells the step to delegate to its `cyboflow-<agent>`
    // role and claims that role is installed in `.claude/agents/` — true on
    // Claude only. The envelope points at the OMP project agents cyboflow
    // installs instead and forbids resolving the prefix-stripped name against
    // OMP's own roster (which is how a real run adopted a third-party
    // `compounder`).
    const { runner, clients, ompManager } = makeHarness({ runtime: 'omp-sdk' }, 'ok', {
      promptRenderContext: { provider: 'omp', runtime: 'omp-sdk', executionModel: 'programmatic' },
    });

    await runner.runStep(STEP, CTX);

    const prompt = clients[0].prompts[0];
    expect(prompt).toContain('# Runtime adapter: OMP');
    expect(prompt).toContain('`.omp/agents/cyboflow-<role>.md`');
    expect(prompt).toContain('NEVER pass the role name with the `cyboflow-` prefix stripped');
    // …and the composed step prompt is still there, after the envelope.
    expect(prompt).toContain('code-review');
    await ompManager.killAllProcesses();
  });
});
