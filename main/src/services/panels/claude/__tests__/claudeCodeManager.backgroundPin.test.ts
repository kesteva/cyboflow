/**
 * Fix B — the depth-aware `run_in_background` pin for Agent-tool dispatches.
 *
 * SDK ≥0.3.201 defaults Agent dispatches to the BACKGROUND. Whether that default
 * is right depends on who dispatches (user decision, 2026-07-14):
 *   - the flow ORCHESTRATOR's own dispatches stay background (pin TRUE) so the
 *     orchestrator remains steerable during parallel stages — fix A's hold-open
 *     keeps the logical turn from false-completing;
 *   - dispatches from WITHIN a subagent (hook agent_id present) pin FALSE — a
 *     stage agent has no interactive surface;
 *   - fan-out LANES pin FALSE — a lane's turn boundary is its completion signal
 *     and fix A never holds lanes open;
 *   - quick CHAT is untouched (SDK default background).
 *
 * Empirical ground truth (probes against the SDK-vendored CLI 2.1.201, the exact
 * binary the app spawns): the dispatch presents as tool_name 'Agent' (not
 * 'Task'); PreToolUse updatedInput IS applied on allow outputs AND on
 * decision-less (auto-defer) outputs, where the verdict still falls through to
 * the native classifier; the CLI REPLACES tool input with updatedInput
 * (anthropics/claude-code#30770), so the merge must spread the full base input.
 *
 * This suite pins:
 *   (1) isAgentDispatchToolName / resolveAgentDispatchBackgroundPin pure matrices;
 *   (2) applyAgentDispatchBackgroundPin merge semantics per output shape;
 *   (3) the installed dynamic hook end-to-end per spawn kind and mode (dontAsk
 *       allow, auto-defer no-decision, router allow), via publicBuildSdkOptions;
 *   (4) the canUseTool mirror (the classifier-'ask' sink) pins its allow echoes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ApprovalRouter } from '../../../../orchestrator/approvalRouter';
import { QuestionRouter } from '../../../../orchestrator/questionRouter';
import { SprintLaneStore } from '../../../../orchestrator/sprintLaneStore';
import { dbAdapter } from '../../../../orchestrator/__test_fixtures__/dbAdapter';
import { createTestDb } from '../../../../orchestrator/__test_fixtures__/orchestratorTestDb';
import { makeProdLoggerSpy } from '../../../../orchestrator/__test_fixtures__/loggerLikeSpy';
import {
  ClaudeCodeManager,
  resolveAgentDispatchBackgroundPin,
  applyAgentDispatchBackgroundPin,
} from '../claudeCodeManager';
import { isAgentDispatchToolName } from '../../../../../../shared/types/agentIdentity';
import type { SessionManager } from '../../../sessionManager';
import type { Logger } from '../../../../utils/logger';
import type {
  Options,
  HookCallback,
  HookCallbackMatcher,
  HookJSONOutput,
  PreToolUseHookSpecificOutput,
} from '@anthropic-ai/claude-agent-sdk';

type LoggerSpy = ReturnType<typeof makeProdLoggerSpy>;

// ---------------------------------------------------------------------------
// Mocks — mirror claudeCodeManager.permissionMode.test.ts's unit boundary.
// ---------------------------------------------------------------------------

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(async function* () {
    yield { type: 'result', subtype: 'success' } as unknown;
  }),
}));
vi.mock('../../../../orchestrator/mcpServer/scriptPath', () => ({
  resolveMcpServerScriptPath: vi.fn(() => '/mock/mcp-server.js'),
}));
vi.mock('../../../../utils/nodeFinder', () => ({
  findNodeExecutable: vi.fn(async () => 'node'),
}));
vi.mock('../../../../utils/sessionValidation', () => ({
  validatePanelSessionOwnership: vi.fn(() => ({ valid: true })),
  logValidationFailure: vi.fn(),
}));
vi.mock('../../../../orchestrator/permissionRules', async (orig) => {
  const actual = await orig<typeof import('../../../../orchestrator/permissionRules')>();
  return {
    ...actual,
    loadMergedPermissionRules: vi.fn(() => ({ allow: [], deny: [] })),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockSessionManager(): SessionManager {
  return {
    getDbSession: vi.fn(() => ({ id: 'stub-session' })),
    getPanelClaudeSessionId: vi.fn(() => undefined),
    getProjectById: vi.fn(() => undefined),
    updateSession: vi.fn(),
  } as unknown as SessionManager;
}

function makeConfigManager(): import('../../../configManager').ConfigManager {
  return {
    getSystemPromptAppend: vi.fn(() => undefined),
    getConfig: vi.fn(() => ({ verbose: false })),
    getDefaultAgentPermissionMode: vi.fn(() => 'default'),
  } as unknown as import('../../../configManager').ConfigManager;
}

class TestableClaudeCodeManager extends ClaudeCodeManager {
  public installedPluginIdsStub: string[] = [];
  protected override getInstalledPluginIds(): string[] {
    return this.installedPluginIdsStub;
  }

  publicBuildSdkOptions(options: {
    panelId: string;
    sessionId: string;
    worktreePath: string;
    prompt: string;
    model?: string;
    runId?: string;
    spawnKey?: string;
  }): Promise<Options> {
    return (
      this as unknown as { buildSdkOptions(o: unknown): Promise<Options> }
    ).buildSdkOptions(options);
  }
}

function extractPreToolUseHook(opts: Options): HookCallback {
  const matchers = opts.hooks?.PreToolUse as HookCallbackMatcher[] | undefined;
  const hook = matchers?.[0]?.hooks?.[0];
  if (!hook) throw new Error('no PreToolUse hook installed');
  return hook;
}

const basePreTool = {
  hook_event_name: 'PreToolUse' as const,
  session_id: 'sess',
  transcript_path: '/tmp/t.jsonl',
  cwd: '/tmp',
};

/** The model-emitted Agent dispatch input the merge must preserve in full. */
const DISPATCH_INPUT = {
  description: 'probe child',
  prompt: 'do the thing',
  subagent_type: 'general-purpose',
  run_in_background: false,
};

