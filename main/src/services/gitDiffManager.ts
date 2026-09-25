import * as fs from 'node:fs';
import * as path from 'node:path';
import { runGitAsync, END_OF_OPTIONS, assertNotOptionLike } from '../utils/runGit';
import type { Logger } from '../utils/logger';
import { GitOperationalError, isAbortError, isOperationalFailure } from './gitPlumbingCommands';
import type { WorktreeStatusEntry, DiffGroupRollup, WorktreeStatusPayload } from '../../../shared/types/runFiles';

export interface GitDiffStats {
  additions: number;
  deletions: number;
  filesChanged: number;
}

export interface GitDiffResult {
  diff: string;
  stats: GitDiffStats;
  changedFiles: string[];
  beforeHash?: string;
  afterHash?: string;
}

/**
 * Return shape of {@link GitDiffManager.getDiffGroups} (TASK-210) — the
 * `groups`/`committedUnavailable` half of the wire-level
 * `WorktreeStatusPayload` (shared/types/runFiles.ts). `entries` (the
 * `getWorktreeStatus` flag records) is composed alongside this by the caller
 * that assembles the full payload; this method owns only the per-scope
 * membership + rollups.
 */
export interface DiffGroupsResult {
  groups: DiffGroupRollup[];
  committedUnavailable: boolean;
}

/**
 * Largest untracked file we will read whole. Both untracked paths below —
 * rendering the file as a diff block, and counting its lines for the stats
 * meter — read with the synchronous fs API, so an unbounded read blocks the
 * main process for as long as the file takes to load.
 */
const MAX_UNTRACKED_READ_BYTES = 1024 * 1024;

/**
 * Read one untracked file's content for diff synthesis / line counting, or
 * `null` when it must be skipped (symlink or other non-regular file, oversize,
 * unreadable, missing).
 *
 * Symlink containment: `git ls-files --others` lists an untracked symlink as
 * an entry, and `statSync`/`readFileSync` FOLLOW it — so an untracked link
 * pointing at `~/.ssh/id_ed25519` or `/etc/passwd` would have that target's
 * contents rendered into the returned diff blob and shipped to the renderer.
 * `lstatSync` inspects the link itself, and only a regular file is read. Git
 * does not descend into symlinked directories for `--others` (it lists the
 * link), so guarding the leaf is sufficient. This is the ONE read path every
 * untracked-content consumer (in this file and in ipc/gitOps.ts's scoped-blob
 * builder) goes through, so the guard cannot drift between them.
 */
export function readUntrackedFileContent(worktreePath: string, relPath: string): string | null {
  try {
    const filePath = path.join(worktreePath, relPath);
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile()) return null;
    // Pre-flight size check matches the previous `maxBuffer: 1MB` bound from
    // execSync — large files are skipped to avoid OOM / event-loop stalls.
    if (stat.size > MAX_UNTRACKED_READ_BYTES) return null;
    // Read the file directly — no shell involved, so filenames with $(...) /
    // backticks / ${...} cannot inject commands.
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

export interface GitCommit {
  hash: string;
  message: string;
  date: Date;
  author: string;
  stats: GitDiffStats;
}

/**
 * Unmerged (conflict) status codes from `git status --porcelain`, mirroring
 * `fastCheckWorkingDirectory`'s `git diff --diff-filter=U` conflict check
 * (gitPlumbingCommands.ts:125). A path in one of these states must set ONLY
 * `conflicted` — never `staged`/`unstaged`, which a naive "X !== ' ' ⇒
 * staged, Y !== ' ' ⇒ unstaged" rule would otherwise produce for e.g. `UU`.
 */
const CONFLICTED_STATUS_CODES: ReadonlySet<string> = new Set([
  'UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD',
]);

/**
 * Parse one `git status --porcelain=v1 -z --untracked-files=all` NUL-field
 * stream into status entries.
 *
 * `-z` changes TWO things from the human-readable form documented in `git
 * status --help`:
 *  - Paths are never C-quoted (no escaping of spaces/specials), so a path
 *    with a literal space or shell metacharacter round-trips byte-for-byte —
 *    required to join against the (also-unquoted) `diff --git a/<path> …`
 *    blob path that parseFileHunks/getChangedFiles produce.
 *  - A rename/copy record emits the NEW path first, then the OLD path, each
 *    its own NUL-terminated field (`XY <new>\0<old>\0`) — the OPPOSITE order
 *    of the human-readable `R  <old> -> <new>` form. `oldPath` on the
 *    returned entry is always the OLD path regardless of this reversed wire
 *    order.
 */
function parseWorktreeStatus(output: unknown): WorktreeStatusEntry[] {
  if (typeof output !== 'string' || output.length === 0) return [];

  const fields = output.split('\0');
  const entries: WorktreeStatusEntry[] = [];

  for (let i = 0; i < fields.length; i++) {
    const record = fields[i];
    // The trailing NUL (and any stray blank field) yields an empty string.
    if (!record || record.length < 3) continue;

    const x = record[0];
    const y = record[1];
    const path = record.slice(3);
    const code = `${x}${y}`;

    let oldPath: string | undefined;
    // A rename/copy record carries a SECOND NUL-terminated field — the path
    // this entry was renamed/copied FROM — which must be consumed here so it
    // is never mistaken for the next record.
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      i++;
      oldPath = fields[i];
    }

    if (code === '??') {
      entries.push({ path, staged: false, unstaged: false, untracked: true, conflicted: false });
      continue;
    }
    if (code === '!!') {
      // Only ever appears with --ignored, which getWorktreeStatus does not pass.
      continue;
    }
    if (CONFLICTED_STATUS_CODES.has(code)) {
      entries.push({ path, staged: false, unstaged: false, untracked: false, conflicted: true });
      continue;
    }

    const entry: WorktreeStatusEntry = {
      path,
      staged: x !== ' ',
      unstaged: y !== ' ',
      untracked: false,
      conflicted: false,
    };
    if (oldPath !== undefined) entry.oldPath = oldPath;
    entries.push(entry);
  }

  return entries;
}

