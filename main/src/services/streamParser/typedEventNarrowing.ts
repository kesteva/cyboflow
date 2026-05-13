/**
 * TypedEventNarrowing — Stage 3 of the streamParser pipeline.
 *
 * Validates each parsed JSON object against the Zod schema and narrows it to
 * the appropriate ClaudeStreamEvent variant. Unknown discriminants fall through
 * to the { kind: '__unknown__', raw } catch-all — never throws, never drops.
 */

import { claudeStreamEventSchema } from './schemas';
import type { ClaudeStreamEvent } from '../../../../shared/types/claudeStream';

/** Minimal debug-level logger interface. */
export interface IDebugLogger {
  /** Optional: log a low-verbosity diagnostic message. */
  verbose?(message: string): void;
}

export class TypedEventNarrowing {
  private readonly logger: IDebugLogger | undefined;

  constructor(logger?: IDebugLogger) {
    this.logger = logger;
  }

  /**
   * Narrow a parsed JSON value to a typed ClaudeStreamEvent.
   *
   * Runs `claudeStreamEventSchema.safeParse(parsed)`. On success, returns the
   * validated, narrowed event. On failure (unknown variant, missing field, bad
   * type), returns `{ kind: '__unknown__', raw: parsed }`.
   *
   * Contract: NEVER throws. NEVER drops (unknown events become the catch-all
   * variant, not null).
   */
  narrow(parsed: unknown): ClaudeStreamEvent {
    const result = claudeStreamEventSchema.safeParse(parsed);
    if (result.success) {
      return result.data;
    }

    // Log at debug/verbose level — informative but not noisy.
    const rawObj =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    const wireType =
      typeof rawObj['type'] === 'string' ? rawObj['type'] : '<missing>';
    this.logger?.verbose?.(
      `[streamParser] unknown ClaudeStreamEvent variant type=${wireType}`,
    );

    return { kind: '__unknown__', raw: rawObj };
  }
}
