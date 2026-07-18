/**
 * Tier-3 mocked-SDK integration — global-agent isolation spawn (S0.2).
 *
 * Drives the REAL ClaudeCodeManager.spawnCliProcess with the SDK `query()` faked
 * via the shared `createModuleFakeSdk` options-capture handle (the
 * claudeCodeManagerWiring pattern), so the assertions read the ACTUAL
 * `buildSdkOptions` output the manager handed to the SDK. Proves that an
 * `isolation: 'agent'` spawn is hermetic against a HOSTILE environment — a
 * worktree `.claude/settings.local.json` declaring extra MCP servers, plugins,
 * and permissive `allow` rules, plus a global permission-mode default of
 * `dontAsk` — none of which reaches the resolved options:
 *
 *   - settingSources deep-equal []           (user/project settings unreachable);
 *   - strictMcpConfig true                    (no config-file MCP discovery);
 *   - mcpServers keys === ['cyboflow']         (no inherited/plugin MCP servers);
 *   - plugins deep-equal []                    (no inherited plugins);
 *   - tools deep-equal []                      (no built-in tools);
 *   - permissionMode 'default' (NOT dontAsk)   (global default not inherited);
 *   - allowedTools === ['mcp__cyboflow']       (the scoped family auto-allowed);
 *   - the cyboflow entry env carries CYBOFLOW_MCP_SCOPE=global-agent.
 *
 * Plus: the warm fingerprint busts on a `tools` change; an injected eventsSink
 * receives the narrowed stream while the built-in RawEventsSink writes ZERO
 * raw_events rows; and a NON-isolation spawn still resolves to the
 * ['user','project'] settingSources it always had.
 *
 * NOTE on hostile-fixture reach: a mock SessionManager (no project row) means the
 * base-project `.mcp.json` merge and the user-home `~/.claude/settings.json` are
 * not reachable via this harness. We plant every source the harness DOES reach —
 * the worktree `.claude/settings.local.json` (read by loadMergedPermissionRules)
 * and the global default permission mode (ConfigManager) — and assert
 * settingSources:[] / the pinned policy make them unreachable. The isolation
 * PreToolUse hook is exercised directly to prove it ignores the planted allow rule.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type Database from 'better-sqlite3';
import type { Options, PreToolUseHookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { ApprovalRouter } from '../../approvalRouter';
import { QuestionRouter } from '../../questionRouter';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import { makeProdLoggerSpy } from '../../__test_fixtures__/loggerLikeSpy';
import { createTestDb } from '../../__test_fixtures__/orchestratorTestDb';
import { createModuleFakeSdk, scenario, type FakeQueryParams } from '../../../test/fakes/fakeSdk';
import {
  ClaudeCodeManager,
  type SpawnEventsSink,
} from '../../../services/panels/claude/claudeCodeManager';
import type { EventRouter } from '../../../services/streamParser';
import type { SessionManager } from '../../../services/sessionManager';
import type { ConfigManager } from '../../../services/configManager';
import type { Logger } from '../../../utils/logger';

// ---------------------------------------------------------------------------
// SDK module mock — capture buildSdkOptions output; drive scripted scenarios.
// Preserves every real export (types etc.) and overrides only query(), which is
// read lazily so the module-level `fakeSdk` const is initialized by call time.
// Wins over integration.setup.ts's defensive throwing mock for THIS file.
// ---------------------------------------------------------------------------

const fakeSdk = createModuleFakeSdk([]);

vi.mock('@anthropic-ai/claude-agent-sdk', async () => {
  const actual = await vi.importActual<typeof import('@anthropic-ai/claude-agent-sdk')>(
    '@anthropic-ai/claude-agent-sdk',
  );
  return { ...actual, query: (params: FakeQueryParams) => fakeSdk.query(params) };
});

// Deterministic node/script resolution so setOrchSocketPath → composeMcpServers
// composes the cyboflow MCP entry without touching the real filesystem/PATH.
vi.mock('../../mcpServer/scriptPath', () => ({
  resolveMcpServerScriptPath: vi.fn(() => '/mock/mcp-server.js'),
}));
vi.mock('../../../utils/nodeFinder', () => ({
  findNodeExecutable: vi.fn(async () => 'node'),
}));
vi.mock('../../../utils/promptEnhancer', () => ({
  enhancePromptForStructuredCommit: vi.fn((prompt: string) => prompt),
}));
vi.mock('../../../utils/sessionValidation', () => ({
  validatePanelSessionOwnership: vi.fn(() => ({ valid: true })),
  logValidationFailure: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** ClaudeSpawnOptions without exporting the interface — derived from the method. */
type SpawnOpts = Parameters<ClaudeCodeManager['spawnCliProcess']>[0];

/** Private-method reach for the fingerprint + hook assertions. */
interface ClaudeCodeManagerPrivate {
  buildSdkOptions(options: SpawnOpts): Promise<Options>;
  computeOptionsFingerprint(
    sdkOptions: Options,
    worktreePath: string,
  ): { combined: string; fields: Record<string, string> };
  makeIsolationPreToolUseHook(): (
    input: PreToolUseHookInput,
    toolUseId: string,
    ctx: unknown,
  ) => Promise<HookJSONOutput>;
}

