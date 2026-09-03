import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { glob } from 'glob';
import { appendCommitFooter } from '../utils/commitFooter';
import { runGitAsync, runGitCapture, assertNotOptionLike, END_OF_OPTIONS } from '../utils/runGit';
import { normalizePathSeparators } from '../utils/posixPath';
import type { AppServices } from './types';
import type { WorkspaceFileOpsLike, FileItem } from '../orchestrator/trpc/contracts/workspaceFileOps';

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
 * not-yet-created files (file:write to a brand-new path).
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

// ===========================================================================
// `git:execute-project` SUBCOMMAND ALLOWLIST — SECURITY BOUNDARY.
//
// This channel is the only renderer-facing handler that takes an arbitrary git
// argv. Before TASK-680 it ran `execSync(\`git ${escapeShellArgs(args)}\`)`:
// shell-escaped, so not injectable as a SHELL command, but still "any git
// subcommand the renderer asks for" — `push`, `config --global`,
// `-c core.pager=…`, `clone` of an attacker URL, and so on, all inside the
// user's real project directory.
//
// The renderer's ACTUAL usage is two calls, both in
// frontend/src/components/panels/SetupTasksPanel.tsx: staging `.gitignore`
// (`['add', '.gitignore']`) and committing it (`['commit', '-m', <message>]`).
// So the allowlist is not "read-only subcommands" but exactly those two argv
// SHAPES — each entry validates its own arguments and returns the final argv
// the runner executes, rather than passing the renderer's array through.
//
// Adding an entry means "a compromised renderer may run this git command in the
// user's project". Prefer a purpose-built IPC channel over widening this.
// ===========================================================================

/** Validates one subcommand's renderer-supplied args and returns the argv to run. */
type ProjectGitArgvBuilder = (args: readonly string[]) => string[];

const PROJECT_GIT_SUBCOMMANDS: Readonly<Record<string, ProjectGitArgvBuilder>> = {
  // `git add -- <pathspec…>`. END_OF_OPTIONS forces every pathspec into a value
  // position, and assertNotOptionLike rejects an option-shaped one outright, so
  // neither git's own parser nor a future git version can reinterpret one as a
  // flag. Paths cannot escape the repo: git rejects a pathspec outside it.
  add: (args) => {
    const pathspecs = args.slice(1);
    if (pathspecs.length === 0) {
      throw new Error('git add requires at least one pathspec');
    }
    pathspecs.forEach((pathspec, i) => assertNotOptionLike(pathspec, `pathspec[${i}]`));
    return ['add', END_OF_OPTIONS, ...pathspecs];
  },

  // `git commit -m <message>` and nothing else — no --amend, no --author, no
  // -F <file>, no pathspecs. The message is bound to `-m`, which takes a
  // required value, so git consumes the next argv element as that value even if
  // it begins with `-`; there is no positional left for END_OF_OPTIONS to guard.
  commit: (args) => {
    const rest = args.slice(1);
    if (rest.length !== 2 || rest[0] !== '-m') {
      throw new Error('git commit is only permitted in the exact form: commit -m <message>');
    }
    return ['commit', '-m', rest[1]];
  },
};

/**
 * Resolve a renderer-supplied argv to the argv that may actually run, or throw
 * with a message naming the offending subcommand and the permitted set.
 */
function resolveProjectGitArgv(args: readonly string[]): string[] {
  if (!Array.isArray(args) || args.length === 0) {
    throw new Error('git args are required');
  }
  const subcommand = args[0];
  const build = Object.prototype.hasOwnProperty.call(PROJECT_GIT_SUBCOMMANDS, subcommand)
    ? PROJECT_GIT_SUBCOMMANDS[subcommand]
    : undefined;
  if (!build) {
    throw new Error(
      `git subcommand "${subcommand}" is not permitted on this channel. ` +
        `Allowed: ${Object.keys(PROJECT_GIT_SUBCOMMANDS).join(', ')}. ` +
        `See PROJECT_GIT_SUBCOMMANDS in main/src/ipc/fileOps.ts.`,
    );
  }
  return build(args);
}

/**
 * Concrete implementation of {@link WorkspaceFileOpsLike}, backing the
 * `workspaceFiles` tRPC router (routers/workspaceFiles.ts). Method bodies are
 * moved verbatim from the legacy `file:*`/`git:*` ipcMain.handle handlers
 * (ipc/file.ts, now deleted) — this file may freely import from
 * main/src/services/*, unlike the tRPC subtree itself. `file:getPath` was not
 * migrated (zero preload/frontend callers) — its containment helper
 * (resolveWithinRoot) is still used by the other methods below.
 */
