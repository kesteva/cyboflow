/**
 * Shared UnifiedMessage contract — consumed by both the main process
 * (MessageProjection) and the renderer (RichOutputView / RichOutputWithSidebar).
 *
 * SINGLE source of truth: all UnifiedMessage, MessageSegment, ToolCall, and
 * ToolResult definitions live here. The renderer-side MessageTransformer.ts
 * re-exports from this file for backward compatibility.
 */

// Session information interface
export interface SessionInfoData {
  type?: string;
  initialPrompt?: string;
  claudeCommand?: string;
  worktreePath?: string;
  model?: string;
  permissionMode?: string;
  timestamp?: string;
  [key: string]: unknown;
}

// Generic system info that can contain various types
export type SystemInfoData = SessionInfoData | {
  type?: string;
  [key: string]: unknown;
};

// Unified message structure that all agents transform to
export interface UnifiedMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  timestamp: string;
  segments: MessageSegment[];
  metadata?: {
    agent?: string;
    model?: string;
    duration?: number;
    tokens?: number;
    cost?: number;
    systemSubtype?: string;
    sessionInfo?: SessionInfoData;
    [key: string]: unknown;
  };
}

export type MessageSegment =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; tool: ToolCall }
  | { type: 'tool_result'; result: ToolResult & { toolCallId: string } }
  | { type: 'system_info'; info: SystemInfoData }
  | { type: 'thinking'; content: string }
  | { type: 'diff'; diff: string }
  | { type: 'error'; error: { message: string; details?: string } };

export interface ToolCall {
  id: string;
  name: string;
  input?: Record<string, unknown>;
  result?: ToolResult;
  status: 'pending' | 'success' | 'error';
  isSubAgent?: boolean;
  subAgentType?: string;
  parentToolId?: string;
  childToolCalls?: ToolCall[];
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  metadata?: {
    exitCode?: number;
    duration?: number;
    [key: string]: unknown;
  };
}
