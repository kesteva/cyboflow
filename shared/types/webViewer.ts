/**
 * Native web viewer — shared wire + config types.
 *
 * This module is compiled into BOTH the Electron main process and the Vite
 * renderer, so it must stay Electron-free: no `electron` import, no Node
 * built-ins, pure types plus a runtime guard. See
 * docs/proposals/native-web-viewer.md.
 */

/**
 * Stored shape of the `webViewer` config block. Every member is optional and
 * floors on READ (see ConfigManager.getWebViewerConfig), so config.json stays
 * byte-identical for users who never touch the feature — the same contract as
 * `visualVerify` and `idleSessionReview`.
 *
 * The split between `enabled` and the three agent members is deliberate:
 * HUMAN browsing ships ON (it is the feature), every AGENT capability ships
 * OFF. `enabled: false` is the master kill switch and disables the agent
 * capabilities too, regardless of their own values.
 */
export interface WebViewerConfig {
  /** Master switch for the whole viewer. Absent → floors to `true`. */
  enabled?: boolean;
  /** Let agents read telemetry / DOM / text / screenshots. Absent → `false`. */
  agentObserve?: boolean;
  /** Let agents drive a tab (navigate / click / type / eval). Absent → `false`. */
  agentDrive?: boolean;
  /**
   * Keep the human partition persistent (`persist:cyboflow-web-viewer`), so
   * logins survive a restart. Absent → `true`. Agent-opened tabs always use a
   * per-session ephemeral partition and are unaffected by this.
   */
  persistLogin?: boolean;
}

/** Fully-resolved web-viewer config (every member present). */
export interface ResolvedWebViewerConfig {
  enabled: boolean;
  agentObserve: boolean;
  agentDrive: boolean;
  persistLogin: boolean;
}

/**
 * Floor values applied on read for any omitted member. Human browsing on,
 * every agent capability off.
 */
export const WEB_VIEWER_DEFAULTS: ResolvedWebViewerConfig = {
  enabled: true,
  agentObserve: false,
  agentDrive: false,
  persistLogin: true,
};

/**
 * The complete set of storable keys. The config boundary iterates THIS, never
 * the caller's own object keys, so an unknown property can never reach
 * config.json.
 */
export const WEB_VIEWER_CONFIG_KEYS = [
  'enabled',
  'agentObserve',
  'agentDrive',
  'persistLogin',
] as const satisfies readonly (keyof WebViewerConfig)[];

export type WebViewerConfigKey = (typeof WEB_VIEWER_CONFIG_KEYS)[number];

/**
 * Strict per-member guard for the config boundary. Booleans ONLY — the config
 * tRPC input accepts any plain object, so a string `"false"` would otherwise
 * pass validation and then read as truthy everywhere downstream.
 */
export function isWebViewerConfigValue(value: unknown): value is boolean {
  return typeof value === 'boolean';
}
