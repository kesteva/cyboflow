import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  setTelemetrySink,
  emitUsage,
  setSeamErrorSink,
  emitSeamError,
} from '../telemetrySink';

// The sink registry is module-level singleton state. Each test re-registers (or
// clears) the sink it exercises; emit* is a no-op until a sink is registered,
// which mirrors the unit-test default (no boot seam runs).
describe('telemetrySink — seam-error sink', () => {
  beforeEach(() => {
    // Reset both sinks to the unregistered state between tests.
    setTelemetrySink(undefined as never);
    setSeamErrorSink(undefined as never);
  });

  it('emitSeamError is a no-op until a sink is registered', () => {
    // No sink set — must not throw and must forward nothing.
    expect(() => emitSeamError('some-seam', new Error('boom'), { substrate: 'sdk' })).not.toThrow();
  });

  it('forwards seam, error, and tags to the registered sink', () => {
    const sink = vi.fn();
    setSeamErrorSink(sink);
    const err = new Error('usage limit reached');
    emitSeamError('run-finalize-failed', err, { errorClass: 'usage-limit-reached', substrate: 'sdk' });
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith('run-finalize-failed', err, {
      errorClass: 'usage-limit-reached',
      substrate: 'sdk',
    });
  });

  it('forwards a non-Error error value verbatim (sink normalizes)', () => {
    const sink = vi.fn();
    setSeamErrorSink(sink);
    emitSeamError('run-launch-failed', 'a string failure');
    expect(sink).toHaveBeenCalledWith('run-launch-failed', 'a string failure', undefined);
  });

  it('never throws into caller code even if the sink throws', () => {
    setSeamErrorSink(() => {
      throw new Error('sink exploded');
    });
    expect(() => emitSeamError('some-seam', new Error('boom'))).not.toThrow();
  });

  it('is independent from the usage sink (registering one does not wire the other)', () => {
    const usage = vi.fn();
    setTelemetrySink(usage);
    // No seam sink registered — emitSeamError stays a no-op, usage sink untouched.
    emitSeamError('some-seam', new Error('boom'));
    expect(usage).not.toHaveBeenCalled();
  });
});
