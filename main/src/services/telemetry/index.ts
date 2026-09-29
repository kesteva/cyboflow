import * as Sentry from '@sentry/electron/main';
import { initialize as aptabaseInitialize, trackEvent as aptabaseTrack } from '@aptabase/electron/main';
import { app } from 'electron';
import {
  scrubSentryEvent,
  scrubBreadcrumb,
  isBenignStreamWriteEpipe,
  tagCrashSource,
  isDeliberateProcessTermination,
} from './scrub';
import { resolveTelemetryCredentials } from './credentials';
import { recordLocalError } from './diagnostics';
import { isSystemicErrorClass } from '../../orchestrator/programmatic/systemicError';
import type { TelemetryEventMap, TelemetryEventName } from '../../../../shared/types/telemetry';

export type { TelemetryEnvironment } from './environment';

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
  // Credential + environment resolution lives in ./credentials so the in-app bug
  // reporter can resolve the same DSN without duplicating the asar-path lookup.
  const { sentryDsn, aptabaseAppKey, environment } = resolveTelemetryCredentials();

  // Gated purely on the config flag + credential presence. Local builds default
  // the flag off, but an opted-in developer (flag on + DSN present) gets it.
  if (cfg.errorReportingEnabled && sentryDsn) {
    try {
      Sentry.init({
        dsn: sentryDsn,
        release: app.getVersion(),
        environment,
        // Scrub every outbound event/breadcrumb so user source code, file
        // paths, repo names and prompts never leave the machine.
        // Drop benign broken-pipe writes before scrubbing — the app already
        // swallows EPIPE at the process level, so these are duplicate noise
        // (see isBenignStreamWriteEpipe). Everything else is scrubbed + kept.
        // Native crashes are additionally tagged by provenance first: the
        // crashpad handler catches processes spawned BENEATH the app too, so a
        // minidump is not self-evidently ours (see tagCrashSource). A minidump
        // from a process we ENDED ON PURPOSE is dropped outright first — that
        // one is unambiguous (see isDeliberateProcessTermination). Scrubbing
        // stays the outermost step — nothing leaves without passing it.
        beforeSend: (event) =>
          isBenignStreamWriteEpipe(event) || isDeliberateProcessTermination(event)
            ? null
            : scrubSentryEvent(tagCrashSource(event)),
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
  // local builds, on for .dmg) plus the Aptabase app key.
  if (cfg.usageMetricsEnabled && aptabaseAppKey) {
    try {
      aptabaseInitialize(aptabaseAppKey);
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

/**
 * Capture a HANDLED error at a named seam. Sentry's default integrations only
 * see uncaught exceptions / unhandled rejections, so failure paths the app
 * catches and surfaces in the UI (CLI unavailable, spawn timeouts) are
 * invisible without an explicit capture like this.
 *
 * No-op unless Sentry initialized; never throws into app code.
 *
 * Payload rules (see scrub.ts): the `extra` bag is DELETED by scrubSentryEvent,
 * so context must ride in `tags` — low-cardinality, non-PII values only (seam
 * names, substrate, platform). Detail belongs in the error MESSAGE, which
 * beforeSend home-path-redacts automatically.
 *
 * Grouping is fingerprinted EXPLICITLY, never by stack — see `seamFingerprint`.
 * That makes the `errorClass` and `errorDigest` tags load-bearing rather than
 * decorative: they are what splits distinct failures at a shared seam.
 */
export function captureSeamError(
  seam: string,
  error: unknown,
  tags?: Record<string, string>,
): void {
  // Record locally FIRST, unconditionally. The Sentry guard below returns early
  // when reporting is off — and that is precisely when a user is most likely to
  // file a bug report by hand, so a buffer fed after the guard would always be
  // empty in the case it exists to serve.
  recordLocalError(seam, error, new Date().toISOString());

  if (!sentryActive) return;
  // A SYSTEMIC errorClass is the user's environment, not our defect — a usage
  // window exhausted, a rate limit, a dead login, a dropped network. The app
  // already handles those (parks the run, offers the sign-in card), so a Sentry
  // event only files someone's expired login as an app error and, because
  // triage ranks by volume, lets it outrank real bugs. 80bde3193 fixed this at
  // ONE seam (run-finalize-failed); the same classes kept arriving through
  // sdk-session-terminal-result and monitor-query-failed (CYBOFLOW-APP-26/-27/
  // -29: 17 of ~30 events on 0.4.2). Filtering here covers every seam, current
  // and future. Still recorded locally above for the in-app bug reporter.
  if (isSystemicErrorClass(tags?.errorClass)) return;
  try {
    const err = error instanceof Error ? error : new Error(String(error));
    Sentry.captureException(err, {
      tags: { seam, ...tags },
      fingerprint: seamFingerprint(seam, tags),
    });
  } catch {
    // Telemetry must never throw into app code.
  }
}

/**
 * The explicit Sentry grouping key for a seam capture.
 *
 * Sentry's default grouping fingerprints a handled capture by its STACK — which,
 * in a packaged build, is minified `main.dist/....js:LINE:COL`. Every seam here
 * constructs its `new Error(...)` at one fixed call site, so that stack carries
 * no information the seam name does not, while shifting with every build and
 * differing between the several call sites that share one seam. The observed
 * result was grouping that failed in both directions at once: `monitor-query-failed`
 * fragmented across three issues (CYBOFLOW-APP-S / -F / -1D), under-reporting its
 * true volume, while a single issue (-B) lumped `sdk-session-terminal-result`
 * together with `sdk-session-error`. Volume ranking is the only tool triage has
 * for choosing what to fix, and both failures corrupt it.
 *
 * So group on the identity the seam has already computed, not on the stack:
 *
 *   [seam, errorClass?, errorDigest?]
 *
 * `errorClass` comes from `classifyErrorPattern`'s bounded vocabulary, so it
 * separates genuinely different failures at one seam without unbounded
 * cardinality. `errorDigest` is attached only for the `other` / `unknown` classes
 * (see `unclassifiedErrorTags`) and is precisely the discriminator those need —
 * without it every unclassified failure at a seam piles into one bucket that
 * cannot say whether it is one bug or twenty.
 *
 * Both parts are optional and appended only when present, so a seam that reports
 * no class still groups cleanly by seam alone.
 *
 * NOTE: changing a fingerprint REGROUPS in Sentry — existing issues stop
 * receiving events and new ones are minted in their place. That one-time
 * discontinuity is the intended cost of correct grouping from here on.
 */
function seamFingerprint(seam: string, tags?: Record<string, string>): string[] {
  const fingerprint = [seam];
  if (tags?.errorClass) fingerprint.push(tags.errorClass);
  if (tags?.errorDigest) fingerprint.push(tags.errorDigest);
  return fingerprint;
}
