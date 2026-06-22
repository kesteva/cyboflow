// Renderer-side telemetry helper.
//
// PRIVACY: props must be enum/scalar only — NEVER repo names, prompts, code, or
// file paths. Only emit closed-vocabulary identifiers (e.g. a flow name) and
// plain scalar counts/flags. Anything user-derived is forbidden here.

export type TelemetryEvent =
  | 'app_started'
  | 'workflow_run_started'
  | 'workflow_run_completed'
  | 'flow_selected'
  | 'session_created'
  | 'review_item_resolved'
  | 'settings_opened';

export type TelemetryProps = Record<string, string | number | boolean>;

export function trackEvent(event: TelemetryEvent, props?: TelemetryProps): void {
  try {
    window.electronAPI?.telemetry?.track(event, props);
  } catch {
    /* telemetry must never throw */
  }
}
