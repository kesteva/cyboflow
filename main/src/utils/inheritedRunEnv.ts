/**
 * The boot-time strip of PER-RUN cyboflow env inherited from a HOSTING cyboflow
 * session (dogfooding: `pnpm dev` launched from a shell inside another cyboflow
 * instance). These vars are only meaningful when stamped per spawned agent by
 * the panel managers; inherited values are ALWAYS stale here — and because dev
 * instances share ~/.cyboflow_dev, a leaked CYBOFLOW_RUN_ID can even RESOLVE
 * (to the hosting session's run), silently misdirecting any child process that
 * spreads process.env without re-stamping (e.g. terminal panels, shell hooks).
 * runShellManager.ts deletes CYBOFLOW_RUN_ID for its own spawns for exactly
 * this reason; this boot-time strip closes every other path at the source.
 * Deliberately NOT stripped: user-facing config/kill-switch vars
 * (CYBOFLOW_DIR, CYBOFLOW_DISABLE_WARM_SDK, CYBOFLOW_DEV_FORCE_GATE_STREAM_CLOSED).
 *
 * Extracted from index.ts (issue #19 file-size ratchet); index.ts calls
 * stripInheritedRunEnv(process.env) at the same top-level point as before.
 */
export const INHERITED_RUN_ENV_KEYS: readonly string[] = [
  'CYBOFLOW_RUN_ID',
  'CYBOFLOW_SESSION_ID',
  'CYBOFLOW_ORCH_SOCKET',
  // A hosting instance's bearer token is not only stale here, it is a live
  // credential for ANOTHER app instance's run — strip it hardest of all.
  'CYBOFLOW_ORCH_TOKEN',
  'CYBOFLOW_RUN_ARTIFACTS_DIR',
  'CYBOFLOW_SUBSTRATE',
  'CYBOFLOW_EXECUTION_MODEL',
  // Identity of a HOSTING instance (spawnMarker.ts) — this process mints its own.
  'CYBOFLOW_INSTANCE',
];

export function stripInheritedRunEnv(env: NodeJS.ProcessEnv): void {
  for (const key of INHERITED_RUN_ENV_KEYS) {
    delete env[key];
  }
}
