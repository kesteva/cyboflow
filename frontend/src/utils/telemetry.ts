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

/** The two persisted telemetry channel flags, as both surfaces resolve them. */
export interface TelemetryChannelFlags {
  errorReportingEnabled: boolean;
  usageMetricsEnabled: boolean;
}

/**
 * Emit `telemetry_opt_out_changed` for each channel whose value actually changed
 * between the persisted baseline and the newly saved flags. Shared by the
 * onboarding Telemetry step (OnboardingGate) and Settings → Privacy & Telemetry
 * so the event semantics — diff against pre-save baseline, fire ONLY after a
 * successful save, one event per changed channel — can never drift between the
 * two surfaces. Call it only after the config write succeeded.
 *
 * `emit` is test-injectable: module mocks that replace `trackEvent` with a spy
 * can delegate to this real implementation with the spy wired in, keeping the
 * diff logic single-source while still asserting on the emitted events.
 */
export function emitTelemetryChangeEvents(
  baseline: TelemetryChannelFlags,
  next: TelemetryChannelFlags,
  emit: typeof trackEvent = trackEvent,
): void {
  if (baseline.errorReportingEnabled !== next.errorReportingEnabled) {
    emit('telemetry_opt_out_changed', { channel: 'errors', enabled: next.errorReportingEnabled });
  }
  if (baseline.usageMetricsEnabled !== next.usageMetricsEnabled) {
    emit('telemetry_opt_out_changed', { channel: 'usage', enabled: next.usageMetricsEnabled });
  }
}
