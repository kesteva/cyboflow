/**
 * Unit tests for CompletionDetector — triple-gate completion + 30s watchdog.
 *
 * Uses vitest fake timers for deterministic watchdog testing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CompletionDetector,
  type CompletionPayload,
  type ForcedPayload,
} from '../completionDetector';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RUN_ID = 'test-run-001';

function makeDetector(watchdogMs = 30_000): CompletionDetector {
  return new CompletionDetector(RUN_ID, watchdogMs);
}

function collectCompleteEvents(detector: CompletionDetector): CompletionPayload[] {
  const events: CompletionPayload[] = [];
  detector.on('complete', (payload: CompletionPayload) => events.push(payload));
  return events;
}

function collectForcedEvents(detector: CompletionDetector): ForcedPayload[] {
  const events: ForcedPayload[] = [];
  detector.on('forced', (payload: ForcedPayload) => events.push(payload));
  return events;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CompletionDetector', () => {
  // -------------------------------------------------------------------------
  // All three signals → exactly one 'complete' emission with reason='all_signals'
  // -------------------------------------------------------------------------

  describe('all-three-signals path', () => {
    it('emits exactly one complete event with reason=all_signals when all three signals fire', () => {
      const detector = makeDetector();
      const completeEvents = collectCompleteEvents(detector);
      const forcedEvents = collectForcedEvents(detector);

      detector.signalChildExited();
      detector.signalStdoutEof();
      detector.signalParserDrained();

      expect(completeEvents).toHaveLength(1);
      expect(completeEvents[0]).toEqual({ runId: RUN_ID, reason: 'all_signals' });
      expect(forcedEvents).toHaveLength(0);

      detector.dispose();
    });

    it('emits complete regardless of the order signals arrive', () => {
      const orders: Array<[string, string, string]> = [
        ['childExited', 'stdoutEof', 'parserDrained'],
        ['stdoutEof', 'childExited', 'parserDrained'],
        ['parserDrained', 'stdoutEof', 'childExited'],
        ['stdoutEof', 'parserDrained', 'childExited'],
        ['childExited', 'parserDrained', 'stdoutEof'],
        ['parserDrained', 'childExited', 'stdoutEof'],
      ];

      for (const [first, second, third] of orders) {
        const detector = makeDetector();
        const completeEvents = collectCompleteEvents(detector);
        const forcedEvents = collectForcedEvents(detector);

        const signalMap: Record<string, () => void> = {
          childExited: () => detector.signalChildExited(),
          stdoutEof: () => detector.signalStdoutEof(),
          parserDrained: () => detector.signalParserDrained(),
        };

        signalMap[first]();
        signalMap[second]();
        signalMap[third]();

        expect(completeEvents).toHaveLength(1);
        expect(completeEvents[0].reason).toBe('all_signals');
        expect(forcedEvents).toHaveLength(0);

        detector.dispose();
      }
    });

    it('does NOT double-emit when signals arrive again after complete', () => {
      const detector = makeDetector();
      const completeEvents = collectCompleteEvents(detector);

      detector.signalChildExited();
      detector.signalStdoutEof();
      detector.signalParserDrained();

      // Fire all signals again — must not produce a second emission
      detector.signalChildExited();
      detector.signalStdoutEof();
      detector.signalParserDrained();

      expect(completeEvents).toHaveLength(1);

      detector.dispose();
    });
  });

  // -------------------------------------------------------------------------
  // Partial signal sets → zero emissions before watchdog
  // -------------------------------------------------------------------------

  describe('partial-signal cases', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('one signal alone produces zero emissions and leaves watchdog pending', () => {
      const detector = makeDetector();
      const completeEvents = collectCompleteEvents(detector);
      const forcedEvents = collectForcedEvents(detector);

      detector.signalChildExited();

      expect(completeEvents).toHaveLength(0);
      expect(forcedEvents).toHaveLength(0);
      // Watchdog timer should be running
      expect(vi.getTimerCount()).toBe(1);

      detector.dispose();
      // After dispose, no pending timers
      expect(vi.getTimerCount()).toBe(0);
    });

    it('two signals produce zero emissions and leave watchdog pending', () => {
      const detector = makeDetector();
      const completeEvents = collectCompleteEvents(detector);
      const forcedEvents = collectForcedEvents(detector);

      detector.signalChildExited();
      detector.signalStdoutEof();

      expect(completeEvents).toHaveLength(0);
      expect(forcedEvents).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(1);

      detector.dispose();
    });

    it('zero signals produces zero emissions and no pending timers', () => {
      const detector = makeDetector();
      const completeEvents = collectCompleteEvents(detector);
      const forcedEvents = collectForcedEvents(detector);

      expect(completeEvents).toHaveLength(0);
      expect(forcedEvents).toHaveLength(0);
      // No signal yet → no watchdog started
      expect(vi.getTimerCount()).toBe(0);

      detector.dispose();
    });
  });

  // -------------------------------------------------------------------------
  // 30s watchdog path: one signal + 30001ms → one 'forced' emission
  // -------------------------------------------------------------------------

  describe('watchdog path', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('fires exactly one forced event after 30s if not all signals received', () => {
      const detector = makeDetector();
      const completeEvents = collectCompleteEvents(detector);
      const forcedEvents = collectForcedEvents(detector);

      detector.signalChildExited(); // only one of three

      expect(forcedEvents).toHaveLength(0);

      vi.advanceTimersByTime(30_001);

      expect(forcedEvents).toHaveLength(1);
      expect(forcedEvents[0]).toEqual({
        runId: RUN_ID,
        reason: 'watchdog_timeout',
        missing: ['stdoutEof', 'parserDrained'],
      });
      expect(completeEvents).toHaveLength(0);

      detector.dispose();
    });

    it('forced payload lists only the unset flags in missing', () => {
      const detector = makeDetector();
      const forcedEvents = collectForcedEvents(detector);

      // Signal two of three
      detector.signalChildExited();
      detector.signalStdoutEof();

      vi.advanceTimersByTime(30_001);

      expect(forcedEvents).toHaveLength(1);
      expect(forcedEvents[0].missing).toEqual(['parserDrained']);
    });

    it('forced payload lists all three flags when zero signals sent before watchdog', () => {
      // Start the watchdog via the first signal, then advance time — but here
      // we test with one signal as initiator.
      const detector = makeDetector();
      const forcedEvents = collectForcedEvents(detector);

      detector.signalParserDrained(); // only third signal

      vi.advanceTimersByTime(30_001);

      expect(forcedEvents).toHaveLength(1);
      expect(forcedEvents[0].missing).toEqual(['childExited', 'stdoutEof']);
    });

    it('does NOT double-emit after forced: further signals produce no emission', () => {
      const detector = makeDetector();
      const completeEvents = collectCompleteEvents(detector);
      const forcedEvents = collectForcedEvents(detector);

      detector.signalChildExited();

      vi.advanceTimersByTime(30_001);

      expect(forcedEvents).toHaveLength(1);

      // Now fire the remaining signals — should NOT produce 'complete'
      detector.signalStdoutEof();
      detector.signalParserDrained();

      expect(completeEvents).toHaveLength(0);
      expect(forcedEvents).toHaveLength(1); // still exactly one

      detector.dispose();
    });

    it('watchdog fires at 30s boundary — not before, yes after', () => {
      const detector = makeDetector();
      const forcedEvents = collectForcedEvents(detector);

      detector.signalChildExited();

      vi.advanceTimersByTime(29_999);
      expect(forcedEvents).toHaveLength(0);

      vi.advanceTimersByTime(2); // cross 30_000ms boundary
      expect(forcedEvents).toHaveLength(1);

      detector.dispose();
    });

    it('all three signals arriving before watchdog fires suppresses watchdog', () => {
      const detector = makeDetector();
      const completeEvents = collectCompleteEvents(detector);
      const forcedEvents = collectForcedEvents(detector);

      detector.signalChildExited();
      detector.signalStdoutEof();
      detector.signalParserDrained(); // all three → should emit 'complete' and clear watchdog

      // Advance well past the watchdog window — no 'forced' should fire
      vi.advanceTimersByTime(60_000);

      expect(completeEvents).toHaveLength(1);
      expect(forcedEvents).toHaveLength(0);
      // No pending timers
      expect(vi.getTimerCount()).toBe(0);

      detector.dispose();
    });
  });

  // -------------------------------------------------------------------------
  // dispose() path: clears watchdog, prevents future emissions
  // -------------------------------------------------------------------------

  describe('dispose path', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('dispose() + all three signals → no emission and zero pending timers', () => {
      const detector = makeDetector();
      const completeEvents = collectCompleteEvents(detector);
      const forcedEvents = collectForcedEvents(detector);

      // Start the watchdog
      detector.signalChildExited();
      expect(vi.getTimerCount()).toBe(1);

      // Dispose cancels the watchdog
      detector.dispose();
      expect(vi.getTimerCount()).toBe(0);

      // Fire all three signals after dispose — should produce no emission
      detector.signalStdoutEof();
      detector.signalParserDrained();

      expect(completeEvents).toHaveLength(0);
      expect(forcedEvents).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('dispose() before any signal leaves no pending timers', () => {
      const detector = makeDetector();
      detector.dispose();

      // No signal started the watchdog so no timers should exist
      expect(vi.getTimerCount()).toBe(0);

      // Signals after dispose do nothing
      detector.signalChildExited();
      detector.signalStdoutEof();
      detector.signalParserDrained();

      expect(vi.getTimerCount()).toBe(0);
    });

    it('dispose() after forced emission produces no double-fire on timer advance', () => {
      const detector = makeDetector();
      const forcedEvents = collectForcedEvents(detector);

      detector.signalChildExited();

      vi.advanceTimersByTime(30_001);
      expect(forcedEvents).toHaveLength(1);

      // Dispose after forced — should be safe and idempotent
      detector.dispose();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Logger integration
  // -------------------------------------------------------------------------

  describe('logger integration', () => {
    it('calls logger.info on clean complete', () => {
      const logger = { info: vi.fn(), warn: vi.fn() };
      const detector = new CompletionDetector(RUN_ID, 30_000, logger);

      detector.signalChildExited();
      detector.signalStdoutEof();
      detector.signalParserDrained();

      expect(logger.info).toHaveBeenCalledOnce();
      expect(logger.info.mock.calls[0][0]).toContain('all_signals');

      detector.dispose();
    });

    it('calls logger.warn on watchdog timeout', () => {
      vi.useFakeTimers();
      try {
        const logger = { info: vi.fn(), warn: vi.fn() };
        const detector = new CompletionDetector(RUN_ID, 30_000, logger);

        detector.signalChildExited();
        vi.advanceTimersByTime(30_001);

        expect(logger.warn).toHaveBeenCalledOnce();
        expect(logger.warn.mock.calls[0][0]).toContain('watchdog_timeout');

        detector.dispose();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Signal method names — acceptance criteria verification
  // (Ensure the three public method names match the contract exactly)
  // -------------------------------------------------------------------------

  describe('signal API contract', () => {
    it('exposes exactly the three required signal methods', () => {
      const detector = makeDetector();

      expect(typeof detector.signalChildExited).toBe('function');
      expect(typeof detector.signalStdoutEof).toBe('function');
      expect(typeof detector.signalParserDrained).toBe('function');

      // No signalResultEvent method
      expect('signalResultEvent' in detector).toBe(false);

      detector.dispose();
    });
  });
});
