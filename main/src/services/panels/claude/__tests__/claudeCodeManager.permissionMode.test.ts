/**
 * Unit tests for the 4-mode agent-permission wiring in ClaudeCodeManager.
 *
 * Permission-mode redesign Slice 6 (SDK dynamic PreToolUse hook): buildSdkOptions
 * now ALWAYS installs exactly ONE dynamic PreToolUse hook that LIVE-READS the
 * owning session's `agent_permission_mode` on EVERY tool call (resolved once at
 * spawn from the gate runId via the workflow_runs→sessions join), and pins native
 * `permissionMode:'auto'` WHENEVER the model supports the classifier.
 *
 * Coverage:
 *   modelSupportsAutoMode pure-helper eligibility table.
 *   buildSdkOptions — always one hook installed; native-auto pin per supported model.
 *   makeDynamicPreToolUseHook (live per-call mode):
 *      - re-reads the mode per call (default→acceptEdits flips edit auto-allow next call);
 *      - dontAsk → allow (no router); default/acceptEdits → allowlist → ApprovalRouter;
 *      - auto (supported) → empty defer output; auto (UNSUPPORTED) → ApprovalRouter;
 *      - the user/project allowlist is honored;
 *      - FLOW run (sessionId===runId) reads the HOST session via the join, not the
 *        global default (the §1 root-fix regression guard);
 *      - deriveLaneFromTaskDispatch fires (observe-only) even on the auto-defer path;
 *      - AskUserQuestion routes through QuestionRouter in ALL modes (incl. dontAsk).
 *   spawnClaudeCode quick/legacy session permission seeding (resolveSessionAgentPermissionMode).
 *   G) maybeFoldAutoDenyVisibility folds a NON-BLOCKING permission review item
 *      when a system/permission_denied SDK message arrives for a workflow run.
 *
 * Design: the SDK is mocked (no real query). A Testable subclass exposes the
 * private buildSdkOptions so we can inspect the composed Options + invoke the
 * installed hook callback directly without a full spawn; the run→session join is
 * seeded into the test DB so the hook's live mode read resolves.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApprovalRouter } from '../../../../orchestrator/approvalRouter';
import { QuestionRouter } from '../../../../orchestrator/questionRouter';
import { ReviewItemRouter } from '../../../../orchestrator/reviewItemRouter';
import { SprintLaneStore } from '../../../../orchestrator/sprintLaneStore';
import { loadMergedPermissionRules } from '../../../../orchestrator/permissionRules';
import { dbAdapter } from '../../../../orchestrator/__test_fixtures__/dbAdapter';
import { createTestDb } from '../../../../orchestrator/__test_fixtures__/orchestratorTestDb';
import { makeProdLoggerSpy } from '../../../../orchestrator/__test_fixtures__/loggerLikeSpy';
import { ClaudeCodeManager, modelSupportsAutoMode } from '../claudeCodeManager';
import type { SessionManager } from '../../../sessionManager';
import type { Logger } from '../../../../utils/logger';
import type { Options, HookCallback, HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';

type LoggerSpy = ReturnType<typeof makeProdLoggerSpy>;

// ---------------------------------------------------------------------------
// Mocks — keep the SDK / FS / node-finder out of the unit boundary.
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
vi.mock('../../../../utils/promptEnhancer', () => ({
  enhancePromptForStructuredCommit: vi.fn((prompt: string) => prompt),
}));
vi.mock('../../../../utils/sessionValidation', () => ({
  validatePanelSessionOwnership: vi.fn(() => ({ valid: true })),
  logValidationFailure: vi.fn(),
}));
// permissionRules.loadMergedPermissionRules touches the FS — stub to an empty
// rule set so 'default'/'acceptEdits' hooks never fall through to a granted
// tool from the host's real settings.
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
    getDbSession: vi.fn(() => ({ id: 'stub-session' })), // no project_id
    getPanelClaudeSessionId: vi.fn(() => undefined),
    getProjectById: vi.fn(() => undefined),
    updateSession: vi.fn(),
  } as unknown as SessionManager;
}

function makeConfigManager(
  defaultAgentMode: import('../../../../../../shared/types/workflows').PermissionMode = 'default',
): import('../../../configManager').ConfigManager {
  return {
    getSystemPromptAppend: vi.fn(() => undefined),
    getConfig: vi.fn(() => ({ verbose: false })),
    getDefaultAgentPermissionMode: vi.fn(() => defaultAgentMode),
  } as unknown as import('../../../configManager').ConfigManager;
}

/** Exposes the private buildSdkOptions + makeAutoModePreToolUseHook for tests. */
class TestableClaudeCodeManager extends ClaudeCodeManager {
  /**
   * Test-controlled installed-plugin universe for the deterministic exclusive
   * enabledPlugins map. Defaults to [] (no installed plugins → the resolver
   * degrades to additive: only the selected `true` entries, nothing to disable),
   * which keeps every non-plugin test hermetic without touching ~/.claude.
   */
  public installedPluginIdsStub: string[] = [];
  protected override getInstalledPluginIds(): string[] {
    return this.installedPluginIdsStub;
  }

