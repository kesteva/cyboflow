/**
 * streamParser — shared derivers.
 *
 * Single source of truth for the `ClaudeStreamEvent → event_type` mapping
 * used by both `RawEventsSink` (storage column) and `runEventBridge`
 * (publisher envelope `type` field). Extracting this helper prevents the
 * two sites from silently diverging on a future variant rename.
 */

import type { ClaudeStreamEvent } from '../../../../shared/types/claudeStream';
import type { AgentStreamEvent } from '../../../../shared/types/agentStream';

export type PersistableStreamEvent = ClaudeStreamEvent | AgentStreamEvent;

/**
 * Derives the event_type string for storage / envelope dispatch.
 *
 * The UnknownStreamEvent uses `kind: '__unknown__'` instead of a `type`
 * field (by design — it cannot collide with any real wire type). Both
 * `__unknown__` and any future `unknown` variant normalize to the string
 * 'unknown' so queries can filter on a stable value.
 */
export function deriveEventType(event: PersistableStreamEvent): string {
  if (!('type' in event)) {
    return 'unknown';
  }
  switch (event.type) {
    case 'agent_session_info':
      return 'session_info';
    case 'agent_init':
      return 'system';
    case 'agent_message':
      return event.role === 'assistant' ? 'assistant' : 'user';
    case 'agent_result':
      return 'result';
    case 'agent_unknown':
      return 'unknown';
    default:
      return event.type;
  }
}
