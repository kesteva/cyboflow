import * as fs from 'fs/promises';
import * as path from 'path';
import { glob } from 'glob';
import { runGitCapture } from '../utils/runGit';
import { normalizePathSeparators } from '../utils/posixPath';
import type { AppServices } from './types';
import type { WorkspaceFileOpsLike } from '../orchestrator/trpc/contracts/workspaceFileOps';

interface FileSearchRequest {
  sessionId?: string;
  projectId?: number;
  pattern: string;
  limit?: number;
}

/** True iff `resolved` is `base` itself or lives beneath it (path.sep-boundary
 * safe, so a sibling whose name is a string prefix — e.g. `/tmp/wt-other` vs
 * base `/tmp/wt` — does NOT pass). */
function isWithin(resolved: string, base: string): boolean {
  return resolved === base || resolved.startsWith(base + path.sep);
}

const MAX_SYMLINK_HOPS = 8;

/**
 * Follow the leaf's symlink chain manually even when the FINAL target does not
 * exist (a dangling symlink — realpath refuses these, but fs.writeFile through
 * one CREATES the target, so containment must be judged on where the write
 * would actually land). Relative link targets resolve against the link's own
 * directory; the hop cap bounds chained/circular links (a circular chain can't
 * be written through anyway — writeFile fails with ELOOP).
 */
async function resolveLeafSymlinkChain(target: string): Promise<string> {
  let current = target;
  for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop++) {
    let isLink: boolean;
    try {
      isLink = (await fs.lstat(current)).isSymbolicLink();
    } catch {
      return current; // leaf does not exist — nothing more to follow
    }
    if (!isLink) return current;
    try {
      current = path.resolve(path.dirname(current), await fs.readlink(current));
    } catch {
      return current;
    }
  }
  return current;
}

/**
 * Resolve `target` to a real path for containment checking. The leaf's symlink
 * chain is chased first (see resolveLeafSymlinkChain — covers dangling links).
 * realpath() throws when the leaf (or any trailing segment) does not exist yet
 * — so we walk up to the deepest EXISTING ancestor, realpath THAT (collapsing
 * every symlink in the real portion, including a dir symlink that escapes the
 * worktree), then re-append the still-nonexistent tail. This lets the guard
 * honor symlinks in each existing segment while still working for
 * not-yet-created files (a write to a brand-new path).
 */
async function resolveForContainment(target: string): Promise<string> {
  const chased = await resolveLeafSymlinkChain(target);
  let existing = chased;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = await fs.realpath(existing);
      return tail.length ? path.join(real, ...tail) : real;
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) {
        // Reached the filesystem root without any existing ancestor.
        return chased;
      }
      tail.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

/**
 * Resolve `fullPath` for containment inside `root` and return the RESOLVED path,
 * throwing if it escapes. Callers must then operate on the returned path — the
 * whole point is that the checked path and the used path are the same string, so
 * a symlink can't be validated in its lexical form and followed in its real one.
 *
 * Both sides go through realpath (`root` too — a project or worktree that itself
 * lives under a symlinked parent, e.g. macOS `/tmp` → `/private/tmp`, would
 * otherwise fail containment against its own children).
 */
async function resolveWithinRoot(root: string, fullPath: string, label: string): Promise<string> {
  const resolvedRoot = await fs.realpath(root).catch(() => root);
  const resolved = await resolveForContainment(fullPath);
  if (!isWithin(resolved, resolvedRoot)) {
    throw new Error(`${label} is outside ${root}`);
  }
  return resolved;
}

/**
 * Concrete implementation of {@link WorkspaceFileOpsLike}, backing the
 * `workspaceFiles` tRPC router (routers/workspaceFiles.ts). Method bodies are
 * moved verbatim from the legacy `file:*`/`git:*` ipcMain.handle handlers
 * (ipc/file.ts, now deleted) — this file may freely import from
 * main/src/services/*, unlike the tRPC subtree itself. `file:getPath` was not
 * migrated (zero preload/frontend callers) — its containment helper
 * (resolveWithinRoot) is still used by `search` below.
 */
