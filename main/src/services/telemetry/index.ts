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
 * The config flag is the single control: packaged (.dmg) builds default it ON
 * (opt-out), unpackaged `pnpm` builds default it OFF but leave it toggleable in
 * Settings (see configManager.defaultTelemetryEnabled). When the flag is on and
 * the credential env var is present, telemetry initializes regardless of build
 * type — so a developer can opt a local build in. The resolved `environment`
 * ('local' / 'dev' / 'stable') is still attached to every event.
 */
export function initTelemetry(cfg: {
  errorReportingEnabled: boolean;
  usageMetricsEnabled: boolean;
  installId: string;
}): void {
  const environment = resolveTelemetryEnvironment();

  // Gated purely on the config flag + credential presence. Local builds default
  // the flag off, but an opted-in developer (flag on + SENTRY_DSN set) gets it.
  if (cfg.errorReportingEnabled && process.env.SENTRY_DSN) {
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

  // Same posture for usage metrics: governed by the config flag (default off on
  // local builds, on for .dmg) plus the APTABASE_APP_KEY credential.
  if (cfg.usageMetricsEnabled && process.env.APTABASE_APP_KEY) {
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
