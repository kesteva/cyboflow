import type {
  AgentAssistantContentBlock,
  AgentAssistantMessageEvent,
  AgentStreamEvent,
  AgentUserContentBlock,
  AgentUserMessageEvent,
} from '../../../../shared/types/agentStream';
import type {
  ClaudeStreamEvent,
  TextBlock,
  ThinkingBlock,
  ToolResultBlock,
  ToolUseBlock,
} from '../../../../shared/types/claudeStream';
import type { AgentProvider, AgentRuntime } from '../../../../shared/types/agentRuntime';

export interface AgentStreamContext {
  provider?: AgentProvider;
  runtime?: AgentRuntime;
}

function toRecord(value: object): Record<string, unknown> {
  return value as unknown as Record<string, unknown>;
}

function agentAssistantBlockToClaude(block: AgentAssistantContentBlock): TextBlock | ThinkingBlock | ToolUseBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'thinking':
      return { type: 'thinking', thinking: block.text };
    case 'tool_call':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
  }
}

function agentUserBlockToClaude(block: AgentUserContentBlock): TextBlock | ToolResultBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.tool_call_id,
        content: block.content,
        ...(block.is_error !== undefined ? { is_error: block.is_error } : {}),
      };
  }
}

function claudeAssistantBlockToAgent(block: TextBlock | ThinkingBlock | ToolUseBlock): AgentAssistantContentBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'thinking':
      return { type: 'thinking', text: block.thinking };
    case 'tool_use':
      return { type: 'tool_call', id: block.id, name: block.name, input: block.input };
  }
}

function claudeUserBlockToAgent(block: TextBlock | ToolResultBlock): AgentUserContentBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_call_id: block.tool_use_id,
        content: block.content,
        ...(block.is_error !== undefined ? { is_error: block.is_error } : {}),
      };
  }
}

export function agentStreamEventToClaudeStreamEvent(event: AgentStreamEvent): ClaudeStreamEvent {
  switch (event.type) {
    case 'agent_session_info': {
      return {
        type: 'session_info',
        initial_prompt: event.initial_prompt,
        claude_command: event.command,
        worktree_path: event.worktree_path,
        model: event.model,
        permission_mode: event.permission_mode,
        timestamp: event.timestamp,
      };
    }
    case 'agent_init': {
      return {
        type: 'system',
        subtype: 'init',
        session_id: event.external_session_id,
        cwd: event.cwd,
        model: event.model,
        tools: event.tools,
        mcp_servers: event.mcp_servers,
        permissionMode: event.permission_mode,
        ...(event.sdk_version !== undefined ? { claude_code_version: event.sdk_version } : {}),
      };
    }
    case 'agent_message': {
      if (event.role === 'assistant') {
        return {
          type: 'assistant',
          message: {
            id: event.id,
            model: event.model,
            role: 'assistant',
            content: event.content.map(agentAssistantBlockToClaude),
            ...(event.usage !== undefined ? { usage: event.usage } : {}),
          },
          ...(event.parent_tool_call_id !== undefined ? { parent_tool_use_id: event.parent_tool_call_id } : {}),
          ...(event.external_session_id !== undefined ? { session_id: event.external_session_id } : {}),
        };
      }

      return {
        type: 'user',
        message: {
          role: 'user',
          content: event.content.map(agentUserBlockToClaude),
        },
        ...(event.parent_tool_call_id !== undefined ? { parent_tool_use_id: event.parent_tool_call_id } : {}),
        ...(event.external_session_id !== undefined ? { session_id: event.external_session_id } : {}),
      };
    }
    case 'agent_result': {
      return {
        type: 'result',
        subtype: event.subtype,
        is_error: event.is_error,
        duration_ms: event.duration_ms,
        num_turns: event.num_turns,
        ...(event.result !== undefined ? { result: event.result } : {}),
        ...(event.cost_usd !== undefined ? { total_cost_usd: event.cost_usd } : {}),
        ...(event.usage !== undefined ? { usage: event.usage } : {}),
        ...(event.external_session_id !== undefined ? { session_id: event.external_session_id } : {}),
      };
    }
    case 'agent_unknown':
      return { kind: '__unknown__', raw: event.raw };
  }
}

export function claudeStreamEventToAgentStreamEvent(
  event: ClaudeStreamEvent,
  context: AgentStreamContext = {},
): AgentStreamEvent {
  const provider = context.provider ?? 'claude';

  if ('kind' in event) {
    return { type: 'agent_unknown', raw: event.raw };
  }

  switch (event.type) {
    case 'session_info':
      return {
        type: 'agent_session_info',
        provider,
        ...(context.runtime !== undefined ? { runtime: context.runtime } : {}),
        initial_prompt: event.initial_prompt,
        command: event.claude_command,
        worktree_path: event.worktree_path,
        model: event.model,
        permission_mode: event.permission_mode,
        timestamp: event.timestamp,
      };
    case 'system':
      if (event.subtype !== 'init') {
        return { type: 'agent_unknown', raw: toRecord(event) };
      }
      return {
        type: 'agent_init',
        provider,
        ...(context.runtime !== undefined ? { runtime: context.runtime } : {}),
        external_session_id: event.session_id,
        cwd: event.cwd,
        model: event.model,
        tools: event.tools,
        mcp_servers: event.mcp_servers,
        permission_mode: event.permissionMode,
        ...(event.claude_code_version !== undefined ? { sdk_version: event.claude_code_version } : {}),
      };
    case 'assistant': {
      const agentEvent: AgentAssistantMessageEvent = {
        type: 'agent_message',
        role: 'assistant',
        id: event.message.id,
        model: event.message.model,
        content: event.message.content.map(claudeAssistantBlockToAgent),
        ...(event.message.usage !== undefined ? { usage: event.message.usage } : {}),
        ...(event.session_id !== undefined ? { external_session_id: event.session_id } : {}),
        ...(event.parent_tool_use_id !== undefined ? { parent_tool_call_id: event.parent_tool_use_id } : {}),
      };
      return agentEvent;
    }
    case 'user': {
      const agentEvent: AgentUserMessageEvent = {
        type: 'agent_message',
        role: 'user',
        content: event.message.content.map(claudeUserBlockToAgent),
        ...(event.session_id !== undefined ? { external_session_id: event.session_id } : {}),
        ...(event.parent_tool_use_id !== undefined ? { parent_tool_call_id: event.parent_tool_use_id } : {}),
      };
      return agentEvent;
    }
    case 'result':
      return {
        type: 'agent_result',
        subtype: event.subtype,
        is_error: event.is_error,
        duration_ms: event.duration_ms,
        num_turns: event.num_turns,
        ...(event.result !== undefined ? { result: event.result } : {}),
        ...(event.total_cost_usd !== undefined ? { cost_usd: event.total_cost_usd } : {}),
        ...(event.usage !== undefined ? { usage: event.usage } : {}),
        ...(event.session_id !== undefined ? { external_session_id: event.session_id } : {}),
      };
    case 'stream_event':
    case 'rate_limit_event':
      return { type: 'agent_unknown', raw: toRecord(event) };
  }
}

export function assertAgentAdapterParity(event: AgentStreamEvent): ClaudeStreamEvent {
  return agentStreamEventToClaudeStreamEvent(event);
}
