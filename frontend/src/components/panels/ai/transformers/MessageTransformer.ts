/**
 * MessageTransformer — renderer-side agent abstraction.
 *
 * UnifiedMessage, MessageSegment, ToolCall, ToolResult, SessionInfoData, and
 * SystemInfoData are defined in shared/types/unifiedMessage.ts (the single
 * source of truth shared between main and renderer). This file re-exports them
 * for backward compatibility with CodexMessageTransformer, RichOutputView, and
 * MessagesView which import from this path.
 */
export type {
  UnifiedMessage,
  MessageSegment,
  ToolCall,
  ToolResult,
  SessionInfoData,
  SystemInfoData,
} from '../../../../../shared/types/unifiedMessage';

// Message transformer interface for converting agent-specific formats to unified format
export interface MessageTransformer {
  // Transform raw agent messages to unified format
  transform(rawMessages: unknown[]): import('../../../../../shared/types/unifiedMessage').UnifiedMessage[];

  // Parse a single message
  parseMessage(raw: unknown): import('../../../../../shared/types/unifiedMessage').UnifiedMessage | null;

  // Agent-specific capabilities
  supportsStreaming(): boolean;
  supportsThinking(): boolean;
  supportsToolCalls(): boolean;

  // Get agent name for display
  getAgentName(): string;
}