export function createFileOps(
  services: Pick<AppServices, 'sessionManager' | 'databaseService' | 'gitStatusManager' | 'configManager'>,
): WorkspaceFileOpsLike {
  const { sessionManager, databaseService, gitStatusManager, configManager } = services;

  return {
    // Read file contents from a session's worktree
    async read(request) {
      try {
        const session = sessionManager.getSession(request.sessionId);
        if (!session) {
          throw new Error(`Session not found: ${request.sessionId}`);
        }

        // Ensure the file path is relative and safe
        const normalizedPath = path.normalize(request.filePath);
        if (normalizedPath.startsWith('..') || path.isAbsolute(normalizedPath)) {
          throw new Error('Invalid file path');
        }

        const fullPath = path.join(session.worktreePath, normalizedPath);

        // Verify the file is within the worktree. Containment is judged on the
        // realpath result alone (symlinks fully collapsed) with a sep-boundary
        // check — a symlink inside the worktree pointing outside is rejected.
        const resolvedWorktreePath = await fs.realpath(session.worktreePath).catch(() => session.worktreePath);
        const resolvedFilePath = await resolveForContainment(fullPath);
        if (!isWithin(resolvedFilePath, resolvedWorktreePath)) {
          throw new Error('File path is outside worktree');
        }

        const content = await fs.readFile(resolvedFilePath, 'utf-8');
        return { success: true, content };
      } catch (error) {
        console.error('Error reading file:', error);
        console.error('Stack:', error instanceof Error ? error.stack : 'No stack');
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },

    // Write file contents to a session's worktree
    async write(request) {
      try {
        // Removed verbose logging of file:write requests to reduce console noise during auto-save

        if (!request.filePath) {
          throw new Error('File path is required');
        }

        const session = sessionManager.getSession(request.sessionId);
        if (!session) {
          throw new Error(`Session not found: ${request.sessionId}`);
        }

        // Note: mainBranch detection removed as it wasn't being used in this function
        // If needed in the future, use worktreeManager.detectMainBranch(session.worktreePath)

        if (!session.worktreePath) {
          throw new Error(`Session worktree path is undefined for session: ${request.sessionId}`);
        }

        // Ensure the file path is relative and safe
        const normalizedPath = path.normalize(request.filePath);
        if (normalizedPath.startsWith('..') || path.isAbsolute(normalizedPath)) {
          throw new Error('Invalid file path');
        }

        const fullPath = path.join(session.worktreePath, normalizedPath);

        // Verify the target is within the worktree BEFORE any mkdir/write side
        // effect. Containment is judged on the realpath of the target (the leaf
        // may not exist yet — resolveForContainment falls back to the deepest
        // existing ancestor) with a sep-boundary check, so an existing symlink
        // that escapes the worktree is rejected rather than followed by writeFile.
        const resolvedWorktreePath = await fs.realpath(session.worktreePath).catch(() => session.worktreePath);
        const resolvedTarget = await resolveForContainment(fullPath);
        if (!isWithin(resolvedTarget, resolvedWorktreePath)) {
          throw new Error('File path is outside worktree');
        }

        // mkdir + write go to the RESOLVED target, not the lexical one: writing to
        // `fullPath` would re-follow the leaf symlink at write time, so the path
        // checked and the path written would be different strings.
        await fs.mkdir(path.dirname(resolvedTarget), { recursive: true });

        // Write the file
        await fs.writeFile(resolvedTarget, request.content, 'utf-8');

        return { success: true };
      } catch (error) {
        console.error('Error writing file:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },

    // Commit changes in a session's worktree
    async gitCommit(request) {
      try {
        const session = sessionManager.getSession(request.sessionId);
        if (!session) {
          throw new Error(`Session not found: ${request.sessionId}`);
        }

        if (!request.message || !request.message.trim()) {
          throw new Error('Commit message is required');
        }

        try {
          // Stage all changes
          await runGitAsync(session.worktreePath, ['add', '-A']);

          // Create the commit with Cyboflow signature if enabled
          const commitMessage = appendCommitFooter(request.message, configManager);

          // Use a temporary file to handle commit messages with special characters
          const tmpFile = path.join(os.tmpdir(), `cyboflow-commit-${Date.now()}.txt`);
          try {
            await fs.writeFile(tmpFile, commitMessage, 'utf-8');
            await runGitAsync(session.worktreePath, ['commit', '-F', tmpFile]);
          } finally {
            // Clean up the temporary file
            await fs.unlink(tmpFile).catch(() => {
              // Ignore cleanup errors
            });
          }

          // Refresh git status for this session after commit
          try {
            await gitStatusManager.refreshSessionGitStatus(request.sessionId, false);
          } catch (error) {
            // Git status refresh failures are logged by GitStatusManager
            console.error('Failed to refresh git status after commit:', error);
          }

          return { success: true };
        } catch (error: unknown) {
          // Check if it's a pre-commit hook failure
          if (error instanceof Error && error.message.includes('pre-commit hook')) {
            // Try to commit again in case the pre-commit hook made changes
            try {
              await runGitAsync(session.worktreePath, ['add', '-A']);

              const retryMessage = appendCommitFooter(request.message, configManager);

              // Use a temporary file for retry as well
              const tmpFile = path.join(os.tmpdir(), `cyboflow-commit-retry-${Date.now()}.txt`);
              try {
                await fs.writeFile(tmpFile, retryMessage, 'utf-8');
                await runGitAsync(session.worktreePath, ['commit', '-F', tmpFile]);
              } finally {
                // Clean up the temporary file
                await fs.unlink(tmpFile).catch(() => {
                  // Ignore cleanup errors
                });
              }

              // Refresh git status for this session after commit
              try {
                await gitStatusManager.refreshSessionGitStatus(request.sessionId, false);
              } catch (error) {
                // Git status refresh failures are logged by GitStatusManager
                console.error('Failed to refresh git status after commit (retry):', error);
              }

              return { success: true };
            } catch (retryError: unknown) {
              throw new Error(`Git commit failed: ${retryError instanceof Error ? retryError.message : retryError}`);
            }
          }
          throw new Error(`Git commit failed: ${error instanceof Error ? error.message : error}`);
        }
      } catch (error) {
        console.error('Error committing changes:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },

    // Revert a specific commit
    async gitRevert(request) {
      try {
        const session = sessionManager.getSession(request.sessionId);
        if (!session) {
          throw new Error(`Session not found: ${request.sessionId}`);
        }

        if (!request.commitHash) {
          throw new Error('Commit hash is required');
        }

        try {
          // Create a revert commit. argv form (no shell), with the caller's hash
          // pinned into a value position: END_OF_OPTIONS after our own flags, plus
          // an explicit reject of an option-shaped hash. The previous form
          // interpolated request.commitHash straight into a shell string.
          await runGitCapture(session.worktreePath, [
            'revert',
            '--no-edit',
            END_OF_OPTIONS,
            assertNotOptionLike(request.commitHash, 'commit hash'),
          ]);

          return { success: true };
        } catch (error: unknown) {
          throw new Error(`Git revert failed: ${error instanceof Error ? error.message : error}`);
        }
      } catch (error) {
        console.error('Error reverting commit:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },

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

    // Read file contents at a specific git revision
    async readAtRevision(request) {
      try {
        const session = sessionManager.getSession(request.sessionId);
        if (!session) {
          throw new Error(`Session not found: ${request.sessionId}`);
        }

        // Ensure the file path is relative and safe
        const normalizedPath = path.normalize(request.filePath);
        if (normalizedPath.startsWith('..') || path.isAbsolute(normalizedPath)) {
          throw new Error('Invalid file path');
        }

        try {
          // Default to HEAD if no revision specified
          const revision = request.revision || 'HEAD';
          // The revision is renderer-supplied and gets concatenated with the path
          // into a single `<rev>:<path>` object spec. Reject an option-shaped one,
          // and reject an embedded ':' — git splits on the FIRST colon, so a
          // revision carrying one would silently re-aim the path half of the spec.
          assertNotOptionLike(revision, 'revision');
          if (revision.includes(':')) {
            throw new Error(`Invalid revision "${revision}": must not contain ":"`);
          }

          // Use git show to get file content at specific revision. argv form (no
          // shell), with END_OF_OPTIONS pinning the spec into a value position.
          // Git's `<rev>:<path>` object spec always uses forward slashes as
          // separators — on Windows, path.normalize emits native backslashes
          // that git treats as literal filename characters, so the spec never
          // matches. Only remap on win32: on POSIX a backslash is a legitimate
          // (literal) filename character and must be preserved.
          const gitObjectPath = normalizePathSeparators(normalizedPath);
          const { stdout } = await runGitCapture(session.worktreePath, [
            'show',
            END_OF_OPTIONS,
            `${revision}:${gitObjectPath}`,
          ]);

          return { success: true, content: stdout };
        } catch (error: unknown) {
          // If file doesn't exist at that revision, return empty content
          if (error instanceof Error && (error.message.includes('does not exist') || error.message.includes('bad file'))) {
            return { success: true, content: '' };
          }
          throw new Error(`Failed to read file at revision: ${error instanceof Error ? error.message : error}`);
        }
      } catch (error) {
        console.error('Error reading file at revision:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },

    // List files and directories in a session's worktree
    async list(request) {
      try {
        const session = sessionManager.getSession(request.sessionId);
        if (!session) {
          throw new Error(`Session not found: ${request.sessionId}`);
        }

        // Check if session is archived - worktree won't exist
        if (session.archived) {
          return { success: false, error: 'Cannot list files for archived session' };
        }

        // Use the provided path or default to root
        const relativePath = request.path || '';

        // Ensure the path is relative and safe
        if (relativePath) {
          const normalizedPath = path.normalize(relativePath);
          if (normalizedPath.startsWith('..') || path.isAbsolute(normalizedPath)) {
            throw new Error('Invalid path');
          }
        }

        const lexicalTarget = relativePath ? path.join(session.worktreePath, relativePath) : session.worktreePath;
        // Realpath containment, like file:read/file:write — the lexical check above
        // does not stop a directory symlink inside the worktree from listing an
        // arbitrary directory outside it. The returned paths are relative to the
        // RESOLVED root (targetPath is now resolved, so relating it to the lexical
        // worktree path would emit `../…` whenever the worktree itself sits under
        // a symlinked parent — e.g. macOS /tmp → /private/tmp).
        const resolvedRoot = await fs.realpath(session.worktreePath).catch(() => session.worktreePath);
        const targetPath = await resolveWithinRoot(session.worktreePath, lexicalTarget, 'Path');

        // Read directory contents
        const entries = await fs.readdir(targetPath, { withFileTypes: true });

        // Process each entry
        const files: FileItem[] = await Promise.all(
          entries
            .filter((entry) => entry.name !== '.git') // Exclude .git directory only
            .map(async (entry) => {
              const fullPath = path.join(targetPath, entry.name);
              const relativePath = path.relative(resolvedRoot, fullPath);

              try {
                const stats = await fs.stat(fullPath);
                return {
                  name: entry.name,
                  path: relativePath,
                  isDirectory: entry.isDirectory(),
                  size: entry.isFile() ? stats.size : undefined,
                  modified: stats.mtime,
                };
              } catch {
                // Handle broken symlinks or inaccessible files
                return {
                  name: entry.name,
                  path: relativePath,
                  isDirectory: entry.isDirectory(),
                };
              }
            }),
        );

        // Sort: directories first, then alphabetically
        files.sort((a, b) => {
          if (a.isDirectory === b.isDirectory) {
            return a.name.localeCompare(b.name);
          }
          return a.isDirectory ? -1 : 1;
        });

        return { success: true, files };
      } catch (error) {
        console.error('Error listing files:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },

    // Delete a file from a session's worktree
    async delete(request) {
      try {
        const session = sessionManager.getSession(request.sessionId);
        if (!session) {
          throw new Error(`Session not found: ${request.sessionId}`);
        }

        // Ensure the file path is relative and safe
        const normalizedPath = path.normalize(request.filePath);
        if (normalizedPath.startsWith('..') || path.isAbsolute(normalizedPath)) {
          throw new Error('Invalid file path');
        }

        const fullPath = path.join(session.worktreePath, normalizedPath);

        // Verify the file is within the worktree
        // First resolve the worktree path to handle symlinks
        const resolvedWorktreePath = await fs.realpath(session.worktreePath).catch(() => session.worktreePath);

        // Check if the file exists and resolve its path
        let resolvedFilePath: string;
        try {
          resolvedFilePath = await fs.realpath(fullPath);
        } catch (err) {
          // File doesn't exist
          throw new Error(`File not found: ${normalizedPath}`);
        }

        // Check if the resolved path is within the worktree (sep-boundary safe;
        // realpath already collapsed any symlink that would escape it).
        if (!isWithin(resolvedFilePath, resolvedWorktreePath)) {
          throw new Error('File path is outside worktree');
        }

        // Check if it's a directory or file
        const stats = await fs.stat(resolvedFilePath);

        if (stats.isDirectory()) {
          // For directories, use rm with recursive option
          await fs.rm(resolvedFilePath, { recursive: true, force: true });
        } else {
          // For files, use unlink
          await fs.unlink(resolvedFilePath);
        }

        return { success: true };
      } catch (error) {
        console.error('Error deleting file:', error);
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

    // Read file from project directory (not worktree)
    async readProject(request) {
      console.log('[file:read-project] Request:', request);
      try {
        const project = databaseService.getProject(request.projectId);
        if (!project) {
          console.error('[file:read-project] Project not found:', request.projectId);
          throw new Error(`Project not found: ${request.projectId}`);
        }

        console.log('[file:read-project] Project path:', project.path);

        // Ensure the file path is relative and safe
        const normalizedPath = path.normalize(request.filePath);
        if (normalizedPath.startsWith('..') || path.isAbsolute(normalizedPath)) {
          throw new Error('Invalid file path');
        }

        const fullPath = path.join(project.path, normalizedPath);
        console.log('[file:read-project] Full path:', fullPath);

        // Containment is judged on the REALPATH, matching the session-scoped
        // handlers above: the `..`/absolute rejection is lexical only, so a
        // symlink committed inside the project (`docs/out -> /Users/me/.ssh`)
        // would otherwise read straight through it.
        const resolvedPath = await resolveWithinRoot(project.path, fullPath, 'File path');

        // Check if file exists
        try {
          await fs.access(resolvedPath);
          console.log('[file:read-project] File exists');
        } catch {
          // File doesn't exist, return null
          console.log('[file:read-project] File does not exist');
          return { success: true, data: null };
        }

        // Read the file
        const content = await fs.readFile(resolvedPath, 'utf-8');
        console.log('[file:read-project] Read', content.length, 'bytes');
        return { success: true, data: content };
      } catch (error) {
        console.error('[file:read-project] Error:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },

    // Write file to project directory (not worktree)
    async writeProject(request) {
      console.log('[file:write-project] Request:', { projectId: request.projectId, filePath: request.filePath, contentLength: request.content.length });
      try {
        const project = databaseService.getProject(request.projectId);
        if (!project) {
          console.error('[file:write-project] Project not found:', request.projectId);
          throw new Error(`Project not found: ${request.projectId}`);
        }

        console.log('[file:write-project] Project path:', project.path);

        // Ensure the file path is relative and safe
        const normalizedPath = path.normalize(request.filePath);
        if (normalizedPath.startsWith('..') || path.isAbsolute(normalizedPath)) {
          throw new Error('Invalid file path');
        }

        const fullPath = path.join(project.path, normalizedPath);
        console.log('[file:write-project] Full path:', fullPath);

        // Containment on the REALPATH, BEFORE any mkdir/write side effect — and
        // the write then goes to that same resolved path, so an existing symlink
        // that escapes the project is rejected rather than written through.
        // resolveForContainment also chases a DANGLING link chain, which matters
        // here: writeFile through one creates the target wherever it points.
        const resolvedTarget = await resolveWithinRoot(project.path, fullPath, 'File path');

        // Ensure directory exists
        await fs.mkdir(path.dirname(resolvedTarget), { recursive: true });

        // Write the file
        await fs.writeFile(resolvedTarget, request.content, 'utf-8');
        console.log('[file:write-project] Successfully wrote', request.content.length, 'bytes to', resolvedTarget);

        return { success: true };
      } catch (error) {
        console.error('[file:write-project] Error:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },

    // Execute git command in project directory
    async gitExecuteProject(request) {
      console.log('[git:execute-project] Request:', request);
      try {
        const project = databaseService.getProject(request.projectId);
        if (!project) {
          console.error('[git:execute-project] Project not found:', request.projectId);
          throw new Error(`Project not found: ${request.projectId}`);
        }

        console.log('[git:execute-project] Project path:', project.path);

        // Validate against the subcommand allowlist BEFORE anything runs, and use
        // the argv it returns rather than the renderer's array — see
        // PROJECT_GIT_SUBCOMMANDS above. argv form (execFile, no shell) also means
        // no argument is ever parsed by a shell.
        const argv = resolveProjectGitArgv(request.args);
        console.log('[git:execute-project] Git command:', 'git', argv.join(' '));

        const { stdout } = await runGitCapture(project.path, argv);

        console.log('[git:execute-project] Command successful');
        return { success: true, output: stdout };
      } catch (error) {
        console.error('[git:execute-project] Error:', error);

        // Surface git's own output as the error. `git commit` reports "nothing to
        // commit" on STDOUT with a non-zero exit, and SetupTasksPanel matches on
        // that string, so the stderr-then-stdout fallback order is load-bearing —
        // an empty stderr must fall through rather than win.
        let errorMessage = 'Unknown error';
        if (error instanceof Error) {
          errorMessage = error.message;
          interface ExecError extends Error {
            stderr?: string | Buffer;
            stdout?: string | Buffer;
          }
          const execError = error as ExecError;
          if (execError.stderr) {
            errorMessage = execError.stderr.toString();
          } else if (execError.stdout) {
            errorMessage = execError.stdout.toString();
          }
        }

        return {
          success: false,
          error: errorMessage,
        };
      }
    },
  };
}
