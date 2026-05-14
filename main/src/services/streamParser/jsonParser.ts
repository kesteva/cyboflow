/**
 * JSONParser — Stage 2 of the streamParser pipeline.
 *
 * Converts raw text lines into parsed JSON objects. Malformed lines are
 * silently dropped (after a WARN log) — they NEVER cause a throw into the
 * event loop.
 *
 * Per IDEA-005 constraint: "Parse errors drop with WARN, never throw into
 * the event loop."
 */

import type { ILogger } from './types';

export class JSONParser {
  private readonly logger: Pick<ILogger, 'warn'> | undefined;

  constructor(logger?: Pick<ILogger, 'warn'>) {
    this.logger = logger;
  }

  /**
   * Attempt to parse a single line of text as JSON.
   *
   * Returns the parsed value (an `unknown`) on success, or `null` on failure.
   * On failure: logs a WARN (if a logger is provided) and returns null.
   * NEVER throws — the catch path is the only exit on a parse failure.
   *
   * Per IDEA-005: parse errors use logger.warn(), never logger.error().
   */
  parse(line: string): unknown | null {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      this.logger?.warn(
        `[streamParser] dropped malformed JSON line: ${line.substring(0, 200)}`,
      );
      return null;
    }
  }
}