export class GitDiffManager {
  constructor(
    private logger?: Logger
  ) {}

  /**
   * Capture git diff for a worktree directory
   */
  async captureWorkingDirectoryDiff(worktreePath: string): Promise<GitDiffResult> {
    try {
      console.log(`captureWorkingDirectoryDiff called for: ${worktreePath}`);
      this.logger?.verbose(`Capturing git diff in ${worktreePath}`);

      // Get current commit hash
      const beforeHash = await this.getCurrentCommitHash(worktreePath);

      // Get diff of working directory vs HEAD
      const diff = await this.getGitDiffString(worktreePath);
      console.log(`Captured diff length: ${diff.length}`);

      // Get changed files
      const changedFiles = await this.getChangedFiles(worktreePath);

      // Get diff stats
      const stats = await this.getDiffStats(worktreePath);

      this.logger?.verbose(`Captured diff: ${stats.filesChanged} files, +${stats.additions} -${stats.deletions}`);
      console.log(`Diff stats:`, stats);

      return {
        diff,
        stats,
        changedFiles,
        beforeHash,
        afterHash: undefined // No after hash for working directory changes
      };
    } catch (error) {
      this.logger?.error(`Failed to capture git diff in ${worktreePath}:`, error instanceof Error ? error : undefined);
      throw error;
    }
  }

  /**
   * Capture the diff of a worktree's working tree against an arbitrary ref
   * (commit / branch), INCLUDING committed, uncommitted, and untracked changes
   * since that ref. `git diff <ref>` compares the working tree to <ref>, so
   * unlike captureWorkingDirectoryDiff (which diffs vs HEAD and therefore hides
   * anything already committed), this surfaces commits made since <ref> too.
   *
   * Used for the run-scoped Diff tab with the run's `base_sha` (the worktree HEAD
   * snapshotted at launch): a flow that COMMITS its work — e.g. a sprint/ship run
   * merging parallel task lanes back to the branch — would otherwise show nothing
   * but stray untracked files, since the real changes are committed past HEAD.
   */
  async captureDiffAgainstRef(worktreePath: string, ref: string): Promise<GitDiffResult> {
    try {
      this.logger?.verbose(`Capturing git diff in ${worktreePath} against ref ${ref}`);
      const diff = await this.getGitDiffString(worktreePath, ref);
      const changedFiles = await this.getChangedFiles(worktreePath, ref);
      const stats = await this.getDiffStats(worktreePath, ref);
      this.logger?.verbose(
        `Captured diff vs ${ref}: ${stats.filesChanged} files, +${stats.additions} -${stats.deletions}`,
      );
      return {
        diff,
        stats,
        changedFiles,
        beforeHash: ref,
        afterHash: undefined, // working tree — no fixed after hash
      };
    } catch (error) {
      this.logger?.error(
        `Failed to capture git diff against ${ref} in ${worktreePath}:`,
        error instanceof Error ? error : undefined,
      );
      throw error;
    }
  }

