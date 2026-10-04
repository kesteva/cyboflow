/**
 * Maps the server's `ReapManifest` (cyboflow.monitorReap.resolve) onto the
 * presentational `ManifestConfirmData` the confirm dialogs render. Pure and
 * lossless for what the dialog shows: an unknown server figure (`null`) becomes an
 * absent field, never `0`.
 */
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '../../../../shared/types/trpc';
import type { ManifestConfirmData, ManifestConfirmTarget } from './ManifestConfirmDialog';
import { basename, processName } from './SystemGroupedBody';

type RouterOutputs = inferRouterOutputs<AppRouter>;

/** The manifest exactly as `monitorReap.resolve` returns it. */
export type ReapManifestData = RouterOutputs['cyboflow']['monitorReap']['resolve']['manifest'];
/** What `monitorReap.execute` returns. */
export type ReapExecuteData = RouterOutputs['cyboflow']['monitorReap']['execute'];
export type ReapManifestTarget = ReapManifestData['targets'][number];

/** Stable identity of a target (matches the server's `reapTargetKey`). */
export function reapTargetId(target: ReapManifestTarget): string {
  return target.kind === 'worktree' ? `worktree:${target.path}` : `process:${target.pid}`;
}

function toConfirmTarget(target: ReapManifestTarget): ManifestConfirmTarget {
  if (target.kind === 'worktree') {
    return {
      id: reapTargetId(target),
      kind: 'worktree',
      name: basename(target.path),
      detail: target.path,
      ...(target.dirtyFileCount !== null ? { dirtyFileCount: target.dirtyFileCount } : {}),
      ...(target.dirty === true ? { dirty: true } : {}),
      ...(target.aheadOfMain !== null ? { aheadOfMainCount: target.aheadOfMain } : {}),
      ...(target.reclaimableBytes !== null ? { reclaimBytes: target.reclaimableBytes } : {}),
    };
  }
  return {
    id: reapTargetId(target),
    kind: 'process',
    name: processName(target.command),
    detail: `pid ${target.pid}`,
    descendantPidCount: target.descendantPidCount,
    taggedAsCyboflow: target.taggedAsCyboflow,
  };
}

export function toManifestConfirmData(manifest: ReapManifestData): ManifestConfirmData {
  return {
    id: manifest.id,
    targets: manifest.targets.map(toConfirmTarget),
    // With any unmeasured target the total is a lower bound — say "unknown" rather than under-report.
    reclaimableBytes: manifest.unmeasuredTargetCount > 0 ? null : manifest.reclaimableBytes,
  };
}
