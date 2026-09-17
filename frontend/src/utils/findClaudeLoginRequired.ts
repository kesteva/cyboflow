import { CLAUDE_AUTHENTICATION_FAILED, isClaudeLoginRequiredError } from '../../../shared/types/claudeAuth';
import type { UnifiedMessage } from '../../../shared/types/unifiedMessage';

/**
 * Does the transcript end in a Claude login failure? Looks at the LAST system
 * error row only — an old, already-recovered failure further up must not keep
 * offering a sign-in. Trusts the SDK's structured `assistantError` code first,
 * the text shapes second.
 */
export function findClaudeLoginRequired(messages: readonly UnifiedMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === 'user') return false; // a newer turn was sent; the failure is history
    if (message.role !== 'system' || message.metadata?.systemSubtype !== 'error') continue;
    if (message.metadata?.assistantError === CLAUDE_AUTHENTICATION_FAILED) return true;
    const text = message.segments
      .map((segment) => (segment.type === 'text' ? segment.content : segment.type === 'error' ? segment.error.message : ''))
      .join('\n');
    return isClaudeLoginRequiredError(text);
  }
  return false;
}
