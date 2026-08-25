/**
 * useOmpAvailability — what the OMP picker may offer on this install.
 *
 * - `launchable`: the main side has a live fleet session manager, so a remote
 *   worker can actually be spawned.
 * - `ariaMode`: this install supervises a REMOTE fleet rather than running OMP
 *   locally. The two OMP flavors are alternatives — the picker shows
 *   `omp-sdk`/`omp-pty` OR `omp-fleet`, never both.
 *
 * Read-only: this drives the SubstrateSelector gating. The provider toggle
 * (Settings → Integrations) is a SEPARATE gate, ANDed by the caller via
 * useIsAgentProviderEnabled('omp') — mirroring the two-sided availability in
 * omp-phase4-coexistence-adr.md §2.3. The renderer read is a courtesy, never
 * the enforcement: a launch that names a half-configured bridge still fails
 * closed on the main side.
 *
 * A transport failure floors `launchable` to `false` (the honest answer — we
 * cannot prove anything), never a stale `true`.
 *
 * WHY ariaMode COMES FROM THE CONFIG STORE, NOT THE QUERY. Both read the same
 * config.json, but the query answers ONCE per mount and never refetches — so a
 * picker that was already on screen when the toggle flipped kept the old flavor
 * and silently offered the wrong OMP family (or none). Reading the store makes
 * the swap reactive, because every Settings save already refreshes it.
 *
 * `launchable` still has to come from the main side (only it knows whether the
 * bridge resolved), so it is REFETCHED whenever ariaMode changes — the
 * supervise capability is derived from Aria mode, so the answer moves with it.
 */
import { useEffect, useMemo, useState } from 'react';
import { trpc } from '../trpc/client';
import { useConfigStore } from '../stores/configStore';

export interface OmpAvailability {
  /** A remote worker can actually be spawned right now. */
  launchable: boolean;
  /** Remote-fleet install: offer `omp-fleet` instead of the local OMP runtimes. */
  ariaMode: boolean;
}

export function useOmpAvailability(): OmpAvailability {
  // Reactive: the flavor swaps the moment the toggle is saved, on every picker
  // currently mounted. An unloaded config floors to false — the LOCAL runtimes,
  // which need no bridge.
  const ariaMode = useConfigStore((s) => s.config?.ariaMode === true);
  const [launchable, setLaunchable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Null-safe: a partial `trpc` mock (component tests) may omit `cyboflow.omp`;
    // a missing router means "cannot prove anything", which is exactly the floor.
    const availabilityQuery = trpc.cyboflow?.omp?.availability?.query;
    if (typeof availabilityQuery !== 'function') {
      setLaunchable(false);
      return () => {
        cancelled = true;
      };
    }
    availabilityQuery()
      .then((res) => {
        if (!cancelled) setLaunchable(res.launchable === true);
      })
      .catch(() => {
        if (!cancelled) setLaunchable(false);
      });
    return () => {
      cancelled = true;
    };
    // Refetched on an Aria change: `launchable` ANDs the supervise capability,
    // which Aria mode grants, so the previous answer is stale by definition.
  }, [ariaMode]);

  return useMemo(() => ({ launchable, ariaMode }), [launchable, ariaMode]);
}
