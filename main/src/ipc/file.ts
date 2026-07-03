import { IpcMain } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { glob } from 'glob';
import { appendCommitFooter } from '../utils/commitFooter';
import { escapeShellArgs } from '../utils/shellEscape';
import { runGitAsync } from '../utils/runGit';
import type { AppServices } from './types';
import type { Session } from '../types/session';

interface FileReadRequest {
  sessionId: string;
  filePath: string;
}

interface FileWriteRequest {
  sessionId: string;
  filePath: string;
  content: string;
}

interface FilePathRequest {
  sessionId: string;
  filePath: string;
}

interface FileListRequest {
  sessionId: string;
  path?: string;
}

interface FileDeleteRequest {
  sessionId: string;
  filePath: string;
}

interface FileItem {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  modified?: Date;
}

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

export function registerFileHandlers(ipcMain: IpcMain, services: AppServices): void {
  const { sessionManager, databaseService, gitStatusManager, configManager } = services;

  // Read file contents from a session's worktree
  ipcMain.handle('file:read', async (_, request: FileReadRequest) => {
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
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  });

  // Write file contents to a session's worktree
  ipcMain.handle('file:write', async (_, request: FileWriteRequest) => {
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
      const dirPath = path.dirname(fullPath);

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

      // Create directory if it doesn't exist
      await fs.mkdir(dirPath, { recursive: true });

      // Write the file
      await fs.writeFile(fullPath, request.content, 'utf-8');
      
      return { success: true };
    } catch (error) {
      console.error('Error writing file:', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  });

  // Get the full path for a file in a session's worktree
  ipcMain.handle('file:getPath', async (_, request: FilePathRequest) => {
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
      return { success: true, path: fullPath };
    } catch (error) {
      console.error('Error getting file path:', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  });

  // Commit changes in a session's worktree
  ipcMain.handle('git:commit', async (_, request: { sessionId: string; message: string }) => {
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
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  });

  // Revert a specific commit
  ipcMain.handle('git:revert', async (_, request: { sessionId: string; commitHash: string }) => {
    try {
      const session = sessionManager.getSession(request.sessionId);
      if (!session) {
        throw new Error(`Session not found: ${request.sessionId}`);
      }

      if (!request.commitHash) {
        throw new Error('Commit hash is required');
      }

      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);

      try {
        // Create a revert commit
        const command = `git revert ${request.commitHash} --no-edit`;
        await execAsync(command, { cwd: session.worktreePath });

        return { success: true };
      } catch (error: unknown) {
        throw new Error(`Git revert failed: ${error instanceof Error ? error.message : error}`);
      }
    } catch (error) {
      console.error('Error reverting commit:', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  });

  // Restore all uncommitted changes
  ipcMain.handle('git:restore', async (_, request: { sessionId: string }) => {
    try {
      const session = sessionManager.getSession(request.sessionId);
      if (!session) {
        throw new Error(`Session not found: ${request.sessionId}`);
      }

      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);

      try {
        // Reset all changes to the last commit
        await execAsync('git reset --hard HEAD', { cwd: session.worktreePath });
        
        // Clean untracked files
        await execAsync('git clean -fd', { cwd: session.worktreePath });

        return { success: true };
      } catch (error: unknown) {
        throw new Error(`Git restore failed: ${error instanceof Error ? error.message : error}`);
      }
    } catch (error) {
      console.error('Error restoring changes:', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  });

  // Read file contents at a specific git revision
  ipcMain.handle('file:readAtRevision', async (_, request: { sessionId: string; filePath: string; revision?: string }) => {
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

      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);

      try {
        // Default to HEAD if no revision specified
        const revision = request.revision || 'HEAD';
        
        // Use git show to get file content at specific revision
        const { stdout } = await execAsync(
          `git show ${revision}:${normalizedPath}`,
          { 
            cwd: session.worktreePath,
            encoding: 'utf8',
            maxBuffer: 10 * 1024 * 1024 // 10MB buffer
          }
        );

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
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  });

  // List files and directories in a session's worktree
  ipcMain.handle('file:list', async (_, request: FileListRequest) => {
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

      const targetPath = relativePath ? path.join(session.worktreePath, relativePath) : session.worktreePath;
      
      // Read directory contents
      const entries = await fs.readdir(targetPath, { withFileTypes: true });
      
      // Process each entry
      const files: FileItem[] = await Promise.all(
        entries
          .filter(entry => entry.name !== '.git') // Exclude .git directory only
          .map(async (entry) => {
            const fullPath = path.join(targetPath, entry.name);
            const relativePath = path.relative(session.worktreePath, fullPath);
            
            try {
              const stats = await fs.stat(fullPath);
              return {
                name: entry.name,
                path: relativePath,
                isDirectory: entry.isDirectory(),
                size: entry.isFile() ? stats.size : undefined,
                modified: stats.mtime
              };
            } catch {
              // Handle broken symlinks or inaccessible files
              return {
                name: entry.name,
                path: relativePath,
                isDirectory: entry.isDirectory()
              };
            }
          })
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
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  });

  // Delete a file from a session's worktree
  ipcMain.handle('file:delete', async (_, request: FileDeleteRequest) => {
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
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  });

  // Search for files matching a pattern
  ipcMain.handle('file:search', async (_, request: FileSearchRequest) => {
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
      
      // If the pattern contains a path separator, search from that path
      const pathParts = searchPattern.split(/[/\\]/);
      const searchDir = pathParts.length > 1 
        ? path.join(searchDirectory, ...pathParts.slice(0, -1))
        : searchDirectory;
      const filePattern = pathParts[pathParts.length - 1] || '';
      
      // Check if searchDir exists
      try {
        await fs.access(searchDir);
      } catch {
        return { success: true, files: [] };
      }

      // Get list of tracked files (not gitignored) using git
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);
      
      let gitTrackedFiles = new Set<string>();
      let isGitRepo = true;
      try {
        // Get list of all tracked files in the repository
        const { stdout: trackedStdout } = await execAsync('git ls-files', {
          cwd: searchDirectory,
          maxBuffer: 10 * 1024 * 1024 // 10MB buffer
        });
        
        if (trackedStdout) {
          trackedStdout.split('\n').forEach((file: string) => {
            if (file.trim()) {
              gitTrackedFiles.add(file.trim());
            }
          });
        }
        
        // Also get untracked files that are not ignored
        const { stdout: untrackedStdout } = await execAsync('git ls-files --others --exclude-standard', {
          cwd: searchDirectory,
          maxBuffer: 10 * 1024 * 1024 // 10MB buffer
        });
        
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
          '**/worktrees/**' // Exclude worktree folders
        ],
        nodir: false,
        dot: true,
        absolute: false,
        maxDepth: 5
      });

      // Convert to relative paths from the original directory
      const results = await Promise.all(
        files.map(async (file) => {
          const fullPath = path.join(searchDir, file);
          const relativePath = path.relative(searchDirectory, fullPath);
          
          // Skip worktree directories
          if (relativePath.includes('worktrees/') || relativePath.startsWith('worktrees/')) {
            return null;
          }
          
          // If we're in a git repo, only include tracked/untracked-but-not-ignored files
          if (isGitRepo && gitTrackedFiles.size > 0 && !gitTrackedFiles.has(relativePath)) {
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
              name: path.basename(file)
            };
          } catch {
            return null;
          }
        })
      );

      // Filter out null results and apply pattern matching
      const filteredResults = results
        .filter((file): file is NonNullable<typeof file> => file !== null)
        .filter(file => {
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
        files: []
      };
    }
  });

  // Read file from project directory (not worktree)
  ipcMain.handle('file:read-project', async (_, request: { projectId: number; filePath: string }) => {
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
      
      // Check if file exists
      try {
        await fs.access(fullPath);
        console.log('[file:read-project] File exists');
      } catch {
        // File doesn't exist, return null
        console.log('[file:read-project] File does not exist');
        return { success: true, data: null };
      }

      // Read the file
      const content = await fs.readFile(fullPath, 'utf-8');
      console.log('[file:read-project] Read', content.length, 'bytes');
      return { success: true, data: content };
    } catch (error) {
      console.error('[file:read-project] Error:', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  });

  // Write file to project directory (not worktree)
  ipcMain.handle('file:write-project', async (_, request: { projectId: number; filePath: string; content: string }) => {
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
      
      // Ensure directory exists
      const dir = path.dirname(fullPath);
      await fs.mkdir(dir, { recursive: true });
      
      // Write the file
      await fs.writeFile(fullPath, request.content, 'utf-8');
      console.log('[file:write-project] Successfully wrote', request.content.length, 'bytes to', fullPath);
      
      return { success: true };
    } catch (error) {
      console.error('[file:write-project] Error:', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  });

  // Execute git command in project directory
  ipcMain.handle('git:execute-project', async (_, request: { projectId: number; args: string[] }) => {
    console.log('[git:execute-project] Request:', request);
    try {
      const project = databaseService.getProject(request.projectId);
      if (!project) {
        console.error('[git:execute-project] Project not found:', request.projectId);
        throw new Error(`Project not found: ${request.projectId}`);
      }

      console.log('[git:execute-project] Project path:', project.path);
      console.log('[git:execute-project] Git command:', 'git', request.args.join(' '));

      // Import execSync from child_process
      const { execSync } = require('child_process');
      
      // Execute git command — use escapeShellArgs to safely quote every argument
      // and prevent shell injection from user-supplied request.args values.
      // TODO(TASK-680): migrate to runGit(cwd, args[]) — see main/src/utils/runGit.ts
      const result = execSync(`git ${escapeShellArgs(request.args)}`, {
        cwd: project.path,
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024 * 10 // 10MB buffer
      });

      console.log('[git:execute-project] Command successful');
      return { success: true, output: result };
    } catch (error) {
      console.error('[git:execute-project] Error:', error);

      // Extract error message from execSync error
      let errorMessage = 'Unknown error';
      if (error instanceof Error) {
        errorMessage = error.message;
        // If it's an execSync error, it may have stderr/stdout buffers
        interface ExecSyncError extends Error {
          stderr?: Buffer;
          stdout?: Buffer;
        }
        const execError = error as ExecSyncError;
        if (execError.stderr) {
          errorMessage = execError.stderr.toString();
        } else if (execError.stdout) {
          errorMessage = execError.stdout.toString();
        }
      }

      return {
        success: false,
        error: errorMessage
      };
    }
  });
}