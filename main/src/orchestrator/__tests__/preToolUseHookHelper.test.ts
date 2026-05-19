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
import { routePreToolUseThroughApprovalRouter } from '../preToolUseHookHelper';
import type { LoggerLike } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Construct a minimal synthetic PreToolUseHookInput.
 * Cast via `as unknown as PreToolUseHookInput` to avoid runtime-shape drift
 * from BaseHookInput required fields (session_id, transcript_path, cwd).
 */
function makePreToolInput(toolName: string): PreToolUseHookInput {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: {},
    tool_use_id: 'test-tool-use-id',
    session_id: 'test-session',
    transcript_path: '/tmp/test.jsonl',
    cwd: '/tmp',
  } as unknown as PreToolUseHookInput;
}

function makeLogger(): LoggerLike & { errorMessages: string[] } {
  const errorMessages: string[] = [];
  return {
    errorMessages,
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn((msg: string) => {
      errorMessages.push(msg);
    }),
  };
}

const CALLER_ID = 'run-abc-123';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('routePreToolUseThroughApprovalRouter', () => {
  afterEach(() => {
    ApprovalRouter._resetForTesting();
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

    const logger = makeLogger();

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
    expect(logger.errorMessages).toHaveLength(1);
    expect(logger.errorMessages[0]).toContain('[MyCallerLabel]');
    expect(logger.errorMessages[0]).toContain('DB connection lost');
  });

  // ─── Test 6: callerLabel prefix distinguishes two different log identities ─

  it('logger.error prefix matches callerLabel — two different labels produce two different prefixes', async () => {
    const requestApproval = vi.fn().mockRejectedValue(new Error('boom'));

    const mockRouter = { requestApproval } as unknown as ApprovalRouter;
    vi.spyOn(ApprovalRouter, 'getInstance').mockReturnValue(mockRouter);

    const loggerA = makeLogger();
    const loggerB = makeLogger();

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

    expect(loggerA.errorMessages[0]).toContain('[PermissionModeMapper]');
    expect(loggerB.errorMessages[0]).toContain('[ClaudeCodeManager]');

    // The two prefixes must be distinct
    expect(loggerA.errorMessages[0]).not.toContain('[ClaudeCodeManager]');
    expect(loggerB.errorMessages[0]).not.toContain('[PermissionModeMapper]');
  });
});
