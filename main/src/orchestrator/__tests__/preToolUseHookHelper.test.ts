/**
 * Unit tests for preToolUseHookHelper.ts — routePreToolUseThroughApprovalRouter.
 *
 * Five cases per the test_strategy in TASK-651:
 *
 * 1. allow — returns permissionDecision:'allow' (no updatedInput when absent).
 * 2. deny with message — returns permissionDecision:'deny' with permissionDecisionReason.
 * 3. deny without message — permissionDecisionReason key is ABSENT (not undefined).
 * 4. allow with updatedInput — updatedInput is threaded into hookSpecificOutput.
 * 5. ApprovalRouter throws → safe deny with reason 'Internal approval-router error';
 *    logger.error is called with the callerLabel prefix.
 * 6. callerLabel prefix — two different callerLabel values produce two distinct
 *    log prefixes when the safe-deny branch fires.
 *
 * No DB, no PQueue, no real ApprovalRouter — ApprovalRouter.getInstance is
 * stubbed via vi.spyOn, matching the pattern in permissionModeMapper.test.ts.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { ApprovalRouter } from '../approvalRouter';
import { SprintLaneStore } from '../sprintLaneStore';
import { routePreToolUseThroughApprovalRouter } from '../preToolUseHookHelper';
import { makeSpyLogger } from '../__test_fixtures__/loggerLikeSpy';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Construct a minimal synthetic PreToolUseHookInput.
 * Cast via `as unknown as PreToolUseHookInput` to avoid runtime-shape drift
 * from BaseHookInput required fields (session_id, transcript_path, cwd).
 */
function makePreToolInput(
  toolName: string,
  toolInput: Record<string, unknown> = {},
): PreToolUseHookInput {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: 'test-tool-use-id',
    session_id: 'test-session',
    transcript_path: '/tmp/test.jsonl',
    cwd: '/tmp',
  } as unknown as PreToolUseHookInput;
}

