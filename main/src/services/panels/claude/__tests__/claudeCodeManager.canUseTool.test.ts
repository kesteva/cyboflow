/**
 * Unit tests for the UNCONDITIONAL `canUseTool` callback in ClaudeCodeManager
 * (permission-mode redesign §5 / Slice 7 — auto-mode prompting).
 *
 * buildSdkOptions now provides `canUseTool` on EVERY SDK spawn. It is the terminal
 * sink for the native auto-mode classifier's 'ask' verdict: the SDK only issues a
 * `can_use_tool` control-request when permissionMode:'auto' is pinned AND the
 * always-installed PreToolUse hook deferred AND the classifier resolved 'ask'. In
 * every hook-decided mode (default / acceptEdits / dontAsk, and 'auto' on an
 * auto-UNSUPPORTED model) the hook emits a concrete decision that pre-empts the
 * classifier, so canUseTool is INERT (never reached) there.
 *
 * Coverage (Slice 7 test plan, §10):
 *   - mapping: allowlisted tool short-circuits → { behavior: 'allow', updatedInput } (no router);
 *   - mapping: ApprovalRouter allow → { behavior: 'allow', updatedInput }, echoing the
 *     reviewer's updatedInput when present, else the original tool input unchanged;
 *   - REGRESSION: the allow branch ALWAYS carries updatedInput as a record — the CLI
 *     Zod-rejects a bare { behavior: 'allow' } ("Tool permission request failed: ZodError");
 *   - mapping: ApprovalRouter deny → { behavior: 'deny', message }, default message when absent;
 *   - RunNotRunningError → { behavior: 'deny', message: 'Run not active' };
 *   - any other error is RETHROWN (only the run-not-running case is a benign deny);
 *   - `interrupt` is never set on the deny path;
 *   - canUseTool is installed unconditionally and INERT in hook-decided modes
 *     (the hook returns a concrete permissionDecision that pre-empts the classifier);
 *   - deny path unchanged: maybeFoldAutoDenyVisibility still folds a NON-BLOCKING
 *     permission item on a classifier system/permission_denied (canUseTool covers
 *     'ask', NOT the classifier 'deny' short-circuit).
 *
 * Design mirrors claudeCodeManager.permissionMode.test.ts: the SDK is mocked, a
 * Testable subclass exposes the private buildSdkOptions, and ApprovalRouter is
 * spied so the mapping is asserted without a real gate.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApprovalRouter, RunNotRunningError } from '../../../../orchestrator/approvalRouter';
import { QuestionRouter } from '../../../../orchestrator/questionRouter';
import { ReviewItemRouter } from '../../../../orchestrator/reviewItemRouter';
import { loadMergedPermissionRules } from '../../../../orchestrator/permissionRules';
import { dbAdapter } from '../../../../orchestrator/__test_fixtures__/dbAdapter';
import { createTestDb } from '../../../../orchestrator/__test_fixtures__/orchestratorTestDb';
import { makeProdLoggerSpy } from '../../../../orchestrator/__test_fixtures__/loggerLikeSpy';
import { ClaudeCodeManager } from '../claudeCodeManager';
import type { SessionManager } from '../../../sessionManager';
import type { Logger } from '../../../../utils/logger';
import type { Options, HookCallback, HookCallbackMatcher, CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';

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
// permissionRules.loadMergedPermissionRules touches the FS — stub to an empty rule
// set so the allowlist short-circuit only fires when a test explicitly seeds it.
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

function makeConfigManager(
  defaultAgentMode: import('../../../../../../shared/types/workflows').PermissionMode = 'default',
): import('../../../configManager').ConfigManager {
  return {
    getSystemPromptAppend: vi.fn(() => undefined),
    getConfig: vi.fn(() => ({ verbose: false })),
    getDefaultAgentPermissionMode: vi.fn(() => defaultAgentMode),
  } as unknown as import('../../../configManager').ConfigManager;
}

/** Exposes the private buildSdkOptions for tests. */
class TestableClaudeCodeManager extends ClaudeCodeManager {
  publicBuildSdkOptions(options: {
    panelId: string;
    sessionId: string;
    worktreePath: string;
    prompt: string;
    model?: string;
    runId?: string;
  }): Promise<Options> {
    return (
      this as unknown as { buildSdkOptions(o: unknown): Promise<Options> }
    ).buildSdkOptions(options);
  }
}

/** Pull the single installed PreToolUse hook callback out of a composed Options. */
function extractPreToolUseHook(opts: Options): HookCallback | null {
  const matchers = opts.hooks?.PreToolUse as HookCallbackMatcher[] | undefined;
  if (!matchers || matchers.length === 0) return null;
  const hooks = matchers[0]?.hooks;
  if (!hooks || hooks.length === 0) return null;
  return hooks[0] ?? null;
}