function buildModeDb(): Database.Database {
  const db = createTestDb({ includeSubstrate: true });
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_permission_mode TEXT)');
  return db;
}

function seedRunSession(
  db: Database.Database,
  gateRunId: string,
  sessionUuid: string,
  mode: string,
): void {
  db.prepare(
    "INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf', 1, 'wf', '{}')",
  ).run();
  db.prepare(
    "INSERT INTO workflow_runs (id, workflow_id, project_id, status, session_id) VALUES (?, 'wf', 1, 'running', ?)",
  ).run(gateRunId, sessionUuid);
  db.prepare('INSERT INTO sessions (id, agent_permission_mode) VALUES (?, ?)').run(sessionUuid, mode);
}

function updatedInputOf(out: HookJSONOutput): Record<string, unknown> | undefined {
  return (out as { hookSpecificOutput?: PreToolUseHookSpecificOutput }).hookSpecificOutput
    ?.updatedInput;
}

function decisionOf(out: HookJSONOutput): string | undefined {
  return (out as { hookSpecificOutput?: PreToolUseHookSpecificOutput }).hookSpecificOutput
    ?.permissionDecision;
}

// ---------------------------------------------------------------------------
// (1) Pure matrices
// ---------------------------------------------------------------------------

describe('isAgentDispatchToolName', () => {
  it.each([
    ['Agent', true], // CLI ≥~2.1.2xx (verified on the vendored 2.1.201)
    ['Task', true], // older CLIs
    ['Bash', false],
    ['AgentOutput', false],
  ] as const)('%s → %s', (name, expected) => {
    expect(isAgentDispatchToolName(name)).toBe(expected);
  });
});