  /**
   * Parse `git status --porcelain=v1 -z --untracked-files=all` for a worktree
   * into a flag record per path (staged / unstaged / untracked / conflicted).
   *
   * Deliberately standalone rather than folded into captureDiffAgainstRef's
   * return (D-9/TASK-209): GitDiffResult is shared by callers — including
   * executionTracker.ts — that have no use for per-path status flags, so
   * widening it here would ripple to all of them. The tRPC boundary composes
   * this with a diff result instead of GitDiffManager doing it internally.
   *
   * `-uall` (`--untracked-files=all`) is mandatory: the default `--porcelain`
   * collapses an untracked directory into a single `?? newdir/` row, while
   * getUntrackedFiles (used by the diff-blob paths elsewhere in this class)
   * enumerates every file inside it via `git ls-files --others
   * --exclude-standard` — without `-uall` the Untracked group would show one
   * unopenable directory row with no matching per-file diff.
   *
   * `-z` is mandatory: without it, a path with spaces/specials is C-quoted
   * here but NOT in the `diff --git a/<path> …` blob, breaking the
   * status↔diff join on exactly the adversarial-filename class this file
   * already hardens against elsewhere.
   */
  async getWorktreeStatus(worktreePath: string): Promise<WorktreeStatusEntry[]> {
    let output: string;
    try {
      output = await runGitAsync(worktreePath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    } catch (error) {
      // A deliberate cancellation must propagate, not be swallowed into an
      // empty (looks-clean) result.
      if (isAbortError(error)) throw error;
      // A timeout/kill/spawn failure must NOT masquerade as "no changes" —
      // mirrors fastGetAheadBehind / fastGetDiffStats in gitPlumbingCommands.ts.
      if (isOperationalFailure(error)) {
        throw new GitOperationalError(`git status failed operationally in ${worktreePath}`, error);
      }
      this.logger?.warn(`Could not get worktree status in ${worktreePath}`);
      return [];
    }
    return parseWorktreeStatus(output);
  }

  /**
   * Stats-only twin of captureDiffAgainstRef: the SAME "working tree vs <ref>,
   * including committed, uncommitted, and untracked changes" view, but computed
   * from `git diff --numstat` WITHOUT materializing the diff blob.
   *
   * Exists because the session-stats poll (sessions:get-statistics, re-fetched
   * every few seconds while the session card is visible) only needs the three
   * numbers and the file list — building the full diff string for a worktree
   * with hundreds of changed files just to count its lines is pure waste.
   *
   * `--numstat` reports per-file `additions \t deletions \t path`, with `-` in
   * both count columns for binary files (counted as a changed file, zero lines
   * — same as `--stat`).
   */
  async getDiffStatsAgainstRef(
    worktreePath: string,
    ref: string = 'HEAD',
  ): Promise<{ stats: GitDiffStats; changedFiles: string[] }> {
    const resolvedRef = await resolveGitRefToSha(worktreePath, ref);
    if (resolvedRef === null) {
      this.logger?.warn(`Could not resolve ref "${ref}" for diff stats in ${worktreePath}`);
      return { stats: { additions: 0, deletions: 0, filesChanged: 0 }, changedFiles: [] };
    }

    const numstat = await runGitAsync(worktreePath, ['diff', '--numstat', resolvedRef]);
    const parsed = this.parseNumstat(numstat);
    let additions = parsed.additions;
    const deletions = parsed.deletions;
    const changedFiles: string[] = [...parsed.files];

    // Untracked files are invisible to `git diff` at any ref, so add them the
    // same way getDiffStats does: every line counts as an addition.
    const untrackedFiles = await this.getUntrackedFiles(worktreePath);
    if (untrackedFiles.length > 0) {
      changedFiles.push(...untrackedFiles);
      additions += this.countUntrackedAdditions(worktreePath, untrackedFiles);
    }

    return {
      stats: { additions, deletions, filesChanged: changedFiles.length },
      changedFiles,
    };
  }

  /**
   * Parse `git diff --numstat` output (`additions \t deletions \t path` per
   * line, `-`/`-` for a binary file) into aggregate stats + the file list.
   * Used by getDiffStatsAgainstRef; the per-scope rollups in getDiffGroups
   * (TASK-210) use the `-z` twin parseNumstatZ below, whose membership paths
   * must be openable/joinable (rename destination, no C-quoting).
   */
  private parseNumstat(output: string): { additions: number; deletions: number; files: string[] } {
    let additions = 0;
    let deletions = 0;
    const files: string[] = [];
    const trimmed = output.trim();
    if (!trimmed) return { additions, deletions, files };
    for (const line of trimmed.split('\n')) {
      const [added, deleted, ...pathParts] = line.split('\t');
      const filePath = pathParts.join('\t').trim();
      if (!filePath) continue;
      files.push(filePath);
      if (added !== '-') additions += parseInt(added, 10) || 0;
      if (deleted !== '-') deletions += parseInt(deleted, 10) || 0;
    }
    return { additions, deletions, files };
  }

  /**
   * Parse `git diff --numstat -z` output into per-scope group membership +
   * aggregate stats (TASK-210 staged/unstaged scopes). Distinct from
   * parseNumstat (the non-`-z` twin) in two ways that matter for a
   * membership list whose paths are later OPENED and joined against
   * `getWorktreeStatus` entries:
   *
   *   • A rename/copy row is `<add>\t<del>\t\0<old>\0<new>\0` under `-z`
   *     (an EMPTY path field, then old and new as separate NUL fields) — the
   *     destination path is recorded, never the human-readable
   *     `old => new` / `dir/{old => new}` display expression the non-`-z`
   *     form prints (which is not a path anything can open).
   *   • `-z` never C-quotes a path with spaces/specials, so the membership
   *     path is byte-identical to the porcelain `-z` status path.
   *
   * Membership is UNIQUE per scope: an unmerged (conflicted) path is emitted
   * as two numstat rows by `git diff` (one per merge side), which would
   * otherwise list — and count — the same file twice inside one group. The
   * numbers are still aggregated across every row.
   */
  private parseNumstatZ(output: string): {
    additions: number;
    deletions: number;
    files: string[];
    fileStats: Record<string, { additions: number; deletions: number }>;
  } {
    let additions = 0;
    let deletions = 0;
    const files: string[] = [];
    const seen = new Set<string>();
    const fileStats: Record<string, { additions: number; deletions: number }> = {};
    if (!output) return { additions, deletions, files, fileStats };

    const fields = output.split('\0');
    for (let i = 0; i < fields.length; i++) {
      const record = fields[i];
      if (!record) continue;
      const [added, deleted, ...pathParts] = record.split('\t');
      if (added === undefined || deleted === undefined) continue;
      let filePath = pathParts.join('\t');
      if (filePath === '') {
        // Rename/copy: the path field is empty and the next two NUL fields
        // are <old> then <new>. Consume both; the NEW path is the member.
        i += 2;
        filePath = fields[i] ?? '';
      }
      if (!filePath) continue;
      const a = added !== '-' ? parseInt(added, 10) || 0 : 0;
      const d = deleted !== '-' ? parseInt(deleted, 10) || 0 : 0;
      additions += a;
      deletions += d;
      const stat = fileStats[filePath] ?? { additions: 0, deletions: 0 };
      stat.additions += a;
      stat.deletions += d;
      fileStats[filePath] = stat;
      if (seen.has(filePath)) continue;
      seen.add(filePath);
      files.push(filePath);
    }
    return { additions, deletions, files, fileStats };
  }

  /**
   * Compute the four diff-group scopes (unstaged / staged / untracked /
   * committed) that back the run/session Diff tab's grouped view (TASK-210).
   * Each scope is an INDEPENDENT `git diff --numstat` call, never derived
   * from a single base-relative diff blob — a file that is both
   * committed-since-`resolvedBase` AND separately dirty in the working tree
   * needs different +n/-n numbers in the Committed group vs. the Unstaged
   * group, which one combined diff cannot represent.
   *
   * Committed membership is a three-dot (merge-base) comparison, computed
   * explicitly rather than reused from a two-dot `resolvedBase..HEAD` diff:
   * if `resolvedBase` is "ahead" of HEAD (a stale/reverted base), a raw
   * two-dot diff reports reverse deletions for files HEAD never touched.
   * Taking the merge-base of `resolvedBase` and HEAD first anchors the
   * comparison at their common ancestor — the same anchor `git diff
   * base...HEAD` uses.
   *
   * When `resolvedBase` is null, or the merge-base step fails (unrelated
   * histories / no common ancestor), Committed is EMPTY and
   * `committedUnavailable` is true — this never falls back to "the whole
   * tree". The other three groups do not depend on `resolvedBase` and are
   * always populated.
   */
  async getDiffGroups(worktreePath: string, resolvedBase: string | null): Promise<DiffGroupsResult> {
    const [staged, unstaged, untracked, committed] = await Promise.all([
      this.getStagedGroup(worktreePath),
      this.getUnstagedGroup(worktreePath),
      this.getUntrackedGroup(worktreePath),
      this.getCommittedGroup(worktreePath, resolvedBase),
    ]);

    return {
      groups: [unstaged, staged, untracked, committed.group],
      committedUnavailable: committed.unavailable,
    };
  }

  /**
   * Staged scope: index vs HEAD. `-z` so a rename yields its real destination
   * path (see parseNumstatZ). `--diff-filter=u` (lowercase = EXCLUDE unmerged)
   * keeps a conflicted path out of this group: `git diff --cached` otherwise
   * emits a `0 0 <path>` row for every unmerged entry, which would put the
   * conflict into Staged membership on the wire — the renderer renders a
   * conflict ONLY under Unstaged (AR-3), so the payload must agree with it
   * rather than rely on the list filtering it back out.
   */
  private async getStagedGroup(worktreePath: string): Promise<DiffGroupRollup> {
    const output = await runGitAsync(worktreePath, ['diff', '--cached', '--numstat', '-z', '--diff-filter=u']);
    const { additions, deletions, files, fileStats } = this.parseNumstatZ(output);
    return { scope: 'staged', files, additions, deletions, fileStats };
  }

  /** Unstaged scope: working tree vs index. No caller-supplied ref involved. */
  private async getUnstagedGroup(worktreePath: string): Promise<DiffGroupRollup> {
    const output = await runGitAsync(worktreePath, ['diff', '--numstat', '-z']);
    const { additions, deletions, files, fileStats } = this.parseNumstatZ(output);
    return { scope: 'unstaged', files, additions, deletions, fileStats };
  }

  /**
   * Untracked scope. Membership is every path `getUntrackedFiles` reports
   * (matching getWorktreeStatus's untracked entries); the addition count per
   * file is sourced from the SAME `split('\n').length` arithmetic
   * createDiffForUntrackedFiles uses to build its synthesized diff blob (one
   * `+` row per split element, including the trailing empty element a
   * newline-terminated file produces) — this is what the frontend's
   * parseFileDiffs (frontend/src/utils/parseFileHunks.ts) would count parsing
   * that same blob. `main/` cannot take a runtime dependency on `frontend/`
   * (only type-only cross-imports exist elsewhere in this codebase), so the
   * arithmetic is replicated here rather than imported.
   *
   * Deliberately NOT `countUntrackedAdditions` (this file, ~line 813): that
   * helper counts `\n` occurrences (`wc -l` semantics) — for `"a\nb\n"` it
   * reports 2, while the blob-based count (and this method) reports 3. Using
   * the wc-l count here would make this rollup disagree with what the Diff
   * tab's viewer actually renders from the blob.
   */
  private async getUntrackedGroup(worktreePath: string): Promise<DiffGroupRollup> {
    const files = await this.getUntrackedFiles(worktreePath);
    let additions = 0;
    const fileStats: Record<string, { additions: number; deletions: number }> = {};
    for (const file of files) {
      if (!file || file.trim().length === 0) continue;
      // Mirrors createDiffForUntrackedFiles: an oversize / symlink / unreadable
      // file is omitted from the diff blob entirely, so it contributes 0 here too.
      const content = readUntrackedFileContent(worktreePath, file.trim());
      if (content === null) continue;
      const lines = content.split('\n').length;
      additions += lines;
      fileStats[file] = { additions: lines, deletions: 0 };
    }
    return { scope: 'untracked', files, additions, deletions: 0, fileStats };
  }

  /**
   * Committed scope: explicit three-dot (merge-base) membership + rollup.
   * See getDiffGroups's doc comment for why merge-base is required instead of
   * a plain two-dot diff.
   *
   * Ref safety (TASK-208 discipline, defense-in-depth): `resolvedBase` is
   * re-resolved via resolveGitRefToSha (assertNotOptionLike + `rev-parse
   * --verify --end-of-options`) even though the caller contract already
   * guarantees a resolved sha, and the merge-base command's OWN output is
   * re-resolved the same way before it is fed into the following `diff`
   * calls, rather than trusted as already-safe.
   */
  private async getCommittedGroup(
    worktreePath: string,
    resolvedBase: string | null,
  ): Promise<{ group: DiffGroupRollup; unavailable: boolean }> {
    const empty: DiffGroupRollup = { scope: 'committed', files: [], additions: 0, deletions: 0 };
    if (!resolvedBase) return { group: empty, unavailable: true };

    const safeBase = await resolveGitRefToSha(worktreePath, resolvedBase);
    if (safeBase === null) return { group: empty, unavailable: true };

    let mergeBaseRaw: string;
    try {
      mergeBaseRaw = (
        await runGitAsync(worktreePath, ['merge-base', END_OF_OPTIONS, safeBase, 'HEAD'])
      ).trim();
    } catch {
      // No common ancestor (e.g. unrelated histories) — never fall back to
      // "the whole tree".
      return { group: empty, unavailable: true };
    }
    if (!mergeBaseRaw) return { group: empty, unavailable: true };

    const safeMergeBase = await resolveGitRefToSha(worktreePath, mergeBaseRaw);
    if (safeMergeBase === null) return { group: empty, unavailable: true };

    try {
      const range = `${safeMergeBase}..HEAD`;
      const nameOutput = await runGitAsync(worktreePath, ['diff', '--name-only', END_OF_OPTIONS, range]);
      const files = nameOutput.trim().split('\n').filter((f) => f.length > 0);

      const numstatOutput = await runGitAsync(worktreePath, ['diff', '--numstat', '-z', END_OF_OPTIONS, range]);
      const { additions, deletions, fileStats } = this.parseNumstatZ(numstatOutput);

      return { group: { scope: 'committed', files, additions, deletions, fileStats }, unavailable: false };
    } catch {
      return { group: empty, unavailable: true };
    }
  }

  /**
   * Capture git diff between two commits or between commit and working directory
   */
  async captureCommitDiff(worktreePath: string, fromCommit: string, toCommit?: string): Promise<GitDiffResult> {
    try {
      const to = toCommit || 'HEAD';
      this.logger?.verbose(`Capturing git diff in ${worktreePath} from ${fromCommit} to ${to}`);

      // Get diff between commits
      const diff = await this.getGitCommitDiff(worktreePath, fromCommit, to);

      // Get changed files between commits
      const changedFiles = await this.getChangedFilesBetweenCommits(worktreePath, fromCommit, to);

      // Get diff stats between commits
      const stats = await this.getCommitDiffStats(worktreePath, fromCommit, to);

      return {
        diff,
        stats,
        changedFiles,
        beforeHash: fromCommit,
        afterHash: to === 'HEAD' ? await this.getCurrentCommitHash(worktreePath) : to
      };
    } catch (error) {
      this.logger?.error(`Failed to capture commit diff in ${worktreePath}:`, error instanceof Error ? error : undefined);
      throw error;
    }
  }

  /**
   * Get git commit history for a worktree (only commits unique to this branch)
   */
  async getCommitHistory(worktreePath: string, limit: number = 50, mainBranch: string = 'main'): Promise<GitCommit[]> {
    try {
      // Get commit log with stats, excluding commits that are in main branch
      // This shows only commits unique to the current branch
      // Using --cherry-pick to also exclude commits that have equivalent patches on main
      // (e.g., commits that were cherry-picked or rebased to main)
      const logFormat = '%H|%s|%ai|%an';
      const gitArgs = [
        'log',
        `--format=${logFormat}`,
        '--numstat',
        '-n', String(limit),
        '--cherry-pick',
        '--left-only',
        `HEAD...${mainBranch}`,
        '--',
      ];

      console.log(`[GitDiffManager] Getting commit history for worktree: ${worktreePath}`);
      console.log(`[GitDiffManager] Main branch: ${mainBranch}`);
      console.log(`[GitDiffManager] Git command: git ${gitArgs.join(' ')}`);

      const logOutput = await runGitAsync(worktreePath, gitArgs);
      console.log(`[GitDiffManager] Git log output length: ${logOutput.length} characters`);

      const commits: GitCommit[] = [];
      const lines = logOutput.trim().split('\n');
      console.log(`[GitDiffManager] Total lines to parse: ${lines.length}`);

      let currentCommit: GitCommit | null = null;
      let statsLines: string[] = [];

      for (const line of lines) {
        if (line.includes('|')) {
          // Process previous commit's stats if any
          if (currentCommit && statsLines.length > 0) {
            const stats = this.parseNumstatOutput(statsLines);
            currentCommit.stats = stats;
          }

          // Start new commit
          const [hash, message, date, author] = line.split('|');

          // Validate and parse the date
          let parsedDate: Date;
          try {
            parsedDate = new Date(date);
            // Check if the date is valid
            if (isNaN(parsedDate.getTime())) {
              throw new Error('Invalid date');
            }
          } catch {
            // Fall back to current date if parsing fails
            parsedDate = new Date();
            this.logger?.warn(`Invalid date format in git log: "${date}". Using current date as fallback.`);
          }

          currentCommit = {
            hash,
            message,
            date: parsedDate,
            author,
            stats: { additions: 0, deletions: 0, filesChanged: 0 }
          };
          commits.push(currentCommit);
          statsLines = [];
        } else if (line.trim() && currentCommit) {
          // Collect stat lines
          statsLines.push(line);
        }
      }

      // Process last commit's stats
      if (currentCommit && statsLines.length > 0) {
        const stats = this.parseNumstatOutput(statsLines);
        currentCommit.stats = stats;
      }

      console.log(`[GitDiffManager] Found ${commits.length} commits unique to this branch`);
      if (commits.length === 0) {
        console.log(`[GitDiffManager] No unique commits found. This could mean:`);
        console.log(`[GitDiffManager]   - The branch is up-to-date with ${mainBranch}`);
        console.log(`[GitDiffManager]   - The branch has been rebased onto ${mainBranch}`);
        console.log(`[GitDiffManager]   - The ${mainBranch} branch doesn't exist in this worktree`);
      }

      return commits;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger?.error('Failed to get commit history', error instanceof Error ? error : undefined);
      console.error(`[GitDiffManager] Error getting commit history: ${errorMessage}`);
      console.error(`[GitDiffManager] Full error:`, error);

      // If it's a git command error, throw it so the caller can handle it appropriately
      if (errorMessage.includes('fatal:') || errorMessage.includes('error:')) {
        console.error(`[GitDiffManager] Git command failed. This might happen if the ${mainBranch} branch doesn't exist.`);
        throw new Error(`Git error: ${errorMessage}`);
      }

      // For other errors, return empty array as fallback
      return [];
    }
  }

  /**
   * Parse numstat output to get diff statistics
   */
  private parseNumstatOutput(lines: string[]): GitDiffStats {
    let additions = 0;
    let deletions = 0;
    let filesChanged = 0;

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 3) {
        const added = parts[0] === '-' ? 0 : parseInt(parts[0], 10);
        const deleted = parts[1] === '-' ? 0 : parseInt(parts[1], 10);

        if (!isNaN(added) && !isNaN(deleted)) {
          additions += added;
          deletions += deleted;
          filesChanged++;
        }
      }
    }

