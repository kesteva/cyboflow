/**
 * syntheticEvents — pure builders for well-formed ClaudeStreamEvent objects that the
 * on-demand monitor injects into a programmatic run's unified transcript.
 *
 * Injecting a conversation turn into the unified stream = emit a synthetic `'output'`
 * event carrying one of these on the programmatic run's bridge source (see Slice B's
 * `injectEvent`). `TypedEventNarrowing` passes these through unchanged and
 * `MessageProjection` renders them as user/assistant turns in the run's Chat pane.
 *
 * These builders are pure and SDK-free: they construct the exact wire shapes
 * (`UserEvent` / `AssistantEvent`) defined in `shared/types/claudeStream.ts`.
 *
 * Message ids are made unique via a module-local monotonic counter combined with
 * `Date.now()` so injected assistant turns never collide with one another (the
 * projection coalesces assistant events sharing a `message.id`). Per the build
 * contract, app code MAY use `Date.now()`; the no-Date.now rule is workflow-script-only.
 */

import type { UserEvent, AssistantEvent } from '../../../../shared/types/claudeStream';
import { CLAUDE_AUTHENTICATION_FAILED } from '../../../../shared/types/claudeAuth';

let syntheticEventCounter = 0;

/** Module-local monotonic id, unique per process even across same-millisecond calls. */
function nextId(): string {
  return `${Date.now()}_${++syntheticEventCounter}`;
}

/**
 * Build a synthetic user-text turn. Renders as a `role: 'user'` message in the chat.
 * Used to inject the human's chat input into the run transcript before the monitor reads
 * the history (Slice E's `send`).
 */
export function buildUserTextEvent(text: string): UserEvent {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
    parent_tool_use_id: null,
  };
}

/**
 * Build a synthetic assistant-text turn from the monitor. Renders as a
 * `role: 'assistant'` message in the chat. Used to inject the monitor's triage rationale
 * and chat answers into the run transcript.
 *
 * The `message.id` is uniquified (see `nextId`) so MessageProjection does not coalesce
 * distinct monitor turns into a single message.
 */
export function buildAssistantTextEvent(text: string, opts?: { model?: string }): AssistantEvent {
  return {
    type: 'assistant',
    message: {
      id: `monitor_${nextId()}`,
      model: opts?.model ?? 'monitor',
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
    parent_tool_use_id: null,
  };
}

/**
 * Build the monitor's reply to a turn that died on a missing/expired Claude
 * login. Deliberately the SDK's OWN shape for that failure — a `<synthetic>`
 * assistant message carrying `error: 'authentication_failed'` — which the
 * projection renders as a system error row with `metadata.assistantError`, the
 * exact row the chat's sign-in card (`findClaudeLoginRequired`) keys on. A
 * plain assistant turn would render the text but never offer the sign-in.
 */
export function buildLoginRequiredEvent(text: string): AssistantEvent {
  return {
    type: 'assistant',
    message: {
      id: `monitor_${nextId()}`,
      model: '<synthetic>',
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
    parent_tool_use_id: null,
    error: CLAUDE_AUTHENTICATION_FAILED,
  };
}