describe('resolveAgentDispatchBackgroundPin', () => {
  it.each([
    // [label, toolName, spawnKind, hookAgentId, expected]
    ['flow orchestrator dispatch → background', 'Agent', 'flow', undefined, true],
    ["legacy 'Task' name matches too", 'Task', 'flow', undefined, true],
    ['nested dispatch (from within a subagent) → sync', 'Agent', 'flow', 'sub-1', false],
    ['lane dispatch → sync', 'Agent', 'lane', undefined, false],
    ['lane nested dispatch → sync', 'Agent', 'lane', 'sub-1', false],
    ['chat → no pin', 'Agent', 'chat', undefined, undefined],
    ['chat nested → no pin', 'Agent', 'chat', 'sub-1', undefined],
    ['non-dispatch tool → no pin', 'Bash', 'flow', undefined, undefined],
  ] as const)('%s', (_label, toolName, spawnKind, hookAgentId, expected) => {
    expect(
      resolveAgentDispatchBackgroundPin({ toolName, spawnKind, hookAgentId }),
    ).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// (2) applyAgentDispatchBackgroundPin merge semantics
// ---------------------------------------------------------------------------

describe('applyAgentDispatchBackgroundPin', () => {
  const allowOutput: HookJSONOutput = {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
  };

  it('pin undefined → identity (the exact same output object)', () => {
    expect(applyAgentDispatchBackgroundPin(allowOutput, DISPATCH_INPUT, undefined)).toBe(
      allowOutput,
    );
  });

  it('allow output with no updatedInput seeds from the FULL original input (#30770 replace-not-merge defense)', () => {
    const out = applyAgentDispatchBackgroundPin(allowOutput, DISPATCH_INPUT, true);
    expect(updatedInputOf(out)).toEqual({ ...DISPATCH_INPUT, run_in_background: true });
    expect(decisionOf(out)).toBe('allow');
  });

  it("allow output with a reviewer's updatedInput preserves the rewrite; the pin overrides only run_in_background", () => {
    const reviewed: HookJSONOutput = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { ...DISPATCH_INPUT, prompt: 'reviewer rewrote this', run_in_background: true },
      },
    };
    const out = applyAgentDispatchBackgroundPin(reviewed, DISPATCH_INPUT, false);
    expect(updatedInputOf(out)).toEqual({
      ...DISPATCH_INPUT,
      prompt: 'reviewer rewrote this',
      run_in_background: false,
    });
  });

  it('decision-less (auto-defer) output gains updatedInput WITHOUT gaining a permissionDecision', () => {
    const defer: HookJSONOutput = { hookSpecificOutput: { hookEventName: 'PreToolUse' } };
    const out = applyAgentDispatchBackgroundPin(defer, DISPATCH_INPUT, true);
    expect(updatedInputOf(out)).toEqual({ ...DISPATCH_INPUT, run_in_background: true });
    expect(decisionOf(out)).toBeUndefined();
  });

  it('bare output (no hookSpecificOutput at all) gains a PreToolUse updatedInput', () => {
    const out = applyAgentDispatchBackgroundPin({}, DISPATCH_INPUT, false);
    expect(updatedInputOf(out)).toEqual({ ...DISPATCH_INPUT, run_in_background: false });
    expect(decisionOf(out)).toBeUndefined();
  });

  it.each([['deny'], ['ask']] as const)('%s output passes through untouched', (decision) => {
    const output: HookJSONOutput = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: 'nope',
      },
    };
    expect(applyAgentDispatchBackgroundPin(output, DISPATCH_INPUT, true)).toBe(output);
  });

  it('async hook output passes through untouched', () => {
    const output = { async: true, asyncTimeout: 5 } as HookJSONOutput;
    expect(applyAgentDispatchBackgroundPin(output, DISPATCH_INPUT, true)).toBe(output);
  });

  it('preserves sibling output fields (systemMessage) on the merged output', () => {
    const output: HookJSONOutput = {
      systemMessage: 'fyi',
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
    };
    const out = applyAgentDispatchBackgroundPin(output, DISPATCH_INPUT, true);
    expect((out as { systemMessage?: string }).systemMessage).toBe('fyi');
    expect(updatedInputOf(out)).toEqual({ ...DISPATCH_INPUT, run_in_background: true });
  });
});

// ---------------------------------------------------------------------------
// (3) The installed dynamic hook, per spawn kind and mode
// ---------------------------------------------------------------------------

