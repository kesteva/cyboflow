/**
 * Environment kill switches for Agents & Environments. Read per call (never cached), so a test or a
 * relaunch with the variable set takes effect without other state.
 *
 *  - CYBOFLOW_DISABLE_PERSISTENT_AGENTS=1: the pump and outbox stop, the nav item and rail section hide;
 *    data is kept, reads still answer, mutations refuse.
 *  - CYBOFLOW_DISABLE_BRIDGE=1: the Bridge connector makes no network requests (no drain, no doorbell).
 */
export const PERSISTENT_AGENTS_KILL_SWITCH_ENV = 'CYBOFLOW_DISABLE_PERSISTENT_AGENTS';
export const BRIDGE_KILL_SWITCH_ENV = 'CYBOFLOW_DISABLE_BRIDGE';

export function isPersistentAgentsKilled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PERSISTENT_AGENTS_KILL_SWITCH_ENV] === '1';
}

export function isBridgeKilled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[BRIDGE_KILL_SWITCH_ENV] === '1';
}
