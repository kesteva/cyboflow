import type { AgentProvider, AgentRuntime } from './agentRuntime';

export interface AgentMcpServerStatus {
  name: string;
  status: string;
}

export interface AgentUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  reasoning_output_tokens?: number;
}

export interface AgentTextBlock {
  type: 'text';
  text: string;
}

export interface AgentThinkingBlock {
  type: 'thinking';
  text: string;
}

export interface AgentToolCallBlock {
  type: 'tool_call';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AgentToolResultBlock {
  type: 'tool_result';
  tool_call_id: string;
  content: string | Array<{ type: string; text: string }>;
  is_error?: boolean;
}

export type AgentAssistantContentBlock = AgentTextBlock | AgentThinkingBlock | AgentToolCallBlock;
export type AgentUserContentBlock = AgentTextBlock | AgentToolResultBlock;

export interface AgentSessionInfoEvent {
  type: 'agent_session_info';
  provider: AgentProvider;
  runtime?: AgentRuntime;
  initial_prompt: string;
  command: string;
  worktree_path: string;
  model: string;
  permission_mode: string;
  timestamp: string;
}

export interface AgentInitEvent {
  type: 'agent_init';
  provider: AgentProvider;
  runtime?: AgentRuntime;
  external_session_id: string;
  cwd: string;
  model: string;
  tools: string[];
  mcp_servers: AgentMcpServerStatus[];
  permission_mode: string;
  sdk_version?: string;
}

export interface AgentAssistantMessageEvent {
  type: 'agent_message';
  role: 'assistant';
  id: string;
  model: string;
  content: AgentAssistantContentBlock[];
  usage?: AgentUsage;
  external_session_id?: string;
  parent_tool_call_id?: string | null;
}

export interface AgentUserMessageEvent {
  type: 'agent_message';
  role: 'user';
  content: AgentUserContentBlock[];
  external_session_id?: string;
  parent_tool_call_id?: string | null;
}

export type AgentResultSubtype =
  | 'success'
  | 'error_max_turns'
  | 'error_max_budget_usd'
  | 'error_during_execution'
  | 'error_max_structured_output_retries';

export interface AgentResultEvent {
  type: 'agent_result';
  subtype: AgentResultSubtype;
  is_error: boolean;
  duration_ms: number;
  num_turns: number;
  result?: string;
  cost_usd?: number;
  usage?: AgentUsage;
  external_session_id?: string;
}

export interface AgentUnknownEvent {
  type: 'agent_unknown';
  raw: Record<string, unknown>;
}

export type AgentStreamEvent =
  | AgentSessionInfoEvent
  | AgentInitEvent
  | AgentAssistantMessageEvent
  | AgentUserMessageEvent
  | AgentResultEvent
  | AgentUnknownEvent;

export const AGENT_STREAM_EVENT_TYPES = [
  'agent_session_info',
  'agent_init',
  'agent_message',
  'agent_result',
  'agent_unknown',
] as const;

export function isAgentStreamEvent(value: unknown): value is AgentStreamEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string' &&
    (AGENT_STREAM_EVENT_TYPES as readonly string[]).includes((value as { type: string }).type)
  );
}
