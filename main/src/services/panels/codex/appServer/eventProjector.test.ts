import { describe, expect, it } from 'vitest';
import type { AgentStreamEvent } from '../../../../../../shared/types/agentStream';
import type { AppServerNotification } from './client';
import {
  projectTurnSessionEvent,
  type TurnSessionEventProjectionContext,
} from './eventProjector';
import type { TurnSessionEvent, TurnSessionItem } from './turnSession';

const CONTEXT: TurnSessionEventProjectionContext = {
  model: 'gpt-test',
  durationMs: 1_234,
};

function completedItem(item: TurnSessionItem): TurnSessionEvent {
  return {
    type: 'item.completed',
    threadId: 'thread-1',
    turnId: 'turn-1',
    completedAtMs: 100,
    item,
  };
}

function project(event: TurnSessionEvent): AgentStreamEvent[] {
  return projectTurnSessionEvent(event, CONTEXT);
}

describe('projectTurnSessionEvent', () => {
  it('leaves initialization and in-progress events to the manager', () => {
    expect(project({ type: 'thread.started', threadId: 'thread-1' })).toEqual([]);
    expect(project({
      type: 'turn.started',
      threadId: 'thread-1',
      turnId: 'turn-1',
    })).toEqual([]);
    expect(project({
      type: 'thread.tokenUsage.updated',
      threadId: 'thread-1',
      turnId: 'turn-1',
      tokenUsage: {
        total: {
          totalTokens: 15,
          inputTokens: 10,
          cachedInputTokens: 3,
          cacheWriteInputTokens: 1,
          outputTokens: 5,
          reasoningOutputTokens: 2,
        },
        last: {
          totalTokens: 15,
          inputTokens: 10,
          cachedInputTokens: 3,
          cacheWriteInputTokens: 1,
          outputTokens: 5,
          reasoningOutputTokens: 2,
        },
        modelContextWindow: 258_400,
      },
    })).toEqual([]);
    expect(project({
      type: 'item.started',
      threadId: 'thread-1',
      turnId: 'turn-1',
      startedAtMs: 10,
      item: { type: 'agentMessage', id: 'message-1', text: 'partial', questions: null },
    })).toEqual([]);
  });

  it('projects completed assistant text, reasoning, and plans with Codex context', () => {
    expect(project(completedItem({
      type: 'agentMessage',
      id: 'message-1',
      text: 'Implementation complete.',
      questions: null,
    }))).toEqual([{
      type: 'agent_message',
      provider: 'codex',
      runtime: 'codex-sdk',
      role: 'assistant',
      id: 'message-1',
      model: 'gpt-test',
      content: [{ type: 'text', text: 'Implementation complete.' }],
      external_session_id: 'thread-1',
    }]);

    expect(project(completedItem({
      type: 'reasoning',
      id: 'reasoning-1',
      summary: ['Inspect the types.'],
      content: ['Keep the mapper pure.'],
    }))).toEqual([{
      type: 'agent_message',
      provider: 'codex',
      runtime: 'codex-sdk',
      role: 'assistant',
      id: 'reasoning-1',
      model: 'gpt-test',
      content: [{ type: 'thinking', text: 'Inspect the types.\nKeep the mapper pure.' }],
      external_session_id: 'thread-1',
    }]);

    expect(project(completedItem({
      type: 'plan',
      id: 'plan-1',
      text: '1. Implement\n2. Verify',
    }))).toEqual([{
      type: 'agent_message',
      provider: 'codex',
      runtime: 'codex-sdk',
      role: 'assistant',
      id: 'plan-1',
      model: 'gpt-test',
      content: [{ type: 'thinking', text: '1. Implement\n2. Verify' }],
      external_session_id: 'thread-1',
    }]);

    expect(project(completedItem({
      type: 'agentMessage',
      id: 'empty-message',
      text: '   ',
      questions: null,
    }))).toEqual([]);
  });

  it('projects app-server userMessage items for prompt and nudge reconstruction', () => {
    expect(project(completedItem({
      type: 'userMessage',
      id: 'user-1',
      clientId: 'nudge-1',
      content: [
        { type: 'text', text: 'Continue the workflow.', text_elements: [] },
        { type: 'localImage', path: '/tmp/context.png', detail: 'high' },
        { type: 'audio', url: 'https://example.com/clip.mp3' },
        { type: 'localAudio', path: '/tmp/clip.wav' },
      ],
    }))).toEqual([{
      type: 'agent_message',
      provider: 'codex',
      runtime: 'codex-sdk',
      role: 'user',
      content: [{
        type: 'text',
        text: 'Continue the workflow.\n[local image: /tmp/context.png]'
          + '\n[audio: https://example.com/clip.mp3]\n[local audio: /tmp/clip.wav]',
      }],
      external_session_id: 'thread-1',
    }]);
  });

  it('omits an internal workflow prompt echo while preserving raw diagnostics upstream', () => {
    expect(projectTurnSessionEvent(completedItem({
      type: 'userMessage',
      id: 'workflow-launch',
      clientId: null,
      content: [{
        type: 'text',
        text: '# Runtime adapter: Codex\n\nInternal workflow body',
        text_elements: [],
      }],
    }), {
      ...CONTEXT,
      hideUserMessage: true,
    })).toEqual([]);
  });

  it('correlates command, MCP, and web-search calls with their results', () => {
    expect(project(completedItem({
      type: 'commandExecution',
      id: 'command-1',
      command: 'pnpm test',
      cwd: '/tmp/worktree',
      processId: 'process-1',
      source: 'agent',
      commandActions: [{ type: 'unknown', command: 'pnpm test' }],
      status: 'failed',
      aggregatedOutput: 'one test failed',
      exitCode: 1,
      durationMs: 50,
    }))).toEqual([
      {
        type: 'agent_message',
        provider: 'codex',
        runtime: 'codex-sdk',
        role: 'assistant',
        id: 'command-1:call',
        model: 'gpt-test',
        content: [{
          type: 'tool_call',
          id: 'command-1',
          name: 'Bash',
          input: {
            command: 'pnpm test',
            cwd: '/tmp/worktree',
            source: 'agent',
            processId: 'process-1',
            commandActions: [{ type: 'unknown', command: 'pnpm test' }],
          },
        }],
        external_session_id: 'thread-1',
      },
      {
        type: 'agent_message',
        provider: 'codex',
        runtime: 'codex-sdk',
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_call_id: 'command-1',
          content: JSON.stringify({
            status: 'failed',
            output: 'one test failed',
            exitCode: 1,
            durationMs: 50,
          }, null, 2),
          is_error: true,
        }],
        external_session_id: 'thread-1',
      },
    ]);

    expect(project(completedItem({
      type: 'mcpToolCall',
      id: 'mcp-1',
      server: 'cyboflow',
      tool: 'report',
      status: 'completed',
      arguments: { step: 'verify' },
      appContext: null,
      pluginId: null,
      result: { accepted: true },
      error: null,
      durationMs: 10,
    }))).toEqual([
      expect.objectContaining({
        type: 'agent_message',
        provider: 'codex',
        runtime: 'codex-sdk',
        role: 'assistant',
        id: 'mcp-1:call',
        content: [{
          type: 'tool_call',
          id: 'mcp-1',
          name: 'report',
          input: {
            server: 'cyboflow',
            arguments: { step: 'verify' },
            appContext: null,
            pluginId: null,
          },
        }],
        external_session_id: 'thread-1',
      }),
      expect.objectContaining({
        type: 'agent_message',
        provider: 'codex',
        runtime: 'codex-sdk',
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_call_id: 'mcp-1',
          content: JSON.stringify({
            status: 'completed',
            result: { accepted: true },
            error: null,
            durationMs: 10,
          }, null, 2),
          is_error: false,
        }],
        external_session_id: 'thread-1',
      }),
    ]);

    const webSearch = project(completedItem({
      type: 'webSearch',
      id: 'search-1',
      query: 'Codex app-server protocol',
      action: { type: 'search', query: 'Codex app-server protocol', queries: null },
    }));
    expect(webSearch).toHaveLength(2);
    expect(webSearch[0]).toMatchObject({
      id: 'search-1:call',
      model: 'gpt-test',
      content: [{
        type: 'tool_call',
        id: 'search-1',
        name: 'WebSearch',
        input: {
          query: 'Codex app-server protocol',
          action: { type: 'search', query: 'Codex app-server protocol', queries: null },
        },
      }],
    });
    expect(webSearch[1]).toMatchObject({
      content: [{
        type: 'tool_result',
        tool_call_id: 'search-1',
        is_error: false,
      }],
    });
  });

  it('correlates completed and failed file changes without losing structured context', () => {
    expect(project(completedItem({
      type: 'fileChange',
      id: 'file-1',
      status: 'completed',
      changes: [
        { path: 'added.ts', kind: { type: 'add' }, diff: '+export {};' },
        { path: 'updated.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@' },
      ],
    }))).toEqual([
      expect.objectContaining({
        role: 'assistant',
        id: 'file-1:call',
        content: [{
          type: 'tool_call',
          id: 'file-1',
          name: 'Edit',
          input: {
            changes: [
              { path: 'added.ts', kind: { type: 'add' }, diff: '+export {};' },
              { path: 'updated.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@' },
            ],
          },
        }],
      }),
      expect.objectContaining({
        role: 'user',
        content: [expect.objectContaining({
          type: 'tool_result',
          tool_call_id: 'file-1',
          is_error: false,
        })],
      }),
    ]);

    expect(project(completedItem({
      type: 'fileChange',
      id: 'file-2',
      status: 'failed',
      changes: [{ path: 'failed.ts', kind: { type: 'delete' }, diff: '' }],
    }))[1]).toMatchObject({
      content: [{ type: 'tool_result', tool_call_id: 'file-2', is_error: true }],
    });
  });

  it('preserves raw notifications, unknown completed items, and retry metadata', () => {
    const notification: AppServerNotification = {
      method: 'turn/plan/updated',
      params: { threadId: 'thread-1', plan: [{ step: 'verify' }] },
    };
    expect(project({ type: 'raw', notification })).toEqual([{
      type: 'agent_unknown',
      provider: 'codex',
      runtime: 'codex-sdk',
      raw: notification,
    }]);

    const unknownItem = { type: 'futureItem', id: 'future-1', answer: 42 };
    expect(project(completedItem({
      type: 'raw',
      itemType: 'futureItem',
      item: unknownItem,
    }))).toEqual([{
      type: 'agent_unknown',
      provider: 'codex',
      runtime: 'codex-sdk',
      raw: {
        type: 'item.completed',
        threadId: 'thread-1',
        turnId: 'turn-1',
        completedAtMs: 100,
        itemType: 'futureItem',
        item: unknownItem,
      },
    }]);

    const retryable: TurnSessionEvent = {
      type: 'turn.error',
      threadId: 'thread-1',
      turnId: 'turn-1',
      willRetry: true,
      error: {
        message: 'temporary outage',
        codexErrorInfo: { kind: 'rateLimit' },
        additionalDetails: 'retrying shortly',
        misalignment: null,
      },
    };
    expect(project(retryable)).toEqual([{
      type: 'agent_unknown',
      provider: 'codex',
      runtime: 'codex-sdk',
      raw: retryable,
    }]);
  });

  it('preserves provider error context in non-retryable and failed turns', () => {
    const nonRetryable: TurnSessionEvent = {
      type: 'turn.error',
      threadId: 'thread-1',
      turnId: 'turn-1',
      willRetry: false,
      error: {
        message: 'Unhandled error. (usageLimitExceeded)',
        codexErrorInfo: {
          code: 'usageLimitExceeded',
          message: 'You have reached your usage limit.',
        },
        additionalDetails: 'Resets at 2026-07-12T00:00:00Z',
        misalignment: null,
      },
    };
    const nonRetryableProjection = project(nonRetryable);
    expect(nonRetryableProjection).toEqual([
      {
        type: 'agent_unknown',
        provider: 'codex',
        runtime: 'codex-sdk',
        raw: nonRetryable,
      },
      {
        type: 'agent_result',
        provider: 'codex',
        runtime: 'codex-sdk',
        subtype: 'error_during_execution',
        is_error: true,
        duration_ms: 1_234,
        num_turns: 1,
        result: [
          'Unhandled error. (usageLimitExceeded)',
          'Codex provider error: {"code":"usageLimitExceeded","message":"You have reached your usage limit."}',
          'Codex provider details: Resets at 2026-07-12T00:00:00Z',
        ].join('\n'),
        external_session_id: 'thread-1',
      },
    ]);

    const completed = project({
      type: 'turn.completed',
      threadId: 'thread-1',
      turnId: 'turn-1',
      status: 'completed',
    });
    expect(completed).toEqual([{
      type: 'agent_result',
      provider: 'codex',
      runtime: 'codex-sdk',
      subtype: 'success',
      is_error: false,
      duration_ms: 1_234,
      num_turns: 1,
      external_session_id: 'thread-1',
    }]);

    expect(project({
      type: 'turn.completed',
      threadId: 'thread-1',
      turnId: 'turn-2',
      status: 'interrupted',
    })).toEqual([{
      type: 'agent_result',
      provider: 'codex',
      runtime: 'codex-sdk',
      subtype: 'error_during_execution',
      is_error: true,
      duration_ms: 1_234,
      num_turns: 1,
      result: 'Codex turn interrupted',
      external_session_id: 'thread-1',
    }]);

    expect(project({
      type: 'turn.failed',
      threadId: 'thread-1',
      turnId: 'turn-3',
      error: {
        message: 'terminal failure',
        codexErrorInfo: { kind: 'other', message: 'provider explanation' },
        additionalDetails: 'details',
        misalignment: null,
      },
    })).toEqual([{
      type: 'agent_result',
      provider: 'codex',
      runtime: 'codex-sdk',
      subtype: 'error_during_execution',
      is_error: true,
      duration_ms: 1_234,
      num_turns: 1,
      result: [
        'terminal failure',
        'Codex provider error: {"kind":"other","message":"provider explanation"}',
        'Codex provider details: details',
      ].join('\n'),
      external_session_id: 'thread-1',
    }]);

    for (const event of [...nonRetryableProjection, ...completed]) {
      expect(event).not.toHaveProperty('usage');
      expect(event).not.toHaveProperty('cost_usd');
    }
  });

  it('appends misalignment detail to a projected turn error', () => {
    expect(project({
      type: 'turn.failed',
      threadId: 'thread-1',
      turnId: 'turn-1',
      error: {
        message: 'Turn blocked',
        codexErrorInfo: 'misalignmentPolicyViolation',
        additionalDetails: null,
        misalignment: {
          errorType: 'policy',
          detailedExplanation: 'The request asks for disallowed content.',
          steer: null,
        },
      },
    })[0]).toMatchObject({
      result: [
        'Turn blocked',
        'Codex provider error: "misalignmentPolicyViolation"',
        'Codex misalignment (policy): The request asks for disallowed content.',
      ].join('\n'),
    });

    // An unknown errorType and an empty explanation must not manufacture a line.
    expect(project({
      type: 'turn.failed',
      threadId: 'thread-1',
      turnId: 'turn-2',
      error: {
        message: 'Turn blocked',
        codexErrorInfo: null,
        additionalDetails: null,
        misalignment: { errorType: null, detailedExplanation: '', steer: null },
      },
    })[0]).toMatchObject({ result: 'Turn blocked' });

    // A null errorType with a real explanation falls back to the 'unknown' label.
    expect(project({
      type: 'turn.failed',
      threadId: 'thread-1',
      turnId: 'turn-3',
      error: {
        message: 'Turn blocked',
        codexErrorInfo: null,
        additionalDetails: null,
        misalignment: {
          errorType: null,
          detailedExplanation: 'Blocked for policy reasons.',
          steer: null,
        },
      },
    })[0]).toMatchObject({
      result: [
        'Turn blocked',
        'Codex misalignment (unknown): Blocked for policy reasons.',
      ].join('\n'),
    });
  });

  it('folds async agentMessage questions into the projected text', () => {
    expect(project(completedItem({
      type: 'agentMessage',
      id: 'message-async',
      text: 'Deploy is staged.',
      questions: [
        { title: 'Which environment?', options: ['staging', 'production'] },
        { title: 'Anything else?', options: null },
      ],
    }))).toEqual([{
      type: 'agent_message',
      provider: 'codex',
      runtime: 'codex-sdk',
      role: 'assistant',
      id: 'message-async',
      model: 'gpt-test',
      content: [{
        type: 'text',
        text: [
          'Deploy is staged.',
          '',
          'Questions:',
          '- Which environment? (options: staging / production)',
          '- Anything else?',
        ].join('\n'),
      }],
      external_session_id: 'thread-1',
    }]);

    // An empty question list leaves the message untouched.
    expect(project(completedItem({
      type: 'agentMessage',
      id: 'message-plain',
      text: 'Done.',
      questions: [],
    }))[0]).toMatchObject({ content: [{ type: 'text', text: 'Done.' }] });

    // A questions-only async message (blank text) must still project the questions
    // block, not the empty string it previously collapsed to.
    expect(project(completedItem({
      type: 'agentMessage',
      id: 'message-questions-only',
      text: '   ',
      questions: [{ title: 'Which environment?', options: null }],
    }))[0]).toMatchObject({
      content: [{ type: 'text', text: 'Questions:\n- Which environment?' }],
    });
  });

  it('attaches accumulated usage only when projecting a terminal result', () => {
    const usage = {
      input_tokens: 7,
      cache_read_input_tokens: 3,
      output_tokens: 5,
      reasoning_output_tokens: 2,
    };
    expect(projectTurnSessionEvent({
      type: 'turn.completed',
      threadId: 'thread-1',
      turnId: 'turn-1',
      status: 'completed',
    }, { ...CONTEXT, usage })).toEqual([expect.objectContaining({ usage })]);

    expect(projectTurnSessionEvent(completedItem({
      type: 'agentMessage',
      id: 'message-usage',
      text: 'Done.',
      questions: null,
    }), { ...CONTEXT, usage })[0]).not.toHaveProperty('usage');
  });
});
