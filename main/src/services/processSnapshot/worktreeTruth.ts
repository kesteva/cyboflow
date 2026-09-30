/**
 * Placeholder input contract for the worktree registry.
 *
 * The process classifiers need to ask "is this path a worktree cyboflow knows
 * about?". The authoritative answer comes from the worktree-registry epic
 * (sessions/runs rows reconciled against git truth); until that is wired in,
 * this interface pins ONLY the minimal shape the classifiers consume so they
 * can be written and tested without it. The `cyboflow.system` provider
 * (services/systemSnapshotProvider.ts) builds one from the reconciled registry's
 * path set per snapshot.
 */
export interface WorktreeTruth {
  /** Absolute paths of every worktree cyboflow knows about (live or stale). */
  readonly knownWorktreePaths: ReadonlySet<string>;
}

/** In-memory `WorktreeTruth` for unit tests. */
export function buildWorktreeTruthFixture(paths: Iterable<string> = []): WorktreeTruth {
  return { knownWorktreePaths: new Set(paths) };
}
