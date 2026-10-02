import * as fs from 'fs/promises';
import * as path from 'path';
import { glob } from 'glob';
import { runGitCapture, assertNotOptionLike, END_OF_OPTIONS } from '../utils/runGit';
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

        // Containment is judged on the REALPATH: the `..`/absolute rejection is
        // lexical only, so a
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
