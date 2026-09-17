/**
 * Behavior parity tests for MessageProjection.
 *
 * Strategy: Verify that MessageProjection.project() produces UnifiedMessage
 * output that is functionally equivalent to what the old renderer-side
 * ClaudeMessageTransformer would have produced for the same events.
 *
 * Coverage:
 *   1. system/init → UnifiedMessage with role='system', systemSubtype='init'
 *   2. system/compact_boundary → UnifiedMessage with role='system', systemSubtype='context_compacted', compactTrigger+preTokens in metadata
 *   3. assistant with text → UnifiedMessage with role='assistant', text segment
 *   4. assistant with tool_use → UnifiedMessage with tool_call segment (pending initially)
 *   5. assistant with thinking block → UnifiedMessage with thinking segment
 *   6. user with tool_result (string content) → null (absorbed; correlates ToolCall)
 *   7. user with tool_result (array content) → null (absorbed; correlates ToolCall)
 *   8. result/success → null (old transformer returns null for non-error results)
 *   9. result/error_during_execution → UnifiedMessage with role='system', systemSubtype='error'
 *  10. stream_event → null
 *  11. __unknown__ → null
 *  12. Tool-result correlation: tool_call status updated to 'success' after user event
 *  13. Thinking block content preserved trimmed
 *  14. Synthetic error (model='<synthetic>') → role='system', systemSubtype='error'
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MessageProjection } from '../messageProjection';
import type {
  SystemInitEvent,
  SystemCompactBoundaryEvent,
  SystemTaskStartedEvent,
  SystemTaskUpdatedEvent,
  SystemTaskNotificationEvent,
  AssistantEvent,
  UserEvent,
  ResultEvent,
  StreamEvent,
  UnknownStreamEvent,
} from '../../types/claudeStream';
import type { UnifiedMessage } from '../../types/unifiedMessage';

// ---------------------------------------------------------------------------
// Fixture helpers — typed ClaudeStreamEvent instances
// ---------------------------------------------------------------------------

const SESSION_ID = 'sess-parity-001';
const TOOL_USE_ID = 'toolu_01A09q90qw90lq917835lq9';
const TOOL_USE_ID_2 = 'toolu_02B10r01rz01mr028946mr0';
const MSG_ID = 'msg_01XFDUDYJgAACzvnptvVoYEL';

const systemInitEvent: SystemInitEvent = {
  type: 'system',
  subtype: 'init',
  session_id: SESSION_ID,
  cwd: '/Users/dev/projects/myapp',
  model: 'claude-opus-4-5',
  tools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
  mcp_servers: [],
  permissionMode: 'bypassPermissions',
  apiKeySource: 'ANTHROPIC_API_KEY',
  claude_code_version: '1.0.0',
};

const systemCompactBoundaryEvent: SystemCompactBoundaryEvent = {
  type: 'system',
  subtype: 'compact_boundary',
  session_id: SESSION_ID,
  compact_metadata: {
    trigger: 'auto',
    pre_tokens: 90000,
  },
};

const assistantTextEvent: AssistantEvent = {
  type: 'assistant',
  message: {
    id: MSG_ID,
    model: 'claude-opus-4-5',
    role: 'assistant',
    content: [{ type: 'text', text: 'I will help you with that task.' }],
    usage: { input_tokens: 1024, output_tokens: 87 },
  },
  session_id: SESSION_ID,
};

const assistantToolUseEvent: AssistantEvent = {
  type: 'assistant',
  message: {
    id: MSG_ID,
    model: 'claude-opus-4-5',
    role: 'assistant',
    content: [
      { type: 'text', text: "I'll run a command to check." },
      { type: 'tool_use', id: TOOL_USE_ID, name: 'Bash', input: { command: 'ls -la' } },
    ],
    usage: { input_tokens: 1024, output_tokens: 87 },
  },
  session_id: SESSION_ID,
};

const assistantThinkingEvent: AssistantEvent = {
  type: 'assistant',
  message: {
    id: 'msg_thinking',
    model: 'claude-opus-4-5',
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: '  Let me think about this carefully.  ' },
      { type: 'text', text: 'Based on my analysis...' },
    ],
  },
  session_id: SESSION_ID,
};

const userStringContentEvent: UserEvent = {
  type: 'user',
  message: {
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: TOOL_USE_ID,
      content: 'total 48\ndrwxr-xr-x  12 dev  staff   384 Jan  1 12:00 .',
      is_error: false,
    }],
  },
  parent_tool_use_id: TOOL_USE_ID,
  session_id: SESSION_ID,
};

const userArrayContentEvent: UserEvent = {
  type: 'user',
  message: {
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: TOOL_USE_ID_2,
      content: [{ type: 'text', text: 'File written successfully.' }],
      is_error: false,
    }],
  },
  parent_tool_use_id: TOOL_USE_ID_2,
  session_id: SESSION_ID,
};

const resultSuccessEvent: ResultEvent = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 12543,
  num_turns: 3,
  result: 'Task completed successfully.',
  total_cost_usd: 0.0234,
  session_id: SESSION_ID,
};

const resultErrorEvent: ResultEvent = {
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  duration_ms: 5678,
  num_turns: 2,
  result: 'An unrecoverable error occurred during execution: Connection to API lost.',
  total_cost_usd: 0.0089,
  session_id: SESSION_ID,
};

const streamEventFixture: StreamEvent = {
  type: 'stream_event',
  event: {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: "I'll help you with that." },
  },
  session_id: SESSION_ID,
};

const unknownEventFixture: UnknownStreamEvent = {
  kind: '__unknown__',
  raw: { type: 'future_variant', foo: 'bar' },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MessageProjection', () => {
  let projection: MessageProjection;

  beforeEach(() => {
    projection = new MessageProjection('run-parity-test');
  });

  // -------------------------------------------------------------------------
  // 1. system/init
  // -------------------------------------------------------------------------

  it('projects system/init to a system message with systemSubtype=init and system_info segment', () => {
    const result = projection.project(systemInitEvent);

    expect(result).not.toBeNull();
    const msg = result as UnifiedMessage;
    expect(msg.role).toBe('system');
    expect(msg.metadata?.systemSubtype).toBe('init');
    expect(msg.segments).toHaveLength(1);
    expect(msg.segments[0].type).toBe('system_info');
    if (msg.segments[0].type === 'system_info') {
      expect(msg.segments[0].info.model).toBe('claude-opus-4-5');
      expect(msg.segments[0].info.cwd).toBe('/Users/dev/projects/myapp');
      expect(Array.isArray(msg.segments[0].info.tools)).toBe(true);
      expect(msg.segments[0].info.session_id).toBe(SESSION_ID);
    }
  });

  // -------------------------------------------------------------------------
  // 2. system/compact_boundary
  // -------------------------------------------------------------------------

  it('projects system/compact_boundary to a system message with systemSubtype=context_compacted', () => {
    const result = projection.project(systemCompactBoundaryEvent);

    expect(result).not.toBeNull();
    const msg = result as UnifiedMessage;
    expect(msg.role).toBe('system');
    expect(msg.metadata?.systemSubtype).toBe('context_compacted');
    expect(msg.metadata?.compactTrigger).toBe('auto');
    expect(msg.metadata?.preTokens).toBe(90000);
    // Segments should contain exactly one system_info segment (no text segment).
    expect(msg.segments).toHaveLength(1);
    expect(msg.segments[0].type).toBe('system_info');
    const textSeg = msg.segments.find(s => s.type === 'text');
    expect(textSeg).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 3. assistant with text
  // -------------------------------------------------------------------------

  it('projects assistant with text content to an assistant message with text segment', () => {
    const result = projection.project(assistantTextEvent);

    expect(result).not.toBeNull();
    const msg = result as UnifiedMessage;
    expect(msg.role).toBe('assistant');
    expect(msg.id).toBe(MSG_ID);
    expect(msg.metadata?.agent).toBe('claude');
    expect(msg.metadata?.model).toBe('claude-opus-4-5');
    expect(msg.segments).toHaveLength(1);
    expect(msg.segments[0].type).toBe('text');
    if (msg.segments[0].type === 'text') {
      expect(msg.segments[0].content).toBe('I will help you with that task.');
    }
  });

  // -------------------------------------------------------------------------
  // 5. assistant with tool_use → tool_call segment pending
  // -------------------------------------------------------------------------

  it('projects assistant with tool_use to an assistant message with text and tool_call segments', () => {
    const result = projection.project(assistantToolUseEvent);

    expect(result).not.toBeNull();
    const msg = result as UnifiedMessage;
    expect(msg.role).toBe('assistant');

    const textSeg = msg.segments.find(s => s.type === 'text');
    expect(textSeg).toBeDefined();
    if (textSeg?.type === 'text') {
      expect(textSeg.content).toBe("I'll run a command to check.");
    }

    const toolSeg = msg.segments.find(s => s.type === 'tool_call');
    expect(toolSeg).toBeDefined();
    if (toolSeg?.type === 'tool_call') {
      expect(toolSeg.tool.id).toBe(TOOL_USE_ID);
      expect(toolSeg.tool.name).toBe('Bash');
      expect(toolSeg.tool.status).toBe('pending');
      expect(toolSeg.tool.result).toBeUndefined();
    }
  });

  // -------------------------------------------------------------------------
  // 6. assistant with thinking block
  // -------------------------------------------------------------------------

  it('projects assistant with thinking block to a message with thinking and text segments', () => {
    const result = projection.project(assistantThinkingEvent);

    expect(result).not.toBeNull();
    const msg = result as UnifiedMessage;
    expect(msg.role).toBe('assistant');

    const thinkSeg = msg.segments.find(s => s.type === 'thinking');
    expect(thinkSeg).toBeDefined();
    if (thinkSeg?.type === 'thinking') {
      // Content must be trimmed (old transformer trimmed it).
      expect(thinkSeg.content).toBe('Let me think about this carefully.');
    }

    const textSeg = msg.segments.find(s => s.type === 'text');
    expect(textSeg).toBeDefined();
    if (textSeg?.type === 'text') {
      expect(textSeg.content).toBe('Based on my analysis...');
    }
  });

  // -------------------------------------------------------------------------
  // 7. user with tool_result (string content) → null
  // -------------------------------------------------------------------------

  it('returns null for user event with tool_result string content (absorbed, not rendered)', () => {
    const result = projection.project(userStringContentEvent);
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 8. user with tool_result (array content) → null
  // -------------------------------------------------------------------------

  it('returns null for user event with tool_result array content (absorbed, not rendered)', () => {
    const result = projection.project(userArrayContentEvent);
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 8b. user with a text block → user-role message (monitor conversation turn)
  // -------------------------------------------------------------------------

  it('projects a user event with a text block to a user-role text message', () => {
    const userTextEvent: UserEvent = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: '  Why did the build step fail?  ' }],
      },
      parent_tool_use_id: null,
      session_id: SESSION_ID,
    };

    const result = projection.project(userTextEvent);

    expect(result).not.toBeNull();
    const msg = result as UnifiedMessage;
    expect(msg.role).toBe('user');
    expect(msg.id).toMatch(/^user_msg_/);
    expect(msg.segments).toHaveLength(1);
    expect(msg.segments[0].type).toBe('text');
    if (msg.segments[0].type === 'text') {
      // Trimmed.
      expect(msg.segments[0].content).toBe('Why did the build step fail?');
    }
    expect(msg.metadata).toEqual({});
  });

  it('joins multiple non-empty text blocks and drops empty ones in a user event', () => {
    const userTextEvent: UserEvent = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'First line' },
          { type: 'text', text: '   ' },
          { type: 'text', text: 'Second line' },
        ],
      },
      parent_tool_use_id: null,
    };

    const result = projection.project(userTextEvent);

    expect(result).not.toBeNull();
    const msg = result as UnifiedMessage;
    expect(msg.role).toBe('user');
    expect(msg.segments[0].type).toBe('text');
    if (msg.segments[0].type === 'text') {
      expect(msg.segments[0].content).toBe('First line\nSecond line');
    }
  });

  it('returns null for a user event whose only text block is whitespace (tool_result-only behavior preserved)', () => {
    const userWhitespaceEvent: UserEvent = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: '   ' }],
      },
      parent_tool_use_id: null,
    };

    const result = projection.project(userWhitespaceEvent);
    expect(result).toBeNull();
  });

  it('returns null for a user TEXT event that carries a parent_tool_use_id (sub-agent INPUT PROMPT, not a chat turn)', () => {
    // The SDK echoes a Task-spawned sub-agent's input prompt as a user-text event
    // nested under its tool_use (parent_tool_use_id set). These are internal plumbing
    // — rendering them leaked giant agent prompts as "You" bubbles (smoke 2026-06-22).
    // Only TOP-LEVEL (parentless) user-text — the monitor's injected turns — renders.
    const subAgentPromptEvent: UserEvent = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'You are implementing **TASK-002** for the current sprint.' }],
      },
      parent_tool_use_id: TOOL_USE_ID,
    };

    const result = projection.project(subAgentPromptEvent);
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 9. result/success → null
  // -------------------------------------------------------------------------

  it('returns null for result/success (old transformer also returned null for non-error results)', () => {
    const result = projection.project(resultSuccessEvent);
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 10. result/error_during_execution → system error message
  // -------------------------------------------------------------------------

  it('projects result/error_during_execution to a system error message', () => {
    const result = projection.project(resultErrorEvent);

    expect(result).not.toBeNull();
    const msg = result as UnifiedMessage;
    expect(msg.role).toBe('system');
    expect(msg.metadata?.systemSubtype).toBe('error');
    expect(msg.segments).toHaveLength(1);
    expect(msg.segments[0].type).toBe('text');
    if (msg.segments[0].type === 'text') {
      expect(msg.segments[0].content).toContain('An unrecoverable error occurred');
    }
    expect(msg.metadata?.cost).toBe(0.0089);
    expect(msg.metadata?.duration).toBe(5678);
  });

  // -------------------------------------------------------------------------
  // 11. stream_event → null
  // -------------------------------------------------------------------------

  it('returns null for stream_event deltas (absorbed, not rendered)', () => {
    const result = projection.project(streamEventFixture);
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 12. __unknown__ → null
  // -------------------------------------------------------------------------

  it('returns null for unknown variants', () => {
    const result = projection.project(unknownEventFixture);
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 12b. system event with unrecognised subtype → null (covers projectSystemEvent fallthrough)
  //
  // The Zod schema now only accepts 'init' and 'compact_boundary' system subtypes,
  // but the TypeScript union still includes SystemApiRetryEvent and SystemCompactEvent
  // (preserved in shared/types/claudeStream.ts as migration stubs). Injecting such a
  // subtype through the project() public API verifies that projectSystemEvent()'s
  // fallthrough `return null` fires rather than crashing.
  // -------------------------------------------------------------------------

  it('returns null for a system event with an unrecognised subtype', () => {
    // Use a legacy-TS-union subtype that the runtime no longer handles.
    const unknownSubtypeEvent = {
      type: 'system',
      subtype: 'api_retry',
      attempt: 1,
      max_retries: 3,
      retry_delay_ms: 1000,
    } as unknown as Parameters<typeof projection.project>[0];

    const result = projection.project(unknownSubtypeEvent);
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 13. Tool-result correlation: ToolCall status updated after user event
  // -------------------------------------------------------------------------

  it('correlates tool_result with tool_call — status becomes success after user event arrives', () => {
    // Emit the assistant event first (tool_call is pending initially).
    const assistantResult = projection.project(assistantToolUseEvent);
    expect(assistantResult).not.toBeNull();

    const assistantMsg = assistantResult as UnifiedMessage;
    const toolSeg = assistantMsg.segments.find(s => s.type === 'tool_call');
    expect(toolSeg?.type).toBe('tool_call');
    if (toolSeg?.type === 'tool_call') {
      // Initially pending.
      expect(toolSeg.tool.status).toBe('pending');
    }

    // Emit the user event (tool_result for the same tool_use_id).
    const userResult = projection.project(userStringContentEvent);
    expect(userResult).toBeNull(); // User events are absorbed.

    // The ToolCall stored in allToolCalls should now be updated in-place.
    // The segment in assistantMsg.segments still holds a reference to the same
    // ToolCall object, so it should now reflect the updated status.
    if (toolSeg?.type === 'tool_call') {
      expect(toolSeg.tool.status).toBe('success');
      expect(toolSeg.tool.result).toBeDefined();
      expect(toolSeg.tool.result?.content).toContain('drwxr-xr-x');
      expect(toolSeg.tool.result?.isError).toBe(false);
    }
  });

  // -------------------------------------------------------------------------
  // 14. Tool-result array content serialized to JSON string
  // -------------------------------------------------------------------------

  it('serializes array tool_result content to a JSON string (matches old transformer behavior)', () => {
    // Set up an assistant event that uses TOOL_USE_ID_2.
    const assistantEvent2: AssistantEvent = {
      type: 'assistant',
      message: {
        id: 'msg_write',
        model: 'claude-opus-4-5',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: TOOL_USE_ID_2, name: 'Write', input: { file_path: '/src/index.ts', content: 'export {};' } },
        ],
      },
    };

    projection.project(assistantEvent2);
    projection.project(userArrayContentEvent);

    // After the user event, the ToolCall should have its result set.
    // Access it indirectly by projecting another assistant event and checking the
    // in-memory state; or just verify via a fresh projection check.
    // The simplest way: project the assistant event before the user event on a
    // fresh instance so the tool starts pending, then check after user event.
    const freshProjection = new MessageProjection('run-array-test');
    const assistResult = freshProjection.project(assistantEvent2) as UnifiedMessage;
    const toolCallSeg = assistResult.segments.find(s => s.type === 'tool_call');
    expect(toolCallSeg?.type).toBe('tool_call');

    freshProjection.project(userArrayContentEvent);

    if (toolCallSeg?.type === 'tool_call') {
      expect(toolCallSeg.tool.status).toBe('success');
      expect(typeof toolCallSeg.tool.result?.content).toBe('string');
      // Array content is JSON-stringified.
      expect(toolCallSeg.tool.result?.content).toContain('File written successfully.');
    }
  });

  // -------------------------------------------------------------------------
  // 15. Synthetic error (model='<synthetic>') → system message
  // -------------------------------------------------------------------------

  it('projects a synthetic error assistant message (model=<synthetic>) to a system error message', () => {
    const syntheticErrorEvent: AssistantEvent = {
      type: 'assistant',
      message: {
        id: 'msg_synthetic',
        model: '<synthetic>',
        role: 'assistant',
        content: [{ type: 'text', text: 'API Error: Something went wrong.' }],
      },
    };

    const result = projection.project(syntheticErrorEvent);
    expect(result).not.toBeNull();

    const msg = result as UnifiedMessage;
    // Old transformer: isSyntheticError → role = 'system', systemSubtype = 'error'.
    expect(msg.role).toBe('system');
    expect(msg.metadata?.systemSubtype).toBe('error');
  });

  it('carries the SDK\'s structured error code (assistant.error) onto metadata.assistantError', () => {
    // The CLI's auth-failure shape: a synthetic message whose text does NOT
    // contain "error", so the text sniff alone would render it as an ordinary
    // assistant turn — the string code is what marks it.
    const authFailedEvent: AssistantEvent = {
      type: 'assistant',
      message: {
        id: 'msg_auth_failed',
        model: '<synthetic>',
        role: 'assistant',
        content: [{ type: 'text', text: 'Not logged in · Please run /login' }],
      },
      error: 'authentication_failed',
    };

    const msg = projection.project(authFailedEvent) as UnifiedMessage;
    expect(msg).not.toBeNull();
    expect(msg.role).toBe('system');
    expect(msg.metadata?.systemSubtype).toBe('error');
    expect(msg.metadata?.assistantError).toBe('authentication_failed');
  });

  it('leaves metadata.assistantError absent on an ordinary assistant turn', () => {
    const plain: AssistantEvent = {
      type: 'assistant',
      message: {
        id: 'msg_plain',
        model: 'claude-opus-4-5',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
      },
    };
    const msg = projection.project(plain) as UnifiedMessage;
    expect(msg.role).toBe('assistant');
    expect('assistantError' in (msg.metadata ?? {})).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 16. Empty assistant message → null
  // -------------------------------------------------------------------------

  it('returns null for an assistant event with no renderable content', () => {
    const emptyAssistant: AssistantEvent = {
      type: 'assistant',
      message: {
        id: 'msg_empty',
        model: 'claude-opus-4-5',
        role: 'assistant',
        content: [], // no blocks
      },
    };

    const result = projection.project(emptyAssistant);
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 17. Token metadata preserved from assistant event
  // -------------------------------------------------------------------------

  it('preserves token count from assistant event usage', () => {
    const result = projection.project(assistantTextEvent);
    const msg = result as UnifiedMessage;
    // input_tokens=1024 + output_tokens=87 = 1111.
    expect(msg.metadata?.tokens).toBe(1111);
  });

  // -------------------------------------------------------------------------
  // 18. Warn logger called on unexpected error — payload assertion (FIND-SPRINT-005-10)
  // -------------------------------------------------------------------------

  it('calls logger.warn with a non-empty message when an unexpected error occurs', () => {
    const warnings: string[] = [];
    const warnProjection = new MessageProjection('run-warn-test', {
      warn: (msg) => warnings.push(msg),
    });

    // null message triggers a TypeError inside projectAssistantEvent, which the
    // try/catch at the top of project() catches and delegates to logger.warn.
    const malformedEvent = { type: 'assistant', message: null } as unknown as AssistantEvent;

    expect(() => {
      warnProjection.project(malformedEvent);
    }).not.toThrow();

    // FIND-SPRINT-005-10: the warn call must actually fire with a non-empty string.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/\[MessageProjection\]/);
    expect(warnings[0]).toContain('run-warn-test');
  });

  // -------------------------------------------------------------------------
  // 19. Out-of-order: tool_result arrives before tool_use
  // -------------------------------------------------------------------------

  it('correctly marks ToolCall as success when tool_result arrives before tool_use', () => {
    // Send the user/tool_result event first — before the assistant event.
    // No parent_tool_use_id so the result is not recorded in parentToolMap.
    const earlyUserEvent: UserEvent = {
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: TOOL_USE_ID,
          content: 'early result content',
          is_error: false,
        }],
      },
      session_id: SESSION_ID,
    };

    const userResult = projection.project(earlyUserEvent);
    expect(userResult).toBeNull(); // always absorbed

    // Now send the assistant event that creates the ToolCall.
    const result = projection.project(assistantToolUseEvent);
    expect(result).not.toBeNull();
    const msg = result as UnifiedMessage;

    const toolSeg = msg.segments.find(s => s.type === 'tool_call');
    expect(toolSeg?.type).toBe('tool_call');
    if (toolSeg?.type === 'tool_call') {
      // Because the result was already stored, the ToolCall must start as success.
      expect(toolSeg.tool.status).toBe('success');
      expect(toolSeg.tool.result?.content).toBe('early result content');
      expect(toolSeg.tool.result?.isError).toBe(false);
    }
  });

  // -------------------------------------------------------------------------
  // 20. Tool result with is_error: true → ToolCall status becomes 'error'
  // -------------------------------------------------------------------------

  it('sets ToolCall status to error when tool_result carries is_error=true', () => {
    // Emit the assistant event first so the ToolCall starts pending.
    projection.project(assistantToolUseEvent);

    const errorUserEvent: UserEvent = {
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: TOOL_USE_ID,
          content: 'bash: command not found',
          is_error: true,
        }],
      },
      parent_tool_use_id: TOOL_USE_ID,
      session_id: SESSION_ID,
    };

    const userResult = projection.project(errorUserEvent);
    expect(userResult).toBeNull(); // absorbed

    // Re-project the assistant event on a shared projection that already has the
    // tool call registered. Inspect via the segment reference stored on the first
    // projection (correlation updates in-place).
    const freshProj = new MessageProjection('run-error-tool-test');
    const assistResult = freshProj.project(assistantToolUseEvent) as UnifiedMessage;
    const toolSeg = assistResult.segments.find(s => s.type === 'tool_call');

    // Now send the error result.
    freshProj.project(errorUserEvent);

    if (toolSeg?.type === 'tool_call') {
      expect(toolSeg.tool.status).toBe('error');
      expect(toolSeg.tool.result?.isError).toBe(true);
      expect(toolSeg.tool.result?.content).toContain('command not found');
    }
  });

  // -------------------------------------------------------------------------
  // 21. Sub-agent: child tool_use linked to parent via parent_tool_use_id
  // -------------------------------------------------------------------------

  it('links child tool_use into parent.childToolCalls and omits child from top-level segments', () => {
    const PARENT_TOOL_ID = 'toolu_parent_task';
    const CHILD_TOOL_ID = 'toolu_child_bash';

    // First event: parent assistant message with a Task tool_use.
    const parentAssistantEvent: AssistantEvent = {
      type: 'assistant',
      message: {
        id: 'msg_parent',
        model: 'claude-opus-4-5',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: PARENT_TOOL_ID, name: 'Task', input: { subagent_type: 'general', prompt: 'Do X' } },
        ],
      },
      session_id: SESSION_ID,
    };

    // Second event: child assistant message (sub-agent) with parent_tool_use_id set.
    const childAssistantEvent: AssistantEvent = {
      type: 'assistant',
      message: {
        id: 'msg_child',
        model: 'claude-opus-4-5',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: CHILD_TOOL_ID, name: 'Bash', input: { command: 'echo hello' } },
        ],
      },
      parent_tool_use_id: PARENT_TOOL_ID,
      session_id: SESSION_ID,
    };

    const parentResult = projection.project(parentAssistantEvent) as UnifiedMessage;
    expect(parentResult).not.toBeNull();

    // Child event should return a message (it has content) but the child tool_use
    // must NOT appear as a top-level segment (it has a parent).
    const childResult = projection.project(childAssistantEvent);
    // Child message is null because the only tool_use is nested (omitted from segments)
    // and there are no other renderable blocks.
    expect(childResult).toBeNull();

    // Parent's Task ToolCall should now have the child in childToolCalls.
    const parentToolSeg = parentResult.segments.find(s => s.type === 'tool_call');
    expect(parentToolSeg?.type).toBe('tool_call');
    if (parentToolSeg?.type === 'tool_call') {
      expect(parentToolSeg.tool.name).toBe('Task');
      expect(parentToolSeg.tool.isSubAgent).toBe(true);
      expect(parentToolSeg.tool.childToolCalls).toHaveLength(1);
      expect(parentToolSeg.tool.childToolCalls?.[0].id).toBe(CHILD_TOOL_ID);
      expect(parentToolSeg.tool.childToolCalls?.[0].name).toBe('Bash');
    }
  });

  // -------------------------------------------------------------------------
  // 21b. Sub-agent: parented assistant TEXT / THINKING is internal narration,
  //      never a turn in the parent chat.
  // -------------------------------------------------------------------------

  it('returns null for a parented assistant event carrying text (SUB-AGENT narration, not a chat turn)', () => {
    // Real prod shape (raw_events, 2026-07-24): a dispatched sub-agent's own
    // narration forwarded with parent_tool_use_id set. Pre-fix these projected
    // to top-level assistant bubbles, so the sub-agent appeared to be talking
    // in the main chat.
    const PARENT_TOOL_ID = 'toolu_parent_agent';

    const parentAssistantEvent: AssistantEvent = {
      type: 'assistant',
      message: {
        id: 'msg_parent_text',
        model: 'claude-opus-4-5',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: PARENT_TOOL_ID, name: 'Agent', input: { subagent_type: 'code-review', prompt: 'Review X' } },
        ],
      },
      session_id: SESSION_ID,
    };

    const subAgentTextEvent: AssistantEvent = {
      type: 'assistant',
      message: {
        id: 'msg_subagent_text',
        model: 'claude-opus-4-5',
        role: 'assistant',
        content: [
          { type: 'text', text: 'I have completed a thorough review. Here are my findings.' },
        ],
      },
      parent_tool_use_id: PARENT_TOOL_ID,
      session_id: SESSION_ID,
    };

    projection.project(parentAssistantEvent);
    expect(projection.project(subAgentTextEvent)).toBeNull();
  });

  it('returns null for a parented assistant event carrying thinking (SUB-AGENT reasoning)', () => {
    const PARENT_TOOL_ID = 'toolu_parent_agent_thinking';

    const parentAssistantEvent: AssistantEvent = {
      type: 'assistant',
      message: {
        id: 'msg_parent_thinking',
        model: 'claude-opus-4-5',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: PARENT_TOOL_ID, name: 'Agent', input: { subagent_type: 'general', prompt: 'Do X' } },
        ],
      },
      session_id: SESSION_ID,
    };

    const subAgentThinkingEvent: AssistantEvent = {
      type: 'assistant',
      message: {
        id: 'msg_subagent_thinking',
        model: 'claude-opus-4-5',
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Let me check how sessions:input resolves the panel.' },
        ],
      },
      parent_tool_use_id: PARENT_TOOL_ID,
      session_id: SESSION_ID,
    };

    projection.project(parentAssistantEvent);
    expect(projection.project(subAgentThinkingEvent)).toBeNull();
  });

  it('still nests a parented tool_use when the same event also carries suppressed sub-agent text', () => {
    // Mixed block shape: the narration must be dropped WITHOUT losing the
    // child tool_use's link into the parent's childToolCalls.
    const PARENT_TOOL_ID = 'toolu_parent_mixed';
    const CHILD_TOOL_ID = 'toolu_child_mixed';

    const parentAssistantEvent: AssistantEvent = {
      type: 'assistant',
      message: {
        id: 'msg_parent_mixed',
        model: 'claude-opus-4-5',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: PARENT_TOOL_ID, name: 'Agent', input: { subagent_type: 'general', prompt: 'Do X' } },
        ],
      },
      session_id: SESSION_ID,
    };

    const subAgentMixedEvent: AssistantEvent = {
      type: 'assistant',
      message: {
        id: 'msg_subagent_mixed',
        model: 'claude-opus-4-5',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check the remaining set-substrate path.' },
          { type: 'tool_use', id: CHILD_TOOL_ID, name: 'Bash', input: { command: 'echo hi' } },
        ],
      },
      parent_tool_use_id: PARENT_TOOL_ID,
      session_id: SESSION_ID,
    };

    const parentResult = projection.project(parentAssistantEvent) as UnifiedMessage;
    expect(projection.project(subAgentMixedEvent)).toBeNull();

    const parentToolSeg = parentResult.segments.find(s => s.type === 'tool_call');
    expect(parentToolSeg?.type).toBe('tool_call');
    if (parentToolSeg?.type === 'tool_call') {
      expect(parentToolSeg.tool.childToolCalls).toHaveLength(1);
      expect(parentToolSeg.tool.childToolCalls?.[0].id).toBe(CHILD_TOOL_ID);
    }
  });

  it('still emits text and thinking for a TOP-LEVEL (parentless) assistant event', () => {
    // Guard the guard: the parent-less main-agent turn must be unaffected.
    const topLevelEvent: AssistantEvent = {
      type: 'assistant',
      message: {
        id: 'msg_top_level_mixed',
        model: 'claude-opus-4-5',
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Considering the options.' },
          { type: 'text', text: 'Here is the answer.' },
        ],
      },
      session_id: SESSION_ID,
    };

    const result = projection.project(topLevelEvent) as UnifiedMessage;
    expect(result).not.toBeNull();
    expect(result.segments.map(s => s.type)).toEqual(['thinking', 'text']);
  });

  // -------------------------------------------------------------------------
  // 21c. system/task_notification — the background task's FINAL REPORT. For a
  //      backgrounded sub-agent this is the only copy on the parent stream.
  // -------------------------------------------------------------------------

  function taskNotification(overrides: Partial<SystemTaskNotificationEvent> = {}): SystemTaskNotificationEvent {
    return {
      type: 'system',
      subtype: 'task_notification',
      task_id: 'a4aff561826d6af1d',
      tool_use_id: 'toolu_01Kg1f8DZg7qmL4T941zw7eL',
      status: 'completed',
      summary: '## Dependencies\n\nTASK-108 depends on TASK-107.',
      output_file: '/tmp/tasks/a4aff561826d6af1d.output',
      usage: { total_tokens: 57286, tool_uses: 6, duration_ms: 17830 },
      uuid: 'uuid-task-notification',
      session_id: SESSION_ID,
      ...overrides,
    };
  }

  it('projects system/task_notification into a system message carrying the report', () => {
    const result = projection.project(taskNotification()) as UnifiedMessage;

    expect(result).not.toBeNull();
    expect(result.role).toBe('system');
    expect(result.metadata?.systemSubtype).toBe('task_complete');
    expect(result.segments).toEqual([
      { type: 'text', content: '## Dependencies\n\nTASK-108 depends on TASK-107.' },
    ]);
    // The dispatching tool_use, so a renderer can attribute the report.
    expect(result.metadata?.parentToolId).toBe('toolu_01Kg1f8DZg7qmL4T941zw7eL');
    expect(result.metadata?.taskStatus).toBe('completed');
    expect(result.metadata?.tokens).toBe(57286);
    expect(result.metadata?.duration).toBe(17830);
  });

  it('preserves a non-completed task status so the renderer can flag it', () => {
    const result = projection.project(
      taskNotification({ status: 'failed', summary: 'Ran out of context.' }),
    ) as UnifiedMessage;

    expect(result.metadata?.taskStatus).toBe('failed');
    expect(result.segments).toEqual([{ type: 'text', content: 'Ran out of context.' }]);
  });

  it('returns null for a COMPLETED task_notification with no summary (nothing to show)', () => {
    expect(projection.project(taskNotification({ summary: undefined }))).toBeNull();
    expect(projection.project(taskNotification({ summary: '   ' }))).toBeNull();
  });

  it('still surfaces a FAILED/STOPPED task_notification that carries no summary', () => {
    // `summary` is optional on the wire; the notification is the only terminal
    // signal for a background task, so a failure must never be swallowed.
    projection.project(taskStarted({ task_id: 'task_fail', description: 'Run the gate' }));
    const failed = projection.project(
      taskNotification({ task_id: 'task_fail', status: 'failed', summary: undefined }),
    ) as UnifiedMessage;

    expect(failed).not.toBeNull();
    expect(failed.metadata?.taskStatus).toBe('failed');
    expect(failed.segments).toEqual([{ type: 'text', content: 'Task failed. Run the gate' }]);

    const stopped = projection.project(
      taskNotification({ task_id: 'task_stop', status: 'stopped', summary: undefined }),
    ) as UnifiedMessage;
    // No task_started seen for this one — still surfaced, just without a description.
    expect(stopped.segments).toEqual([{ type: 'text', content: 'Task stopped.' }]);
  });

  // -------------------------------------------------------------------------
  // 21d. Task ATTRIBUTION — `local_bash` background commands share the task
  //      lifecycle with Agent-tool subagents (and outnumber them), so a
  //      notification must not be labelled a sub-agent report by default.
  // -------------------------------------------------------------------------

  function taskStarted(overrides: Partial<SystemTaskStartedEvent> = {}): SystemTaskStartedEvent {
    return {
      type: 'system',
      subtype: 'task_started',
      task_id: 'b48iau5q5',
      tool_use_id: 'toolu_01UKGFjnFervr56MbWGBbSQJ',
      description: 'background work',
      task_type: 'local_agent',
      uuid: 'uuid-task-started',
      session_id: SESSION_ID,
      ...overrides,
    };
  }

  it('projects task_started to null but records the task identity', () => {
    expect(projection.project(taskStarted())).toBeNull();

    const result = projection.project(taskNotification({ task_id: 'b48iau5q5' })) as UnifiedMessage;
    expect(result.metadata?.taskKind).toBe('agent');
  });

  it('classifies a local_bash task as a command, not a sub-agent', () => {
    projection.project(taskStarted({
      task_id: 'bash_1',
      task_type: 'local_bash',
      description: 'Locate soloflow plugin root',
    }));
    const result = projection.project(
      taskNotification({ task_id: 'bash_1', summary: 'found it' }),
    ) as UnifiedMessage;

    expect(result.metadata?.taskKind).toBe('command');
    expect(result.metadata?.subagentType).toBeUndefined();
    expect(result.metadata?.taskDescription).toBe('Locate soloflow plugin root');
  });

  it('attributes CONCURRENT agent and local_bash tasks to the right identity', () => {
    // Both lifecycles interleave on one stream; attribution is by task_id, so a
    // notification must never pick up the other task's identity.
    projection.project(taskStarted({ task_id: 'agent_1', task_type: 'local_agent', subagent_type: 'cyboflow-code-review' }));
    projection.project(taskStarted({ task_id: 'bash_1', task_type: 'local_bash', description: 'pnpm test' }));

    const bashResult = projection.project(
      taskNotification({ task_id: 'bash_1', summary: '12 passed' }),
    ) as UnifiedMessage;
    const agentResult = projection.project(
      taskNotification({ task_id: 'agent_1', summary: 'Review findings…' }),
    ) as UnifiedMessage;

    expect(bashResult.metadata?.taskKind).toBe('command');
    expect(bashResult.metadata?.subagentType).toBeUndefined();
    expect(agentResult.metadata?.taskKind).toBe('agent');
    expect(agentResult.metadata?.subagentType).toBe('cyboflow-code-review');
  });

  it('classifies as agent from subagent_type alone when task_type is absent', () => {
    // The fake-SDK builders emit exactly this shape. Evidence in hand must not be
    // thrown away in favour of the neutral label.
    projection.project(taskStarted({
      task_id: 'agent_no_type',
      task_type: undefined,
      subagent_type: 'cyboflow-implement',
    }));
    const result = projection.project(
      taskNotification({ task_id: 'agent_no_type' }),
    ) as UnifiedMessage;

    expect(result.metadata?.taskKind).toBe('agent');
    expect(result.metadata?.subagentType).toBe('cyboflow-implement');
  });

  // -------------------------------------------------------------------------
  // 21e. A terminal `task_updated` patch is the OTHER settle path — a task can
  //      end this way with no notification ever arriving (observed in the DB).
  // -------------------------------------------------------------------------

  function taskUpdated(taskId: string, patch: Record<string, unknown>): SystemTaskUpdatedEvent {
    return {
      type: 'system',
      subtype: 'task_updated',
      task_id: taskId,
      patch,
      uuid: 'uuid-task-updated',
      session_id: SESSION_ID,
    };
  }

  it('surfaces a task that FAILS via task_updated with no notification', () => {
    projection.project(taskStarted({ task_id: 'upd_fail', task_type: 'local_bash', description: 'pnpm build' }));
    const result = projection.project(taskUpdated('upd_fail', { status: 'failed' })) as UnifiedMessage;

    expect(result).not.toBeNull();
    expect(result.metadata?.systemSubtype).toBe('task_complete');
    expect(result.metadata?.taskStatus).toBe('failed');
    expect(result.metadata?.taskKind).toBe('command');
    expect(result.segments).toEqual([{ type: 'text', content: 'Task failed. pnpm build' }]);
  });

  it('treats an unrecognised task_updated status as terminal (matches the turn-boundary tracker)', () => {
    // LIVE_TASK_STATUSES is the allow-list; anything outside it settles. A status
    // the vocabulary has not seen must not be assumed live.
    projection.project(taskStarted({ task_id: 'upd_weird' }));
    const result = projection.project(taskUpdated('upd_weird', { status: 'evicted' })) as UnifiedMessage;
    expect(result?.metadata?.taskStatus).toBe('evicted');
  });

  it('ignores a task_updated that does not settle the task', () => {
    projection.project(taskStarted({ task_id: 'upd_live' }));
    expect(projection.project(taskUpdated('upd_live', { status: 'running' }))).toBeNull();
    expect(projection.project(taskUpdated('upd_live', { is_backgrounded: true }))).toBeNull();
    // A CLEAN completion via task_updated carries no summary — nothing to show.
    expect(projection.project(taskUpdated('upd_live', { status: 'completed' }))).toBeNull();
  });

  it('leaves taskKind undefined when no task_started was seen (truncated stream)', () => {
    // The renderer must stay neutral rather than guessing "sub-agent".
    const result = projection.project(taskNotification({ task_id: 'orphan' })) as UnifiedMessage;
    expect(result.metadata?.taskKind).toBeUndefined();
    expect(result.segments[0]).toEqual({ type: 'text', content: '## Dependencies\n\nTASK-108 depends on TASK-107.' });
  });

  // -------------------------------------------------------------------------
  // 22. Partial-message streaming: blocks of ONE logical message arrive as
  //     separate `assistant` events that all share `message.id`. They must
  //     coalesce into a SINGLE UnifiedMessage (no duplicate-keyed messages).
  //
  // Reproduces the real raw_events shape observed in prod: the SDK
  // (`--include-partial-messages`) emits one `assistant` event per completed
  // content block — e.g. thinking → text → tool_use × N — each with exactly
  // one block but the same `message.id`. Pre-fix, project() returned N
  // messages sharing one id → React "two children with the same key" warning.
  // -------------------------------------------------------------------------

  it('coalesces partial-streamed blocks sharing one message.id into a single message', () => {
    const SHARED_ID = 'msg_01ARTvPr5GeVxDUBGbLoiVKf';
    const mk = (content: AssistantEvent['message']['content']): AssistantEvent => ({
      type: 'assistant',
      message: { id: SHARED_ID, model: 'claude-opus-4-5', role: 'assistant', content },
      session_id: SESSION_ID,
    });

    // Block 1: thinking → emits the message.
    const first = projection.project(mk([{ type: 'thinking', thinking: 'Planning the work.' }]));
    expect(first).not.toBeNull();
    const msg = first as UnifiedMessage;
    expect(msg.id).toBe(SHARED_ID);

    // Block 2: text → coalesced (returns null), appended to the same message.
    expect(projection.project(mk([{ type: 'text', text: 'Here is the plan.' }]))).toBeNull();

    // Blocks 3 & 4: two tool_use blocks → also coalesced.
    expect(projection.project(mk([{ type: 'tool_use', id: 'toolu_a', name: 'Agent', input: { x: 1 } }]))).toBeNull();
    expect(projection.project(mk([{ type: 'tool_use', id: 'toolu_b', name: 'Agent', input: { x: 2 } }]))).toBeNull();

    // The first message accumulated all four blocks via the shared segments ref.
    expect(msg.segments.map((s) => s.type)).toEqual(['thinking', 'text', 'tool_call', 'tool_call']);
    const toolCalls = msg.segments.filter((s) => s.type === 'tool_call');
    expect(toolCalls).toHaveLength(2);
  });
});
