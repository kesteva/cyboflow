/**
 * Unit tests for the 4-mode agent-permission wiring in ClaudeCodeManager
 * (Step E+G of the global agent-permission-mode feature).
 *
 * Coverage:
 *   E) buildSdkOptions branches on options.agentPermissionMode:
 *      - 'dontAsk'     → NO PreToolUse hook installed.
 *      - 'auto' (supported model) → sdkOptions.permissionMode='auto' AND an
 *        AskUserQuestion-ONLY hook that defers every other tool (no
 *        ApprovalRouter routing).
 *      - 'auto' (unsupported model) → FALLBACK: no permissionMode, the normal
 *        permission hook installed, logger.warn fired.
 *      - 'acceptEdits' → the hook auto-allows Edit/Write/MultiEdit BEFORE the
 *        allowlist; routes the rest through ApprovalRouter.
 *      - 'default' (and undefined agentPermissionMode + legacy permissionMode)
 *        → behavior unchanged.
 *   modelSupportsAutoMode pure-helper eligibility table.
 *   G) maybeFoldAutoDenyVisibility folds a NON-BLOCKING permission review item
 *      when a system/permission_denied SDK message arrives for a workflow run.
 *
 * Design: the SDK is mocked (no real query). A Testable subclass exposes the
 * private buildSdkOptions/makeAutoModePreToolUseHook so we can inspect the
 * composed Options + invoke the hook callback directly without a full spawn.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApprovalRouter } from '../../../../orchestrator/approvalRouter';
import { QuestionRouter } from '../../../../orchestrator/questionRouter';
import { ReviewItemRouter } from '../../../../orchestrator/reviewItemRouter';
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

function makeConfigManager(): import('../../../configManager').ConfigManager {
  return {
    getSystemPromptAppend: vi.fn(() => undefined),
    getConfig: vi.fn(() => ({ verbose: false })),
  } as unknown as import('../../../configManager').ConfigManager;
}

/** Exposes the private buildSdkOptions + makeAutoModePreToolUseHook for tests. */
class TestableClaudeCodeManager extends ClaudeCodeManager {
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
// buildSdkOptions — mode branching
// ---------------------------------------------------------------------------

describe('ClaudeCodeManager.buildSdkOptions — agentPermissionMode branching', () => {
  let db: Database.Database;
  let logger: LoggerSpy;
  let mgr: TestableClaudeCodeManager;

  beforeEach(() => {
    db = createTestDb();
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

  it("dontAsk installs NO PreToolUse hook", async () => {
    const opts = await mgr.publicBuildSdkOptions({
      panelId: 'p1', sessionId: 's1', worktreePath: '/tmp/w', prompt: 'go',
      agentPermissionMode: 'dontAsk',
    });
    expect(opts.hooks?.PreToolUse).toBeUndefined();
    expect(opts.permissionMode).toBeUndefined();
  });

  it("auto (supported model) sets permissionMode='auto' + AskUserQuestion-only hook that defers other tools", async () => {
    const requestApproval = vi.fn();
    vi.spyOn(ApprovalRouter, 'getInstance').mockReturnValue({ requestApproval } as unknown as ApprovalRouter);

    const opts = await mgr.publicBuildSdkOptions({
      panelId: 'p2', sessionId: 's2', worktreePath: '/tmp/w', prompt: 'go',
      agentPermissionMode: 'auto', model: 'sonnet',
    });

    // Native auto is set.
    expect(opts.permissionMode).toBe('auto');

    const hook = extractPreToolUseHook(opts);
    expect(hook).not.toBeNull();

    // A non-AskUserQuestion tool defers (no permissionDecision) and NEVER
    // touches ApprovalRouter.
    const deferOut = (await hook!(
      { ...basePreTool, tool_name: 'Bash', tool_use_id: 'tu1', tool_input: { command: 'ls' } },
      'tu1',
      undefined as never,
    )) as { hookSpecificOutput: { hookEventName: string; permissionDecision?: string } };
    expect(deferOut.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(deferOut.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(requestApproval).not.toHaveBeenCalled();

    // AskUserQuestion still routes to QuestionRouter.
    const fakeAnswer = { answers: { Q: 'A' } };
    vi.spyOn(QuestionRouter, 'getInstance').mockReturnValue({
      requestQuestion: vi.fn().mockResolvedValue(fakeAnswer),
    } as unknown as QuestionRouter);
    const askOut = (await hook!(
      { ...basePreTool, tool_name: 'AskUserQuestion', tool_use_id: 'tu2', tool_input: { questions: [] } },
      'tu2',
      undefined as never,
    )) as { hookSpecificOutput: { permissionDecision: string; updatedInput?: unknown } };
    expect(askOut.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(askOut.hookSpecificOutput.updatedInput).toEqual({ questions: [], answers: fakeAnswer.answers });
  });

  it('auto (unsupported model) falls back: no permissionMode, normal hook installed, logger.warn fired', async () => {
    const requestApproval = vi.fn().mockResolvedValue({ behavior: 'allow' as const });
    vi.spyOn(ApprovalRouter, 'getInstance').mockReturnValue({ requestApproval } as unknown as ApprovalRouter);

    const opts = await mgr.publicBuildSdkOptions({
      panelId: 'p3', sessionId: 's3', worktreePath: '/tmp/w', prompt: 'go',
      agentPermissionMode: 'auto', model: 'claude-3-5-sonnet',
    });

    expect(opts.permissionMode).toBeUndefined();
    const hook = extractPreToolUseHook(opts);
    expect(hook).not.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('does not support native auto-mode'));

    // The fallback hook is the normal 'default' hook → routes through ApprovalRouter.
    await hook!(
      { ...basePreTool, tool_name: 'Bash', tool_use_id: 'tu3', tool_input: { command: 'ls' } },
      'tu3',
      undefined as never,
    );
    expect(requestApproval).toHaveBeenCalledOnce();
  });

  it('acceptEdits auto-allows Edit/Write/MultiEdit without ApprovalRouter, routes the rest', async () => {
    const requestApproval = vi.fn().mockResolvedValue({ behavior: 'allow' as const });
    vi.spyOn(ApprovalRouter, 'getInstance').mockReturnValue({ requestApproval } as unknown as ApprovalRouter);

    const opts = await mgr.publicBuildSdkOptions({
      panelId: 'p4', sessionId: 's4', worktreePath: '/tmp/w', prompt: 'go',
      agentPermissionMode: 'acceptEdits',
    });
    expect(opts.permissionMode).toBeUndefined();
    const hook = extractPreToolUseHook(opts);
    expect(hook).not.toBeNull();

    for (const tool of ['Edit', 'Write', 'MultiEdit']) {
      const out = (await hook!(
        { ...basePreTool, tool_name: tool, tool_use_id: `tu-${tool}`, tool_input: { file_path: '/tmp/f' } },
        `tu-${tool}`,
        undefined as never,
      )) as { hookSpecificOutput: { permissionDecision: string } };
      expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
    }
    expect(requestApproval).not.toHaveBeenCalled();

    // A non-edit tool still routes through ApprovalRouter.
    await hook!(
      { ...basePreTool, tool_name: 'Bash', tool_use_id: 'tu-bash', tool_input: { command: 'rm -rf /' } },
      'tu-bash',
      undefined as never,
    );
    expect(requestApproval).toHaveBeenCalledOnce();
  });

  it('default routes every tool through ApprovalRouter (behavior unchanged)', async () => {
    const requestApproval = vi.fn().mockResolvedValue({ behavior: 'allow' as const });
    vi.spyOn(ApprovalRouter, 'getInstance').mockReturnValue({ requestApproval } as unknown as ApprovalRouter);

    const opts = await mgr.publicBuildSdkOptions({
      panelId: 'p5', sessionId: 's5', worktreePath: '/tmp/w', prompt: 'go',
      agentPermissionMode: 'default',
    });
    expect(opts.permissionMode).toBeUndefined();
    const hook = extractPreToolUseHook(opts);
    expect(hook).not.toBeNull();

    // Edit is NOT auto-allowed in default mode.
    await hook!(
      { ...basePreTool, tool_name: 'Edit', tool_use_id: 'tu-edit', tool_input: { file_path: '/tmp/f' } },
      'tu-edit',
      undefined as never,
    );
    expect(requestApproval).toHaveBeenCalledOnce();
  });

  it('legacy permissionMode=ignore (no agentPermissionMode) installs NO hook', async () => {
    const opts = await mgr.publicBuildSdkOptions({
      panelId: 'p6', sessionId: 's6', worktreePath: '/tmp/w', prompt: 'go',
      permissionMode: 'ignore',
    });
    expect(opts.hooks?.PreToolUse).toBeUndefined();
  });

  it('legacy permissionMode=approve (no agentPermissionMode) installs the default hook', async () => {
    const requestApproval = vi.fn().mockResolvedValue({ behavior: 'allow' as const });
    vi.spyOn(ApprovalRouter, 'getInstance').mockReturnValue({ requestApproval } as unknown as ApprovalRouter);

    const opts = await mgr.publicBuildSdkOptions({
      panelId: 'p7', sessionId: 's7', worktreePath: '/tmp/w', prompt: 'go',
      permissionMode: 'approve',
    });
    const hook = extractPreToolUseHook(opts);
    expect(hook).not.toBeNull();
    await hook!(
      { ...basePreTool, tool_name: 'Edit', tool_use_id: 'tu-e', tool_input: {} },
      'tu-e',
      undefined as never,
    );
    expect(requestApproval).toHaveBeenCalledOnce();
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