const CALLER_ID = 'run-abc-123';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('routePreToolUseThroughApprovalRouter', () => {
  afterEach(() => {
    ApprovalRouter._resetForTesting();
    SprintLaneStore._resetForTesting();
    vi.restoreAllMocks();
  });

  // ─── Test 1: allow decision → permissionDecision:'allow' ────────────────

  it('allow decision returns permissionDecision allow', async () => {
    const requestApproval = vi.fn().mockResolvedValue({ behavior: 'allow' as const });

    vi.spyOn(ApprovalRouter, 'getInstance').mockReturnValue({
      requestApproval,
    } as unknown as ApprovalRouter);

    const result = await routePreToolUseThroughApprovalRouter(
      makePreToolInput('Bash'),
      CALLER_ID,
      'TestCaller',
    );

    expect(result).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    });
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(requestApproval).toHaveBeenCalledWith(CALLER_ID, 'Bash', {}, expect.any(Function));
  });

  // ─── Test 2: deny with message → permissionDecisionReason populated ──────

  it('deny decision with message populates permissionDecisionReason', async () => {
    const requestApproval = vi.fn().mockResolvedValue({
      behavior: 'deny' as const,
      message: 'User rejected the tool call',
    });

    vi.spyOn(ApprovalRouter, 'getInstance').mockReturnValue({
      requestApproval,
    } as unknown as ApprovalRouter);

    const result = await routePreToolUseThroughApprovalRouter(
      makePreToolInput('Bash'),
      CALLER_ID,
      'TestCaller',
    );

    expect(result).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'User rejected the tool call',
      },
    });
  });

  // ─── Test 3: deny without message → permissionDecisionReason key absent ──

  it('deny decision without message omits permissionDecisionReason key entirely', async () => {
    const requestApproval = vi.fn().mockResolvedValue({
      behavior: 'deny' as const,
      // no message field
    });

    vi.spyOn(ApprovalRouter, 'getInstance').mockReturnValue({
      requestApproval,
    } as unknown as ApprovalRouter);

    const result = await routePreToolUseThroughApprovalRouter(
      makePreToolInput('Read'),
      CALLER_ID,
      'TestCaller',
    );

    expect(result).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
      },
    });

    // The key must be absent — not just falsy
    const output = result as { hookSpecificOutput: Record<string, unknown> };
    expect(Object.prototype.hasOwnProperty.call(output.hookSpecificOutput, 'permissionDecisionReason')).toBe(false);
  });

  // ─── Test 4: allow with updatedInput → updatedInput threaded through ──────

  it('allow decision with updatedInput threads updatedInput into hookSpecificOutput', async () => {
    const mutatedInput = { path: '/safe/rewrite.ts', content: '// approved' };
    const requestApproval = vi.fn().mockResolvedValue({
      behavior: 'allow' as const,
      updatedInput: mutatedInput,
    });

    vi.spyOn(ApprovalRouter, 'getInstance').mockReturnValue({
      requestApproval,
    } as unknown as ApprovalRouter);

    const result = await routePreToolUseThroughApprovalRouter(
      makePreToolInput('Edit'),
      CALLER_ID,
      'TestCaller',
    );

    expect(result).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: mutatedInput,
      },
    });
  });

  // ─── Test 5: ApprovalRouter throws → safe deny + logger.error called ──────

  it('ApprovalRouter throwing yields permissionDecision deny with internal error reason and logs the error', async () => {
    const requestApproval = vi.fn().mockRejectedValue(new Error('DB connection lost'));

    vi.spyOn(ApprovalRouter, 'getInstance').mockReturnValue({
      requestApproval,
    } as unknown as ApprovalRouter);

    const logger = makeSpyLogger();

    const result = await routePreToolUseThroughApprovalRouter(
      makePreToolInput('Bash'),
      CALLER_ID,
      'MyCallerLabel',
      logger,
    );

    expect(result).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Internal approval-router error',
      },
    });

    // logger.error must be called with the callerLabel prefix
    const errorCalls = logger.calls.filter((c) => c.level === 'error');
    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0].message).toContain('[MyCallerLabel]');
    expect(errorCalls[0].message).toContain('DB connection lost');
  });

  // ─── Test 6: callerLabel prefix distinguishes two different log identities ─

  it('logger.error prefix matches callerLabel — two different labels produce two different prefixes', async () => {
    const requestApproval = vi.fn().mockRejectedValue(new Error('boom'));

    const mockRouter = { requestApproval } as unknown as ApprovalRouter;
    vi.spyOn(ApprovalRouter, 'getInstance').mockReturnValue(mockRouter);

    const loggerA = makeSpyLogger();
    const loggerB = makeSpyLogger();

    await routePreToolUseThroughApprovalRouter(
      makePreToolInput('Bash'),
      CALLER_ID,
      'PermissionModeMapper',
      loggerA,
    );

    await routePreToolUseThroughApprovalRouter(
      makePreToolInput('Bash'),
      CALLER_ID,
      'ClaudeCodeManager',
      loggerB,
    );

    const errorCallsA = loggerA.calls.filter((c) => c.level === 'error');
    const errorCallsB = loggerB.calls.filter((c) => c.level === 'error');
    expect(errorCallsA[0].message).toContain('[PermissionModeMapper]');
    expect(errorCallsB[0].message).toContain('[ClaudeCodeManager]');

    // The two prefixes must be distinct
    expect(errorCallsA[0].message).not.toContain('[ClaudeCodeManager]');
    expect(errorCallsB[0].message).not.toContain('[PermissionModeMapper]');
  });

  // ─── Test 7: SDK-substrate sprint-lane auto-derive is wired here ──────────
  // The SDK PreToolUse seam must forward a parent orchestrator Task dispatch to
  // SprintLaneStore.deriveLaneFromTaskDispatch so lanes advance on the SDK
  // substrate too (not only the interactive socket handler). Observe-only — the
  // verdict is unaffected.

  it('forwards a Task dispatch to SprintLaneStore.deriveLaneFromTaskDispatch (SDK lane auto-derive)', async () => {
    const requestApproval = vi.fn().mockResolvedValue({ behavior: 'allow' as const });
    vi.spyOn(ApprovalRouter, 'getInstance').mockReturnValue({
      requestApproval,
    } as unknown as ApprovalRouter);

    const deriveLaneFromTaskDispatch = vi.fn();
    vi.spyOn(SprintLaneStore, 'getInstance').mockReturnValue({
      deriveLaneFromTaskDispatch,
    } as unknown as SprintLaneStore);

    const toolInput = { subagent_type: 'cyboflow-implement', prompt: 'Implement TASK-1' };
    const result = await routePreToolUseThroughApprovalRouter(
      makePreToolInput('Task', toolInput),
      CALLER_ID,
      'ClaudeCodeManager',
    );

    expect(deriveLaneFromTaskDispatch).toHaveBeenCalledTimes(1);
    expect(deriveLaneFromTaskDispatch).toHaveBeenCalledWith({
      runId: CALLER_ID,
      toolName: 'Task',
      toolInput,
    });
    // The observe call never alters the verdict.
    expect(result).toMatchObject({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
    });
  });

  it('a missing/erroring SprintLaneStore never disturbs the gating verdict', async () => {
    const requestApproval = vi.fn().mockResolvedValue({ behavior: 'allow' as const });
    vi.spyOn(ApprovalRouter, 'getInstance').mockReturnValue({
      requestApproval,
    } as unknown as ApprovalRouter);

    // Store not initialized — getInstance throws; the wrapped call must swallow it.
    vi.spyOn(SprintLaneStore, 'getInstance').mockImplementation(() => {
      throw new Error('SprintLaneStore has not been initialized');
    });

    const result = await routePreToolUseThroughApprovalRouter(
      makePreToolInput('Task', { subagent_type: 'cyboflow-implement' }),
      CALLER_ID,
      'ClaudeCodeManager',
    );

    expect(result).toMatchObject({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
    });
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });
});
