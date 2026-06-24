// Renderer-side telemetry helper.
//
// PRIVACY: props must be enum/scalar only — NEVER repo names, prompts, code, or
// file paths. The per-event prop shapes are defined in the shared contract and
// enforced by `trackEvent`'s generic signature, so a wrong/free-text prop fails
// to compile. New events extend `TelemetryEventMap` in shared/types/telemetry.ts.

import type { TelemetryEventMap, TelemetryEventName } from '../../../shared/types/telemetry';

export type { TelemetryEventName, TelemetryEventMap } from '../../../shared/types/telemetry';
export type TelemetryProps = Record<string, string | number | boolean>;

/**
 * Record an anonymized usage event. Events whose props type is `Record<string, never>`
 * take no second argument; all others require their typed props object. Fire-and-forget
 * over the `telemetry:track` IPC channel; never throws into app code, and a no-op when
 * usage metrics are disabled / no Aptabase key is configured (gated in main).
 */
export function trackEvent<E extends TelemetryEventName>(
  ...args: TelemetryEventMap[E] extends Record<string, never>
    ? [event: E]
    : [event: E, props: TelemetryEventMap[E]]
): void {
  const [event, props] = args as [E, TelemetryEventMap[E] | undefined];
  try {
    window.electronAPI?.telemetry?.track(event, props as TelemetryProps | undefined);
  } catch {
    /* telemetry must never throw */
  }
}
