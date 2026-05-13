/**
 * ClaudeStreamParser — Orchestrator of the 4-stage streamParser pipeline.
 *
 * Wires LineBufferer → JSONParser → TypedEventNarrowing → EventRouter together.
 * Accepts raw stdout chunks via `.feed(chunk)` and dispatches typed
 * ClaudeStreamEvents to the shared EventRouter under the given runId.
 *
 * Contract: NEVER throws into the caller. All parse/narrowing errors are
 * swallowed at each stage (WARN logged, processing continues).
 */

import { LineBufferer } from './lineBufferer';
import { JSONParser } from './jsonParser';
import { TypedEventNarrowing } from './typedEventNarrowing';
import type { EventRouter } from './eventRouter';

/** Minimal logger interface consumed by ClaudeStreamParser. */
export interface IStreamParserLogger {
  warn(message: string): void;
  verbose?(message: string): void;
}

export class ClaudeStreamParser {
  private readonly runId: string;
  private readonly router: EventRouter;
  private readonly lineBufferer: LineBufferer;
  private readonly jsonParser: JSONParser;
  private readonly narrower: TypedEventNarrowing;
  private readonly logger: IStreamParserLogger | undefined;

  constructor(runId: string, router: EventRouter, logger?: IStreamParserLogger) {
    this.runId = runId;
    this.router = router;
    this.logger = logger;
    this.lineBufferer = new LineBufferer();
    this.jsonParser = new JSONParser(logger);
    this.narrower = new TypedEventNarrowing(logger);
  }

  /**
   * Feed a raw stdout chunk through the pipeline.
   *
   * The chunk is buffered and split into complete lines by LineBufferer. Each
   * line is JSON-parsed (malformed lines produce null and a WARN), then
   * schema-narrowed to a ClaudeStreamEvent (unknown variants fall through to
   * the catch-all), then dispatched via EventRouter.
   *
   * Any unexpected error in the per-line loop is caught, WARN-logged, and
   * processing continues with the next line (defensive against bugs in the
   * narrowing stage).
   */
  feed(chunk: string): void {
    const lines = this.lineBufferer.feed(chunk);
    this.processLines(lines);
  }

  /**
   * Flush any partially-buffered content through the pipeline.
   *
   * Call this when the process stream ends (EOF / process exit) to ensure
   * any trailing partial line that was not newline-terminated is processed.
   * The completion gate (TASK-202) should call flush() after the process exits.
   */
  flush(): void {
    const lines = this.lineBufferer.flush();
    this.processLines(lines);
  }

  private processLines(lines: string[]): void {
    for (const line of lines) {
      if (line.trim() === '') continue;
      try {
        const parsed = this.jsonParser.parse(line);
        if (parsed === null) continue; // JSONParser already logged the WARN
        const event = this.narrower.narrow(parsed);
        this.router.emitForRun(this.runId, event);
      } catch (err) {
        // Defensive catch — bugs in narrowing must not kill the pipeline.
        this.logger?.warn(
          `[streamParser] unexpected error processing line: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
