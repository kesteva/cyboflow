/**
 * Regression tests for the native auto-mode classifier hardening (2026-07-01).
 *
 * A planner run launched with permission mode `auto` and model NULL had EVERY
 * `mcp__cyboflow__*` tool denied because the bundled CLI's default model (Fable 5,
 * pulled from availability) is what the auto classifier uses, and an unavailable
 * classifier model denies every tool ("cannot determine the safety"). That
 * soft-bricked the flow: `cyboflow_report_step` denied → current_step_id never
 * advanced → the human's plan-gate answer no-oped. Two layers close the gap:
 *
 *   (a) First-party `mcp__cyboflow__*` tools are allowed DETERMINISTICALLY by the
 *       auto-mode PreToolUse hook, before the classifier — the app's own
 *       orchestration surface is never model-gated. Non-first-party tools STILL
 *       defer to the classifier (fail-closed preserved — no fail-open).
 *   (b) When the run has no explicit model pin (NULL/'auto') and the guarded
 *       default (Fable 5) is unavailable, buildSdkOptions pins the guarded model's
 *       fallback family (Opus) so the classifier runs on an available model rather
 *       than denying. When the default is available, no pin is added (CLI default
 *       retained).
 *
 * Setup mirrors claudeCodeManager.canUseTool.test.ts (mocked SDK/FS, a Testable
 * subclass exposing buildSdkOptions, DB-backed run→session join).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ApprovalRouter } from '../../../../orchestrator/approvalRouter';
import { QuestionRouter } from '../../../../orchestrator/questionRouter';
import { dbAdapter } from '../../../../orchestrator/__test_fixtures__/dbAdapter';
import { createTestDb } from '../../../../orchestrator/__test_fixtures__/orchestratorTestDb';
import { ClaudeCodeManager } from '../claudeCodeManager';
import { ModelAvailabilityService } from '../../../modelAvailabilityService';
import type { SessionManager } from '../../../sessionManager';
import type { Options, HookCallback, HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';

const FABLE = 'claude-fable-5';

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
vi.mock('../../../../orchestrator/permissionRules', async (orig) => {
  const actual = await orig<typeof import('../../../../orchestrator/permissionRules')>();
  return { ...actual, loadMergedPermissionRules: vi.fn(() => ({ allow: [], deny: [] })) };
});

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
  publicBuildSdkOptions(options: {
    panelId: string;
    sessionId: string;
    worktreePath: string;
    prompt: string;
    model?: string;
    runId?: string;
  }): Promise<Options> {
    return (this as unknown as { buildSdkOptions(o: unknown): Promise<Options> }).buildSdkOptions(options);
  }
}

function extractPreToolUseHook(opts: Options): HookCallback | null {
  const matchers = opts.hooks?.PreToolUse as HookCallbackMatcher[] | undefined;
  const hooks = matchers?.[0]?.hooks;
  return hooks?.[0] ?? null;
}

const basePreTool = {
  hook_event_name: 'PreToolUse' as const,
  session_id: 'sess',
  transcript_path: '/tmp/t.jsonl',
  cwd: '/tmp',
};

function fire(hook: HookCallback, toolName: string, toolInput: Record<string, unknown>): Promise<unknown> {
  return hook(
    { ...basePreTool, tool_name: toolName, tool_use_id: 'tu', tool_input: toolInput },
    'tu',
    undefined as never,
  ) as Promise<unknown>;
}

function buildModeDb(): Database.Database {
  const db = createTestDb({ includeSubstrate: true });
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_permission_mode TEXT)');
  return db;
}

function seedRunSession(db: Database.Database, runId: string, sessionUuid: string, mode: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf', 1, 'wf', '{}')",
  ).run();
  db.prepare(
    "INSERT INTO workflow_runs (id, workflow_id, project_id, status, session_id) VALUES (?, 'wf', 1, 'running', ?)",
  ).run(runId, sessionUuid);
  db.prepare('INSERT INTO sessions (id, agent_permission_mode) VALUES (?, ?)').run(sessionUuid, mode);
}

// ---------------------------------------------------------------------------
// (a) First-party cyboflow MCP tools are allowed WITHOUT the classifier.
// ---------------------------------------------------------------------------

describe('ClaudeCodeManager auto-mode hook — first-party cyboflow tools bypass the classifier', () => {
  let db: Database.Database;
  let mgr: TestableClaudeCodeManager;
  let requestApproval: ReturnType<typeof vi.fn>;
  let approvalSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    db = buildModeDb();
    const adapter = dbAdapter(db);
    ApprovalRouter.initialize(adapter);
    QuestionRouter.initialize(adapter);
    mgr = new TestableClaudeCodeManager(createMockSessionManager(), undefined, makeConfigManager(), db);
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

  async function autoHook(runId: string, sessionUuid: string): Promise<HookCallback> {
    seedRunSession(db, runId, sessionUuid, 'auto');
    const opts = await mgr.publicBuildSdkOptions({
      panelId: 'panel', sessionId: sessionUuid, worktreePath: '/tmp/w', prompt: 'go',
      runId, model: 'sonnet', // auto-supported → classifier pinned, hook defers
    });
    expect(opts.permissionMode).toBe('auto');
    const hook = extractPreToolUseHook(opts);
    expect(hook).not.toBeNull();
    return hook!;
  }

  it('allows mcp__cyboflow__cyboflow_report_step deterministically (allow decision, no ApprovalRouter)', async () => {
    const hook = await autoHook('run-fp', 'sess-fp');

    const out = (await fire(hook, 'mcp__cyboflow__cyboflow_report_step', { stepId: 'context' })) as {
      hookSpecificOutput: { permissionDecision?: string };
    };

    // A concrete allow pre-empts the classifier entirely — no model call, no gate.
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('allows every mcp__cyboflow__* tool, not only report_step', async () => {
    const hook = await autoHook('run-fp2', 'sess-fp2');
    for (const tool of [
      'mcp__cyboflow__cyboflow_create_task',
      'mcp__cyboflow__cyboflow_create_sprint_batch',
      'mcp__cyboflow__cyboflow_update_entity',
    ]) {
      const out = (await fire(hook, tool, {})) as { hookSpecificOutput: { permissionDecision?: string } };
      expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
    }
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('does NOT widen to other MCP servers or built-in tools (fail-closed defer preserved)', async () => {
    const hook = await autoHook('run-defer', 'sess-defer');

    // Another MCP server → still deferred to the classifier (no decision).
    const otherMcp = (await fire(hook, 'mcp__github__create_issue', {})) as {
      hookSpecificOutput: { permissionDecision?: string };
    };
    expect(otherMcp.hookSpecificOutput.permissionDecision).toBeUndefined();

    // A built-in tool → still deferred to the classifier (no decision).
    const bash = (await fire(hook, 'Bash', { command: 'rm -rf /' })) as {
      hookSpecificOutput: { permissionDecision?: string };
    };
    expect(bash.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(requestApproval).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// (b) Classifier model fallback: unpinned default + guarded model unavailable.
// ---------------------------------------------------------------------------

describe('ClaudeCodeManager buildSdkOptions — auto-mode classifier model fallback', () => {
  let db: Database.Database;
  let mgr: TestableClaudeCodeManager;

  beforeEach(() => {
    db = buildModeDb();
    const adapter = dbAdapter(db);
    ApprovalRouter.initialize(adapter);
    QuestionRouter.initialize(adapter);
    ModelAvailabilityService._resetForTesting();
    ModelAvailabilityService.initialize();
    mgr = new TestableClaudeCodeManager(createMockSessionManager(), undefined, makeConfigManager(), db);
  });

  afterEach(() => {
    ApprovalRouter._resetForTesting();
    QuestionRouter._resetForTesting();
    ModelAvailabilityService._resetForTesting();
    db.close();
    vi.clearAllMocks();
  });

  async function autoOptsNullModel(runId: string, sessionUuid: string): Promise<Options> {
    seedRunSession(db, runId, sessionUuid, 'auto');
    return mgr.publicBuildSdkOptions({
      panelId: 'panel', sessionId: sessionUuid, worktreePath: '/tmp/w', prompt: 'go', runId,
      // model omitted → NULL/'auto' run model → SDK/CLI default (Fable 5).
    });
  }

  it('NULL model + auto + guarded default UNAVAILABLE → pins the Opus fallback for the classifier', async () => {
    ModelAvailabilityService.getInstance().markUnavailable(FABLE, 'pulled');

    const opts = await autoOptsNullModel('run-fb', 'sess-fb');

    expect(opts.permissionMode).toBe('auto');
    // Classifier now runs on an available model instead of the pulled default.
    expect(opts.model).toBe('claude-opus-4-8[1m]');
  });

  it('NULL model + auto + guarded default AVAILABLE → no pin (CLI default retained)', async () => {
    const opts = await autoOptsNullModel('run-ok', 'sess-ok');

    expect(opts.permissionMode).toBe('auto');
    // Fable is usable → leave the model unset so the CLI uses its own default.
    expect(opts.model).toBeUndefined();
  });

  it('auto-UNSUPPORTED model (no classifier) is untouched even when the guarded default is unavailable', async () => {
    // permissionMode is pinned to 'auto' for any classifier-capable model (incl. an
    // unpinned/NULL model); the classifier-fallback block keys on that. An
    // auto-UNSUPPORTED pinned model leaves permissionMode unset → no classifier → the
    // block must NOT fire and the explicitly pinned model is kept as-is.
    ModelAvailabilityService.getInstance().markUnavailable(FABLE, 'pulled');
    seedRunSession(db, 'run-haiku', 'sess-haiku', 'auto');

    const opts = await mgr.publicBuildSdkOptions({
      panelId: 'panel', sessionId: 'sess-haiku', worktreePath: '/tmp/w', prompt: 'go',
      runId: 'run-haiku', model: 'haiku',
    });

    expect(opts.permissionMode).toBeUndefined(); // no classifier for haiku
    expect(opts.model).toBe('claude-haiku-4-5'); // explicit pin kept, no fallback swap
  });
});
