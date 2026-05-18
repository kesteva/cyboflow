/**
 * Unit tests for permissionModeMapper.ts — buildPreToolUseHook.
 *
 * Five cases per the test_strategy in TASK-643:
 *
 * 1. 'dontAsk' mode returns undefined (no hook installed).
 * 2. 'default' mode routes Edit, Bash, Read through ApprovalRouter (3 calls,
 *    decisions threaded back through hookSpecificOutput).
 * 3. 'acceptEdits' mode auto-approves Edit/Write/MultiEdit (0 router calls)
 *    and defers Bash/Read to ApprovalRouter.
 * 4. ApprovalRouter deny decision is translated to permissionDecision:'deny'
 *    with permissionDecisionReason populated when ApprovalDecision.message is set.
 * 5. ApprovalRouter throwing an error yields permissionDecision:'deny' with
 *    reason 'Internal approval-router error'.
 *
 * No DB, no PQueue, no real ApprovalRouter — ApprovalRouter.getInstance is
 * stubbed via vi.spyOn.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { HookCallback, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { ApprovalRouter } from '../approvalRouter';
import {
  buildPreToolUseHook,
  ACCEPT_EDITS_AUTO_APPROVE_TOOLS,
} from '../permissionModeMapper';

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

const RUN_ID = 'run-abc-123';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildPreToolUseHook', () => {
  afterEach(() => {
    ApprovalRouter._resetForTesting();
    vi.restoreAllMocks();
  });

  // ─── Test 1: dontAsk ────────────────────────────────────────────────────

  it('dontAsk returns undefined', () => {
    const hook = buildPreToolUseHook('dontAsk', RUN_ID);
    expect(hook).toBeUndefined();
  });

  // ─── Test 2: default mode defers through ApprovalRouter ─────────────────

  it('default mode defers Edit, Bash, Read through ApprovalRouter', async () => {
    const requestApproval = vi
      .fn()
      .mockResolvedValue({ behavior: 'allow' as const });

    vi.spyOn(ApprovalRouter, 'getInstance').mockReturnValue({
      requestApproval,
    } as unknown as ApprovalRouter);

    const hook = buildPreToolUseHook('default', RUN_ID);
    expect(hook).toBeDefined();

    // Invoke for three distinct tool names
    const toolNames = ['Edit', 'Bash', 'Read'];
    for (const toolName of toolNames) {
      const result = await hook!(makePreToolInput(toolName), 'tool-use-id', {} as Parameters<HookCallback>[2]);
      expect(result).toMatchObject({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      });
    }

    // ApprovalRouter was called once per tool
    expect(requestApproval).toHaveBeenCalledTimes(3);
    expect(requestApproval).toHaveBeenCalledWith(RUN_ID, 'Edit', {}, expect.any(Function));
    expect(requestApproval).toHaveBeenCalledWith(RUN_ID, 'Bash', {}, expect.any(Function));
    expect(requestApproval).toHaveBeenCalledWith(RUN_ID, 'Read', {}, expect.any(Function));
  });

  // ─── Test 3: acceptEdits auto-approves edit tools, defers others ─────────

  it('acceptEdits auto-approves Edit/Write/MultiEdit and defers others', async () => {
    const requestApproval = vi
      .fn()
      .mockResolvedValue({ behavior: 'allow' as const });

    vi.spyOn(ApprovalRouter, 'getInstance').mockReturnValue({
      requestApproval,
    } as unknown as ApprovalRouter);

    const hook = buildPreToolUseHook('acceptEdits', RUN_ID);
    expect(hook).toBeDefined();

    // Edit, Write, MultiEdit should be auto-approved without ApprovalRouter
    for (const toolName of ACCEPT_EDITS_AUTO_APPROVE_TOOLS) {
      const result = await hook!(makePreToolInput(toolName), 'tool-use-id', {} as Parameters<HookCallback>[2]);
      expect(result).toMatchObject({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      });
    }
    expect(requestApproval).toHaveBeenCalledTimes(0);

    // Bash and Read should go through ApprovalRouter
    for (const toolName of ['Bash', 'Read']) {
      const result = await hook!(makePreToolInput(toolName), 'tool-use-id', {} as Parameters<HookCallback>[2]);
      expect(result).toMatchObject({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      });
    }
    expect(requestApproval).toHaveBeenCalledTimes(2);
  });

  // ─── Test 4: deny decision threads through permissionDecisionReason ──────

  it('deny decision is translated with permissionDecisionReason when message is set', async () => {
    const requestApproval = vi.fn().mockResolvedValue({
      behavior: 'deny' as const,
      message: 'User rejected the tool call',
    });

    vi.spyOn(ApprovalRouter, 'getInstance').mockReturnValue({
      requestApproval,
    } as unknown as ApprovalRouter);

    const hook = buildPreToolUseHook('default', RUN_ID);
    expect(hook).toBeDefined();

    const result = await hook!(makePreToolInput('Bash'), 'tool-use-id', {} as Parameters<HookCallback>[2]);
    expect(result).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'User rejected the tool call',
      },
    });
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  // ─── Test 5: ApprovalRouter throws → safe deny ───────────────────────────

  it('ApprovalRouter throwing yields permissionDecision deny with internal error reason', async () => {
    const requestApproval = vi.fn().mockRejectedValue(new Error('DB connection lost'));

    vi.spyOn(ApprovalRouter, 'getInstance').mockReturnValue({
      requestApproval,
    } as unknown as ApprovalRouter);

    const hook = buildPreToolUseHook('default', RUN_ID);
    expect(hook).toBeDefined();

    const result = await hook!(makePreToolInput('Bash'), 'tool-use-id', {} as Parameters<HookCallback>[2]);
    expect(result).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Internal approval-router error',
      },
    });
  });
});
