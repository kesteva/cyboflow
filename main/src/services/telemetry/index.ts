import * as Sentry from '@sentry/electron/main';
import { initialize as aptabaseInitialize, trackEvent as aptabaseTrack } from '@aptabase/electron/main';
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { scrubSentryEvent, scrubBreadcrumb } from './scrub';
import { environmentFromBuildInfo, type TelemetryEnvironment } from './environment';
import type { TelemetryEventMap, TelemetryEventName } from '../../../../shared/types/telemetry';

export type { TelemetryEnvironment } from './environment';

// Module-level singleton state. Both stay false until the corresponding SDK is
// successfully initialized (env credential present AND config flag enabled), so
// every telemetry entry point is a silent no-op when credentials are absent.
let sentryActive = false;
let aptabaseActive = false;

/** Resolve the telemetry environment by reading the packaged buildInfo.json. */
function resolveTelemetryEnvironment(): TelemetryEnvironment {
  if (!app.isPackaged) return 'local';
  let buildInfo: { environment?: unknown } | null = null;
  try {
    const buildInfoPath = path.join(process.resourcesPath, 'app', 'main', 'dist', 'buildInfo.json');
    if (fs.existsSync(buildInfoPath)) {
      buildInfo = JSON.parse(fs.readFileSync(buildInfoPath, 'utf8'));
    }
  } catch {
    buildInfo = null;
  }
  return environmentFromBuildInfo(app.isPackaged, buildInfo);
}

/**
 * Initialize error reporting (Sentry) and usage metrics (Aptabase) from the
 * resolved telemetry config. Each SDK is only initialized when its config flag
 * is enabled AND its credential env var is present; otherwise it is skipped
 * silently. Telemetry must never throw into app code.
 *
 * Errors are reported only from PACKAGED (.dmg) builds — both the Cyboflow Dev
 * release .dmg used for active testing (tagged 'dev') and stable releases
 * (tagged 'stable') — never under `pnpm dev`, where errors surface directly in
 * the console. Usage metrics fire ONLY for release builds ('dev' / 'stable') —
 * never under `pnpm dev` or an unstamped local `build:mac` .dmg.
 */
export function initTelemetry(cfg: {
  errorReportingEnabled: boolean;
  usageMetricsEnabled: boolean;
  installId: string;
}): void {
  const environment = resolveTelemetryEnvironment();
  const isPackagedBuild = app.isPackaged;
  const isReleaseBuild = environment !== 'local';

  // Errors are .dmg-only: under `pnpm dev` (unpackaged) they are tracked
  // directly in the console, so Sentry stays off to avoid dev noise.
  if (isPackagedBuild && cfg.errorReportingEnabled && process.env.SENTRY_DSN) {
    try {
      Sentry.init({
        dsn: process.env.SENTRY_DSN,
        release: app.getVersion(),
        environment,
        // Scrub every outbound event/breadcrumb so user source code, file
        // paths, repo names and prompts never leave the machine.
        beforeSend: (event) => scrubSentryEvent(event),
        beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
      });
      // Default integrations capture uncaught exceptions / unhandled
      // rejections — no manual process handlers needed.
      sentryActive = true;
    } catch {
      // Telemetry init must never break the app boot.
      sentryActive = false;
    }
  }

  // Usage metrics are release-only: a non-release build (unpackaged OR an
  // unstamped local `build:mac` .dmg) resolves to 'local' and is skipped.
  if (isReleaseBuild && cfg.usageMetricsEnabled && process.env.APTABASE_APP_KEY) {
    try {
      aptabaseInitialize(process.env.APTABASE_APP_KEY);
      aptabaseActive = true;
      trackUsage('app_started', { environment });
    } catch {
      aptabaseActive = false;
    }
  }
}

function emitUsage(name: string, props?: Record<string, string | number | boolean>): void {
  if (!aptabaseActive) return;
  try {
    aptabaseTrack(name, props);
  } catch {
    // Swallow — telemetry must never throw into app code.
  }
}

/**
 * Record an anonymous usage event (typed against the shared `TelemetryEventMap`).
 * For main-process call sites. No-op unless Aptabase was initialized; never throws.
 */
export function trackUsage<E extends TelemetryEventName>(
  event: E,
  props?: TelemetryEventMap[E],
): void {
  emitUsage(event, props as Record<string, string | number | boolean> | undefined);
}

/**
 * Forward a renderer-originated usage event over the `telemetry:track` IPC boundary.
 * The event/props were already type-checked at the renderer's `trackEvent`; here they
 * arrive as opaque JSON, so this entry point is intentionally stringly-typed.
 */
export function trackUsageFromRenderer(
  eventName: string,
  props?: Record<string, string | number | boolean>,
): void {
  emitUsage(eventName, props);
}

/** Whether Sentry error reporting was successfully initialized this boot. */
export function isSentryActive(): boolean {
  return sentryActive;
}
