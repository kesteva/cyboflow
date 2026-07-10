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
          outputTokens: 5,
          reasoningOutputTokens: 2,
        },
        last: {
          totalTokens: 15,
          inputTokens: 10,
          cachedInputTokens: 3,
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
      item: { type: 'agentMessage', id: 'message-1', text: 'partial' },
    })).toEqual([]);
  });

  it('projects completed assistant text, reasoning, and plans with Codex context', () => {
    expect(project(completedItem({
      type: 'agentMessage',
      id: 'message-1',
      text: 'Implementation complete.',
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
    }))).toEqual([]);
  });

  it('correlates command, MCP, and web-search calls with their results', () => {
    expect(project(completedItem({
      type: 'commandExecution',
      id: 'command-1',
      command: 'pnpm test',
      status: 'failed',
      aggregatedOutput: 'one test failed',
      exitCode: 1,
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
          input: { command: 'pnpm test' },
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
          content: 'one test failed',
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
      result: { accepted: true },
      error: null,
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
          input: { server: 'cyboflow', arguments: { step: 'verify' } },
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
          content: '{\n  "accepted": true\n}',
          is_error: false,
        }],
        external_session_id: 'thread-1',
      }),
    ]);

    const webSearch = project(completedItem({
      type: 'webSearch',
      id: 'search-1',
      query: 'Codex app-server protocol',
    }));
    expect(webSearch).toHaveLength(2);
    expect(webSearch[0]).toMatchObject({
      id: 'search-1:call',
      model: 'gpt-test',
      content: [{
        type: 'tool_call',
        id: 'search-1',
        name: 'WebSearch',
        input: { query: 'Codex app-server protocol' },
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
        { path: 'added.ts', kind: 'add', diff: '+export {};' },
        { path: 'updated.ts', kind: 'update', diff: '@@ -1 +1 @@' },
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
              { path: 'added.ts', kind: 'add', diff: '+export {};' },
              { path: 'updated.ts', kind: 'update', diff: '@@ -1 +1 @@' },
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
      changes: [{ path: 'failed.ts', kind: 'delete', diff: '' }],
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
      },
    };
    expect(project(retryable)).toEqual([{
      type: 'agent_unknown',
      provider: 'codex',
      runtime: 'codex-sdk',
      raw: retryable,
    }]);
  });

  it('projects non-retryable errors and completed, interrupted, or failed turns', () => {
    const nonRetryable: TurnSessionEvent = {
      type: 'turn.error',
      threadId: 'thread-1',
      turnId: 'turn-1',
      willRetry: false,
      error: {
        message: 'request failed',
        codexErrorInfo: null,
        additionalDetails: null,
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
        result: 'request failed',
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
        codexErrorInfo: { kind: 'other' },
        additionalDetails: 'details',
      },
    })).toEqual([{
      type: 'agent_result',
      provider: 'codex',
      runtime: 'codex-sdk',
      subtype: 'error_during_execution',
      is_error: true,
      duration_ms: 1_234,
      num_turns: 1,
      result: 'terminal failure',
      external_session_id: 'thread-1',
    }]);

    for (const event of [...nonRetryableProjection, ...completed]) {
      expect(event).not.toHaveProperty('usage');
      expect(event).not.toHaveProperty('cost_usd');
    }
  });
});
