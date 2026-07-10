/**
 * Orchestrator-local telemetry sink registry.
 *
 * The orchestrator subtree holds a standalone-typecheck invariant: it MUST NOT
 * import from `main/src/services/*` (nor electron / better-sqlite3). So
 * orchestrator code that wants to record an anonymized usage event cannot call
 * `trackUsage` directly — that lives in `services/telemetry` and eagerly loads
 * the Sentry/Aptabase SDKs.
 *
 * Instead, the boot seam (`main/src/index.ts`, which is free of the invariant)
 * registers the real sink once via `setTelemetrySink(trackUsage)`, and
 * orchestrator code emits through `emitUsage()`. This mirrors the injected-
 * dependency pattern already used for `emitRunStatusChanged`. `emitUsage` is a
 * no-op until a sink is registered (and in unit tests, which never register
 * one), and never throws into orchestrator code.
 */
import type { TelemetryEventMap, TelemetryEventName } from '../../../shared/types/telemetry';

type TelemetrySink = <E extends TelemetryEventName>(event: E, props?: TelemetryEventMap[E]) => void;

let sink: TelemetrySink | null = null;

/** Register the real usage sink. Called once at the boot seam with `trackUsage`. */
export function setTelemetrySink(fn: TelemetrySink): void {
  sink = fn;
}

/** Emit an anonymized usage event from orchestrator code. No-op until a sink is set. */
export function emitUsage<E extends TelemetryEventName>(event: E, props?: TelemetryEventMap[E]): void {
  if (!sink) return;
  try {
    sink(event, props);
  } catch {
    // Telemetry must never throw into orchestrator code.
  }
}

// ---------------------------------------------------------------------------
// Seam-error sink — the same injected-dependency pattern as the usage sink
// above, but for HANDLED failures at named seams (run/session/step failures,
// timeouts, skips, systemic parks). Orchestrator code under the standalone-
// typecheck invariant cannot import `captureSeamError` (it lives in
// services/telemetry and eagerly loads the Sentry SDK), so the boot seam
// registers the real sink once via `setSeamErrorSink(captureSeamError)` and
// orchestrator code reports through `emitSeamError()`. No-op until a sink is
// registered (and in unit tests, which never register one); never throws into
// orchestrator code.
//
// Payload rules MIRROR captureSeamError (see services/telemetry/index.ts): the
// Sentry `extra` bag is scrubbed, so context must ride in `tags` —
// LOW-CARDINALITY, NON-PII values only (seam name, substrate, run status,
// workflow name, an errorClass label from classifyErrorPattern). Free-form
// detail belongs in the error MESSAGE, which beforeSend home-path-redacts.
// NEVER put run ids, file paths, prompts, or repo names in tags.
// ---------------------------------------------------------------------------
type SeamErrorSink = (seam: string, error: unknown, tags?: Record<string, string>) => void;

let seamErrorSink: SeamErrorSink | null = null;

/** Register the real seam-error sink. Called once at the boot seam with `captureSeamError`. */
export function setSeamErrorSink(fn: SeamErrorSink): void {
  seamErrorSink = fn;
}

/** Report a HANDLED seam error from orchestrator code. No-op until a sink is set. */
export function emitSeamError(seam: string, error: unknown, tags?: Record<string, string>): void {
  if (!seamErrorSink) return;
  try {
    seamErrorSink(seam, error, tags);
  } catch {
    // Telemetry must never throw into orchestrator code.
  }
}
