import { describe, expect, it } from 'vitest';
import type { AgentStreamEvent } from '../../../../../shared/types/agentStream';
import type { ClaudeStreamEvent } from '../../../../../shared/types/claudeStream';
import {
  agentStreamEventToClaudeStreamEvent,
  claudeStreamEventToAgentStreamEvent,
} from '../agentStreamAdapter';

describe('agentStreamAdapter', () => {
  it('converts provider-neutral Codex session/init events to legacy stream events', () => {
    const sessionInfo: AgentStreamEvent = {
      type: 'agent_session_info',
      provider: 'codex',
      runtime: 'codex-sdk',
      initial_prompt: 'ship it',
      command: 'codex-sdk-in-process',
      worktree_path: '/tmp/worktree',
      model: 'gpt-5.5',
      permission_mode: 'acceptEdits',
      timestamp: '2026-07-09T00:00:00.000Z',
    };
    const init: AgentStreamEvent = {
      type: 'agent_init',
      provider: 'codex',
      runtime: 'codex-sdk',
      external_session_id: 'codex-thread-1',
      cwd: '/tmp/worktree',
      model: 'gpt-5.5',
      tools: [],
      mcp_servers: [{ name: 'cyboflow', status: 'connected' }],
      permission_mode: 'acceptEdits',
      sdk_version: '@openai/codex-sdk',
    };

    expect(agentStreamEventToClaudeStreamEvent(sessionInfo)).toMatchObject({
      type: 'session_info',
      claude_command: 'codex-sdk-in-process',
      model: 'gpt-5.5',
    });
    expect(agentStreamEventToClaudeStreamEvent(init)).toMatchObject({
      type: 'system',
      subtype: 'init',
      session_id: 'codex-thread-1',
      mcp_servers: [{ name: 'cyboflow', status: 'connected' }],
      permissionMode: 'acceptEdits',
      claude_code_version: '@openai/codex-sdk',
    });
  });

  it('converts neutral assistant tool calls and user tool results to legacy content blocks', () => {
    const assistant: AgentStreamEvent = {
      type: 'agent_message',
      role: 'assistant',
      id: 'tool-1:call',
      model: 'gpt-5.5',
      external_session_id: 'codex-thread-1',
      content: [{
        type: 'tool_call',
        id: 'tool-1',
        name: 'cyboflow_report_step',
        input: { step_id: 'execute' },
      }],
    };
    const user: AgentStreamEvent = {
      type: 'agent_message',
      role: 'user',
      external_session_id: 'codex-thread-1',
      content: [{
        type: 'tool_result',
        tool_call_id: 'tool-1',
        content: 'ok',
        is_error: false,
      }],
    };

    expect(agentStreamEventToClaudeStreamEvent(assistant)).toEqual({
      type: 'assistant',
      message: {
        id: 'tool-1:call',
        model: 'gpt-5.5',
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'tool-1',
          name: 'cyboflow_report_step',
          input: { step_id: 'execute' },
        }],
      },
      session_id: 'codex-thread-1',
    });
    expect(agentStreamEventToClaudeStreamEvent(user)).toEqual({
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool-1',
          content: 'ok',
          is_error: false,
        }],
      },
      session_id: 'codex-thread-1',
    });
  });

  it('converts neutral result events without losing usage or cost fields', () => {
    const result: AgentStreamEvent = {
      type: 'agent_result',
      subtype: 'success',
      is_error: false,
      duration_ms: 123,
      num_turns: 1,
      cost_usd: 0.02,
      usage: { input_tokens: 10, output_tokens: 4 },
      external_session_id: 'codex-thread-1',
    };

    expect(agentStreamEventToClaudeStreamEvent(result)).toEqual({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 123,
      num_turns: 1,
      total_cost_usd: 0.02,
      usage: { input_tokens: 10, output_tokens: 4 },
      session_id: 'codex-thread-1',
    });
  });

  it('converts legacy Claude assistant/user events back to neutral agent events', () => {
    const assistant: ClaudeStreamEvent = {
      type: 'assistant',
      message: {
        id: 'msg-1',
        model: 'opus',
        role: 'assistant',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'thinking', thinking: 'reasoning' },
        ],
        usage: { input_tokens: 8, output_tokens: 3 },
      },
      session_id: 'claude-session-1',
    };
    const user: ClaudeStreamEvent = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }],
      },
      session_id: 'claude-session-1',
    };

    expect(claudeStreamEventToAgentStreamEvent(assistant, { runtime: 'claude-sdk' })).toEqual({
      type: 'agent_message',
      role: 'assistant',
      id: 'msg-1',
      model: 'opus',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'thinking', text: 'reasoning' },
      ],
      usage: { input_tokens: 8, output_tokens: 3 },
      external_session_id: 'claude-session-1',
    });
    expect(claudeStreamEventToAgentStreamEvent(user, { runtime: 'claude-sdk' })).toEqual({
      type: 'agent_message',
      role: 'user',
      content: [{ type: 'tool_result', tool_call_id: 'tool-1', content: 'done' }],
      external_session_id: 'claude-session-1',
    });
  });

  it('keeps unknown and unsupported Claude events explicit instead of pretending they are neutral', () => {
    const unknown: AgentStreamEvent = {
      type: 'agent_unknown',
      raw: { provider_event_type: 'new.codex.event' },
    };
    const rateLimit: ClaudeStreamEvent = {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed' },
      uuid: 'uuid-1',
      session_id: 'claude-session-1',
    };

    expect(agentStreamEventToClaudeStreamEvent(unknown)).toEqual({
      kind: '__unknown__',
      raw: { provider_event_type: 'new.codex.event' },
    });
    expect(claudeStreamEventToAgentStreamEvent(rateLimit)).toEqual({
      type: 'agent_unknown',
      raw: rateLimit,
    });
  });
});
