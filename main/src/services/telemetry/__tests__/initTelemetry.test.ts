import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { app } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Stable spy references shared across vi.resetModules() reloads. vi.hoisted runs
// before the vi.mock factories below, so the same fns back every reimport of the
// module under test and we can assert call counts after each initTelemetry().
const sentry = vi.hoisted(() => ({ init: vi.fn(), captureException: vi.fn() }));
const aptabase = vi.hoisted(() => ({ initialize: vi.fn(), trackEvent: vi.fn() }));

vi.mock('@sentry/electron/main', () => ({
  init: sentry.init,
  captureException: sentry.captureException,
  // scrub.ts imports only the Event/Breadcrumb *types* from here (erased at
  // compile time), so no further runtime exports are needed.
}));

vi.mock('@aptabase/electron/main', () => ({
  initialize: aptabase.initialize,
  trackEvent: aptabase.trackEvent,
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getVersion: vi.fn(() => '0.1.4'),
  },
}));

function setPackaged(value: boolean): void {
  (app as unknown as { isPackaged: boolean }).isPackaged = value;
}

// A throwaway resourcesPath whose app/main/dist/buildInfo.json drives the
// environment resolution exactly as a packaged build's would.
let tmpResources: string;
const realResourcesPath = process.resourcesPath;

/**
 * Write (or clear) the buildInfo.json the telemetry reader will pick up. `creds`
 * mirrors the keys baked by inject-build-info.js into a distributed packaged app.
 */
