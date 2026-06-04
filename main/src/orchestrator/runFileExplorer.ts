/**
 * Orchestrator-subtree handler for the workflow-run File Explorer.
 *
 * Resolves a run to its git worktree (workflow_runs.worktree_path) and performs
 * read-only filesystem access scoped strictly inside that worktree:
 *   - listRunFiles(db, runId, relPath?) — one directory level, dirs-first.
 *   - readRunFile(db, runId, relPath)   — a single file's text content.
 *
 * Path safety: every caller-supplied relative path is normalized, rejected if it
 * is absolute or escapes the worktree (`..`), and the resolved real path is
 * verified to live inside the worktree's real path (defends against symlinks
 * planted inside the tree). The `.git` directory is excluded from listings.
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3',
 * or main/src/services/*. Node 'fs'/'path' (used widely across this subtree, e.g.
 * permissionRules.ts, runLauncher.ts) and DatabaseLike are the only deps.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import type { DatabaseLike } from './types';
import type { RunFileEntry, RunFileContent } from '../../../shared/types/runFiles';

/** Files larger than this are not returned as text (the viewer shows a notice). */
export const MAX_VIEWABLE_BYTES = 1024 * 1024; // 1 MiB

/** Number of leading bytes sampled for binary (NUL-byte) detection. */
const BINARY_SNIFF_BYTES = 8000;

/**
 * Stable failure reasons surfaced by the handler. The tRPC router maps each to
 * an appropriate TRPCError code; the message is preserved for the UI.
 */
export type RunFileErrorReason =
  | 'run-not-found' // no workflow_runs row for the id
  | 'no-worktree' // run exists but has no worktree_path yet
  | 'worktree-missing' // worktree_path points nowhere on disk (e.g. torn down)
  | 'invalid-path' // caller path is absolute or escapes the worktree
  | 'not-found' // target file/dir does not exist
  | 'not-a-directory' // listFiles target is a regular file
  | 'not-a-file'; // readFile target is a directory

/** Typed error carrying a stable `reason` for the router to map to a tRPC code. */
export class RunFileError extends Error {
  public readonly reason: RunFileErrorReason;
  constructor(reason: RunFileErrorReason, message: string) {
    super(message);
    this.name = 'RunFileError';
    this.reason = reason;
  }
}

interface WorktreeRow {
  worktree_path: string | null;
}

/**
 * Look up a run's worktree path. Throws RunFileError when the run is unknown or
 * has not yet been assigned a worktree.
 */
function resolveWorktreePath(db: DatabaseLike, runId: string): string {
  const row = db
    .prepare('SELECT worktree_path FROM workflow_runs WHERE id = ?')
    .get(runId) as WorktreeRow | undefined;
  if (!row) {
    throw new RunFileError('run-not-found', `Run ${runId} not found`);
  }
  if (!row.worktree_path) {
    throw new RunFileError('no-worktree', `Run ${runId} has no worktree yet`);
  }
  return row.worktree_path;
}

/**
 * Resolve a caller-supplied relative path against the worktree root, rejecting
 * absolute paths and any path that normalizes to an escape (`..`). Returns the
 * absolute joined path (NOT yet realpath-checked — callers do that against the
 * resolved fs entry so a broken target still produces a clean error).
 */
function resolveInsideWorktree(worktreePath: string, relPath: string | undefined): string {
  const rel = relPath ?? '';
  if (rel.length === 0) {
    return worktreePath;
  }
  const normalized = path.normalize(rel);
  // After normalization, any traversal escape collapses to a leading '..'.
  if (path.isAbsolute(normalized) || normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new RunFileError('invalid-path', `Invalid path: ${relPath}`);
  }
  return path.join(worktreePath, normalized);
}

/**
 * Verify that `targetAbs` resolves (via realpath) to a location inside the
 * worktree's real path. Defends against symlinks inside the worktree that point
 * outside it.
 *
 * Used ONLY for the security check — relative (wire) paths are computed against
 * the original (un-realpath'd) worktree root by callers, because realpath would
 * diverge on platforms where the worktree sits under a symlinked prefix (e.g.
 * macOS /tmp → /private/tmp).
 *
 * Throws RunFileError('worktree-missing') if the worktree root itself is gone,
 * and RunFileError('not-found') if the target does not exist.
 */
async function assertWithinWorktree(worktreePath: string, targetAbs: string): Promise<void> {
  let realRoot: string;
  try {
    realRoot = await fs.realpath(worktreePath);
  } catch {
    throw new RunFileError('worktree-missing', 'Worktree no longer exists on disk');
  }
  if (targetAbs === worktreePath) {
    return;
  }
  let realTarget: string;
  try {
    realTarget = await fs.realpath(targetAbs);
  } catch {
    throw new RunFileError('not-found', `Path not found: ${path.relative(worktreePath, targetAbs)}`);
  }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
    throw new RunFileError('invalid-path', 'Path resolves outside the worktree');
  }
}

/**
 * Non-throwing containment check: does `childAbs` resolve (via realpath) to a
 * location inside the worktree's real path? Used in the listing loop to decide
 * whether a symlink may be followed for type/size. Returns false on any error
 * (broken link, missing worktree) so the caller treats the entry conservatively.
 */
