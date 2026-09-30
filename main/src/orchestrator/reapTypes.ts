/**
 * Wire types for the reap manifest (services/monitor/reapManifest.ts) and its
 * execution result. Declared here, type-only, so the `monitorReap` router can
 * import them without pulling in `main/src/services/*` (standalone-typecheck
 * invariant); reapManifest.ts re-exports them for service-side callers.
 */
import type { SystemProcessType } from './systemTypes';

export type ReapManifestKind = 'row' | 'card' | 'kill-all-of-type' | 'reap-all-stale';

export interface ReapWorktreeTarget {
  kind: 'worktree';
  path: string;
  branch: string;
  /** Registry tag; only prunable tags ever appear here. */
  tag: 'session-owned' | 'run-owned' | 'orphan';
  sessionId: string | null;
  runId: string | null;
  /** Fresh `du` bytes, or null when the measurement failed / is unsupported. */
  reclaimableBytes: number | null;
  /** Uncommitted/untracked work would be discarded; null when the git cache has no entry. */
  dirty: boolean | null;
  /**
   * Uncommitted file count. null = unavailable: no git cache entry, or the worktree
   * has untracked files (GitStatusManager's `filesChanged` excludes them, so any
   * number would under-report). Never 0 when the count is merely unknown.
   */
  dirtyFileCount: number | null;
  /** Commits ahead of the base branch; null when the git cache has no entry. */
  aheadOfMain: number | null;
}

export interface ReapProcessTarget {
  kind: 'process';
  pid: number;
  processType: SystemProcessType;
  bucket: 'owned' | 'orphan' | 'suspected';
  command: string;
  worktreePath: string | null;
  sessionId: string | null;
  runId: string | null;
  /** False for `suspected` (no spawn marker): killing it needs the harder confirm. */
  taggedAsCyboflow: boolean;
  descendantPidCount: number;
}

export type ReapTarget = ReapWorktreeTarget | ReapProcessTarget;

export interface ReapManifest {
  /**
   * Unguessable single-use confirmation token, minted fresh by the server on every
   * resolve (never derived from content, so identical content re-resolved yields a
   * different id). The manifest carries everything the user confirms: kind, snapshot
   * generation, the full target list and `alsoDeleteBranch`; execute runs exactly it.
   */
  id: string;
  kind: ReapManifestKind;
  /** `generatedAt` of the snapshot this was built against. */
  snapshotGeneratedAt: number;
  /** Epoch ms the manifest was built (the fresh `du` figures are as of this time). */
  builtAt: number;
  targets: ReapTarget[];
  /** Sum of the targets' measured bytes. */
  reclaimableBytes: number;
  /** Worktree targets whose size could not be measured (the total is then a lower bound). */
  unmeasuredTargetCount: number;
  /** Known uncommitted files across worktree targets — a lower bound when `dirtyCountUnknownTargetCount > 0`. */
  dirtyFileCount: number;
  /** Worktree targets whose uncommitted-file count is unavailable (see {@link ReapWorktreeTarget.dirtyFileCount}). */
  dirtyCountUnknownTargetCount: number;
  /** Total commits ahead of the base branch across worktree targets (annotation only). */
  aheadOfMainCount: number;
  /** Total descendant pids across process targets. */
  descendantPidCount: number;
  /** Delete the branch when pruning. Defaults false; true only when explicitly requested. */
  alsoDeleteBranch: boolean;
}


/** What a `monitorReap.resolve` call selects; one variant per manifest kind. */
export type ReapSelection =
  | { kind: 'row'; worktreePaths?: string[]; pids?: number[] }
  | { kind: 'card'; worktreePath: string }
  | { kind: 'kill-all-of-type'; processType: SystemProcessType }
  | { kind: 'reap-all-stale' };

/** The stable identity of a target: what an execution result refers back to. */
export function reapTargetKey(target: ReapTarget): string {
  return target.kind === 'worktree'
    ? `worktree:${target.path}`
    : `process:${target.pid}`;
}

/** What happened to one manifest target when it was executed. */
export interface ReapExecutionResult {
  /** {@link reapTargetKey} of the target this result is for. */
  targetId: string;
  kind: 'killed' | 'pruned' | 'survived' | 'skipped' | 'failed';
  /** Pids still alive after the KILL step (`kind: 'survived'`). */
  survivorPids?: number[];
  /** Human-readable failure (`kind: 'failed'`). */
  error?: string;
}

/** A result that must be shown as an error, never as success. */
export interface ReapExecutionError {
  targetId: string;
  message: string;
  survivorPids?: number[];
}

/**
 * Performs a confirmed manifest. Implemented by the execution primitives; receives
 * the manifest's exact target list (never the raw request).
 */
export interface ReapExecutor {
  execute(
    manifest: ReapManifest,
    options: { alsoDeleteBranch: boolean },
  ): Promise<ReapExecutionResult[]>;
}
