/**
 * The agent rail's collapse flag, reachable from non-component code (the
 * onboarding tour's exits) without importing the rail's whole body. The state
 * itself lives in layoutStore (persisted under AGENT_RAIL_COLLAPSED_KEY, the
 * key the rail has always used) so ⌘] and the rail's own chevron share it.
 */
import { AGENT_RAIL_COLLAPSED_KEY, useLayoutStore } from '../../stores/layoutStore';

export { AGENT_RAIL_COLLAPSED_KEY };

/**
 * Force the rail OPEN — now (the store is live, so a mounted rail expands
 * immediately) and on every later mount (the flag is persisted). The
 * onboarding exits are the callers: the tour must hand the user a visible
 * assistant rail whether it is already mounted (steps 12-14) or about to be
 * (steps 7-11). Best-effort on the persistence side (storage can be
 * unavailable).
 */
export function expandAgentRail(): void {
  useLayoutStore.setState({ agentRailCollapsed: false });
  try {
    localStorage.setItem(AGENT_RAIL_COLLAPSED_KEY, 'false');
  } catch {
    // localStorage unavailable — the live store still expanded the rail.
  }
}
