/**
 * mcpHealthStore — Zustand store for CyboflowMcpServer subprocess health.
 *
 * ## Status enum
 *
 * The store uses a three-value status enum that maps onto the UI dot colours:
 *   'healthy'  → green  (MCP server is running normally)
 *   'starting' → yellow (initial boot, restarting, or unknown)
 *   'error'    → red    (failed, stopped, or repeated restart attempts)
 *
 * The tRPC query (`trpc.cyboflow.health.mcpServer`) returns the four-value
 * McpServerHealth type from shared/types/mcpHealth.ts:
 *   'running'  → mapped to 'healthy'
 *   'starting' → mapped to 'starting'
 *   'failed'   → mapped to 'error'
 *   'stopped'  → mapped to 'error'
 *
 * ## Subscription path
 *
 * This store polls via `trpc.cyboflow.health.mcpServer.query()`.
 * The query returns a McpServerHealth snapshot on every call.  A tRPC
 * subscription path (`cyboflow.events.onMcpHealth`) does NOT yet exist —
 * TASK-535 (cyboflow-mcp-server epic) owns the push-based subscription.
 *
 * FIND-SPRINT-013-TODO: When TASK-535 lands, subscribe to
 * `trpc.cyboflow.events.onMcpHealth` and remove the polling interval.
 * The wiring point is the `subscribeToMcpHealth()` action below — replace
 * the `setInterval` block with the tRPC subscription.
 *
 * ## Cold-mount guarantee
 *
 * Default status is 'starting' (yellow).  The store never starts 'healthy'
 * without receiving a 'running' probe from the main process.
 */
import { create } from 'zustand';
import type { McpServerHealth, McpHealthUiStatus } from '../../../shared/types/mcpHealth';
import { toUiStatus } from '../../../shared/types/mcpHealth';
import { trpc } from '../trpc/client';

// ---------------------------------------------------------------------------
// Store status enum (three-value UI-level status)
// ---------------------------------------------------------------------------

/** @alias McpHealthUiStatus — preserved for backward-compat with existing imports. */
export type McpHealthStatus = McpHealthUiStatus;

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

export interface McpHealthState {
  /** Three-value UI status — never 'healthy' before first probe. */
  status: McpHealthStatus;
  /** Unix timestamp (ms) of the last successful health check, or null. */
  lastCheckedAt: number | null;
  /** Last error string surfaced by the MCP server, if any. */
  lastError: string | null;
  /** Subprocess PID if available from the health snapshot. */
  pid: number | null;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface McpHealthActions {
  /** Merge a partial state patch into the store (used by the poller). */
  setHealth: (patch: Partial<McpHealthState>) => void;
  /**
   * Start the polling loop against `trpc.cyboflow.health.mcpServer`.
   *
   * Returns an unsubscribe function.  Call during app mount; call the
   * returned cleanup during unmount or hot-reload.
   *
   * FUTURE(TASK-535): Replace this polling loop with a tRPC push subscription
   * once `cyboflow.events.onMcpHealth` is emitted by the orchestrator.
   */
  subscribeToMcpHealth: () => () => void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useMcpHealthStore = create<McpHealthState & McpHealthActions>()((set) => ({
  // Default state: 'starting' (yellow) — never 'healthy' before first probe.
  status: 'starting',
  lastCheckedAt: null,
  lastError: null,
  pid: null,

  setHealth(patch) {
    set((prev) => ({ ...prev, ...patch }));
  },

  subscribeToMcpHealth() {
    let alive = true;

    const poll = async () => {
      try {
        // Primary channel: trpc.cyboflow.health.mcpServer (tRPC query).
        // Subscription channel: NOT yet available — TASK-535 will add
        //   trpc.cyboflow.events.onMcpHealth push events.
        const raw: McpServerHealth = await trpc.cyboflow.health.mcpServer.query();

        if (!alive) return;

        set({
          status: toUiStatus(raw.status),
          lastCheckedAt: Date.now(),
          lastError: raw.lastError ?? null,
          // McpServerHealth does not expose a PID field yet — default null.
          // FUTURE(TASK-535): populate pid from the health snapshot once the
          //   subprocess lifecycle manager exposes it.
          pid: null,
        });
      } catch {
        // Orchestrator not yet ready — stay in current state.
      }
    };

    // Fire immediately, then every 5 seconds.
    void poll();
    const intervalId = setInterval(() => { void poll(); }, 5000);

    return () => {
      alive = false;
      clearInterval(intervalId);
    };
  },
}));
