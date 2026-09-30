/**
 * Shared types for the `cyboflow.system` snapshot. The port/socket portion is
 * declared here exactly once — the system router and `index.ts` boot wiring
 * import it rather than redeclaring. Type-only: no runtime imports, so it stays
 * safe under the standalone-typecheck invariant.
 */
import type { PortProbeResult } from './portProbe';

/** The fixed ports the System view probes. */
export const DEV_RENDERER_PROBE_PORT = 4521;
export const CDP_PROBE_PORT = 9223;

/** `orch.sock` occupancy, matching OrchSocketServer's public getters. */
export interface OrchSocketSnapshot {
  /** `OrchSocketServer.getConnectionCount()` — all open client connections. */
  connectionCount: number;
  /** `OrchSocketServer.getRunBindingCounts()` — live socket count per bound runId. */
  runBindings: Record<string, number>;
}

export interface PortsAndSocketsSnapshot {
  /** :4521 dev renderer. */
  devRenderer: PortProbeResult;
  /** :9223 CDP. */
  cdp: PortProbeResult;
  orchSocket: OrchSocketSnapshot;
}
