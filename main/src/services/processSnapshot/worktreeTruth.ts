/**
 * Placeholder input contract for the worktree registry.
 *
 * The process classifiers need to ask "is this path a worktree cyboflow knows
 * about?". The authoritative answer comes from the worktree-registry epic
 * (sessions/runs rows reconciled against git truth); until that is wired in,
 * this interface pins ONLY the minimal shape the classifiers consume so they
 * can be written and tested without it. Nothing in production constructs a
 * `WorktreeTruth` yet — the registry epic will implement it and inject it.
 */
export interface WorktreeTruth {
  /** Absolute paths of every worktree cyboflow knows about (live or stale). */
  readonly knownWorktreePaths: ReadonlySet<string>;
}

/** In-memory `WorktreeTruth` for unit tests. */
export function buildWorktreeTruthFixture(paths: Iterable<string> = []): WorktreeTruth {
  return { knownWorktreePaths: new Set(paths) };
}
