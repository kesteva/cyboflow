import * as Sentry from '@sentry/electron/main';
import { initialize as aptabaseInitialize, trackEvent as aptabaseTrack } from '@aptabase/electron/main';
import { app } from 'electron';
import { scrubSentryEvent, scrubBreadcrumb } from './scrub';

// Module-level singleton state. Both stay false until the corresponding SDK is
// successfully initialized (env credential present AND config flag enabled), so
// every telemetry entry point is a silent no-op when credentials are absent.
let sentryActive = false;
let aptabaseActive = false;

/**
 * Initialize error reporting (Sentry) and usage metrics (Aptabase) from the
 * resolved telemetry config. Each SDK is only initialized when its config flag
 * is enabled AND its credential env var is present; otherwise it is skipped
 * silently. Telemetry must never throw into app code.
 */
export function initTelemetry(cfg: {
  errorReportingEnabled: boolean;
  usageMetricsEnabled: boolean;
  installId: string;
}): void {
  if (cfg.errorReportingEnabled && process.env.SENTRY_DSN) {
    try {
      Sentry.init({
        dsn: process.env.SENTRY_DSN,
        release: app.getVersion(),
        environment: app.isPackaged ? 'production' : 'development',
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

  if (cfg.usageMetricsEnabled && process.env.APTABASE_APP_KEY) {
    try {
      aptabaseInitialize(process.env.APTABASE_APP_KEY);
      aptabaseActive = true;
      trackUsage('app_started');
    } catch {
      aptabaseActive = false;
    }
  }
}

/**
 * Record an anonymous usage event. No-op unless Aptabase was initialized.
 * Never throws into app code.
 */
export function trackUsage(name: string, props?: Record<string, string | number | boolean>): void {
  if (!aptabaseActive) return;
  try {
    aptabaseTrack(name, props);
  } catch {
    // Swallow — telemetry must never throw into app code.
  }
}

/** Whether Sentry error reporting was successfully initialized this boot. */
export function isSentryActive(): boolean {
  return sentryActive;
}