function stampBuildInfo(
  environment: 'local' | 'dev' | 'stable' | null,
  creds?: { sentryDsn?: string; aptabaseAppKey?: string },
  // The resource container the file sits under: 'app' mirrors an asar:false build,
  // 'app.asar' mirrors the default asar build where buildInfo.json lives inside the
  // archive (Electron resolves the member path the same way node fs resolves a dir).
  container: 'app' | 'app.asar' = 'app',
): void {
  const distDir = path.join(tmpResources, container, 'main', 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  const file = path.join(distDir, 'buildInfo.json');
  if (environment === null) {
    if (fs.existsSync(file)) fs.rmSync(file);
    return;
  }
  fs.writeFileSync(file, JSON.stringify({ environment, ...creds }));
}

const CFG = { errorReportingEnabled: true, usageMetricsEnabled: true, installId: 'test-install-id' };

describe('initTelemetry gating (Sentry + Aptabase paths)', () => {
  beforeEach(() => {
    vi.resetModules();
    sentry.init.mockClear();
    sentry.captureException.mockClear();
    aptabase.initialize.mockClear();
    aptabase.trackEvent.mockClear();
    setPackaged(false);
    tmpResources = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-tel-'));
    (process as unknown as { resourcesPath: string }).resourcesPath = tmpResources;
    delete process.env.SENTRY_DSN;
    delete process.env.APTABASE_APP_KEY;
  });

  afterEach(() => {
    (process as unknown as { resourcesPath: string }).resourcesPath = realResourcesPath;
    if (tmpResources && fs.existsSync(tmpResources)) fs.rmSync(tmpResources, { recursive: true, force: true });
  });

  // ---- Sentry path: opt-in (config flag) AND DSN present, any build type ----

  it('initializes Sentry for a packaged build with reporting on and a DSN', async () => {
    setPackaged(true);
    stampBuildInfo('stable');
    process.env.SENTRY_DSN = 'https://public@example.ingest.sentry.io/1';
    const { initTelemetry, isSentryActive } = await import('../index');
    initTelemetry(CFG);
    expect(sentry.init).toHaveBeenCalledTimes(1);
    expect(isSentryActive()).toBe(true);
    // The DSN, release version and environment are threaded through.
    const opts = sentry.init.mock.calls[0][0];
    expect(opts.dsn).toBe(process.env.SENTRY_DSN);
    expect(opts.environment).toBe('stable');
    expect(opts.release).toBe('0.1.4');
    expect(typeof opts.beforeSend).toBe('function');
    expect(typeof opts.beforeBreadcrumb).toBe('function');
  });

  it('initializes Sentry under pnpm dev (unpackaged) when opted in with a DSN — toggleable, env local', async () => {
    // pnpm builds default the flag OFF (see configManager), but a developer who
    // opts in (flag on + DSN present) gets telemetry; the build type no longer gates it.
    setPackaged(false);
    process.env.SENTRY_DSN = 'https://public@example.ingest.sentry.io/1';
    const { initTelemetry, isSentryActive } = await import('../index');
    initTelemetry(CFG);
    expect(sentry.init).toHaveBeenCalledTimes(1);
    expect(isSentryActive()).toBe(true);
    expect(sentry.init.mock.calls[0][0].environment).toBe('local');
  });

  // ---- Baked credentials: distributed packaged app, no env vars at runtime ----

  it('uses the Sentry DSN baked into buildInfo when no env var is set (distributed .dmg)', async () => {
    setPackaged(true);
    // No process.env.SENTRY_DSN — exactly a double-clicked packaged app.
    stampBuildInfo('stable', { sentryDsn: 'https://baked@example.ingest.sentry.io/9' });
    const { initTelemetry, isSentryActive } = await import('../index');
    initTelemetry(CFG);
    expect(sentry.init).toHaveBeenCalledTimes(1);
    expect(isSentryActive()).toBe(true);
    expect(sentry.init.mock.calls[0][0].dsn).toBe('https://baked@example.ingest.sentry.io/9');
  });

  it('uses the Aptabase key baked into buildInfo when no env var is set (distributed .dmg)', async () => {
    setPackaged(true);
    stampBuildInfo('stable', { aptabaseAppKey: 'A-US-BAKEDKEY00' });
    const { initTelemetry } = await import('../index');
    initTelemetry(CFG);
    expect(aptabase.initialize).toHaveBeenCalledWith('A-US-BAKEDKEY00');
    expect(aptabase.trackEvent).toHaveBeenCalledWith('app_started', { environment: 'stable' });
  });

  it('reads buildInfo.json from inside app.asar (the default asar build layout)', async () => {
    setPackaged(true);
    // No loose app/ dir — only the asar member path, exactly like a shipped .dmg.
    stampBuildInfo('stable', { aptabaseAppKey: 'A-US-ASARKEY000' }, 'app.asar');
    const { initTelemetry } = await import('../index');
    initTelemetry(CFG);
    expect(aptabase.initialize).toHaveBeenCalledWith('A-US-ASARKEY000');
    expect(aptabase.trackEvent).toHaveBeenCalledWith('app_started', { environment: 'stable' });
  });

  it('prefers the runtime env var over the baked buildInfo credential', async () => {
    setPackaged(true);
    stampBuildInfo('stable', { aptabaseAppKey: 'A-US-BAKED00000' });
    process.env.APTABASE_APP_KEY = 'A-US-ENVWINS0000';
    const { initTelemetry } = await import('../index');
    initTelemetry(CFG);
    expect(aptabase.initialize).toHaveBeenCalledWith('A-US-ENVWINS0000');
  });

  it('stays a silent no-op when neither env var nor baked credential is present', async () => {
    setPackaged(true);
    stampBuildInfo('stable'); // no creds baked, no env set
    const { initTelemetry, isSentryActive } = await import('../index');
    initTelemetry(CFG);
    expect(sentry.init).not.toHaveBeenCalled();
    expect(aptabase.initialize).not.toHaveBeenCalled();
    expect(isSentryActive()).toBe(false);
  });

  it('does NOT initialize Sentry when error reporting is opted out', async () => {
    setPackaged(true);
    stampBuildInfo('stable');
    process.env.SENTRY_DSN = 'https://public@example.ingest.sentry.io/1';
    const { initTelemetry, isSentryActive } = await import('../index');
    initTelemetry({ ...CFG, errorReportingEnabled: false });
    expect(sentry.init).not.toHaveBeenCalled();
    expect(isSentryActive()).toBe(false);
  });

  it('does NOT initialize Sentry when the DSN credential is absent', async () => {
    setPackaged(true);
    stampBuildInfo('stable');
    const { initTelemetry, isSentryActive } = await import('../index');
    initTelemetry(CFG);
    expect(sentry.init).not.toHaveBeenCalled();
    expect(isSentryActive()).toBe(false);
  });

  it('survives a throwing Sentry.init without breaking boot (isSentryActive false)', async () => {
    setPackaged(true);
    stampBuildInfo('stable');
    process.env.SENTRY_DSN = 'https://public@example.ingest.sentry.io/1';
    sentry.init.mockImplementationOnce(() => {
      throw new Error('sdk blew up');
    });
    const { initTelemetry, isSentryActive } = await import('../index');
    expect(() => initTelemetry(CFG)).not.toThrow();
    expect(isSentryActive()).toBe(false);
  });

  // ---- Aptabase path: opt-in (config flag) AND app key present, any build type ----

  it('initializes Aptabase and fires app_started for a stamped stable release', async () => {
    setPackaged(true);
    stampBuildInfo('stable');
    process.env.APTABASE_APP_KEY = 'A-US-0000000000';
    const { initTelemetry } = await import('../index');
    initTelemetry(CFG);
    expect(aptabase.initialize).toHaveBeenCalledWith('A-US-0000000000');
    expect(aptabase.trackEvent).toHaveBeenCalledWith('app_started', { environment: 'stable' });
  });

  it('initializes Aptabase for the Cyboflow Dev release channel (dev)', async () => {
    setPackaged(true);
    stampBuildInfo('dev');
    process.env.APTABASE_APP_KEY = 'A-US-0000000000';
    const { initTelemetry } = await import('../index');
    initTelemetry(CFG);
    expect(aptabase.initialize).toHaveBeenCalledTimes(1);
    expect(aptabase.trackEvent).toHaveBeenCalledWith('app_started', { environment: 'dev' });
  });

  it('initializes Aptabase under pnpm dev (unpackaged → local) when opted in with a key — toggleable', async () => {
    setPackaged(false);
    process.env.APTABASE_APP_KEY = 'A-US-0000000000';
    const { initTelemetry } = await import('../index');
    initTelemetry(CFG);
    expect(aptabase.initialize).toHaveBeenCalledWith('A-US-0000000000');
    expect(aptabase.trackEvent).toHaveBeenCalledWith('app_started', { environment: 'local' });
  });

  it('initializes Aptabase for an unstamped local .dmg (environment local) when opted in', async () => {
    setPackaged(true);
    stampBuildInfo('local');
    process.env.APTABASE_APP_KEY = 'A-US-0000000000';
    const { initTelemetry } = await import('../index');
    initTelemetry(CFG);
    expect(aptabase.initialize).toHaveBeenCalledWith('A-US-0000000000');
    expect(aptabase.trackEvent).toHaveBeenCalledWith('app_started', { environment: 'local' });
  });

  it('does NOT initialize Aptabase when usage metrics are opted out', async () => {
    setPackaged(true);
    stampBuildInfo('stable');
    process.env.APTABASE_APP_KEY = 'A-US-0000000000';
    const { initTelemetry } = await import('../index');
    initTelemetry({ ...CFG, usageMetricsEnabled: false });
    expect(aptabase.initialize).not.toHaveBeenCalled();
  });

  it('does NOT initialize Aptabase when the app key credential is absent', async () => {
    setPackaged(true);
    stampBuildInfo('stable');
    const { initTelemetry } = await import('../index');
    initTelemetry(CFG);
    expect(aptabase.initialize).not.toHaveBeenCalled();
  });

  // ---- trackUsage gating off the initialized state ----

  it('trackUsage forwards events once Aptabase is active', async () => {
    setPackaged(true);
    stampBuildInfo('stable');
    process.env.APTABASE_APP_KEY = 'A-US-0000000000';
    const { initTelemetry, trackUsage } = await import('../index');
    initTelemetry(CFG);
    aptabase.trackEvent.mockClear(); // drop the app_started call
    trackUsage('session_created', { kind: 'quick' });
    expect(aptabase.trackEvent).toHaveBeenCalledWith('session_created', { kind: 'quick' });
  });

  it('trackUsage is a silent no-op when Aptabase never initialized', async () => {
    setPackaged(false); // no APTABASE_APP_KEY set in beforeEach → aptabase never initializes
    const { initTelemetry, trackUsage } = await import('../index');
    initTelemetry(CFG);
    trackUsage('session_created', { kind: 'quick' });
    expect(aptabase.trackEvent).not.toHaveBeenCalled();
  });

  // ---- captureSeamError gating off the initialized state ----

  it('captureSeamError forwards to Sentry with the seam tag once active', async () => {
    setPackaged(true);
    stampBuildInfo('stable');
    process.env.SENTRY_DSN = 'https://public@example.ingest.sentry.io/1';
    const { initTelemetry, captureSeamError } = await import('../index');
    initTelemetry(CFG);
    const err = new Error('claude executable not found in PATH');
    captureSeamError('cli-availability', err, { cliTool: 'Claude Code (Interactive)' });
    expect(sentry.captureException).toHaveBeenCalledWith(err, {
      tags: { seam: 'cli-availability', cliTool: 'Claude Code (Interactive)' },
    });
  });

  it('captureSeamError wraps a non-Error value in an Error', async () => {
    setPackaged(true);
    stampBuildInfo('stable');
    process.env.SENTRY_DSN = 'https://public@example.ingest.sentry.io/1';
    const { initTelemetry, captureSeamError } = await import('../index');
    initTelemetry(CFG);
    captureSeamError('sdk-first-event-timeout', 'no events after 30000ms');
    const [captured, hint] = sentry.captureException.mock.calls[0];
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toBe('no events after 30000ms');
    expect(hint).toEqual({ tags: { seam: 'sdk-first-event-timeout' } });
  });

  it('captureSeamError is a silent no-op when Sentry never initialized', async () => {
    setPackaged(false); // no DSN in beforeEach → Sentry never initializes
    const { initTelemetry, captureSeamError } = await import('../index');
    initTelemetry(CFG);
    captureSeamError('cli-availability', new Error('boom'));
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('captureSeamError swallows a throwing Sentry.captureException', async () => {
    setPackaged(true);
    stampBuildInfo('stable');
    process.env.SENTRY_DSN = 'https://public@example.ingest.sentry.io/1';
    sentry.captureException.mockImplementationOnce(() => {
      throw new Error('transport down');
    });
    const { initTelemetry, captureSeamError } = await import('../index');
    initTelemetry(CFG);
    expect(() => captureSeamError('cli-availability', new Error('boom'))).not.toThrow();
  });

  it('trackUsage swallows a throwing aptabase trackEvent', async () => {
    setPackaged(true);
    stampBuildInfo('stable');
    process.env.APTABASE_APP_KEY = 'A-US-0000000000';
    const { initTelemetry, trackUsage } = await import('../index');
    initTelemetry(CFG);
    aptabase.trackEvent.mockImplementationOnce(() => {
      throw new Error('network down');
    });
    expect(() => trackUsage('session_created')).not.toThrow();
  });
});