  publicBuildSdkOptions(options: {
    panelId: string;
    sessionId: string;
    worktreePath: string;
    prompt: string;
    agentPermissionMode?: import('../../../../../../shared/types/workflows').PermissionMode;
    permissionMode?: 'approve' | 'ignore';
    model?: string;
    runId?: string;
  }): Promise<Options> {
    return (
      this as unknown as { buildSdkOptions(o: unknown): Promise<Options> }
    ).buildSdkOptions(options);
  }
}

/**
 * Pull the single installed PreToolUse hook callback out of a composed Options,
 * or null when none is installed.
 */
function extractPreToolUseHook(opts: Options): HookCallback | null {
  const matchers = opts.hooks?.PreToolUse as HookCallbackMatcher[] | undefined;
  if (!matchers || matchers.length === 0) return null;
  const hooks = matchers[0]?.hooks;
  if (!hooks || hooks.length === 0) return null;
  return hooks[0] ?? null;
}

const basePreTool = {
  hook_event_name: 'PreToolUse' as const,
  session_id: 'sess',
  transcript_path: '/tmp/t.jsonl',
  cwd: '/tmp',
};

// ---------------------------------------------------------------------------
// modelSupportsAutoMode pure helper
// ---------------------------------------------------------------------------

describe('modelSupportsAutoMode', () => {
  it.each([
    [undefined, true],
    ['auto', true],
    ['sonnet', true],
    ['opus', true],
    ['claude-opus-4-6-20260101', true], // newer pinned → assume capable
    ['claude-3-5-sonnet', false],
    ['claude-3-7-sonnet-20250219', false],
    ['claude-opus-4-1-20250805', false],
    ['claude-sonnet-4-5-20250929', false],
    ['claude-3-5-haiku', false],
  ] as const)('model %s → supported=%s', (model, expected) => {
    expect(modelSupportsAutoMode(model as string | undefined)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Live-mode test DB: the run→session join the dynamic hook reads
// (workflow_runs.session_id [migration 019, via includeSubstrate] +
// sessions.agent_permission_mode [migration 021]).
// ---------------------------------------------------------------------------

/** Build a test DB carrying the run→session join the dynamic hook live-reads. */
function buildModeDb(): Database.Database {
  const db = createTestDb({ includeSubstrate: true });
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_permission_mode TEXT)');
  return db;
}

/**
 * Seed the gate run + its owning session at a live mode. `sessionUuid === null`
 * leaves workflow_runs.session_id NULL (the join-miss / orphan case) and inserts
 * no session row, so the hook floors to the global default.
 */
function seedRunSession(
  db: Database.Database,
  gateRunId: string,
  sessionUuid: string | null,
  mode: string | null,
): void {
  db.prepare(
    "INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf', 1, 'wf', '{}')",
  ).run();
  db.prepare(
    "INSERT INTO workflow_runs (id, workflow_id, project_id, status, session_id) VALUES (?, 'wf', 1, 'running', ?)",
  ).run(gateRunId, sessionUuid);
  if (sessionUuid !== null) {
    db.prepare('INSERT INTO sessions (id, agent_permission_mode) VALUES (?, ?)').run(sessionUuid, mode);
  }
}

// ---------------------------------------------------------------------------
// buildSdkOptions — always ONE dynamic PreToolUse hook + native-auto pin
// ---------------------------------------------------------------------------

describe('ClaudeCodeManager.buildSdkOptions — dynamic hook installation + native-auto pin', () => {
  let db: Database.Database;
  let logger: LoggerSpy;
  let mgr: TestableClaudeCodeManager;

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
  });

  afterEach(() => {
    ApprovalRouter._resetForTesting();
    QuestionRouter._resetForTesting();
    db.close();
    vi.clearAllMocks();
  });

  it('ALWAYS installs exactly ONE PreToolUse hook — even for dontAsk (formerly NO hook)', async () => {
    seedRunSession(db, 'run-da', 'sess-da', 'dontAsk');
    const opts = await mgr.publicBuildSdkOptions({
      panelId: 'run-da', sessionId: 'sess-da', worktreePath: '/tmp/w', prompt: 'go', runId: 'run-da',
    });
    const matchers = opts.hooks?.PreToolUse as HookCallbackMatcher[] | undefined;
    expect(matchers).toHaveLength(1);
    expect(matchers?.[0]?.hooks).toHaveLength(1);
    expect(extractPreToolUseHook(opts)).not.toBeNull();
  });

  it("pins permissionMode='auto' whenever the model supports auto — regardless of the session mode (here dontAsk)", async () => {
    seedRunSession(db, 'run-da2', 'sess-da2', 'dontAsk');
    const opts = await mgr.publicBuildSdkOptions({
      panelId: 'run-da2', sessionId: 'sess-da2', worktreePath: '/tmp/w', prompt: 'go', runId: 'run-da2', model: 'sonnet',
    });
    // The native pin is now decoupled from the session mode (the hook pre-empts).
    expect(opts.permissionMode).toBe('auto');
  });

  it("pins permissionMode='auto' for an undefined model (SDK default is classifier-capable)", async () => {
    seedRunSession(db, 'run-um', 'sess-um', 'default');
    const opts = await mgr.publicBuildSdkOptions({
      panelId: 'run-um', sessionId: 'sess-um', worktreePath: '/tmp/w', prompt: 'go', runId: 'run-um',
    });
    expect(opts.permissionMode).toBe('auto');
  });

  it('does NOT pin permissionMode on an auto-UNSUPPORTED model', async () => {
    seedRunSession(db, 'run-old', 'sess-old', 'auto');
    const opts = await mgr.publicBuildSdkOptions({
      panelId: 'run-old', sessionId: 'sess-old', worktreePath: '/tmp/w', prompt: 'go', runId: 'run-old', model: 'claude-3-5-sonnet',
    });
    expect(opts.permissionMode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// makeDynamicPreToolUseHook — live per-call session mode (redesign §3b/§4)
// ---------------------------------------------------------------------------

describe('ClaudeCodeManager dynamic PreToolUse hook — live per-call mode', () => {
  let db: Database.Database;
  let logger: LoggerSpy;
  let mgr: TestableClaudeCodeManager;
  let requestApproval: ReturnType<typeof vi.fn>;
  let deriveLaneFromTaskDispatch: ReturnType<typeof vi.fn>;
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
      makeConfigManager(), // global default 'default'
      db,
    );

    requestApproval = vi.fn().mockResolvedValue({ behavior: 'allow' as const });
    approvalSpy = vi
      .spyOn(ApprovalRouter, 'getInstance')
      .mockReturnValue({ requestApproval } as unknown as ApprovalRouter);

    // The SprintLaneStore singleton is uninitialized in this unit boundary
    // (getInstance() would throw, swallowed by the hook's step-0 guard). Spy it so
    // the observe-only call is deterministic and assertable.
    deriveLaneFromTaskDispatch = vi.fn();
    laneSpy = vi
      .spyOn(SprintLaneStore, 'getInstance')
      .mockReturnValue({ deriveLaneFromTaskDispatch } as unknown as SprintLaneStore);
  });

  afterEach(() => {
    // mockRestore (not restoreAllMocks) so the module-level vi.mock factory for
    // loadMergedPermissionRules is NOT reset to a no-op for later describes.
    approvalSpy.mockRestore();
    laneSpy.mockRestore();
    ApprovalRouter._resetForTesting();
    QuestionRouter._resetForTesting();
    db.close();
    vi.clearAllMocks();
  });

  /** Build + extract the installed dynamic hook for a gate run. */
  async function installedHook(o: {
    runId: string;
    sessionId?: string;
    panelId?: string;
    model?: string;
  }): Promise<HookCallback> {
    const opts = await mgr.publicBuildSdkOptions({
      panelId: o.panelId ?? 'panel',
      sessionId: o.sessionId ?? 'session',
      worktreePath: '/tmp/w',
      prompt: 'go',
      runId: o.runId,
      model: o.model,
    });
    const hook = extractPreToolUseHook(opts);
    expect(hook).not.toBeNull();
    return hook!;
  }

  function fire(hook: HookCallback, toolName: string, toolInput: Record<string, unknown>, id = 'tu'): Promise<unknown> {
    return hook(
      { ...basePreTool, tool_name: toolName, tool_use_id: id, tool_input: toolInput },
      id,
      undefined as never,
    ) as Promise<unknown>;
  }

  it('re-reads the session mode per call: default → acceptEdits flips edit auto-allow on the NEXT call', async () => {
    seedRunSession(db, 'run-flip', 'sess-flip', 'default');
    const hook = await installedHook({ runId: 'run-flip', sessionId: 'sess-flip' });

    // 1st call under 'default' → Edit is NOT auto-allowed → routes through the router.
    await fire(hook, 'Edit', { file_path: '/tmp/f' }, 't1');
    expect(requestApproval).toHaveBeenCalledTimes(1);

    // Flip the SESSION mode live — no re-spawn, same hook instance.
    db.prepare('UPDATE sessions SET agent_permission_mode = ? WHERE id = ?').run('acceptEdits', 'sess-flip');

    // 2nd call → the SAME hook now auto-allows Edit WITHOUT touching the router.
    const out = (await fire(hook, 'Edit', { file_path: '/tmp/f' }, 't2')) as {
      hookSpecificOutput: { permissionDecision: string };
    };
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(requestApproval).toHaveBeenCalledTimes(1); // unchanged — no new router call
  });

  it('dontAsk → returns allow without touching ApprovalRouter', async () => {
    seedRunSession(db, 'run-da', 'sess-da', 'dontAsk');
    const hook = await installedHook({ runId: 'run-da', sessionId: 'sess-da' });

    const out = (await fire(hook, 'Bash', { command: 'rm -rf /' })) as {
      hookSpecificOutput: { permissionDecision: string };
    };
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('default → routes every tool through ApprovalRouter (Edit is NOT auto-allowed)', async () => {
    seedRunSession(db, 'run-def', 'sess-def', 'default');
    const hook = await installedHook({ runId: 'run-def', sessionId: 'sess-def' });

    await fire(hook, 'Edit', { file_path: '/tmp/f' });
    expect(requestApproval).toHaveBeenCalledOnce();
  });

  it('acceptEdits → auto-allows edits + safe reads + read-only git, routes unsafe Bash through ApprovalRouter', async () => {
    seedRunSession(db, 'run-ae', 'sess-ae', 'acceptEdits');
    const hook = await installedHook({ runId: 'run-ae', sessionId: 'sess-ae' });

    // Edit tools fast-allow.
    for (const tool of ['Edit', 'Write', 'MultiEdit']) {
      const out = (await fire(hook, tool, { file_path: '/tmp/f' }, `tu-${tool}`)) as {
        hookSpecificOutput: { permissionDecision: string };
      };
      expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
    }
    // Widened read-only surface: a read-only tool and a read-only git command
    // fast-allow too (no router round-trip).
    const readOut = (await fire(hook, 'Read', { file_path: '/tmp/f' }, 'tu-read')) as {
      hookSpecificOutput: { permissionDecision: string };
    };
    expect(readOut.hookSpecificOutput.permissionDecision).toBe('allow');
    const gitOut = (await fire(hook, 'Bash', { command: 'git status -s' }, 'tu-git')) as {
      hookSpecificOutput: { permissionDecision: string };
    };
    expect(gitOut.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(requestApproval).not.toHaveBeenCalled();

    // A mutating Bash still routes to the human gate.
    await fire(hook, 'Bash', { command: 'rm -rf /' }, 'tu-bash');
    expect(requestApproval).toHaveBeenCalledOnce();
  });

  it('honors the user/project allowlist (auto-allow without the router) in default mode', async () => {
    // composeHookOptions loads the rules ONCE at spawn; mockReturnValueOnce applies
    // to exactly that call, then reverts to the empty-rules factory default.
    vi.mocked(loadMergedPermissionRules).mockReturnValueOnce({ allow: ['Bash(git status:*)'], deny: [] });
    seedRunSession(db, 'run-al', 'sess-al', 'default');
    const hook = await installedHook({ runId: 'run-al', sessionId: 'sess-al' });

    const out = (await fire(hook, 'Bash', { command: 'git status -s' })) as {
      hookSpecificOutput: { permissionDecision: string };
    };
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('FLOW run (sessionId === runId) reads the HOST session via the run→session join, NOT the global default (§1 regression guard)', async () => {
    // The gate run id EQUALS the panel/session id (the flow invariant). The owning
    // session is a DISTINCT uuid resolved via workflow_runs.session_id. A naive
    // `WHERE sessions.id = runId` lookup would miss → global default ('default') →
    // Edit would route through the router. Reading the HOST session ('acceptEdits')
    // proves the join is used.
    const flowRunId = 'flow-run';
    seedRunSession(db, flowRunId, 'host-sess', 'acceptEdits');
    const hook = await installedHook({ runId: flowRunId, sessionId: flowRunId, panelId: flowRunId });

    const out = (await fire(hook, 'Edit', { file_path: '/tmp/f' })) as {
      hookSpecificOutput: { permissionDecision: string };
    };
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow'); // acceptEdits fast-allow
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('auto on an auto-UNSUPPORTED model routes through ApprovalRouter (no classifier to defer to)', async () => {
    seedRunSession(db, 'run-auto-old', 'sess-auto-old', 'auto');
    const opts = await mgr.publicBuildSdkOptions({
      panelId: 'panel', sessionId: 'sess-auto-old', worktreePath: '/tmp/w', prompt: 'go',
      runId: 'run-auto-old', model: 'claude-3-5-sonnet',
    });
    expect(opts.permissionMode).toBeUndefined(); // not pinned on an unsupported model
    const hook = extractPreToolUseHook(opts);
    expect(hook).not.toBeNull();

    await fire(hook!, 'Bash', { command: 'ls' });
    expect(requestApproval).toHaveBeenCalledOnce();
  });

  it('auto on a SUPPORTED model defers to the native classifier (EMPTY PreToolUse output, no router)', async () => {
    seedRunSession(db, 'run-auto', 'sess-auto', 'auto');
    const opts = await mgr.publicBuildSdkOptions({
      panelId: 'panel', sessionId: 'sess-auto', worktreePath: '/tmp/w', prompt: 'go',
      runId: 'run-auto', model: 'sonnet',
    });
    expect(opts.permissionMode).toBe('auto');
    const hook = extractPreToolUseHook(opts);
    expect(hook).not.toBeNull();

    const out = (await fire(hook!, 'Bash', { command: 'ls' })) as {
      hookSpecificOutput: { hookEventName: string; permissionDecision?: string };
    };
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('derives the sprint lane (observe-only) on a Task dispatch even in auto-defer (step 0 runs before the mode branch)', async () => {
    seedRunSession(db, 'run-lane', 'sess-lane', 'auto');
    const hook = await installedHook({ runId: 'run-lane', sessionId: 'sess-lane', model: 'sonnet' });

    const toolInput = { subagent_type: 'cyboflow-implement', prompt: 'Implement TASK-1' };
    const out = (await fire(hook, 'Task', toolInput)) as {
      hookSpecificOutput: { permissionDecision?: string };
    };

    // Lane derivation fired with the GATE run id...
    expect(deriveLaneFromTaskDispatch).toHaveBeenCalledTimes(1);
    expect(deriveLaneFromTaskDispatch).toHaveBeenCalledWith({
      runId: 'run-lane',
      toolName: 'Task',
      toolInput,
    });
    // ...and the verdict still DEFERS (auto-supported) — proving step 0 runs even
    // though the ApprovalRouter (the other deriveLane caller) is NEVER reached.
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('routes AskUserQuestion through QuestionRouter in ALL modes (including dontAsk)', async () => {
    const fakeAnswer = { answers: { Q: 'A' } };
    const requestQuestion = vi.fn().mockResolvedValue(fakeAnswer);
    const questionSpy = vi
      .spyOn(QuestionRouter, 'getInstance')
      .mockReturnValue({ requestQuestion } as unknown as QuestionRouter);

    // dontAsk would otherwise return a plain allow — the question must still route.
    seedRunSession(db, 'run-q', 'sess-q', 'dontAsk');
    const hook = await installedHook({ runId: 'run-q', sessionId: 'sess-q' });

    const out = (await fire(hook, 'AskUserQuestion', { questions: [] })) as {
      hookSpecificOutput: { permissionDecision: string; updatedInput?: unknown };
    };
    expect(requestQuestion).toHaveBeenCalledOnce();
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(out.hookSpecificOutput.updatedInput).toEqual({ questions: [], answers: fakeAnswer.answers });
    expect(requestApproval).not.toHaveBeenCalled();

    questionSpy.mockRestore();
  });

  it('an unresolved session (NULL session_id) floors to the GLOBAL default — here dontAsk → allow', async () => {
    // ownerSessionId undefined → readLiveSessionMode → configManager global default.
    const mgrDontAsk = new TestableClaudeCodeManager(
      createMockSessionManager(),
      logger as unknown as Logger,
      makeConfigManager('dontAsk'),
      db,
    );
    seedRunSession(db, 'run-orphan', null, null);
    const opts = await mgrDontAsk.publicBuildSdkOptions({
      panelId: 'panel', sessionId: 'sess-x', worktreePath: '/tmp/w', prompt: 'go', runId: 'run-orphan',
    });
    const hook = extractPreToolUseHook(opts);
    expect(hook).not.toBeNull();

    const out = (await fire(hook!, 'Bash', { command: 'ls' })) as {
      hookSpecificOutput: { permissionDecision: string };
    };
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('an unresolved session with a default global mode routes through ApprovalRouter (conservative gate)', async () => {
    seedRunSession(db, 'run-orphan2', null, null);
    const hook = await installedHook({ runId: 'run-orphan2', sessionId: 'sess-y' });

    await fire(hook, 'Edit', {});
    expect(requestApproval).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// spawnClaudeCode — quick/legacy SDK sessions inherit the global default
// ---------------------------------------------------------------------------

describe('ClaudeCodeManager.spawnClaudeCode — quick/legacy session permission seeding', () => {
  let db: Database.Database;
  let logger: LoggerSpy;

  beforeEach(() => {
    db = createTestDb();
    logger = makeProdLoggerSpy();
  });

  afterEach(() => {
    db.close();
    vi.clearAllMocks();
  });

  /** Build a manager whose ConfigManager reports the given global default. */
  function mgrWithGlobalDefault(
    mode: import('../../../../../../shared/types/workflows').PermissionMode,
  ): ClaudeCodeManager {
    return new ClaudeCodeManager(
      createMockSessionManager(),
      logger as unknown as Logger,
      makeConfigManager(mode),
      db,
    );
  }

  /** Spy on the spawn chokepoint so no real query runs; capture the options. */
  function spySpawn(mgr: ClaudeCodeManager) {
    return vi
      .spyOn(mgr as unknown as { spawnCliProcess(o: unknown): Promise<void> }, 'spawnCliProcess')
      .mockResolvedValue(undefined);
  }

  it('seeds agentPermissionMode from the global default for a legacy approve session', async () => {
    const mgr = mgrWithGlobalDefault('auto');
    const spawn = spySpawn(mgr);

    await mgr.spawnClaudeCode('p1', 's1', '/tmp/w', 'go', undefined, false, 'approve');

    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ agentPermissionMode: 'auto' }));
  });

  it("preserves explicit legacy 'ignore' (don't-ask) by leaving agentPermissionMode unset", async () => {
    const mgr = mgrWithGlobalDefault('auto');
    const spawn = spySpawn(mgr);

    await mgr.spawnClaudeCode('p2', 's2', '/tmp/w', 'go', undefined, false, 'ignore');

    expect(spawn).toHaveBeenCalledOnce();
    const opts = spawn.mock.calls[0][0] as { agentPermissionMode?: string };
    expect(opts.agentPermissionMode).toBeUndefined();
  });

  it("seeds 'default' when the global default is 'default' (zero-behavior-change)", async () => {
    const mgr = mgrWithGlobalDefault('default');
    const spawn = spySpawn(mgr);

    await mgr.spawnClaudeCode('p3', 's3', '/tmp/w', 'go', undefined, false, 'approve');

    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ agentPermissionMode: 'default' }));
  });

  it('prefers the per-session agent_permission_mode override over the global default', async () => {
    // A session configured (Wizard step 3 / quick config) with an explicit
    // 4-mode override. resolveSessionAgentPermissionMode must read it from the
    // DB row and prefer it over the global default ('auto' here).
    const sessionManager = {
      getDbSession: vi.fn(() => ({ id: 's-override', agent_permission_mode: 'acceptEdits' })),
      getPanelClaudeSessionId: vi.fn(() => undefined),
      getProjectById: vi.fn(() => undefined),
      updateSession: vi.fn(),
    } as unknown as SessionManager;
    const mgr = new ClaudeCodeManager(
      sessionManager,
      logger as unknown as Logger,
      makeConfigManager('auto'),
      db,
    );
    const spawn = spySpawn(mgr);

    await mgr.spawnClaudeCode('p-ov', 's-override', '/tmp/w', 'go', undefined, false, 'approve');

    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ agentPermissionMode: 'acceptEdits' }));
  });

  it('ignores an invalid stored agent_permission_mode and falls back to the global default', async () => {
    const sessionManager = {
      getDbSession: vi.fn(() => ({ id: 's-bad', agent_permission_mode: 'garbage' })),
      getPanelClaudeSessionId: vi.fn(() => undefined),
      getProjectById: vi.fn(() => undefined),
      updateSession: vi.fn(),
    } as unknown as SessionManager;
    const mgr = new ClaudeCodeManager(
      sessionManager,
      logger as unknown as Logger,
      makeConfigManager('auto'),
      db,
    );
    const spawn = spySpawn(mgr);

    await mgr.spawnClaudeCode('p-bad', 's-bad', '/tmp/w', 'go', undefined, false, 'approve');

    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ agentPermissionMode: 'auto' }));
  });

  it("legacy 'ignore' still wins over a per-session agent_permission_mode override", async () => {
    const sessionManager = {
      getDbSession: vi.fn(() => ({ id: 's-ig', permission_mode: 'ignore', agent_permission_mode: 'acceptEdits' })),
      getPanelClaudeSessionId: vi.fn(() => undefined),
      getProjectById: vi.fn(() => undefined),
      updateSession: vi.fn(),
    } as unknown as SessionManager;
    const mgr = new ClaudeCodeManager(
      sessionManager,
      logger as unknown as Logger,
      makeConfigManager('auto'),
      db,
    );
    const spawn = spySpawn(mgr);

    await mgr.spawnClaudeCode('p-ig', 's-ig', '/tmp/w', 'go', undefined, false, 'ignore');

    const opts = spawn.mock.calls[0][0] as { agentPermissionMode?: string };
    expect(opts.agentPermissionMode).toBeUndefined();
  });

  it("restartPanelWithHistory preserves the session's legacy 'ignore' (no clobber by the global default)", async () => {
    // A session that opted into legacy 'ignore' (don't-ask). The restart path
    // must read it and forward it — otherwise spawnClaudeCode would seed the
    // global default ('auto' here) and silently re-enable prompting.
    const sessionManager = {
      getDbSession: vi.fn(() => ({ id: 's-restart', permission_mode: 'ignore' })),
      getPanelClaudeSessionId: vi.fn(() => undefined),
      getProjectById: vi.fn(() => undefined),
      updateSession: vi.fn(),
    } as unknown as SessionManager;
    const mgr = new ClaudeCodeManager(
      sessionManager,
      logger as unknown as Logger,
      makeConfigManager('auto'),
      db,
    );
    const spawn = spySpawn(mgr);
    vi.spyOn(
      mgr as unknown as { killProcess(id: string): Promise<void> },
      'killProcess',
    ).mockResolvedValue(undefined);

    await mgr.restartPanelWithHistory('p-restart', 's-restart', '/tmp/w', 'go', []);

    expect(spawn).toHaveBeenCalledOnce();
    const opts = spawn.mock.calls[0][0] as { agentPermissionMode?: string; permissionMode?: string };
    expect(opts.permissionMode).toBe('ignore');
    expect(opts.agentPermissionMode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// G) Native-auto visibility folding — maybeFoldAutoDenyVisibility
// ---------------------------------------------------------------------------

/** Build a migration-layered DB that includes review_items (migration 016). */
function buildReviewDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj', '/tmp/p1');

  // __tests__ → claude → panels → services → src; migrations live at src/database/migrations.
  const migDir = join(__dirname, '..', '..', '..', '..', 'database', 'migrations');
  db.exec(readFileSync(join(migDir, '006_cyboflow_schema.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '011_workflow_step_tracking.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '014_native_tasks.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '015_entity_model_rebuild.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '016_review_items.sql'), 'utf-8'));
  return db;
}

describe('ClaudeCodeManager.maybeFoldAutoDenyVisibility — native-auto deny visibility (Step G)', () => {
  let db: Database.Database;
  let logger: LoggerSpy;
  let mgr: ClaudeCodeManager;

  beforeEach(() => {
    db = buildReviewDb();
    db.prepare(
      `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'sprint', '{}')`,
    ).run();
    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, status) VALUES ('run-auto-1', 'wf-1', 1, 'running')`,
    ).run();

    logger = makeProdLoggerSpy();
    ReviewItemRouter.initialize(dbAdapter(db));
    mgr = new ClaudeCodeManager(
      createMockSessionManager(),
      logger as unknown as Logger,
      makeConfigManager(),
      db,
    );
  });

  afterEach(() => {
    ReviewItemRouter._resetForTesting();
    db.close();
    vi.clearAllMocks();
  });

  function fold(event: unknown, runId = 'run-auto-1'): void {
    (mgr as unknown as { maybeFoldAutoDenyVisibility(r: string, e: unknown): void }).maybeFoldAutoDenyVisibility(
      runId,
      event,
    );
  }

  it('folds a NON-BLOCKING permission review item on system/permission_denied', async () => {
    fold({
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Bash',
      tool_use_id: 'tu-x',
      tool_input: { command: 'rm -rf /' },
      decision_reason: 'classifier rejected destructive command',
      decision_reason_type: 'classifier',
    });

    // applyReviewItem is queued per-project; drain it.
    await ReviewItemRouter.getInstance()._queueForProject(1).onIdle();

    const rows = db
      .prepare('SELECT kind, blocking, title, body, source, run_id FROM review_items')
      .all() as Array<{ kind: string; blocking: number; title: string; body: string | null; source: string | null; run_id: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('permission');
    expect(rows[0].blocking).toBe(0); // NON-BLOCKING
    expect(rows[0].title).toContain('Bash');
    expect(rows[0].body).toBe('classifier rejected destructive command');
    expect(rows[0].source).toBe('auto:classifier');
    expect(rows[0].run_id).toBe('run-auto-1');
  });

  it('ignores non-permission_denied system messages', async () => {
    fold({ type: 'system', subtype: 'init', session_id: 'abc' });
    await ReviewItemRouter.getInstance()._queueForProject(1).onIdle();
    const count = (db.prepare('SELECT COUNT(*) AS n FROM review_items').get() as { n: number }).n;
    expect(count).toBe(0);
  });

  it('skips (no crash) when the run has no workflow_runs row', async () => {
    fold(
      { type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 'tu-y', tool_input: {} },
      'unknown-run',
    );
    await ReviewItemRouter.getInstance()._queueForProject(1).onIdle();
    const count = (db.prepare('SELECT COUNT(*) AS n FROM review_items').get() as { n: number }).n;
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Per-session plugin enablement (migration 039 — read-at-spawn, DETERMINISTIC).
// buildSdkOptions reads sessions.enabled_plugins_json and merges an EXCLUSIVE
// enabledPlugins map into the SAME inline `settings` overlay that holds the
// fastMode pins: every SELECTED plugin → true, every OTHER installed plugin →
// false (so a file-enabled plugin is deterministically disabled at the flag
// tier). An empty or missing allow-list emits NO enabledPlugins key; when no
// plugins are installed it degrades to additive (selected `true` only).
// settingSources is untouched.
// ---------------------------------------------------------------------------

describe('ClaudeCodeManager.buildSdkOptions — per-session enabledPlugins overlay', () => {
  let db: Database.Database;
  let logger: LoggerSpy;

  beforeEach(() => {
    db = createTestDb();
    logger = makeProdLoggerSpy();
    const adapter = dbAdapter(db);
    ApprovalRouter.initialize(adapter);
  });

  afterEach(() => {
    ApprovalRouter._resetForTesting();
    db.close();
    vi.clearAllMocks();
  });

  // Manager whose getDbSession returns the given enabled_plugins_json (or none).
  // `installed` seeds the deterministic exclusive map's installed universe.
  function makeManager(enabledPluginsJson?: string, installed: string[] = []): TestableClaudeCodeManager {
    const sessionManager = {
      getDbSession: vi.fn(() =>
        enabledPluginsJson === undefined
          ? { id: 'stub-session' }
          : { id: 'stub-session', enabled_plugins_json: enabledPluginsJson },
      ),
      getPanelClaudeSessionId: vi.fn(() => undefined),
      getProjectById: vi.fn(() => undefined),
      updateSession: vi.fn(),
    } as unknown as SessionManager;
    const mgr = new TestableClaudeCodeManager(sessionManager, logger as unknown as Logger, makeConfigManager(), db);
    mgr.installedPluginIdsStub = installed;
    return mgr;
  }

  // dontAsk → no PreToolUse hook / no FS, so buildSdkOptions stays hermetic.
  const baseOpts = { panelId: 'p', sessionId: 's', worktreePath: '/tmp/w', prompt: 'go', agentPermissionMode: 'dontAsk' as const };

  it('additive fallback: with NO installed catalogue, only the selected plugins → true', async () => {
    // Empty installed universe (nothing to disable) → the map holds only the
    // selected `true` entries (matches the legacy additive overlay).
    const mgr = makeManager(JSON.stringify(['acme@market', 'foo@bar']));
    const opts = await mgr.publicBuildSdkOptions(baseOpts);

    const settings = opts.settings as Record<string, unknown>;
    expect(settings.enabledPlugins).toEqual({ 'acme@market': true, 'foo@bar': true });
    // The fast-mode pins on the same overlay are preserved.
    expect(settings.fastMode).toBe(false);
    expect(settings.fastModePerSessionOptIn).toBe(true);
    // settingSources is NOT touched by the plugin overlay.
    expect(opts.settingSources).toEqual(['user', 'project']);
  });

  it('EXCLUSIVE map: selected plugins → true, every OTHER installed plugin → false', async () => {
    const mgr = makeManager(
      JSON.stringify(['acme@market']),
      ['acme@market', 'foo@bar', 'other@mkt', 'third@mkt'],
    );
    const opts = await mgr.publicBuildSdkOptions(baseOpts);

    const settings = opts.settings as Record<string, unknown>;
    // acme selected → true; the three unselected-but-installed → false, so the
    // session deterministically runs ONLY acme regardless of file-enabled state.
    expect(settings.enabledPlugins).toEqual({
      'acme@market': true,
      'foo@bar': false,
      'other@mkt': false,
      'third@mkt': false,
    });
    expect(opts.settingSources).toEqual(['user', 'project']);
  });

  it('a SELECTED plugin absent from the installed catalogue is still force-enabled (true)', async () => {
    const mgr = makeManager(JSON.stringify(['ghost@mkt']), ['foo@bar']);
    const opts = await mgr.publicBuildSdkOptions(baseOpts);

    const settings = opts.settings as Record<string, unknown>;
    expect(settings.enabledPlugins).toEqual({ 'ghost@mkt': true, 'foo@bar': false });
  });

  it('explicit empty selection [] with installed plugins → disable ALL (every id false)', async () => {
    // "Turn everything off for this session": distinct from the missing-column
    // inherit default — every installed plugin is force-disabled at the flag tier.
    const mgr = makeManager('[]', ['acme@market', 'foo@bar']);
    const opts = await mgr.publicBuildSdkOptions(baseOpts);

    const settings = opts.settings as Record<string, unknown>;
    expect(settings.enabledPlugins).toEqual({ 'acme@market': false, 'foo@bar': false });
    expect(opts.settingSources).toEqual(['user', 'project']);
  });

  it('empty [] allow-list → no enabledPlugins key emitted', async () => {
    const mgr = makeManager('[]');
    const opts = await mgr.publicBuildSdkOptions(baseOpts);

    const settings = opts.settings as Record<string, unknown>;
    expect(settings).not.toHaveProperty('enabledPlugins');
    expect(settings.fastModePerSessionOptIn).toBe(true);
    expect(opts.settingSources).toEqual(['user', 'project']);
  });

  it('missing column → no enabledPlugins key (byte-identical legacy overlay)', async () => {
    const mgr = makeManager(undefined);
    const opts = await mgr.publicBuildSdkOptions(baseOpts);

    const settings = opts.settings as Record<string, unknown>;
    expect(settings).not.toHaveProperty('enabledPlugins');
    expect(opts.settingSources).toEqual(['user', 'project']);
  });

  it('malformed JSON → no enabledPlugins key', async () => {
    const mgr = makeManager('not-json');
    const opts = await mgr.publicBuildSdkOptions(baseOpts);

    const settings = opts.settings as Record<string, unknown>;
    expect(settings).not.toHaveProperty('enabledPlugins');
  });
});