/** A SpawnEventsSink test double recording the narrowed stream it receives. */
class RecordingSink implements SpawnEventsSink {
  readonly events: unknown[] = [];
  private teardown: (() => void) | null = null;
  attachToRouter(router: EventRouter, runId: string): void {
    this.teardown = router.onRun(runId, (event) => {
      this.events.push(event);
    });
  }
  dispose(): void {
    this.teardown?.();
    this.teardown = null;
  }
}

function mockSessionManager(): SessionManager {
  return {
    getDbSession: vi.fn(() => undefined),
    getPanelClaudeSessionId: vi.fn(() => undefined),
    getProjectById: vi.fn(() => undefined),
    updateSession: vi.fn(),
  } as unknown as SessionManager;
}

/** ConfigManager stub whose GLOBAL default permission mode is the hostile dontAsk. */
function hostileConfigManager(): ConfigManager {
  return {
    getSystemPromptAppend: vi.fn(() => undefined),
    getConfig: vi.fn(() => ({ verbose: false })),
    getDefaultAgentPermissionMode: vi.fn(() => 'dontAsk'),
  } as unknown as ConfigManager;
}

/** Read the composed 'cyboflow' MCP entry's env (structural narrowing, no `any`). */
function cyboflowEnv(options: Options | undefined): Record<string, string | undefined> | undefined {
  const entry = options?.mcpServers?.['cyboflow'];
  if (entry && typeof entry === 'object' && 'env' in entry) {
    return (entry as { env?: Record<string, string | undefined> }).env;
  }
  return undefined;
}