/** Invoke the installed canUseTool with a minimal options object. */
async function callCanUseTool(
  opts: Options,
  toolName: string,
  input: Record<string, unknown>,
): Promise<PermissionResult> {
  const fn = opts.canUseTool;
  if (!fn) throw new Error('canUseTool not installed on the composed Options');
  const callOpts = {
    signal: new AbortController().signal,
    toolUseID: 'tu-1',
    requestId: 'req-1',
  } as Parameters<CanUseTool>[2];
  // SDK 0.3.201 widened CanUseTool to `PermissionResult | null` (null = suppress the
  // control response); cyboflow's makeCanUseTool always decides, so null is a test failure.
  const res = await fn(toolName, input, callOpts);
  if (res === null) throw new Error('canUseTool returned null');
  return res;
}

const basePreTool = {
  hook_event_name: 'PreToolUse' as const,
  session_id: 'sess',
  transcript_path: '/tmp/t.jsonl',
  cwd: '/tmp',
};

/** Build a test DB carrying the run→session join buildSdkOptions reads at spawn. */
function buildModeDb(): Database.Database {
  const db = createTestDb({ includeSubstrate: true });
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_permission_mode TEXT)');
  return db;
}

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
// canUseTool — ApprovalDecision → PermissionResult mapping (the auto 'ask' sink)
// ---------------------------------------------------------------------------

