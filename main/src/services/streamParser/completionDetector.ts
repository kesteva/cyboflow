/**
 * CompletionDetector — Triple-gate run-completion detector with 30s watchdog.
 *
 * A run is considered cleanly complete only when ALL THREE signals fire:
 *   1. signalChildExited()   — the child process has exited
 *   2. signalStdoutEof()     — stdout reached EOF
 *   3. signalParserDrained() — the parser queue is drained
 *
 * If 30 seconds elapse from the first signal without all three landing, the
 * watchdog fires and emits 'forced' (reason='watchdog_timeout') so the run can
 * be marked failed instead of hanging indefinitely.
 *
 * The detector NEVER trusts the Claude `result` event as a gate-opener — that
 * event is unreliable across multiple Claude versions (issues #1920, #25629,
 * closed-not-planned). The three signals above are the only gates.
 *
 * Each run gets its own CompletionDetector instance. Call .dispose() when the
 * run is canceled or cleaned up to prevent the watchdog from firing after the
 * run is gone.
 */

import { EventEmitter } from 'node:events';

/** Minimal logger interface consumed by CompletionDetector. */
export interface ICompletionDetectorLogger {
  info(message: string): void;
  warn(message: string): void;
}

/** Payload emitted with the 'complete' event (clean shutdown). */
export interface CompletionPayload {
  runId: string;
  reason: 'all_signals';
}

/** Payload emitted with the 'forced' event (watchdog timeout). */
export interface ForcedPayload {
  runId: string;
  reason: 'watchdog_timeout';
  missing: string[];
}

export class CompletionDetector extends EventEmitter {
  private readonly runId: string;
  private readonly watchdogMs: number;
  private readonly logger: ICompletionDetectorLogger | undefined;

  // --- Gate flags ---
  private childExited: boolean = false;
  private stdoutEof: boolean = false;
  private parserDrained: boolean = false;

  // --- Lifecycle guards ---
  private disposed: boolean = false;
  private emitted: boolean = false;
  private watchdogTimer: NodeJS.Timeout | undefined = undefined;

  constructor(
    runId: string,
    watchdogMs: number = 30_000,
    logger?: ICompletionDetectorLogger,
  ) {
    super();
    this.runId = runId;
    this.watchdogMs = watchdogMs;
    this.logger = logger;
  }

  /**
   * Signal that the child process has exited.
   * Starts the watchdog on first call (any signal).
   */
  signalChildExited(): void {
    this.childExited = true;
    this.startWatchdogIfNeeded();
    this.checkComplete();
  }

  /**
   * Signal that the stdout stream has reached EOF.
   * Starts the watchdog on first call (any signal).
   */
  signalStdoutEof(): void {
    this.stdoutEof = true;
    this.startWatchdogIfNeeded();
    this.checkComplete();
  }

  /**
   * Signal that the parser queue has been drained (all buffered lines processed).
   * Starts the watchdog on first call (any signal).
   */
  signalParserDrained(): void {
    this.parserDrained = true;
    this.startWatchdogIfNeeded();
    this.checkComplete();
  }

  /**
   * Dispose of the detector. Clears the watchdog timer and removes all
   * listeners. After dispose(), any subsequently-arrived signals produce no
   * further emissions — safe to call even after 'complete' or 'forced'.
   */
  dispose(): void {
    this.disposed = true;
    if (this.watchdogTimer !== undefined) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
    this.removeAllListeners();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private startWatchdogIfNeeded(): void {
    if (this.disposed || this.emitted || this.watchdogTimer !== undefined) {
      return;
    }
    this.watchdogTimer = setTimeout(() => this.fireWatchdog(), this.watchdogMs);
  }

  private checkComplete(): void {
    if (this.disposed || this.emitted) return;
    if (this.childExited && this.stdoutEof && this.parserDrained) {
      if (this.watchdogTimer !== undefined) {
        clearTimeout(this.watchdogTimer);
        this.watchdogTimer = undefined;
      }
      this.emitted = true;
      this.logger?.info(
        `[completionDetector] run ${this.runId} complete (all_signals)`,
      );
      const payload: CompletionPayload = {
        runId: this.runId,
        reason: 'all_signals',
      };
      this.emit('complete', payload);
    }
  }

  private fireWatchdog(): void {
    if (this.disposed || this.emitted) return;
    this.watchdogTimer = undefined;
    this.emitted = true;

    const missing: string[] = [];
    if (!this.childExited) missing.push('childExited');
    if (!this.stdoutEof) missing.push('stdoutEof');
    if (!this.parserDrained) missing.push('parserDrained');

    this.logger?.warn(
      `[completionDetector] run ${this.runId} watchdog_timeout — missing signals: ${missing.join(', ')}`,
    );

    const payload: ForcedPayload = {
      runId: this.runId,
      reason: 'watchdog_timeout',
      missing,
    };
    this.emit('forced', payload);
  }
}
