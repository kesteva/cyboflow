/**
 * The agent rail's persisted collapse flag, split out of AgentRail.tsx so
 * non-component code (the onboarding finale) can set it without importing the
 * rail's whole body.
 */

/** localStorage key: 'true' = collapsed. AgentRail's `collapsed` state seeds from it on mount. */
export const AGENT_RAIL_COLLAPSED_KEY = 'cyboflow.agentRail.collapsed';

/**
 * Force the rail OPEN on its next mount by writing the persisted collapse
 * flag directly. The onboarding finale is the caller: the tour hides the whole
 * shell, so <AgentRail/> is unmounted when the tour ends and there is no
 * component state to set — but its `collapsed` initializer reads the key on
 * the mount that follows, which is exactly the mount the finale is about to
 * trigger. Best-effort (storage can be unavailable).
 */
export function expandAgentRail(): void {
  try {
    localStorage.setItem(AGENT_RAIL_COLLAPSED_KEY, 'false');
  } catch {
    // localStorage unavailable — the rail keeps whatever state it had.
  }
}
