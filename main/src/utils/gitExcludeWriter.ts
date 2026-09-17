/**
 * gitExcludeWriter — the ONE shared implementation of "idempotently append
 * lines to a repo/worktree's LOCAL git exclude" (`$GIT_DIR/info/exclude`,
 * resolved via `git rev-parse --git-path info/exclude` — NEVER the tracked
 * `.gitignore`, which would show up as a diff in the user's own repo).
 *
 * Before this file, the same ~40 lines of git-path resolution + idempotent
 * line-append + fail-soft error handling were copied three times:
 * `workflowBundleInstall.ensureBundleExcluded` (the cyboflow bundle globs),
 * `InteractiveClaudeManager.ensureWorktreeExcludesCyboflowDir` (`.cyboflow/`),
 * and `ompMcpConfigWriter.ensureWorktreeExcludesOmpDir` (`.omp/`) — the third
 * copy's own doc comment named this file as the fix. `ipc/project.ts`
 * (worktree folders) and `RunLauncher.ensureGitignoreEntry` (`.cyboflow/
 * worktrees/`) additionally wrote the TRACKED `.gitignore`, which is the wrong
 * file for generated/plumbing paths: it shows up as a diff in the user's own
 * repo the moment cyboflow touches a project for the first time. All five
 * call sites now go through this one writer instead.
 *
 * CONTRACT: never throws. A non-repo target (the global-agent chat thread's
 * home directory, a unit-test fixture dir) is an EXPECTED no-op, logged at
 * `debug` (or silently, with no logger) — not a fault, so never `warn`. Any
 * OTHER git or fs failure still warns: that quieting must stay narrow. Success
 * is reported via the return value only (`{ added: string[] }`, the entries
 * this call actually appended) so each caller keeps its own success-log
 * wording; this module owns only the failure-path logging, since that was the
 * part that was duplicated near-verbatim across all three prior copies.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { LoggerLike } from '../orchestrator/types';
import { resolveGitCommand } from './gitExeFinder';

export interface EnsureGitExcludeEntriesOptions {
  /**
   * Optional marker/comment line written immediately before the entries, once,
   * the first time any of `entries` is actually appended. Never (re)written
   * once present, even if `entries` changes on a later call. Omit for a
   * marker-less append (e.g. a worktree-folder exclude with no comment).
   */
  marker?: string;
  /** Bridges to the caller's own logger; omit for a console-only fallback. */
  logger?: LoggerLike;
  /** Prefix identifying the caller in failure-path log lines (e.g. 'OMP'). */
  label?: string;
}

/**
 * True when a failed `git` invocation failed *because the cwd is not a git
 * repository* — the expected, uninteresting case callers should treat as a
 * quiet no-op rather than a warning. Node puts the child's stderr on
 * `err.stderr` when it is piped, and also folds it into `err.message`
 * ("Command failed: <cmd>\n<stderr>"); both are checked so this holds
 * regardless of how the spawn's stdio is configured. Callers pin `LC_ALL=C`
 * on the `git` invocation so this match is locale-stable.
 */
export function isNotAGitRepositoryError(err: unknown): boolean {
  const candidate = err as { stderr?: unknown; message?: unknown } | null;
  const stderr = typeof candidate?.stderr === 'string' ? candidate.stderr : '';
  const message = typeof candidate?.message === 'string' ? candidate.message : '';
  return /not a git repository/i.test(stderr) || /not a git repository/i.test(message);
}

/** Strips a leading/trailing `/` so `x/` and `/x/` and `x` compare equal. */
function normalizeExcludeLine(line: string): string {
  return line.trim().replace(/^\//, '').replace(/\/$/, '');
}

/**
 * Ensure every one of `entries` is present in `repoPath`'s local git exclude
 * file, appending whichever are missing (plus `opts.marker`, once, only when
 * something is actually being appended). Idempotent: a line already present
 * — in any leading/trailing-slash form — is left alone and not re-added.
 *
 * Returns `{ added }` — the subset of `entries` this call appended (`[]` when
 * everything was already present) — or `null` when nothing could be written:
 * `repoPath` is not a git repository (or git itself is unavailable), or a
 * real git/fs error occurred. Both cases are logged internally (debug for the
 * expected non-repo case, warn otherwise) and NEVER thrown — callers that
 * want to log their own success message should do so from the truthy result.
 */
export function ensureGitExcludeEntries(
  repoPath: string,
  entries: readonly string[],
  opts?: EnsureGitExcludeEntriesOptions,
): { added: string[] } | null {
  const label = opts?.label ?? 'gitExcludeWriter';
  if (entries.length === 0) return { added: [] };
  try {
    const raw = execFileSync(resolveGitCommand(), ['rev-parse', '--git-path', 'info/exclude'], {
      cwd: repoPath,
      encoding: 'utf8',
      windowsHide: true,
      // Pin git's message language for isNotAGitRepositoryError, and capture
      // stderr rather than letting the child's `fatal:` line leak to the
      // app's own stderr on the (expected) non-repo path.
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    }).trim();
    if (raw.length === 0) return null; // defensive — git answered nothing resolvable

    const excludePath = path.isAbsolute(raw) ? raw : path.join(repoPath, raw);

    let existing = '';
    try {
      existing = fs.readFileSync(excludePath, 'utf8');
    } catch {
      /* file absent — created below */
    }
    const lines = existing.split(/\r?\n/);
    const existingNormalized = new Set(lines.map(normalizeExcludeLine));
    const missing = entries.filter((entry) => !existingNormalized.has(normalizeExcludeLine(entry)));
    if (missing.length === 0) return { added: [] };

    const parts: string[] = [];
    if (existing.length > 0 && !existing.endsWith('\n')) parts.push(''); // close a dangling line
    if (opts?.marker !== undefined && !lines.includes(opts.marker)) parts.push(opts.marker);
    parts.push(...missing, '');

    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    fs.appendFileSync(excludePath, parts.join('\n'), 'utf8');
    return { added: missing };
  } catch (err) {
    if (isNotAGitRepositoryError(err)) {
      opts?.logger?.debug(`[${label}] skipped git exclude — not a git repository`, { repoPath });
      return null;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (opts?.logger) {
      opts.logger.warn(`[${label}] could not update git exclude for ${repoPath}: ${message}`);
    } else {
      console.error(`[${label}] could not update git exclude for ${repoPath}:`, err);
    }
    return null;
  }
}
