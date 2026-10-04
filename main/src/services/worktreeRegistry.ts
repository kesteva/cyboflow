/**
 * Worktree registry — a DERIVED, in-memory read model that reconciles the three
 * places a worktree can be known: `sessions.worktree_path`,
 * `workflow_runs.worktree_path`, and git's own `worktree list` truth. There is
 * deliberately no `worktrees` table and no migration: the registry is recomputed
 * from those sources on every read.
 *
 * Every git-reported path gets exactly ONE tag. Precedence when several rows
 * reference the same path (highest first):
 *   is_main_repo > in_place > session-owned > run-owned > orphan
 * so a path owned by both a session and a run resolves to `session-owned`, and
 * the entry carries both owner ids for display.
 *
 * Staleness (v1) is strict: a path is `orphan` iff NO session row and NO run row
 * references it. Age, idleness and terminal run/session status are never folded
 * into the tag.
 *
 * `in_place` / `is_main_repo` entries carry `prunable: false` in the returned
 * shape itself (a literal type), so no caller has to remember the guard.
 */

export type WorktreeTag = 'session-owned' | 'run-owned' | 'orphan' | 'in_place' | 'is_main_repo';

export interface RegistrySessionRow {
  id: string;
  worktreePath: string;
  inPlace: boolean;
  isMainRepo: boolean;
}

export interface RegistryRunRow {
  id: string;
  worktreePath: string;
}

/** One `git worktree list --porcelain` entry (the shape WorktreeManager.listWorktrees returns). */
export interface GitWorktreeEntry {
  path: string;
  branch: string;
}

export interface WorktreeRegistryInput {
  projectPath: string;
  sessions: readonly RegistrySessionRow[];
  runs: readonly RegistryRunRow[];
  gitWorktrees: readonly GitWorktreeEntry[];
}

interface WorktreeRegistryEntryBase {
  path: string;
  branch: string;
  /** Owning session id, when a session row references the path. */
  sessionId?: string;
  /** Owning run id, when a run row references the path. */
  runId?: string;
}

export interface GuardedWorktreeRegistryEntry extends WorktreeRegistryEntryBase {
  tag: 'in_place' | 'is_main_repo';
  /** The user's real checkout — never prunable. Baked into the shape, not left to callers. */
  prunable: false;
}

export interface OwnedOrOrphanWorktreeRegistryEntry extends WorktreeRegistryEntryBase {
  tag: 'session-owned' | 'run-owned' | 'orphan';
  prunable: true;
}

export type WorktreeRegistryEntry = GuardedWorktreeRegistryEntry | OwnedOrOrphanWorktreeRegistryEntry;

/** Case/separator-insensitive-on-Windows key so equal paths compare equal. */
export function worktreePathKey(p: string, platform: NodeJS.Platform = process.platform): string {
  let key = p;
  if (platform === 'win32') key = key.replace(/\\/g, '/').toLowerCase();
  while (key.length > 1 && key.endsWith('/')) key = key.slice(0, -1);
  return key;
}

/**
 * Pure reconciliation — no DB, no git, no clock. See the file header for the
 * tag precedence and the v1 staleness rule.
 */
export function reconcileWorktreeRegistry(
  input: WorktreeRegistryInput,
  platform: NodeJS.Platform = process.platform,
): WorktreeRegistryEntry[] {
  const key = (p: string) => worktreePathKey(p, platform);
  const projectKey = key(input.projectPath);

  const sessionsByPath = new Map<string, RegistrySessionRow[]>();
  for (const s of input.sessions) {
    const k = key(s.worktreePath);
    const bucket = sessionsByPath.get(k);
    if (bucket) bucket.push(s);
    else sessionsByPath.set(k, [s]);
  }
  const runByPath = new Map<string, RegistryRunRow>();
  for (const r of input.runs) {
    const k = key(r.worktreePath);
    if (!runByPath.has(k)) runByPath.set(k, r);
  }

  const seen = new Set<string>();
  const entries: WorktreeRegistryEntry[] = [];
  for (const wt of input.gitWorktrees) {
    const k = key(wt.path);
    if (seen.has(k)) continue;
    seen.add(k);

    const sessions = sessionsByPath.get(k) ?? [];
    const run = runByPath.get(k);
    const mainRepoSession = sessions.find((s) => s.isMainRepo);
    const inPlaceSession = sessions.find((s) => s.inPlace);
    const session = mainRepoSession ?? inPlaceSession ?? sessions[0];
    const base: WorktreeRegistryEntryBase = {
      path: wt.path,
      branch: wt.branch,
      ...(session ? { sessionId: session.id } : {}),
      ...(run ? { runId: run.id } : {}),
    };

    if (mainRepoSession) entries.push({ ...base, tag: 'is_main_repo', prunable: false });
    else if (inPlaceSession) entries.push({ ...base, tag: 'in_place', prunable: false });
    else if (k === projectKey) {
      // The project's own checkout as git reports it. With no owning row it is
      // still the user's real checkout — never an orphan, never prunable.
      entries.push({ ...base, tag: 'is_main_repo', prunable: false });
    } else if (sessions.length > 0) entries.push({ ...base, tag: 'session-owned', prunable: true });
    else if (run) entries.push({ ...base, tag: 'run-owned', prunable: true });
    else entries.push({ ...base, tag: 'orphan', prunable: true });
  }
  return entries;
}

/** Structural slice of Database the loader needs (keeps this module unit-testable). */
export interface WorktreeRegistryDatabase {
  getSessionWorktreeRefs(projectId: number): Array<{ id: string; worktree_path: string; in_place: number | null; is_main_repo: number | null }>;
  getRunWorktreeRefs(projectId: number): Array<{ id: string; worktree_path: string }>;
}

/** Structural slice of WorktreeManager the loader needs. */
export interface WorktreeRegistryGit {
  listWorktrees(projectPath: string): Promise<GitWorktreeEntry[]>;
}

/** DB + git pull feeding {@link reconcileWorktreeRegistry}, for one project. */
export async function loadWorktreeRegistry(deps: {
  database: WorktreeRegistryDatabase;
  worktreeManager: WorktreeRegistryGit;
  projectId: number;
  projectPath: string;
}): Promise<WorktreeRegistryEntry[]> {
  const gitWorktrees = await deps.worktreeManager.listWorktrees(deps.projectPath);
  return reconcileWorktreeRegistry({
    projectPath: deps.projectPath,
    gitWorktrees,
    sessions: deps.database.getSessionWorktreeRefs(deps.projectId).map((r) => ({
      id: r.id,
      worktreePath: r.worktree_path,
      inPlace: !!r.in_place,
      isMainRepo: !!r.is_main_repo,
    })),
    runs: deps.database.getRunWorktreeRefs(deps.projectId).map((r) => ({ id: r.id, worktreePath: r.worktree_path })),
  });
}
