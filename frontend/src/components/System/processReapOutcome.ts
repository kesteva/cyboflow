/**
 * Pure decisions for the System view's process-reap flow: which confirm dialog a kill
 * opens, and how an execute response folds into per-target failures. The manifest →
 * dialog mapping lives in reapManifestAdapter.ts. No I/O.
 */
import { basename, processName } from './SystemGroupedBody';
import { reapTargetId, type ReapExecuteData, type ReapManifestData } from './reapManifestAdapter';

/** Process targets of a manifest that carry no cyboflow spawn marker. */
function untaggedCount(manifest: ReapManifestData): { untagged: number; processes: number } {
  let untagged = 0;
  let processes = 0;
  for (const t of manifest.targets) {
    if (t.kind !== 'process') continue;
    processes += 1;
    if (!t.taggedAsCyboflow) untagged += 1;
  }
  return { untagged, processes };
}

/**
 * Which confirm a kill opens. An individual kill always gets the harder dialog (its
 * banner appears exactly when the target is untagged); a batch gets it only when EVERY
 * process in it is untagged. A mixed batch keeps the plain dialog plus `mixedUntagged`,
 * which the caller renders as a note so the untagged members are still named.
 */
export function chooseKillDialog(
  manifest: ReapManifestData,
  scope: 'single' | 'batch',
): { dialog: 'kill-process' | 'manifest'; mixedUntagged: number } {
  if (scope === 'single') return { dialog: 'kill-process', mixedUntagged: 0 };
  const { untagged, processes } = untaggedCount(manifest);
  if (processes > 0 && untagged === processes) return { dialog: 'kill-process', mixedUntagged: 0 };
  return { dialog: 'manifest', mixedUntagged: untagged };
}

/** One failure/survivor the UI must show against a target, never as success. */
export interface ReapFailure {
  targetId: string;
  /** Human-readable target label (process name + pid, or worktree name). */
  label: string;
  message: string;
  survivorPids: number[];
}

function labelOf(manifest: ReapManifestData, targetId: string): string {
  const target = manifest.targets.find((t) => reapTargetId(t) === targetId);
  if (!target) return targetId;
  return target.kind === 'worktree'
    ? basename(target.path)
    : `${processName(target.command)} (pid ${target.pid})`;
}

export interface ReapOutcome {
  failures: ReapFailure[];
  killed: number;
  pruned: number;
  skipped: number;
}

/**
 * Fold an execute response into per-target failures plus success counts. A target
 * is a success only when its own result is `killed`/`pruned`; a survivor or failed
 * result — or a target with no result at all — is a failure.
 */
export function summarizeExecution(manifest: ReapManifestData, response: ReapExecuteData): ReapOutcome {
  const failures = new Map<string, ReapFailure>();
  for (const e of response.errors) {
    failures.set(e.targetId, {
      targetId: e.targetId,
      label: labelOf(manifest, e.targetId),
      message: e.message,
      survivorPids: e.survivorPids ?? [],
    });
  }
  let killed = 0;
  let pruned = 0;
  let skipped = 0;
  const seen = new Set<string>();
  for (const r of response.results) {
    seen.add(r.targetId);
    if (r.kind === 'killed') killed += 1;
    else if (r.kind === 'pruned') pruned += 1;
    else if (r.kind === 'skipped') skipped += 1;
    else if (!failures.has(r.targetId)) {
      failures.set(r.targetId, {
        targetId: r.targetId,
        label: labelOf(manifest, r.targetId),
        message: r.kind === 'survived' ? 'Process survived SIGKILL' : (r.error ?? 'Execution failed'),
        survivorPids: r.survivorPids ?? [],
      });
    }
  }
  for (const t of manifest.targets) {
    const id = reapTargetId(t);
    if (!seen.has(id) && !failures.has(id)) {
      failures.set(id, { targetId: id, label: labelOf(manifest, id), message: 'No result was reported for this target', survivorPids: [] });
    }
  }
  return { failures: [...failures.values()], killed, pruned, skipped };
}
