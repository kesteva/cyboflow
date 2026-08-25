/**
 * cyboflow.omp sub-router — read-only OMP fleet awareness.
 *
 * Exposes a REDACTED fleet summary from the injected OmpControlPlaneAdapter.
 * The adapter's full snapshot carries task text, lastOutput, repoPath,
 * allowedPaths, and failure-report output — none of which may cross into the
 * renderer. This router maps it to the renderer-safe view DTO BEFORE the tRPC
 * reply, so sensitive fields never leave main.
 *
 * Read-only by construction: no mutation surface lives here (commands are a
 * separate, privileged router).
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3',
 * or main/src/services/*.
 */
import { router, protectedProcedure } from '../trpc';
import type {
  OmpFleetViewResult,
  OmpFleetViewSnapshot,
  OmpSnapshotResult,
} from '../../../../../shared/types/omp';
import { hasSupervise } from '../../../../../shared/types/ompCommand';

/** Map a full snapshot to the renderer-safe view projection. */
function toViewSnapshot(result: OmpSnapshotResult): OmpFleetViewResult {
  if (!result.ok) {
    return result;
  }
  const s = result.snapshot;
  const view: OmpFleetViewSnapshot = {
    version: s.version,
    savedAt: s.savedAt,
    totalWorkers: s.workers.length,
    workers: s.workers.map((w) => ({
      id: w.id,
      label: w.label,
      model: w.model,
      status: w.status,
      backend: w.backend,
      spawnedAt: w.spawnedAt,
      lastSeenAt: w.lastSeenAt,
    })),
  };
  return { ok: true, snapshot: view };
}

export const ompRouter = router({
  /**
   * What the OMP picker may offer.
   *
   * `launchable` asks the boot-built fleet manager whether it EXISTS, rather
   * than re-deriving "bridge config resolved" here. The manager owns long-lived
   * remote workers, so it is constructed once at boot; re-deriving would let the
   * picker offer OMP fleet the instant Aria mode is toggled, while dispatch
   * still answered "the bridge is not configured" until the next launch. Asking
   * the manager keeps the picker and the dispatch seam telling the same story.
   *
   * `ariaMode` says WHICH OMP flavor this install runs — the renderer shows the
   * local runtimes (`omp-sdk`/`omp-pty`) or the fleet supervisor, never both.
   * Reported live from config, so the picker reflects a toggle immediately even
   * though `launchable` waits for the relaunch.
   *
   * Both are read-only probes. The renderer ANDs them with the `omp` provider
   * toggle; none of it is enforcement — the main side fails closed regardless.
   */
  availability: protectedProcedure.query(({ ctx }) => ({
    launchable: ctx.ompFleetLaunchable?.() === true && hasSupervise(ctx.principal),
    ariaMode: ctx.ompAriaMode?.() === true,
  })),
  /**
   * The latest fleet summary (redacted), or a discriminated failure.
   * An absent registry surfaces as `{ ok: false, error: 'missing' }`; an
   * unreadable (permission-denied/IO) registry as `'unavailable'`; a parse or
   * version failure as `'malformed'` / `'unsupported-version'`. Never a thrown
   * error or an empty-success.
   */
  fleetSnapshot: protectedProcedure.query(async ({ ctx }): Promise<OmpFleetViewResult> => {
    const omp = ctx.omp;
    if (!omp) {
      return {
        ok: false,
        error: 'unavailable',
        detail: 'OMP adapter not configured',
      };
    }
    const result = await omp.getFleetSnapshot();
    return toViewSnapshot(result);
  }),
});
