import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Stable spy references shared across vi.resetModules() reloads (same pattern as
// initTelemetry.test.ts): vi.hoisted runs before the vi.mock factories, so one
// set of fns backs every reimport of the module under test.
const sentry = vi.hoisted(() => ({ init: vi.fn(), captureException: vi.fn() }));
const aptabase = vi.hoisted(() => ({ initialize: vi.fn(), trackEvent: vi.fn() }));

vi.mock('@sentry/electron/main', () => ({
  init: sentry.init,
  captureException: sentry.captureException,
}));

vi.mock('@aptabase/electron/main', () => ({
  initialize: aptabase.initialize,
  trackEvent: aptabase.trackEvent,
}));

vi.mock('electron', () => ({
  app: { isPackaged: false, getVersion: vi.fn(() => '0.2.7') },
}));

const CFG = { errorReportingEnabled: true, usageMetricsEnabled: true, installId: 'test-install-id' };

/**
 * Boot a live Sentry (unpackaged + flag on + DSN present is enough — see
 * initTelemetry) and hand back the capture entry point. Every test needs an
 * ACTIVE Sentry, because captureSeamError returns before the fingerprint is
 * computed when reporting is off.
 */
async function loadWithActiveSentry(): Promise<
  (seam: string, error: unknown, tags?: Record<string, string>) => void
> {
  process.env.SENTRY_DSN = 'https://public@example.ingest.sentry.io/1';
  const mod = await import('../index');
  mod.initTelemetry(CFG);
  expect(mod.isSentryActive()).toBe(true);
  return mod.captureSeamError;
}

/** The `fingerprint` array the single captureException call was given. */
function capturedFingerprint(): string[] {
  expect(sentry.captureException).toHaveBeenCalledTimes(1);
  return sentry.captureException.mock.calls[0][1].fingerprint;
}

describe('captureSeamError explicit fingerprinting', () => {
  beforeEach(() => {
    vi.resetModules();
    sentry.init.mockClear();
    sentry.captureException.mockClear();
    aptabase.initialize.mockClear();
    aptabase.trackEvent.mockClear();
  });

  afterEach(() => {
    delete process.env.SENTRY_DSN;
  });

  it('groups a classified seam error by [seam, errorClass]', async () => {
    const captureSeamError = await loadWithActiveSentry();
    captureSeamError('monitor-query-failed', new Error('monitor triage query failed (timed-out)'), {
      substrate: 'sdk',
      queryKind: 'triage',
      errorClass: 'timed-out',
    });
    expect(capturedFingerprint()).toEqual(['monitor-query-failed', 'timed-out']);
  });

  it('appends errorDigest so distinct unclassified failures at one seam stay separable', async () => {
    const captureSeamError = await loadWithActiveSentry();
    captureSeamError('sdk-session-terminal-result', new Error('sdk terminal result (other)'), {
      errorClass: 'other',
      errorShape: 'plain-message',
      errorDigest: 'a1b2c3d4',
    });
    expect(capturedFingerprint()).toEqual(['sdk-session-terminal-result', 'other', 'a1b2c3d4']);
  });

  it('falls back to the seam alone when no class is reported', async () => {
    const captureSeamError = await loadWithActiveSentry();
    captureSeamError('sdk-first-event-timeout', new Error('SDK query yielded no events'));
    expect(capturedFingerprint()).toEqual(['sdk-first-event-timeout']);
  });

  it('separates two seams that share a stack shape — the CYBOFLOW-APP-B lumping', async () => {
    // Both of these fire from claudeCodeManager.runSdkQuery and were grouped into
    // ONE Sentry issue by stack similarity despite being different failures.
    const captureSeamError = await loadWithActiveSentry();
    captureSeamError('sdk-session-terminal-result', new Error('sdk terminal result (other)'), {
      errorClass: 'other',
    });
    captureSeamError('sdk-session-error', new Error('sdk session error (other)'), {
      errorClass: 'other',
    });
    const [first, second] = sentry.captureException.mock.calls.map((c) => c[1].fingerprint);
    expect(first).toEqual(['sdk-session-terminal-result', 'other']);
    expect(second).toEqual(['sdk-session-error', 'other']);
    expect(first).not.toEqual(second);
  });

  it('keeps one seam+class in ONE group regardless of release — the S/F/1D fragmentation', async () => {
    // The fingerprint must not depend on anything build-varying (minified line
    // numbers were what split this seam three ways across releases).
    const captureSeamError = await loadWithActiveSentry();
    captureSeamError('monitor-query-failed', new Error('failed at main.dist/a.js:149:72'), {
      errorClass: 'other',
      errorDigest: 'deadbeef',
    });
    captureSeamError('monitor-query-failed', new Error('failed at main.dist/a.js:207:31'), {
      errorClass: 'other',
      errorDigest: 'deadbeef',
    });
    const [first, second] = sentry.captureException.mock.calls.map((c) => c[1].fingerprint);
    expect(first).toEqual(second);
  });

  it('still tags the seam alongside the caller tags', async () => {
    const captureSeamError = await loadWithActiveSentry();
    captureSeamError('run-finalize-failed', new Error('run failed (other)'), {
      errorClass: 'other',
      flow: 'ship',
    });
    expect(sentry.captureException.mock.calls[0][1].tags).toEqual({
      seam: 'run-finalize-failed',
      errorClass: 'other',
      flow: 'ship',
    });
  });

  it('does not report at all when Sentry is inactive', async () => {
    // No DSN — initTelemetry leaves Sentry off and the capture is a silent no-op.
    const { initTelemetry, captureSeamError, isSentryActive } = await import('../index');
    initTelemetry(CFG);
    expect(isSentryActive()).toBe(false);
    captureSeamError('monitor-query-failed', new Error('boom'), { errorClass: 'other' });
    expect(sentry.captureException).not.toHaveBeenCalled();
  });
});

describe('captureSeamError drops systemic environment conditions', () => {
  beforeEach(() => {
    vi.resetModules();
    sentry.init.mockClear();
    sentry.captureException.mockClear();
  });

  afterEach(() => {
    delete process.env.SENTRY_DSN;
  });

  // The three live 0.4.2 shapes (CYBOFLOW-APP-29, -26, -27): each correctly
  // classified systemic, each previously reported as an app defect.
  it.each([
    ['sdk-session-terminal-result', 'limit-verb-first'],
    ['sdk-session-terminal-result', 'auth-failed-to-authenticate'],
    ['monitor-query-failed', 'auth-failed-to-authenticate'],
    ['sdk-session-error', 'net-connection-closed'],
  ])('does not send %s (%s) to Sentry', async (seam, errorClass) => {
    const captureSeamError = await loadWithActiveSentry();
    captureSeamError(seam, new Error(`${seam} (${errorClass})`), { substrate: 'sdk', errorClass });
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('still records a dropped systemic error in the local bug-report buffer', async () => {
    const captureSeamError = await loadWithActiveSentry();
    const { getRecentErrors } = await import('../diagnostics');
    captureSeamError('sdk-session-terminal-result', new Error('sdk terminal result (limit-verb-first)'), {
      errorClass: 'limit-verb-first',
    });
    expect(getRecentErrors().some((e) => e.seam === 'sdk-session-terminal-result')).toBe(true);
  });

  it('still reports non-systemic and unclassified classes', async () => {
    const captureSeamError = await loadWithActiveSentry();
    captureSeamError('monitor-query-failed', new Error('x'), { errorClass: 'timed-out' });
    captureSeamError('sdk-session-terminal-result', new Error('y'), { errorClass: 'other', errorDigest: '01cebb29' });
    expect(sentry.captureException).toHaveBeenCalledTimes(2);
  });
});