async function pathStaysInWorktree(worktreePath: string, childAbs: string): Promise<boolean> {
  try {
    const realRoot = await fs.realpath(worktreePath);
    const realChild = await fs.realpath(childAbs);
    return realChild === realRoot || realChild.startsWith(realRoot + path.sep);
  } catch {
    return false;
  }
}

/** Normalize a platform path to POSIX separators for the wire contract. */
function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * List one directory level of a run's worktree. `relPath` is relative to the
 * worktree root (omit / empty for the root). Directories sort first, then files,
 * each alphabetically (case-insensitive). The `.git` directory is excluded.
 */
export async function listRunFiles(
  db: DatabaseLike,
  runId: string,
  relPath?: string,
): Promise<RunFileEntry[]> {
  const worktreePath = resolveWorktreePath(db, runId);
  const targetAbs = resolveInsideWorktree(worktreePath, relPath);
  await assertWithinWorktree(worktreePath, targetAbs);

  let dirents: import('fs').Dirent[];
  try {
    dirents = await fs.readdir(targetAbs, { withFileTypes: true });
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOTDIR') {
      throw new RunFileError('not-a-directory', 'Path is not a directory');
    }
    if (isErrnoException(err) && err.code === 'ENOENT') {
      throw new RunFileError('not-found', 'Directory not found');
    }
    throw err;
  }

  const entries: RunFileEntry[] = [];
  for (const dirent of dirents) {
    if (dirent.name === '.git') {
      continue; // never expose the git plumbing directory
    }
    const childAbs = path.join(targetAbs, dirent.name);
    const childRel = toPosix(path.relative(worktreePath, childAbs));
    let isDirectory = dirent.isDirectory();
    let size: number | undefined;
    if (dirent.isSymbolicLink()) {
      // A symlink is only FOLLOWED for type/size when its target stays inside the
      // worktree; otherwise it's reported as a non-traversable leaf with no size.
      // This stops the listing from leaking the existence / type / byte-size of an
      // arbitrary path OUTSIDE the worktree (the per-directory containment check
      // does not re-run per entry, and stat() would otherwise follow the link).
      if (await pathStaysInWorktree(worktreePath, childAbs)) {
        try {
          const stat = await fs.stat(childAbs);
          isDirectory = stat.isDirectory();
          size = stat.isFile() ? stat.size : undefined;
        } catch {
          isDirectory = false; // broken in-worktree symlink — show as a leaf
        }
      } else {
        isDirectory = false; // escaping symlink — leaf, no size; read is rejected too
      }
    } else {
      try {
        const stat = await fs.stat(childAbs);
        isDirectory = stat.isDirectory();
        size = stat.isFile() ? stat.size : undefined;
      } catch {
        // Unreadable entry: fall back to the dirent type with no size rather than
        // dropping the entry entirely.
      }
    }
    entries.push({ name: dirent.name, path: childRel, isDirectory, size });
  }

  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1;
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  return entries;
}

/**
 * Read a single file from a run's worktree as UTF-8 text. Files over
 * MAX_VIEWABLE_BYTES or that look binary (NUL bytes in the first sniff window)
 * return `content: null` with an `unviewableReason` rather than throwing.
 */
export async function readRunFile(
  db: DatabaseLike,
  runId: string,
  relPath: string,
): Promise<RunFileContent> {
  const worktreePath = resolveWorktreePath(db, runId);
  const targetAbs = resolveInsideWorktree(worktreePath, relPath);
  await assertWithinWorktree(worktreePath, targetAbs);
  const wirePath = toPosix(path.relative(worktreePath, targetAbs));

  let stat: import('fs').Stats;
  try {
    stat = await fs.stat(targetAbs);
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') {
      throw new RunFileError('not-found', `File not found: ${relPath}`);
    }
    throw err;
  }
  // Only regular files are readable. Rejecting directories AND special files
  // (FIFOs, sockets, char/block devices) is load-bearing: fs.readFile on a FIFO
  // blocks forever, pinning a libuv threadpool slot (a DoS if the agent planted
  // one in the worktree). stat() has followed symlinks already, so a symlink to
  // a special file is caught here too.
  if (!stat.isFile()) {
    throw new RunFileError('not-a-file', `Not a regular file: ${relPath}`);
  }
  if (stat.size > MAX_VIEWABLE_BYTES) {
    return { path: wirePath, content: null, size: stat.size, unviewableReason: 'too-large' };
  }

  const buffer = await fs.readFile(targetAbs);
  if (looksBinary(buffer)) {
    return { path: wirePath, content: null, size: stat.size, unviewableReason: 'binary' };
  }
  return { path: wirePath, content: buffer.toString('utf8'), size: stat.size, unviewableReason: null };
}

/** Treat a buffer as binary if any NUL byte appears in the leading sniff window. */
function looksBinary(buffer: Buffer): boolean {
  const len = Math.min(buffer.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < len; i++) {
    if (buffer[i] === 0) {
      return true;
    }
  }
  return false;
}

/** Narrow an unknown thrown value to a Node errno exception (has a `.code`). */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}