describe('ClaudeCodeManager canUseTool — auto-mode prompting (ApprovalDecision → PermissionResult)', () => {
  let db: Database.Database;
  let logger: LoggerSpy;
  let mgr: TestableClaudeCodeManager;
  let requestApproval: ReturnType<typeof vi.fn>;
  let approvalSpy: ReturnType<typeof vi.spyOn>;

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
  });

  afterEach(() => {
    // mockRestore (not restoreAllMocks) so the module-level vi.mock factory for
    // loadMergedPermissionRules is NOT reset for later describes.
    approvalSpy.mockRestore();
    ApprovalRouter._resetForTesting();
    QuestionRouter._resetForTesting();
    db.close();
    vi.clearAllMocks();
  });

  /** Build options for an auto-supported run so canUseTool is the live sink. */
  async function autoOpts(runId: string, sessionUuid: string): Promise<Options> {
    seedRunSession(db, runId, sessionUuid, 'auto');
    return mgr.publicBuildSdkOptions({
      panelId: 'panel', sessionId: sessionUuid, worktreePath: '/tmp/w', prompt: 'go',
      runId, model: 'sonnet',
    });
  }

  it('classifier ask → ApprovalRouter allow (no updatedInput) → echoes the original input as updatedInput', async () => {
    requestApproval.mockResolvedValueOnce({ behavior: 'allow' as const });
    const opts = await autoOpts('run-allow', 'sess-allow');

    const res = await callCanUseTool(opts, 'Bash', { command: 'ls' });

    expect(requestApproval).toHaveBeenCalledTimes(1);
    // gateRunId is the run id (NOT the session) — the gate vehicle (Slice 3).
    expect(requestApproval).toHaveBeenCalledWith(
      'run-allow', 'Bash', { command: 'ls' }, expect.any(Function),
    );
    // updatedInput is MANDATORY on allow (the CLI ZodErrors on a bare allow). When
    // the reviewer didn't modify the input, echo the original tool input unchanged.
    expect(res).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
  });

  it('classifier ask → ApprovalRouter allow WITH updatedInput → passes updatedInput through', async () => {
    requestApproval.mockResolvedValueOnce({
      behavior: 'allow' as const,
      updatedInput: { command: 'ls -la' },
    });
    const opts = await autoOpts('run-upd', 'sess-upd');

    const res = await callCanUseTool(opts, 'Bash', { command: 'ls' });

    expect(res).toEqual({ behavior: 'allow', updatedInput: { command: 'ls -la' } });
  });

  it('classifier ask → ApprovalRouter deny → { behavior: "deny", message } (no interrupt)', async () => {
    requestApproval.mockResolvedValueOnce({
      behavior: 'deny' as const,
      message: 'reviewer blocked this',
    });
    const opts = await autoOpts('run-deny', 'sess-deny');

    const res = (await callCanUseTool(opts, 'Bash', { command: 'rm -rf /' })) as {
      behavior: string; message: string; interrupt?: boolean;
    };

    expect(res.behavior).toBe('deny');
    expect(res.message).toBe('reviewer blocked this');
    // interrupt is deliberately NOT set — let the agent retry (matches the hook deny).
    expect(res.interrupt).toBeUndefined();
  });

  it('deny with no message → falls back to the default "Denied by reviewer"', async () => {
    requestApproval.mockResolvedValueOnce({ behavior: 'deny' as const });
    const opts = await autoOpts('run-deny2', 'sess-deny2');

    const res = (await callCanUseTool(opts, 'Bash', { command: 'rm -rf /' })) as {
      behavior: string; message: string;
    };

    expect(res).toEqual({ behavior: 'deny', message: 'Denied by reviewer' });
  });

  it('RunNotRunningError → { behavior: "deny", message: "Run not active" }', async () => {
    requestApproval.mockRejectedValueOnce(new RunNotRunningError('run-dead'));
    const opts = await autoOpts('run-dead', 'sess-dead');

    const res = (await callCanUseTool(opts, 'Bash', { command: 'ls' })) as {
      behavior: string; message: string;
    };

    expect(res).toEqual({ behavior: 'deny', message: 'Run not active' });
  });

  it('any OTHER error is RETHROWN (only run-not-running is a benign deny)', async () => {
    requestApproval.mockRejectedValueOnce(new Error('db exploded'));
    const opts = await autoOpts('run-boom', 'sess-boom');

    await expect(callCanUseTool(opts, 'Bash', { command: 'ls' })).rejects.toThrow('db exploded');
  });

  it('allowlisted tool short-circuits → { behavior: "allow", updatedInput } WITHOUT touching ApprovalRouter', async () => {
    // composeHookOptions loads the rules ONCE at spawn (shared by the hook AND
    // canUseTool); mockReturnValueOnce applies to exactly that single load.
    vi.mocked(loadMergedPermissionRules).mockReturnValueOnce({ allow: ['Bash(git status:*)'], deny: [] });
    const opts = await autoOpts('run-allowlist', 'sess-allowlist');

    const res = await callCanUseTool(opts, 'Bash', { command: 'git status -s' });

    // The short-circuit must STILL carry updatedInput — this is the exact path that
    // shipped the production ZodError (an allowlisted Bash command returned a bare
    // allow, which the CLI rejected as "Tool permission request failed: ZodError").
    expect(res).toEqual({ behavior: 'allow', updatedInput: { command: 'git status -s' } });
    expect(requestApproval).not.toHaveBeenCalled();
  });

  // REGRESSION (live-smoke 2026-06-30): every allow PermissionResult canUseTool can
  // emit MUST carry `updatedInput` as a record. The native CLI Zod-validates the
  // can_use_tool control-response; its allow branch requires `updatedInput`, so a
  // bare `{ behavior: 'allow' }` fails `invalid_union` ("expected record, received
  // undefined") and surfaces to the model as an is_error "Tool permission request
  // failed: ZodError …" tool_result (the agent then loops). This asserts the
  // invariant across BOTH allow producers — the allowlist short-circuit and the
  // ApprovalRouter allow with no reviewer-modified input.
  it('REGRESSION: the allow branch ALWAYS carries updatedInput as a record (never a bare allow)', async () => {
    const isRecord = (v: unknown): v is Record<string, unknown> =>
      typeof v === 'object' && v !== null && !Array.isArray(v);

    // Producer 1: ApprovalRouter allow, reviewer did NOT modify the input.
    requestApproval.mockResolvedValueOnce({ behavior: 'allow' as const });
    const optsA = await autoOpts('run-reg-a', 'sess-reg-a');
    const resA = (await callCanUseTool(optsA, 'Edit', { file_path: '/tmp/f', content: 'x' })) as PermissionResult;
    expect(resA.behavior).toBe('allow');
    expect(isRecord((resA as { updatedInput?: unknown }).updatedInput)).toBe(true);

    // Producer 2: allowlist short-circuit (never reaches ApprovalRouter).
    vi.mocked(loadMergedPermissionRules).mockReturnValueOnce({ allow: ['Bash(ls:*)'], deny: [] });
    const optsB = await autoOpts('run-reg-b', 'sess-reg-b');
    const resB = (await callCanUseTool(optsB, 'Bash', { command: 'ls -la' })) as PermissionResult;
    expect(resB.behavior).toBe('allow');
    expect(isRecord((resB as { updatedInput?: unknown }).updatedInput)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// canUseTool — installed unconditionally + INERT in hook-decided modes
// ---------------------------------------------------------------------------

describe('ClaudeCodeManager canUseTool — unconditional install + inert in hook-decided modes', () => {
  let db: Database.Database;
  let logger: LoggerSpy;
  let mgr: TestableClaudeCodeManager;
  let requestApproval: ReturnType<typeof vi.fn>;
  let approvalSpy: ReturnType<typeof vi.spyOn>;

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
  });

  afterEach(() => {
    approvalSpy.mockRestore();
    ApprovalRouter._resetForTesting();
    QuestionRouter._resetForTesting();
    db.close();
    vi.clearAllMocks();
  });

  function fire(hook: HookCallback, toolName: string, toolInput: Record<string, unknown>): Promise<unknown> {
    return hook(
      { ...basePreTool, tool_name: toolName, tool_use_id: 'tu', tool_input: toolInput },
      'tu',
      undefined as never,
    ) as Promise<unknown>;
  }

  it('canUseTool is installed on EVERY spawn — even dontAsk (a hook-decided mode)', async () => {
    seedRunSession(db, 'run-da', 'sess-da', 'dontAsk');
    const opts = await mgr.publicBuildSdkOptions({
      panelId: 'run-da', sessionId: 'sess-da', worktreePath: '/tmp/w', prompt: 'go', runId: 'run-da',
    });
    expect(typeof opts.canUseTool).toBe('function');
  });

  it('canUseTool is installed for an auto-UNSUPPORTED model too (hook routes, canUseTool inert)', async () => {
    seedRunSession(db, 'run-old', 'sess-old', 'auto');
    const opts = await mgr.publicBuildSdkOptions({
      panelId: 'panel', sessionId: 'sess-old', worktreePath: '/tmp/w', prompt: 'go',
      runId: 'run-old', model: 'claude-3-5-sonnet',
    });
    // permissionMode is NOT pinned (unsupported) so the classifier never runs and
    // the SDK never issues can_use_tool — but the callback is still present (inert).
    expect(opts.permissionMode).toBeUndefined();
    expect(typeof opts.canUseTool).toBe('function');
  });

  it.each([
    ['dontAsk', 'Bash', { command: 'rm -rf /' }],
    ['acceptEdits', 'Edit', { file_path: '/tmp/f' }],
    ['default', 'Edit', { file_path: '/tmp/f' }],
  ] as const)(
    '%s → the PreToolUse hook emits a CONCRETE decision (pre-empts the classifier → canUseTool never reached)',
    async (mode, tool, input) => {
      seedRunSession(db, `run-${mode}`, `sess-${mode}`, mode);
      const opts = await mgr.publicBuildSdkOptions({
        panelId: 'panel', sessionId: `sess-${mode}`, worktreePath: '/tmp/w', prompt: 'go',
        runId: `run-${mode}`, model: 'sonnet',
      });
      const hook = extractPreToolUseHook(opts);
      expect(hook).not.toBeNull();

      const out = (await fire(hook!, tool, input)) as {
        hookSpecificOutput: { permissionDecision?: string };
      };
      // A concrete allow/deny is exactly what makes the SDK skip the classifier and
      // therefore never issue a can_use_tool control-request → canUseTool is inert.
      expect(out.hookSpecificOutput.permissionDecision).toBeDefined();
    },
  );

  it('auto on a SUPPORTED model → the hook DEFERS (empty output) — the ONLY path that reaches canUseTool', async () => {
    seedRunSession(db, 'run-auto', 'sess-auto', 'auto');
    const opts = await mgr.publicBuildSdkOptions({
      panelId: 'panel', sessionId: 'sess-auto', worktreePath: '/tmp/w', prompt: 'go',
      runId: 'run-auto', model: 'sonnet',
    });
    expect(opts.permissionMode).toBe('auto'); // classifier pinned
    const hook = extractPreToolUseHook(opts);
    const out = (await fire(hook!, 'Bash', { command: 'ls' })) as {
      hookSpecificOutput: { permissionDecision?: string };
    };
    // Deferred (no decision) → classifier runs → its 'ask' lands on canUseTool.
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(typeof opts.canUseTool).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Deny path unchanged — maybeFoldAutoDenyVisibility still folds NON-BLOCKING.
// canUseTool covers the classifier 'ask'; the classifier 'deny' short-circuit
// continues to surface via the visibility fold (NOT canUseTool). Slice 7 must not
// regress that.
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

  const migDir = join(__dirname, '..', '..', '..', '..', 'database', 'migrations');
  db.exec(readFileSync(join(migDir, '006_cyboflow_schema.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '011_workflow_step_tracking.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '014_native_tasks.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '015_entity_model_rebuild.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '016_review_items.sql'), 'utf-8'));
  return db;
}

describe('ClaudeCodeManager.maybeFoldAutoDenyVisibility — classifier deny path unchanged by Slice 7', () => {
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

  it('folds a NON-BLOCKING permission review item on a classifier system/permission_denied', async () => {
    fold({
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Bash',
      tool_use_id: 'tu-x',
      tool_input: { command: 'rm -rf /' },
      decision_reason: 'classifier rejected destructive command',
      decision_reason_type: 'classifier',
    });

    await ReviewItemRouter.getInstance()._queueForProject(1).onIdle();

    const rows = db
      .prepare('SELECT kind, blocking FROM review_items')
      .all() as Array<{ kind: string; blocking: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('permission');
    expect(rows[0].blocking).toBe(0); // NON-BLOCKING — unchanged by Slice 7
  });
});
