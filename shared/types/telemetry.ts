/**
 * Telemetry usage-event contract — the single closed source of truth shared by
 * the renderer (`frontend/src/utils/telemetry.ts` → `trackEvent`) and the main
 * process (`main/src/services/telemetry` → `trackUsage`).
 *
 * PRIVACY: every prop value below is a fixed enum, boolean, or number. NEVER add
 * a prop that can carry user content — no repo/branch/project names, prompts,
 * file paths, or entity (idea/epic/task) titles or bodies. New events extend
 * `TelemetryEventMap`; the typed helpers enforce per-event prop shapes so a wrong
 * or free-text prop fails to compile.
 */
import type { PermissionMode, CyboflowWorkflowName } from './workflows';
import type { CliSubstrate } from './substrate';

/** Built-in flow names plus a catch-all for user-defined ("save as new") flows. */
export type TelemetryFlow = CyboflowWorkflowName | 'custom';

/** Telemetry build environment (mirrors `main/src/services/telemetry/environment.ts`). */
export type TelemetryEnvironment = 'local' | 'dev' | 'stable';

export interface TelemetryEventMap {
  // ── Tier 1 — activation + the core run funnel ───────────────────────────────
  app_started: { environment: TelemetryEnvironment };
  project_created: { source?: 'wizard' | 'dialog' };
  flow_selected: { flow: TelemetryFlow };
  workflow_run_started: {
    flow: TelemetryFlow;
    launch_surface: 'wizard' | 'topbar' | 'backlog' | 'in_session';
    substrate?: CliSubstrate;
    permission_mode?: PermissionMode;
  };
  workflow_run_completed: {
    outcome: 'completed' | 'failed' | 'canceled';
    flow?: TelemetryFlow;
    duration_seconds?: number;
  };
  workflow_run_reopened: { via: 'composer' | 'boot_recovery' };
  session_created: { kind: 'quick' | 'flow_hosted'; substrate?: CliSubstrate };
  session_resolved: { action: 'merge' | 'pr' | 'dismiss'; had_conflicts?: boolean };

  // ── Tier 2 — human-in-the-loop + feature breadth ────────────────────────────
  review_item_resolved: {
    kind: 'finding' | 'permission' | 'decision' | 'human_task';
    action: 'resolve' | 'dismiss' | 'promote_to_task';
    blocking?: boolean;
  };
  approval_decided: { decision: 'approve' | 'reject'; scope: 'single' | 'rest_of_run' };
  view_opened: { view: 'human_review' | 'backlog' | 'insights' | 'workflows' };
  settings_opened: Record<string, never>;
  telemetry_opt_out_changed: { channel: 'errors' | 'usage'; enabled: boolean };

  // ── Tier 3 — customization + config ─────────────────────────────────────────
  workflow_saved: { scope: 'global' | 'project' };
  workflow_deleted: Record<string, never>;
  agent_saved: { custom: boolean };
  permission_mode_changed: { mode: PermissionMode };
  substrate_default_changed: { substrate: CliSubstrate };
  theme_changed: { theme: 'paper' | 'light' | 'dark' };
  update_applied: { variant: 'stable' | 'dev' };
}

export type TelemetryEventName = keyof TelemetryEventMap;