    return { additions, deletions, filesChanged };
  }

  /**
   * Get diff for a specific commit
   */
  async getCommitDiff(worktreePath: string, commitHash: string): Promise<GitDiffResult> {
    try {
      const diff = await runGitAsync(worktreePath, ['show', '--format=', commitHash]);

      const stats = await this.getCommitStats(worktreePath, commitHash);
      const changedFiles = await this.getCommitChangedFiles(worktreePath, commitHash);

      return {
        diff,
        stats,
        changedFiles,
        beforeHash: `${commitHash}~1`,
        afterHash: commitHash
      };
    } catch (error) {
      this.logger?.error(`Failed to get commit diff for ${commitHash}`, error instanceof Error ? error : undefined);
      return {
        diff: '',
        stats: { additions: 0, deletions: 0, filesChanged: 0 },
        changedFiles: []
      };
    }
  }

  /**
   * Get stats for a specific commit
   */
  private async getCommitStats(worktreePath: string, commitHash: string): Promise<GitDiffStats> {
    try {
      const fullOutput = await runGitAsync(worktreePath, ['show', '--stat', '--format=', commitHash]);
      // Get the last line manually instead of using tail
      const lines = fullOutput.trim().split('\n');
      const statsOutput = lines[lines.length - 1];
      return this.parseDiffStats(statsOutput);
    } catch {
      return { additions: 0, deletions: 0, filesChanged: 0 };
    }
  }

  /**
   * Get changed files for a specific commit
   */
  private async getCommitChangedFiles(worktreePath: string, commitHash: string): Promise<string[]> {
    try {
      const output = await runGitAsync(worktreePath, ['show', '--name-only', '--format=', commitHash]);
      return output.trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Combine multiple diffs into a single diff
   */
  combineDiffs(diffs: GitDiffResult[]): GitDiffResult {
    const combinedDiff = diffs.map(d => d.diff).join('\n\n');

    // Aggregate stats
    const stats: GitDiffStats = {
      additions: diffs.reduce((sum, d) => sum + d.stats.additions, 0),
      deletions: diffs.reduce((sum, d) => sum + d.stats.deletions, 0),
      filesChanged: 0 // Will be calculated from unique files
    };

    // Get unique changed files
    const allFiles = new Set<string>();
    diffs.forEach(d => d.changedFiles.forEach(f => allFiles.add(f)));
    const changedFiles = Array.from(allFiles);
    stats.filesChanged = changedFiles.length;

    return {
      diff: combinedDiff,
      stats,
      changedFiles,
      beforeHash: diffs[0]?.beforeHash,
      afterHash: diffs[diffs.length - 1]?.afterHash
    };
  }

  async getCurrentCommitHash(worktreePath: string): Promise<string> {
    try {
      return (await runGitAsync(worktreePath, ['rev-parse', 'HEAD'])).trim();
    } catch (error) {
      this.logger?.warn(`Could not get current commit hash in ${worktreePath}`);
      return '';
    }
  }

  async getGitDiff(worktreePath: string): Promise<GitDiffResult> {
    const result = await this.captureWorkingDirectoryDiff(worktreePath);

    return result;
  }

  async getCombinedDiff(worktreePath: string, mainBranch: string): Promise<GitDiffResult> {
    // Get diff against main branch
    try {

      // Get diff between current branch and main
      const diff = await runGitAsync(worktreePath, ['diff', `origin/${mainBranch}...HEAD`]);

      // Get changed files
      const changedFiles = (await runGitAsync(worktreePath, ['diff', '--name-only', `origin/${mainBranch}...HEAD`]))
        .trim().split('\n').filter((f: string) => f.length > 0);

      // Get stats
      const statsOutput = await runGitAsync(worktreePath, ['diff', '--stat', `origin/${mainBranch}...HEAD`]);

      const stats = this.parseDiffStats(statsOutput);

      return {
        diff,
        stats,
        changedFiles,
        beforeHash: `origin/${mainBranch}`,
        afterHash: 'HEAD'
      };
    } catch (error) {
      this.logger?.warn(`Could not get combined diff in ${worktreePath}:`, error instanceof Error ? error : undefined);
      // Fallback to working directory diff
      return this.captureWorkingDirectoryDiff(worktreePath);
    }
  }

  private async getGitDiffString(worktreePath: string, ref: string = 'HEAD'): Promise<string> {
    try {
      // First check if we're in a valid git repository
      try {
        await runGitAsync(worktreePath, ['rev-parse', '--git-dir']);
      } catch {
        console.error(`Not a git repository: ${worktreePath}`);
        return '';
      }

      // Get diff of the working tree against <ref> (default HEAD), including both
      // staged and unstaged changes. With a base ref this also surfaces commits
      // made since <ref>; with HEAD it is committed-agnostic (uncommitted only).
      const resolvedRef = await resolveGitRefToSha(worktreePath, ref);
      if (resolvedRef === null) {
        throw new Error(`Could not resolve ref "${ref}" for diff in ${worktreePath}`);
      }
      let diff = await runGitAsync(worktreePath, ['diff', resolvedRef]);
      console.log(`Git diff in ${worktreePath}: ${diff.length} characters`);

      // Get untracked files and create diff-like output for them
      const untrackedFiles = await this.getUntrackedFiles(worktreePath);
      if (untrackedFiles.length > 0) {
        console.log(`Found ${untrackedFiles.length} untracked files`);
        const untrackedDiff = this.createDiffForUntrackedFiles(worktreePath, untrackedFiles);
        if (untrackedDiff) {
          diff = diff ? diff + '\n' + untrackedDiff : untrackedDiff;
        }
      }

      return diff;
    } catch (error) {
      this.logger?.warn(`Could not get git diff in ${worktreePath}`, error instanceof Error ? error : undefined);
      console.error(`Error getting git diff:`, error);
      return '';
    }
  }

  private async getGitCommitDiff(worktreePath: string, fromCommit: string, toCommit: string): Promise<string> {
    try {
      return await runGitAsync(worktreePath, ['diff', `${fromCommit}..${toCommit}`]);
    } catch (error) {
      this.logger?.warn(`Could not get git commit diff in ${worktreePath}`);
      return '';
    }
  }

  private async getChangedFiles(worktreePath: string, ref: string = 'HEAD'): Promise<string[]> {
    try {
      const resolvedRef = await resolveGitRefToSha(worktreePath, ref);
      if (resolvedRef === null) {
        throw new Error(`Could not resolve ref "${ref}" for changed files in ${worktreePath}`);
      }
      // Get tracked changed files (working tree vs <ref>)
      const trackedOutput = await runGitAsync(worktreePath, ['diff', '--name-only', resolvedRef]);
      const trackedFiles = trackedOutput.trim().split('\n').filter((f: string) => f.length > 0);

      // Get untracked files
      const untrackedFiles = await this.getUntrackedFiles(worktreePath);

      // Combine both lists
      return [...trackedFiles, ...untrackedFiles];
    } catch (error) {
      this.logger?.warn(`Could not get changed files in ${worktreePath}`);
      return [];
    }
  }

  private async getChangedFilesBetweenCommits(worktreePath: string, fromCommit: string, toCommit: string): Promise<string[]> {
    try {
      const output = await runGitAsync(worktreePath, ['diff', '--name-only', `${fromCommit}..${toCommit}`]);
      return output.trim().split('\n').filter((f: string) => f.length > 0);
    } catch (error) {
      this.logger?.warn(`Could not get changed files between commits in ${worktreePath}`);
      return [];
    }
  }

  private async getDiffStats(worktreePath: string, ref: string = 'HEAD'): Promise<GitDiffStats> {
    try {
      const resolvedRef = await resolveGitRefToSha(worktreePath, ref);
      if (resolvedRef === null) {
        throw new Error(`Could not resolve ref "${ref}" for diff stats in ${worktreePath}`);
      }
      const output = await runGitAsync(worktreePath, ['diff', '--stat', resolvedRef]);

      const trackedStats = this.parseDiffStats(output);

      // Add stats for untracked files
      const untrackedFiles = await this.getUntrackedFiles(worktreePath);
      if (untrackedFiles.length > 0) {
        return {
          additions: trackedStats.additions + this.countUntrackedAdditions(worktreePath, untrackedFiles),
          deletions: trackedStats.deletions,
          filesChanged: trackedStats.filesChanged + untrackedFiles.length
        };
      }

      return trackedStats;
    } catch (error) {
      this.logger?.warn(`Could not get diff stats in ${worktreePath}`);
      return { additions: 0, deletions: 0, filesChanged: 0 };
    }
  }

  private async getCommitDiffStats(worktreePath: string, fromCommit: string, toCommit: string): Promise<GitDiffStats> {
    try {
      const output = await runGitAsync(worktreePath, ['diff', '--stat', `${fromCommit}..${toCommit}`]);

      return this.parseDiffStats(output);
    } catch (error) {
      this.logger?.warn(`Could not get commit diff stats in ${worktreePath}`);
      return { additions: 0, deletions: 0, filesChanged: 0 };
    }
  }

  parseDiffStats(statsOutput: string): GitDiffStats {
    const lines = statsOutput.trim().split('\n');
    const summaryLine = lines[lines.length - 1];

    // Parse summary line like: "3 files changed, 45 insertions(+), 12 deletions(-)"
    const fileMatch = summaryLine.match(/(\d+) files? changed/);
    const addMatch = summaryLine.match(/(\d+) insertions?\(\+\)/);
    const delMatch = summaryLine.match(/(\d+) deletions?\(-\)/);

    return {
      filesChanged: fileMatch ? parseInt(fileMatch[1]) : 0,
      additions: addMatch ? parseInt(addMatch[1]) : 0,
      deletions: delMatch ? parseInt(delMatch[1]) : 0
    };
  }

  /**
   * Check if there are any changes in the working directory
   */
  async hasChanges(worktreePath: string): Promise<boolean> {
    try {
      const output = await runGitAsync(worktreePath, ['status', '--porcelain']);
      return output.trim().length > 0;
    } catch (error) {
      this.logger?.warn(`Could not check git status in ${worktreePath}`);
      return false;
    }
  }

  /**
   * Get list of untracked files
   */
  private async getUntrackedFiles(worktreePath: string): Promise<string[]> {
    try {
      const output = await runGitAsync(worktreePath, ['ls-files', '--others', '--exclude-standard']);

      // Handle empty output case
      if (!output || output.trim().length === 0) {
        return [];
      }

      return output.trim().split('\n').filter((f: string) => f && f.trim().length > 0);
    } catch (error) {
      this.logger?.warn(`Could not get untracked files in ${worktreePath}`);
      return [];
    }
  }

  /**
   * Line count of every readable untracked file, which is what an untracked
   * file contributes to a diff: all of its lines are additions.
   *
   * Oversize files are skipped rather than read. This runs on the
   * sessions:get-statistics poll (every few seconds, on the main process), so
   * an unbounded readFileSync here would let one large untracked artifact — a
   * build output, a captured log, a dataset — stall the event loop and
   * allocate a file-sized string on every tick. The skipped file still counts
   * as a changed file; only its line count is unknown, exactly as in
   * createDiffForUntrackedFiles, which omits oversize files from the diff for
   * the same reason.
   */
  private countUntrackedAdditions(worktreePath: string, untrackedFiles: string[]): number {
    let untrackedAdditions = 0;
    for (const file of untrackedFiles) {
      // Skip invalid filenames
      if (!file || file.trim().length === 0) {
        continue;
      }

      const cleanFile = file.trim();
      // 'utf8' mirrors the semantics of `wc -l`, which counts newline
      // characters in text mode. Oversize / symlink / unreadable → skipped.
      const content = readUntrackedFileContent(worktreePath, cleanFile);
      if (content === null) {
        this.logger?.verbose(`Skipping line count for untracked file ${cleanFile}`);
        continue;
      }
      // `wc -l` counts \n occurrences; match that exactly.
      untrackedAdditions += (content.match(/\n/g) || []).length;
    }
    return untrackedAdditions;
  }

  /**
   * Create diff-like output for untracked files
   */
  private createDiffForUntrackedFiles(worktreePath: string, untrackedFiles: string[]): string {
    let diffOutput = '';

    for (const file of untrackedFiles) {
      // Skip invalid filenames
      if (!file || file.trim().length === 0) {
        continue;
      }

      const cleanFile = file.trim();
      const fileContent = readUntrackedFileContent(worktreePath, cleanFile);
      if (fileContent === null) {
        // Skip files that can't be read (symlink, binary, oversize, permission
        // denied, missing, etc.)
        this.logger?.verbose(`Could not read untracked file ${cleanFile}; omitted from diff`);
        continue;
      }
      diffOutput += createUntrackedFileDiffBlock(cleanFile, fileContent);
    }

    return diffOutput;
  }
}

/**
 * Synthesize the `git diff`-shaped block for one untracked file: every line
 * is an addition (one `+` row per `split('\n')` element — this is the count
 * the frontend's parseFileHunks derives from the blob, and what getDiffGroups'
 * untracked rollup must agree with). Shared with ipc/gitOps.ts's per-scope
 * blob builder so the two never drift in header or hunk shape.
 */
export function createUntrackedFileDiffBlock(relPath: string, content: string): string {
  let block = '';
  block += `diff --git a/${relPath} b/${relPath}\n`;
  block += `new file mode 100644\n`;
  block += `index 0000000..0000000\n`;
  block += `--- /dev/null\n`;
  block += `+++ b/${relPath}\n`;
  const lines = content.split('\n');
  if (lines.length > 0) {
    block += `@@ -0,0 +1,${lines.length} @@\n`;
    for (const line of lines) {
      block += `+${line}\n`;
    }
  }
  return block;
}

/**
 * Resolve a caller-supplied ref (branch, tag, sha) to a concrete commit sha for
 * a run-scoped `gitDiff` context closure (TASK-211) or any GitDiffManager
 * method that puts a caller-supplied ref into `git diff` argv (TASK-208), or
 * `null` when the ref is falsy or fails to resolve (callers fall back to their
 * normal safe empty/zeroed result rather than throwing).
 *
 * Why this exists: a ref like `--output=/tmp/pwn` is a valid `git diff`
 * OPTION, not a revision — git parses it as a flag and writes an arbitrary
 * file. `execFile` blocks shell injection but not this git-argv
 * option-injection class. THE single implementation of the TASK-208
 * ref-safety discipline — GitDiffManager's own ref-taking methods and
 * sessionFileStats.ts `resolveSessionDiffBaseRef` all call it rather than
 * keeping a second copy: `END_OF_OPTIONS` forces
 * the ref into a value position and `^{commit}` forces a commit-ish
 * resolution that an option-like string can never satisfy.
 *
 * Lives here (rather than inline at its `main/src/index.ts` call site) so that
 * file stays under its frozen size ratchet (issue #19) — a free function with
 * no dependency beyond `runGitAsync`, so it needs no injection.
 */
export async function resolveGitRefToSha(worktreePath: string, ref: string | undefined): Promise<string | null> {
  if (!ref) return null;
  try {
    assertNotOptionLike(ref, 'diff ref');
    const resolved = (
      await runGitAsync(worktreePath, ['rev-parse', '--verify', '--quiet', END_OF_OPTIONS, `${ref}^{commit}`])
    ).trim();
    return resolved || null;
  } catch {
    return null;
  }
}

/**
 * A `WorktreeStatusPayload` stub for callers that capture a `RunGitDiff` but
 * have no meaningful worktree status to report (e.g. the eval snapshot's
 * fail-soft closure, TASK-211). Still declares all four `DiffGroupScope`
 * groups (zeroed) per WorktreeStatusPayload's fixed-shape doc comment, rather
 * than an empty `groups` array. See {@link resolveGitRefToSha}'s doc comment
 * for why this lives here rather than in `main/src/index.ts`.
 */
export const EMPTY_WORKTREE_STATUS: WorktreeStatusPayload = {
  entries: [],
  groups: [
    { scope: 'unstaged', files: [], additions: 0, deletions: 0 },
    { scope: 'staged', files: [], additions: 0, deletions: 0 },
    { scope: 'untracked', files: [], additions: 0, deletions: 0 },
    { scope: 'committed', files: [], additions: 0, deletions: 0 },
  ],
  committedUnavailable: true,
};
