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
