/**
 * Environment kill switches for Environments (hosts). Read per call (never cached), so a test or a relaunch
 * with the variable set takes effect without other state. Only the exact value '1' counts.
 *
 *  - CYBOFLOW_DISABLE_REMOTE_HOSTS=1: no SSH preflights, no terminals, add/update of SSH machines refused;
 *    rows stay readable and This Mac is still listed.
 *  - CYBOFLOW_DISABLE_HOST_PREFLIGHT_SCHEDULE=1: stops only the scheduled (daily / app-version-change)
 *    preflights; "Check again" still works.
 */
export const REMOTE_HOSTS_KILL_SWITCH_ENV = 'CYBOFLOW_DISABLE_REMOTE_HOSTS';
export const HOST_PREFLIGHT_SCHEDULE_KILL_SWITCH_ENV = 'CYBOFLOW_DISABLE_HOST_PREFLIGHT_SCHEDULE';

export function isRemoteHostsKilled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[REMOTE_HOSTS_KILL_SWITCH_ENV] === '1';
}

export function isHostPreflightScheduleKilled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[HOST_PREFLIGHT_SCHEDULE_KILL_SWITCH_ENV] === '1';
}