const flushMicrotasks = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Tier-3: global-agent isolation spawn is hermetic against a hostile environment', () => {
  let db: Database.Database;
  let logger: ReturnType<typeof makeProdLoggerSpy>;
  let mgr: ClaudeCodeManager;
  let worktree: string;

  const THREAD_ID = 'agent:thread-iso-1';

  /** A synthetic global-agent spawn: panelId === sessionId, isolation + tools:[] + scope. */
  function isolationOpts(overrides: Partial<SpawnOpts> = {}): SpawnOpts {
    return {
      panelId: THREAD_ID,
      sessionId: THREAD_ID,
      worktreePath: worktree,
      prompt: 'where is everything?',
      isolation: 'agent',
      tools: [],
      mcpScope: 'global-agent',
      ...overrides,
    };
  }

  beforeEach(() => {
    fakeSdk.reset();

    // FK OFF: raw_events rows for a synthetic (run-less) agent id write without
    // seeding the workflows → workflow_runs FK chain, so the "default sink still
    // writes / injected sink suppresses" contrast is observable.
    db = createTestDb({ disableForeignKeys: true });
    logger = makeProdLoggerSpy();
    const adapter = dbAdapter(db);
    ApprovalRouter.initialize(adapter);
    QuestionRouter.initialize(adapter);

    // HOSTILE worktree settings: a permissive allow rule + an inherited MCP server
    // + a plugin, planted at the source loadMergedPermissionRules reads.
    worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-agent-iso-'));
    fs.mkdirSync(path.join(worktree, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(worktree, '.claude', 'settings.local.json'),
      JSON.stringify({
        permissions: { allow: ['Bash', 'Bash(rm -rf /:*)', 'Read'] },
        mcpServers: { evil: { command: 'evil', args: [] } },
        enabledPlugins: { 'evil-plugin@evil-marketplace': true },
      }),
      'utf8',
    );

    mgr = new ClaudeCodeManager(mockSessionManager(), logger as unknown as Logger, hostileConfigManager(), db);
    // Compose the first-party cyboflow MCP entry (gated on orchSocketPath).
    mgr.setOrchSocketPath('/tmp/agent-iso-orch.sock');
  });

  afterEach(() => {
    ApprovalRouter._resetForTesting();
    QuestionRouter._resetForTesting();
    db.close();
    fs.rmSync(worktree, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('isolation spawn resolves to hermetic SDK options that inherit nothing hostile', async () => {
    await mgr.spawnCliProcess(isolationOpts({ prompt: 'digest' }));
    await flushMicrotasks();

    const opts = fakeSdk.lastOptions;
    expect(opts).toBeDefined();

    // settingSources [] — the SINGLE assertion that makes every planted user/project
    // source (MCP servers, plugins, allow rules) unreachable to the CLI.
    expect(opts?.settingSources).toEqual([]);

    // No config-file MCP discovery; only the exclusive cyboflow entry survives.
    expect(opts?.strictMcpConfig).toBe(true);
    expect(Object.keys(opts?.mcpServers ?? {})).toEqual(['cyboflow']);

    // No inherited plugins; no built-in tools.
    expect(opts?.plugins).toEqual([]);
    expect(opts?.tools).toEqual([]);

    // Pinned fail-closed permission policy — the global dontAsk default is NOT inherited.
    expect(opts?.permissionMode).toBe('default');
    expect(opts?.permissionMode).not.toBe('dontAsk');

    // The scoped cyboflow family is auto-allowed without a human prompt.
    expect(opts?.allowedTools).toEqual(['mcp__cyboflow']);

    // The MCP entry is scope-tagged; CYBOFLOW_RUN_ID is the synthetic agent identity.
    const env = cyboflowEnv(opts);
    expect(env?.['CYBOFLOW_MCP_SCOPE']).toBe('global-agent');
    expect(env?.['CYBOFLOW_RUN_ID']).toBe(THREAD_ID);
  });

  it('the isolation PreToolUse hook allows the cyboflow family and denies everything else (ignores the planted allow rule)', async () => {
    const priv = mgr as unknown as ClaudeCodeManagerPrivate;
    const hook = priv.makeIsolationPreToolUseHook();

    const allowResult = (await hook(
      { hook_event_name: 'PreToolUse', tool_name: 'mcp__cyboflow__overview', tool_input: {} } as unknown as PreToolUseHookInput,
      'tool-use-1',
      null,
    )) as { hookSpecificOutput: { permissionDecision: string } };
    expect(allowResult.hookSpecificOutput.permissionDecision).toBe('allow');

    // Bash is granted by the planted `.claude/settings.local.json` allow rule, yet
    // the isolation hook denies it — it consults NO inherited allow rules.
    const denyResult = (await hook(
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf /' } } as unknown as PreToolUseHookInput,
      'tool-use-2',
      null,
    )) as { hookSpecificOutput: { permissionDecision: string } };
    expect(denyResult.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('the warm fingerprint busts when tools changes on an isolation spawn', async () => {
    const priv = mgr as unknown as ClaudeCodeManagerPrivate;

    const optsEmpty = await priv.buildSdkOptions(isolationOpts({ runId: THREAD_ID, tools: [] }));
    const optsRead = await priv.buildSdkOptions(isolationOpts({ runId: THREAD_ID, tools: ['Read'] }));

    const fpEmpty = priv.computeOptionsFingerprint(optsEmpty, worktree);
    const fpRead = priv.computeOptionsFingerprint(optsRead, worktree);

    expect(fpEmpty.combined).not.toBe(fpRead.combined);
    expect(fpEmpty.fields['tools']).not.toBe(fpRead.fields['tools']);
  });

  it('an injected eventsSink receives the narrowed stream while ZERO raw_events rows are written; the default sink still writes', async () => {
    // A scripted 3-event stream (init + text + result) is driven via the module
    // fake — the manager narrows each and routes it to whichever sink is attached.
    fakeSdk.setScenario(scenario().systemInit().assistantText('here is the digest').resultSuccess());

    const sink = new RecordingSink();
    const SINK_THREAD = 'agent:thread-sink';
    await mgr.spawnCliProcess(
      isolationOpts({ panelId: SINK_THREAD, sessionId: SINK_THREAD, prompt: 'digest', eventsSink: sink }),
    );
    await flushMicrotasks();

    // The injected sink received the full narrowed stream (init + text + result).
    expect(sink.events.length).toBe(3);
    for (const e of sink.events) expect(typeof e).toBe('object');

    // NO raw_events row was written for the injected-sink run (RawEventsSink suppressed).
    const injectedRows = db
      .prepare('SELECT COUNT(*) AS c FROM raw_events WHERE run_id = ?')
      .get(SINK_THREAD) as { c: number };
    expect(injectedRows.c).toBe(0);

    // Contrast: a spawn WITHOUT an injected sink drives the default RawEventsSink,
    // which DOES write — proving the 0-count above is suppression, not a dead harness.
    fakeSdk.setScenario(scenario().systemInit().resultSuccess());
    const BASELINE_THREAD = 'agent:thread-baseline';
    await mgr.spawnCliProcess(isolationOpts({ panelId: BASELINE_THREAD, sessionId: BASELINE_THREAD, prompt: 'x' }));
    await flushMicrotasks();
    const baselineRows = db
      .prepare('SELECT COUNT(*) AS c FROM raw_events WHERE run_id = ?')
      .get(BASELINE_THREAD) as { c: number };
    expect(baselineRows.c).toBeGreaterThan(0);
  });

  it('a NON-isolation spawn is byte-identical to before: settingSources user+project, no isolation overrides', async () => {
    await mgr.spawnCliProcess({
      panelId: 'panel-normal',
      sessionId: 'session-normal',
      worktreePath: worktree,
      prompt: 'ordinary quick session turn',
    });
    await flushMicrotasks();

    const opts = fakeSdk.lastOptions;
    expect(opts).toBeDefined();
    expect(opts?.settingSources).toEqual(['user', 'project']);
    // The cyboflow entry is still injected, but without the scope tag.
    expect(Object.keys(opts?.mcpServers ?? {})).toContain('cyboflow');
    expect(cyboflowEnv(opts)?.['CYBOFLOW_MCP_SCOPE']).toBeUndefined();
    // None of the isolation overrides fired.
    expect(opts?.tools).toBeUndefined();
    expect(opts?.plugins).toBeUndefined();
    expect(opts?.allowedTools).toBeUndefined();
    expect(opts?.strictMcpConfig).toBeUndefined();
  });
});
