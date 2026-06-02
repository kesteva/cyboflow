import { execSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { ShellDetector } from './shellDetector';

// Try to import app from electron (might not be available in all contexts)
let app: typeof import('electron').app | undefined;
try {
  app = require('electron').app;
} catch {
  // Electron not available (e.g., in worker threads)
  app = undefined;
}

// Try to get config manager for additional paths
let getAdditionalPaths: () => string[] = () => [];
try {
  // Lazy import to avoid circular dependencies
  const getConfigManager = () => {
    try {
      const { configManager } = require('../services/configManager');
      return configManager;
    } catch {
      return null;
    }
  };
  
  getAdditionalPaths = () => {
    const configManager = getConfigManager();
    if (configManager) {
      const config = configManager.getConfig();
      return config?.additionalPaths || [];
    }
    return [];
  };
} catch {
  // ConfigManager not available
}

let cachedPath: string | null = null;
let isFirstCall: boolean = true;

/**
 * Get the path separator (colon on macOS/Unix)
 */
function getPathSeparator(): string {
  return ':';
}

/**
 * Get the user's shell PATH by executing their shell
 */
export function getShellPath(): string {
  // In packaged apps, always refresh PATH on first call to avoid cached restricted PATH
  if (cachedPath && !isFirstCall) {
    console.log('[ShellPath] Using cached PATH');
    return cachedPath;
  }
  isFirstCall = false;

  console.log('[ShellPath] Starting PATH detection...');
  console.log(`[ShellPath] Platform: ${process.platform}`);
  console.log(`[ShellPath] Current process PATH: ${process.env.PATH ? process.env.PATH.substring(0, 200) + '...' : 'not set'}`);
  console.log(`[ShellPath] Shell environment: ${process.env.SHELL || 'not set'}`);
  console.log(`[ShellPath] Home directory: ${os.homedir()}`);

  const pathSep = getPathSeparator();

  try {
    let shellPath: string;

    // macOS — use login shell to get the user's full PATH
    const shellInfo = ShellDetector.getDefaultShell();
    const shell = shellInfo.path;

    console.log(`[ShellPath] Detected shell: ${shell} (${shellInfo.name})`);

    const shellCommand = `${shell} -l -i -c 'echo $PATH'`;

    console.log(`[ShellPath] macOS PATH detection - Shell: ${shell}`);
    console.log(`[ShellPath] Shell command: ${shellCommand}`);

    // Execute the command to get the PATH
    // For packaged apps, ALWAYS use login shell to get the user's real PATH
    const isPackaged = process.env.NODE_ENV === 'production' || 'pkg' in process || app?.isPackaged;

    if (isPackaged) {
      console.log('Running in packaged app, using login shell to get full PATH...');

      // Use minimal base PATH - just enough to find the shell
      const minimalPath = '/usr/bin:/bin';

      // Use login shell to load user's full environment
      try {
        // First try with explicit sourcing of shell config files
        let sourceCommand = '';
        const homeDir = os.homedir();

        if (shell.includes('zsh')) {
          // For zsh, source the standard config files
          sourceCommand = `source /etc/zprofile 2>/dev/null || true; ` +
                         `source ${homeDir}/.zprofile 2>/dev/null || true; ` +
                         `source /etc/zshrc 2>/dev/null || true; ` +
                         `source ${homeDir}/.zshrc 2>/dev/null || true; `;
        } else if (shell.includes('bash')) {
          // For bash, source the standard config files
          sourceCommand = `source /etc/profile 2>/dev/null || true; ` +
                         `source ${homeDir}/.bash_profile 2>/dev/null || true; ` +
                         `source ${homeDir}/.bashrc 2>/dev/null || true; `;
        }

        const fullCommand = `${shell} -c '${sourceCommand}echo $PATH'`;
        console.log('Executing shell command to get PATH:', fullCommand);

        shellPath = execSync(fullCommand, {
          encoding: 'utf8',
          timeout: 10000,
          env: {
            PATH: minimalPath,
            SHELL: shell,
            USER: os.userInfo().username,
            HOME: homeDir,
            // Add ZDOTDIR for zsh users who might have custom config location
            ZDOTDIR: process.env.ZDOTDIR || homeDir
          }
        }).trim();
        console.log('Successfully loaded user PATH from shell config files');
      } catch (error) {
        console.error('Failed to load PATH from shell config:', error);

        // Try the standard login shell approach
        try {
          shellPath = execSync(shellCommand, {
            encoding: 'utf8',
            timeout: 10000,
            env: {
              PATH: minimalPath,
              SHELL: shell,
              USER: os.userInfo().username,
              HOME: os.homedir()
            }
          }).trim();
          console.log('Loaded PATH using login shell flags');
        } catch (loginError) {
          console.error('Failed to load PATH from login shell:', loginError);
          // Fallback to current PATH + common locations
          shellPath = process.env.PATH || '';
        }
      }
    } else {
      // In development, try faster approach first
      try {
        shellPath = execSync(`${shell} -c 'echo $PATH'`, {
          encoding: 'utf8',
          timeout: 2000,
          env: process.env
        }).trim();
        console.log(`[ShellPath] Quick PATH retrieval succeeded`);
      } catch (quickError) {
        console.log(`[ShellPath] Quick PATH retrieval failed: ${quickError instanceof Error ? quickError.message : quickError}`);
        console.log(`[ShellPath] Falling back to login shell approach...`);
        shellPath = execSync(shellCommand, {
          encoding: 'utf8',
          timeout: 10000,
          env: process.env
        }).trim();
        console.log(`[ShellPath] Login shell PATH retrieval succeeded`);
      }
    }

    console.log(`[ShellPath] Retrieved shell PATH (${shellPath.split(pathSep).length} entries): ${shellPath.substring(0, 200)}...`);
    
    // Combine with current process PATH to ensure we don't lose anything
    const currentPath = process.env.PATH || '';
    console.log(`[ShellPath] Current process PATH has ${currentPath.split(pathSep).length} entries`);
    
    // Also include npm global bin directories and macOS-specific paths
    const additionalPaths: string[] = [];

    console.log(`[ShellPath] Checking for npm/yarn global paths...`);
    // Try to get npm global bin directory
    try {
      const npmBin = execSync('npm bin -g', {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['pipe', 'pipe', 'ignore']
      }).trim();
      if (npmBin) additionalPaths.push(npmBin);
    } catch {
      // Ignore npm bin errors
    }

    // Try to get yarn global bin directory
    try {
      const yarnBin = execSync('yarn global bin', {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['pipe', 'pipe', 'ignore']
      }).trim();
      if (yarnBin) additionalPaths.push(yarnBin);
    } catch {
      // Ignore yarn bin errors
    }

    // macOS-specific paths
    additionalPaths.push(
      path.join(os.homedir(), '.yarn', 'bin'),
      path.join(os.homedir(), '.config', 'yarn', 'global', 'node_modules', '.bin')
    );

    // Check for nvm directories - look for all versions
    const nvmDir = path.join(os.homedir(), '.nvm/versions/node');
    if (fs.existsSync(nvmDir)) {
      try {
        const versions = fs.readdirSync(nvmDir);
        versions.forEach(version => {
          const binPath = path.join(nvmDir, version, 'bin');
          if (fs.existsSync(binPath)) {
            additionalPaths.push(binPath);
          }
        });
      } catch {
        // Ignore nvm directory read errors
      }
    }

    // Common standard executable locations that interactive/login shells
    // frequently add to PATH (e.g. ~/.local/bin for pipx/uv/`claude` installs)
    // but that a non-interactive `sh -c 'echo $PATH'` probe can miss when the
    // entry is exported only from an interactive rc file (.zshrc). The
    // interactive CLI substrate needs the real `claude` binary on PATH (the SDK
    // substrate uses the npm SDK and never hits this), so a missing ~/.local/bin
    // here surfaces as "claude executable not found in PATH". Existence-checked
    // to avoid adding noise.
    const commonBinPaths = [
      path.join(os.homedir(), '.local', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
    ];
    for (const binPath of commonBinPaths) {
      if (fs.existsSync(binPath)) {
        additionalPaths.push(binPath);
      }
    }

    // Add user-configured additional paths
    const userAdditionalPaths = getAdditionalPaths();
    if (userAdditionalPaths.length > 0) {
      console.log(`[ShellPath] Adding ${userAdditionalPaths.length} user-configured paths`);
      // Expand ~ to home directory
      const expandedUserPaths = userAdditionalPaths.map(p => {
        if (p.startsWith('~')) {
          return path.join(os.homedir(), p.slice(1));
        }
        return p;
      });
      additionalPaths.push(...expandedUserPaths);
    }
    
    const combinedPaths = new Set([
      ...shellPath.split(pathSep),
      ...currentPath.split(pathSep),
      ...additionalPaths
    ]);
    
    cachedPath = Array.from(combinedPaths).filter(p => p).join(pathSep);
    const pathEntries = cachedPath.split(pathSep);
    console.log(`[ShellPath] Final combined PATH has ${pathEntries.length} entries`);
    console.log(`[ShellPath] Added ${additionalPaths.length} additional paths`);
    console.log(`[ShellPath] First few PATH entries: ${pathEntries.slice(0, 5).join(', ')}`);
    console.log(`[ShellPath] PATH loading completed successfully`);
    
    return cachedPath;
  } catch (error) {
    console.error('[ShellPath] ERROR: Failed to get shell PATH:', error);
    console.error(`[ShellPath] Error details: ${error instanceof Error ? error.stack : 'No stack trace available'}`);

    // Try alternative method: read shell config files directly
    console.log('[ShellPath] Attempting fallback: reading shell config files directly...');
    try {
      const homeDir = os.homedir();
      const shellConfigPaths = [
        path.join(homeDir, '.zshrc'),
        path.join(homeDir, '.bashrc'),
        path.join(homeDir, '.bash_profile'),
        path.join(homeDir, '.profile'),
        path.join(homeDir, '.zprofile')
      ];

      console.log(`[ShellPath] Checking shell config files: ${shellConfigPaths.join(', ')}`);
      const extractedPaths: string[] = [];

      for (const configPath of shellConfigPaths) {
        if (fs.existsSync(configPath)) {
          console.log(`[ShellPath] Reading config file: ${configPath}`);
          const content = fs.readFileSync(configPath, 'utf8');
          // Look for PATH exports
          const pathMatches = content.match(/export\s+PATH=["']?([^"'\n]+)["']?/gm);
          if (pathMatches) {
            console.log(`[ShellPath] Found ${pathMatches.length} PATH exports in ${configPath}`);
            pathMatches.forEach(match => {
              const pathValue = match.replace(/export\s+PATH=["']?/, '').replace(/["']?$/, '');
              // Expand $PATH references
              if (pathValue.includes('$PATH')) {
                extractedPaths.push(pathValue.replace(/\$PATH/g, process.env.PATH || ''));
              } else {
                extractedPaths.push(pathValue);
              }
            });
          }
        }
      }

      if (extractedPaths.length > 0) {
        console.log(`[ShellPath] Found ${extractedPaths.length} PATH entries from config files`);
        const combinedPaths = new Set(extractedPaths.join(pathSep).split(pathSep).filter(p => p));
        cachedPath = Array.from(combinedPaths).join(pathSep);
        console.log(`[ShellPath] Fallback successful - PATH has ${cachedPath.split(pathSep).length} entries`);
        return cachedPath;
      } else {
        console.log('[ShellPath] No PATH entries found in config files');
      }
    } catch (configError) {
      console.error('[ShellPath] ERROR: Failed to read shell config files:', configError);
      console.error(`[ShellPath] Config error details: ${configError instanceof Error ? configError.stack : 'No stack trace'}`);
    }

    // Final fallback to process PATH
    const fallbackPath = process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin';

    console.error(`[ShellPath] CRITICAL: Using final fallback PATH`);
    console.error(`[ShellPath] Fallback PATH: ${fallbackPath}`);
    console.error(`[ShellPath] This may indicate a serious PATH loading issue on ${process.platform}`);

    return fallbackPath;
  }
}

/**
 * Clear the cached PATH (useful for development/testing and config changes)
 */
export function clearShellPathCache(): void {
  cachedPath = null;
  console.log('[ShellPath] PATH cache cleared - will be rebuilt on next access');
}

/**
 * Find an executable in the shell PATH
 */
export function findExecutableInPath(executable: string): string | null {
  console.log(`[ShellPath] Finding executable: ${executable}`);
  const shellPath = getShellPath();
  const pathSep = getPathSeparator();
  const paths = shellPath.split(pathSep);

  console.log(`[ShellPath] Searching in ${paths.length} PATH directories`);

  let searchedPaths = 0;
  for (const dir of paths) {
    const fullPath = path.join(dir, executable);
    searchedPaths++;
    try {
      execSync(`test -x "${fullPath}"`, { stdio: 'ignore' });
      console.log(`[ShellPath] Found executable at: ${fullPath}`);
      return fullPath;
    } catch {
      // Not found in this directory
    }
  }

  console.error(`[ShellPath] Executable '${executable}' not found after searching ${searchedPaths} paths`);
  console.error(`[ShellPath] First few paths searched: ${paths.slice(0, 5).join(', ')}`);
  return null;
}