export function createFileOps(
  services: Pick<AppServices, 'sessionManager' | 'databaseService'>,
): WorkspaceFileOpsLike {
  const { sessionManager, databaseService } = services;

  return {
    // Restore all uncommitted changes
    async gitRestore(request) {
      try {
        const session = sessionManager.getSession(request.sessionId);
        if (!session) {
          throw new Error(`Session not found: ${request.sessionId}`);
        }

        try {
          // Reset all changes to the last commit
          await runGitCapture(session.worktreePath, ['reset', '--hard', 'HEAD']);

          // Clean untracked files
          await runGitCapture(session.worktreePath, ['clean', '-fd']);

          return { success: true };
        } catch (error: unknown) {
          throw new Error(`Git restore failed: ${error instanceof Error ? error.message : error}`);
        }
      } catch (error) {
        console.error('Error restoring changes:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },

    // Search for files matching a pattern
    async search(request: FileSearchRequest) {
      try {
        // Determine the search directory
        let searchDirectory: string;

        if (request.sessionId) {
          const session = sessionManager.getSession(request.sessionId);
          if (!session) {
            throw new Error(`Session not found: ${request.sessionId}`);
          }
          searchDirectory = session.worktreePath;
        } else if (request.projectId) {
          const project = databaseService.getProject(request.projectId);
          if (!project) {
            throw new Error(`Project not found: ${request.projectId}`);
          }
          searchDirectory = project.path;
        } else {
          throw new Error('Either sessionId or projectId must be provided');
        }

        // Normalize the pattern for searching
        const searchPattern = request.pattern.replace(/^@/, '').toLowerCase();

        // If the pattern contains a path separator, search from that path. The
        // leading segments come straight from the renderer's search box, so they
        // are joined and then CONTAINMENT-CHECKED: `@../../../../etc/pass` would
        // otherwise walk the glob root right out of the worktree/project.
        const pathParts = searchPattern.split(/[/\\]/);
        const lexicalSearchDir = pathParts.length > 1
          ? path.join(searchDirectory, ...pathParts.slice(0, -1))
          : searchDirectory;
        const filePattern = pathParts[pathParts.length - 1] || '';

        // Resolve the search root and the glob root through realpath together, so
        // the relative paths reported below stay relative to the same root.
        const resolvedSearchDirectory = await fs.realpath(searchDirectory).catch(() => searchDirectory);
        let searchDir: string;
        try {
          searchDir = await resolveWithinRoot(searchDirectory, lexicalSearchDir, 'Search path');
        } catch {
          // An escaping pattern is not an error the user can act on — it simply
          // matches nothing, same as a nonexistent directory below.
          return { success: true, files: [] };
        }

        // Check if searchDir exists
        try {
          await fs.access(searchDir);
        } catch {
          return { success: true, files: [] };
        }

        // Get list of tracked files (not gitignored) using git
        const gitTrackedFiles = new Set<string>();
        let isGitRepo = true;
        try {
          // Get list of all tracked files in the repository
          const { stdout: trackedStdout } = await runGitCapture(searchDirectory, ['ls-files']);

          if (trackedStdout) {
            trackedStdout.split('\n').forEach((file: string) => {
              if (file.trim()) {
                gitTrackedFiles.add(file.trim());
              }
            });
          }

          // Also get untracked files that are not ignored
          const { stdout: untrackedStdout } = await runGitCapture(searchDirectory, [
            'ls-files',
            '--others',
            '--exclude-standard',
          ]);

          if (untrackedStdout) {
            untrackedStdout.split('\n').forEach((file: string) => {
              if (file.trim()) {
                gitTrackedFiles.add(file.trim());
              }
            });
          }
        } catch (err) {
          // Git command failed, likely not a git repo
          isGitRepo = false;
          console.log('Could not get git tracked files:', err);
        }

        // Use glob to find matching files
        const globPattern = filePattern ? `**/*${filePattern}*` : '**/*';
        const files = await glob(globPattern, {
          cwd: searchDir,
          ignore: [
            '**/node_modules/**',
            '**/.git/**',
            '**/dist/**',
            '**/build/**',
            '**/worktrees/**', // Exclude worktree folders
          ],
          nodir: false,
          dot: true,
          absolute: false,
          maxDepth: 5,
        });

        // Convert to relative paths from the original directory
        const results = await Promise.all(
          files.map(async (file) => {
            const fullPath = path.join(searchDir, file);
            const relativePath = path.relative(resolvedSearchDirectory, fullPath);

            // Both comparisons below are against '/'-separated forms (the literal
            // worktree filters, and git ls-files output which git always emits
            // with '/'), while path.relative is platform-native (backslashes on
            // Windows). Normalize once for MATCHING — the reported path stays
            // exactly what path.relative produced.
            const relativeMatchPath = normalizePathSeparators(relativePath);

            // Skip worktree directories
            if (relativeMatchPath.includes('worktrees/') || relativeMatchPath.startsWith('worktrees/')) {
              return null;
            }

            // If we're in a git repo, only include tracked/untracked-but-not-ignored files
            if (isGitRepo && gitTrackedFiles.size > 0 && !gitTrackedFiles.has(relativeMatchPath)) {
              // Check if it's a directory - directories might not be in git ls-files
              try {
                const stats = await fs.stat(fullPath);
                if (!stats.isDirectory()) {
                  return null; // Skip non-directory files that aren't tracked
                }
              } catch {
                return null;
              }
            }

            try {
              const stats = await fs.stat(fullPath);
              return {
                path: relativePath,
                isDirectory: stats.isDirectory(),
                name: path.basename(file),
              };
            } catch {
              return null;
            }
          }),
        );

        // Filter out null results and apply pattern matching
        const filteredResults = results
          .filter((file): file is NonNullable<typeof file> => file !== null)
          .filter((file) => {
            // Filter by the full search pattern
            return file.path.toLowerCase().includes(searchPattern);
          })
          .sort((a, b) => {
            // Sort directories first, then by path
            if (a.isDirectory && !b.isDirectory) return -1;
            if (!a.isDirectory && b.isDirectory) return 1;
            return a.path.localeCompare(b.path);
          })
          .slice(0, request.limit || 50);

        return { success: true, files: filteredResults };
      } catch (error) {
        console.error('Error searching files:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
          files: [],
        };
      }
    },
  };
}