describe('dynamic PreToolUse hook — background pin per spawn kind', () => {
  let db: Database.Database;
  let logger: LoggerSpy;
  let mgr: TestableClaudeCodeManager;
  let requestApproval: ReturnType<typeof vi.fn>;
  let approvalSpy: ReturnType<typeof vi.spyOn>;
  let laneSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    db = buildModeDb();
    logger = makeProdLoggerSpy();
    const adapter = dbAdapter(db);
    ApprovalRouter.initialize(adapter);
    QuestionRouter.initialize(adapter);
    mgr = new TestableClaudeCodeManager(
      createMockSessionManager(),
      logger as unknown as Logger,
      makeConfigManager(),
      db,
    );
    requestApproval = vi.fn().mockResolvedValue({ behavior: 'allow' as const });
    approvalSpy = vi
      .spyOn(ApprovalRouter, 'getInstance')
      .mockReturnValue({ requestApproval } as unknown as ApprovalRouter);
    laneSpy = vi
      .spyOn(SprintLaneStore, 'getInstance')
      .mockReturnValue({ deriveLaneFromTaskDispatch: vi.fn() } as unknown as SprintLaneStore);
  });

  afterEach(() => {
    approvalSpy.mockRestore();
    laneSpy.mockRestore();
    ApprovalRouter._resetForTesting();
    QuestionRouter._resetForTesting();
    db.close();
    vi.clearAllMocks();
  });

  async function installedHook(o: {
    runId: string;
    panelId: string;
    sessionId: string;
    spawnKey?: string;
    model?: string;
  }): Promise<HookCallback> {
    const opts = await mgr.publicBuildSdkOptions({
      panelId: o.panelId,
      sessionId: o.sessionId,
      worktreePath: '/tmp/w',
      prompt: 'go',
      runId: o.runId,
      model: o.model,
      spawnKey: o.spawnKey,
    });
    return extractPreToolUseHook(opts);
  }

  function fire(
    hook: HookCallback,
    toolName: string,
    toolInput: Record<string, unknown>,
    agentId?: string,
  ): Promise<HookJSONOutput> {
    return hook(
      {
        ...basePreTool,
        tool_name: toolName,
        tool_use_id: 'tu-1',
        tool_input: toolInput,
        ...(agentId !== undefined ? { agent_id: agentId } : {}),
      },
      'tu-1',
      undefined as never,
    ) as Promise<HookJSONOutput>;
  }

  it("FLOW orchestrator dispatch (dontAsk): 'Agent' pinned to background, full input preserved", async () => {
    seedRunSession(db, 'run-f', 'sess-f', 'dontAsk');
    const hook = await installedHook({ runId: 'run-f', panelId: 'run-f', sessionId: 'run-f' });
    const out = await fire(hook, 'Agent', DISPATCH_INPUT);
    expect(decisionOf(out)).toBe('allow');
    expect(updatedInputOf(out)).toEqual({ ...DISPATCH_INPUT, run_in_background: true });
  });

  it('FLOW nested dispatch (hook agent_id present): pinned to sync', async () => {
    seedRunSession(db, 'run-n', 'sess-n', 'dontAsk');
    const hook = await installedHook({ runId: 'run-n', panelId: 'run-n', sessionId: 'run-n' });
    const out = await fire(hook, 'Agent', { ...DISPATCH_INPUT, run_in_background: true }, 'sub-1');
    expect(updatedInputOf(out)).toEqual({ ...DISPATCH_INPUT, run_in_background: false });
  });

  it('FLOW auto-defer (classifier-capable model): pin rides a DECISION-LESS output — the classifier is not pre-empted', async () => {
    seedRunSession(db, 'run-a', 'sess-a', 'auto');
    const hook = await installedHook({
      runId: 'run-a',
      panelId: 'run-a',
      sessionId: 'run-a',
      model: 'sonnet',
    });
    const out = await fire(hook, 'Agent', DISPATCH_INPUT);
    expect(decisionOf(out)).toBeUndefined();
    expect(updatedInputOf(out)).toEqual({ ...DISPATCH_INPUT, run_in_background: true });
  });

  it('FLOW auto-defer: a NON-dispatch tool keeps the pristine empty defer output', async () => {
    seedRunSession(db, 'run-a2', 'sess-a2', 'auto');
    const hook = await installedHook({
      runId: 'run-a2',
      panelId: 'run-a2',
      sessionId: 'run-a2',
      model: 'sonnet',
    });
    const out = await fire(hook, 'Bash', { command: 'ls' });
    expect(decisionOf(out)).toBeUndefined();
    expect(updatedInputOf(out)).toBeUndefined();
  });

  it("FLOW router path (default mode → ApprovalRouter allow): the pin merges onto the router's allow", async () => {
    seedRunSession(db, 'run-r', 'sess-r', 'default');
    const hook = await installedHook({ runId: 'run-r', panelId: 'run-r', sessionId: 'run-r' });
    const out = await fire(hook, 'Agent', DISPATCH_INPUT);
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(decisionOf(out)).toBe('allow');
    expect(updatedInputOf(out)).toEqual({ ...DISPATCH_INPUT, run_in_background: true });
  });

  it('LANE spawn (composite spawnKey): dispatch pinned to sync', async () => {
    seedRunSession(db, 'run-l', 'sess-l', 'dontAsk');
    const hook = await installedHook({
      runId: 'run-l',
      panelId: 'run-l',
      sessionId: 'run-l',
      spawnKey: 'run-l:item-1',
    });
    const out = await fire(hook, 'Agent', { ...DISPATCH_INPUT, run_in_background: true });
    expect(updatedInputOf(out)).toEqual({ ...DISPATCH_INPUT, run_in_background: false });
  });

  it('CHAT turn (gate run ≠ panel): NO pin — the allow output carries no updatedInput', async () => {
    seedRunSession(db, 'chat-sentinel', 'sess-c', 'dontAsk');
    const hook = await installedHook({
      runId: 'chat-sentinel',
      panelId: 'panel-chat',
      sessionId: 'sess-chat',
    });
    const out = await fire(hook, 'Agent', DISPATCH_INPUT);
    expect(decisionOf(out)).toBe('allow');
    expect(updatedInputOf(out)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (4) canUseTool mirror — the classifier-'ask' sink pins its allow echoes
// ---------------------------------------------------------------------------

describe('canUseTool — background pin on the allow echoes', () => {
  let db: Database.Database;
  let mgr: TestableClaudeCodeManager;
  let requestApproval: ReturnType<typeof vi.fn>;
  let approvalSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    db = buildModeDb();
    const adapter = dbAdapter(db);
    ApprovalRouter.initialize(adapter);
    QuestionRouter.initialize(adapter);
    mgr = new TestableClaudeCodeManager(
      createMockSessionManager(),
      makeProdLoggerSpy() as unknown as Logger,
      makeConfigManager(),
      db,
    );
    requestApproval = vi.fn().mockResolvedValue({ behavior: 'allow' as const });
    approvalSpy = vi
      .spyOn(ApprovalRouter, 'getInstance')
      .mockReturnValue({ requestApproval } as unknown as ApprovalRouter);
  });

  afterEach(() => {
    approvalSpy.mockRestore();
    ApprovalRouter._resetForTesting();
    QuestionRouter._resetForTesting();
    db.close();
    vi.clearAllMocks();
  });

  async function invokeCanUseTool(o: {
    runId: string;
    panelId: string;
    toolName: string;
    input: Record<string, unknown>;
    agentID?: string;
  }): Promise<{ behavior: string; updatedInput?: Record<string, unknown> }> {
    const opts = await mgr.publicBuildSdkOptions({
      panelId: o.panelId,
      sessionId: o.panelId,
      worktreePath: '/tmp/w',
      prompt: 'go',
      runId: o.runId,
    });
    const fn = opts.canUseTool;
    if (!fn) throw new Error('canUseTool not installed');
    const res = await fn(o.toolName, o.input, {
      signal: new AbortController().signal,
      toolUseID: 'tu-cut',
      requestId: 'rq-cut',
      ...(o.agentID !== undefined ? { agentID: o.agentID } : {}),
    });
    if (res === null) throw new Error('canUseTool returned null');
    return res as { behavior: string; updatedInput?: Record<string, unknown> };
  }

  it('FLOW orchestrator Agent dispatch allowed by the reviewer → echo pinned to background', async () => {
    seedRunSession(db, 'run-cf', 'sess-cf', 'auto');
    const res = await invokeCanUseTool({
      runId: 'run-cf',
      panelId: 'run-cf',
      toolName: 'Agent',
      input: DISPATCH_INPUT,
    });
    expect(res.behavior).toBe('allow');
    expect(res.updatedInput).toEqual({ ...DISPATCH_INPUT, run_in_background: true });
  });

  it('nested dispatch (opts.agentID present) → echo pinned to sync', async () => {
    seedRunSession(db, 'run-cn', 'sess-cn', 'auto');
    const res = await invokeCanUseTool({
      runId: 'run-cn',
      panelId: 'run-cn',
      toolName: 'Agent',
      input: { ...DISPATCH_INPUT, run_in_background: true },
      agentID: 'sub-2',
    });
    expect(res.updatedInput).toEqual({ ...DISPATCH_INPUT, run_in_background: false });
  });

  it('CHAT spawn → the allow echo is the input UNCHANGED', async () => {
    seedRunSession(db, 'chat-run', 'sess-cc', 'auto');
    const res = await invokeCanUseTool({
      runId: 'chat-run',
      panelId: 'panel-cc',
      toolName: 'Agent',
      input: DISPATCH_INPUT,
    });
    expect(res.behavior).toBe('allow');
    expect(res.updatedInput).toEqual(DISPATCH_INPUT);
  });

  it('non-dispatch tool on a flow spawn → echo unchanged', async () => {
    seedRunSession(db, 'run-cb', 'sess-cb', 'auto');
    const res = await invokeCanUseTool({
      runId: 'run-cb',
      panelId: 'run-cb',
      toolName: 'Bash',
      input: { command: 'ls' },
    });
    expect(res.updatedInput).toEqual({ command: 'ls' });
  });
});
