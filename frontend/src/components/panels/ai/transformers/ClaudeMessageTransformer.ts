// @cyboflow-stub — parsing has moved to main/src/services/streamParser/messageProjection.ts.
// This file is retained as an IdentityMessageTransformer for compatibility with the
// renderer's MessageTransformer prop contract. DO NOT add parsing logic here.
//
// The MessageTransformer prop in RichOutputView is still used by CodexMessageTransformer
// (active) and will be removed when the crystal-cuts-and-rebrand epic deletes Codex.
import type { MessageTransformer, UnifiedMessage } from './MessageTransformer';

export class ClaudeMessageTransformer implements MessageTransformer {
  transform(rawMessages: unknown[]): UnifiedMessage[] {
    return rawMessages as UnifiedMessage[];
  }

  parseMessage(raw: unknown): UnifiedMessage | null {
    return raw as UnifiedMessage | null;
  }

  supportsStreaming(): boolean { return true; }
  supportsThinking(): boolean { return true; }
  supportsToolCalls(): boolean { return true; }
  getAgentName(): string { return 'Claude'; }
}
