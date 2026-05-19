/**
 * streamParser — shared derivers.
 *
 * Single source of truth for the `ClaudeStreamEvent → event_type` mapping
 * used by both `RawEventsSink` (storage column) and `runEventBridge`
 * (publisher envelope `type` field). Extracting this helper prevents the
 * two sites from silently diverging on a future variant rename.
 */

import type { ClaudeStreamEvent } from '../../../../shared/types/claudeStream';

/**
 * Derives the event_type string for storage / envelope dispatch.
 *
 * The UnknownStreamEvent uses `kind: '__unknown__'` instead of a `type`
 * field (by design — it cannot collide with any real wire type). Both
 * `__unknown__` and any future `unknown` variant normalize to the string
 * 'unknown' so queries can filter on a stable value.
 */
export function deriveEventType(event: ClaudeStreamEvent): string {
  if ('kind' in event && event.kind === '__unknown__') {
    return 'unknown';
  }
  return (event as { type: string }).type;
}
