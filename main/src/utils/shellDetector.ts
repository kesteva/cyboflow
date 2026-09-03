import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import * as os from 'os';
import { escapeShellArg } from './shellEscape';

interface ShellInfo {
  path: string;
  name: string;
  args?: string[];
}

/**
 * The PowerShell stand-in for POSIX `&&`: PS 5.1 cannot parse `&&` at all, so
 * a failing step is checked explicitly. $LASTEXITCODE is unset until a native
 * command runs, so a cmdlet-only failure falls back to 1 rather than 0.
 */
const PS_STOP_ON_ERROR =
  'if (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }';

/**
 * Detects the user's default shell in a robust, cross-platform way
 */
export class ShellDetector {
  private static cachedShell: ShellInfo | null = null;

  /**
   * Get the user's default shell
   * @param forceRefresh Force re-detection instead of using cache
   * @returns Shell information including path and name
   */
  static getDefaultShell(forceRefresh = false): ShellInfo {
    if (!forceRefresh && this.cachedShell) {
      return this.cachedShell;
    }

    const shell = this.detectShell();
    this.cachedShell = shell;
    return shell;
  }

  private static detectShell(): ShellInfo {
    if (process.platform === 'win32') {
      return this.detectWindowsShell();
    }
    return this.detectUnixShell();
  }

  /**
   * PowerShell 7 when installed, else the 5.1 that every Windows host ships at
   * a fixed path. cmd.exe is the last resort only: no `-c`-style execution.
   */
  private static detectWindowsShell(): ShellInfo {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const systemPowerShell = this.systemPowerShellPath();

    // PowerShell 7's fixed MSI install location — probe it FIRST, before the
    // PATH loop. The PATH probe cannot tell a real pwsh.exe from a 0-byte
    // Microsoft Store execution-alias stub (see below), but Program Files
    // never holds stubs, so a hit here is always the real binary.
    const pwsh7 = path.join(
      process.env.ProgramFiles || 'C:\\Program Files',
      'PowerShell', '7', 'pwsh.exe'
    );
    if (fs.existsSync(pwsh7)) {
      return { path: pwsh7, name: 'pwsh', args: this.getShellArgs('pwsh') };
    }

    // Skip 0-byte candidates. accessSync(X_OK) is existence-only on Windows,
    // so a Store execution-alias stub (0 bytes until first launch) passes the
    // probe, fails every spawn, and would win this scan without the check.
    const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    for (const dir of pathDirs) {
      const candidate = path.join(dir, 'pwsh.exe');
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).size === 0) continue;
        return { path: candidate, name: 'pwsh', args: this.getShellArgs('pwsh') };
      } catch {
        // Not here (or stat raced away) — keep scanning.
      }
    }

    if (fs.existsSync(systemPowerShell)) {
      return { path: systemPowerShell, name: 'powershell', args: this.getShellArgs('powershell') };
    }

    // cmd.exe is always present — last-resort so an INTERACTIVE spawn always
    // has a target. Command execution never lands here: see commandShellPath.
    const cmd = path.join(systemRoot, 'System32', 'cmd.exe');
    return { path: cmd, name: 'cmd', args: [] };
  }

  /** Windows PowerShell, at the fixed location every supported host ships it. */
  private static systemPowerShellPath(): string {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  }

  /**
   * Which binary runs a built command. The cmd.exe last resort understands
   * neither the flags below nor the dialect buildCommandString emits, so
   * command execution uses the system PowerShell instead. Exported for tests.
   */
  static commandShellPath(detected: { name: string; path: string }): string {
    return detected.name === 'cmd' ? this.systemPowerShellPath() : detected.path;
  }

  private static detectUnixShell(): ShellInfo {
    // First, try the SHELL environment variable
    const envShell = process.env.SHELL;
    if (envShell && fs.existsSync(envShell)) {
      const name = path.basename(envShell);
      return { path: envShell, name, args: this.getShellArgs(name) };
    }

    // On macOS, try to get the default shell from Directory Services
    if (process.platform === 'darwin') {
      try {
        const username = os.userInfo().username;
        const result = execSync(`dscl . -read /Users/${username} UserShell`, { encoding: 'utf8', windowsHide: true });
        const match = result.match(/UserShell:\s*(.+)/);
        if (match && match[1]) {
          const shellPath = match[1].trim();
          if (fs.existsSync(shellPath)) {
            const name = path.basename(shellPath);
            return { path: shellPath, name, args: this.getShellArgs(name) };
          }
        }
      } catch (error) {
        // Ignore errors and continue with fallback detection
      }
    }

    // Try to read from /etc/passwd
    try {
      const username = os.userInfo().username;
      const passwdContent = fs.readFileSync('/etc/passwd', 'utf8');
      const userLine = passwdContent.split('\n').find(line => line.startsWith(`${username}:`));
      if (userLine) {
        const parts = userLine.split(':');
        const shellPath = parts[6];
        if (shellPath && fs.existsSync(shellPath)) {
          const name = path.basename(shellPath);
          return { path: shellPath, name, args: this.getShellArgs(name) };
        }
      }
    } catch (error) {
      // Ignore errors and continue with fallback detection
    }

    // Try common shell paths in order of preference
    const commonShells = [
      '/usr/local/bin/zsh',
      '/bin/zsh',
      '/usr/bin/zsh',
      '/usr/local/bin/fish',
      '/usr/bin/fish',
      '/usr/local/bin/bash',
      '/bin/bash',
      '/usr/bin/bash',
      '/bin/sh',
      '/usr/bin/sh'
    ];

    for (const shellPath of commonShells) {
      if (fs.existsSync(shellPath)) {
        const name = path.basename(shellPath);
        return { path: shellPath, name, args: this.getShellArgs(name) };
      }
    }

    // Last resort - use sh
    return { path: '/bin/sh', name: 'sh', args: ['-i'] };
  }

  private static getShellArgs(shellName: string): string[] {
    // Return appropriate arguments for interactive shell sessions
    switch (shellName) {
      case 'bash':
      case 'sh':
      case 'zsh':
      case 'fish':
        return ['-i']; // Interactive mode
      case 'pwsh':
      case 'powershell':
        return ['-NoLogo']; // Skip the banner in interactive PTY sessions
      default:
        return [];
    }
  }

  /**
   * Get shell-specific command execution arguments
   * @param command The command to execute
   * @returns Array of arguments to pass to spawn/exec
   */
  static getShellCommandArgs(command: string): { shell: string; args: string[] } {
    const shellInfo = this.getDefaultShell();
    if (process.platform === 'win32') {
      // -EncodedCommand (base64 of the UTF-16LE command string) instead of
      // -Command: `command` carries user content — quoted paths, nested
      // quotes — that -Command's argv quoting cannot survive verbatim, while
      // the encoded form reaches PowerShell byte-exact. -NonInteractive keeps
      // a script awaiting input from dropping into a REPL.
      return {
        shell: this.commandShellPath(shellInfo),
        args: [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(command, 'utf16le').toString('base64'),
        ],
      };
    }
    return { shell: shellInfo.path, args: ['-c', command] };
  }

  /**
   * Env assignments, then the command lines, in the dialect
   * {@link getShellCommandArgs} routes to. POSIX joins with `&&`; PowerShell
   * has no `export` and no `&&`, so it assigns via `$env:` (single quotes
   * doubled, its own escaping) and separates lines with
   * {@link PS_STOP_ON_ERROR}. `platform` is injectable for tests.
   */
  static buildCommandString(
    envVars: Record<string, string>,
    commandLines: string[],
    platform: NodeJS.Platform = process.platform
  ): string {
    if (platform === 'win32') {
      const parts = Object.entries(envVars).map(
        ([key, value]) => `$env:${key} = '${value.replace(/'/g, "''")}'`
      );
      // The guard follows the LAST line too, so the script's own exit code is
      // the failing step's — matching what `&&` reports on POSIX.
      for (const line of commandLines) {
        parts.push(line, PS_STOP_ON_ERROR);
      }
      return parts.join('\n');
    }
    const parts = Object.entries(envVars).map(
      ([key, value]) => `export ${key}=${escapeShellArg(value)}`
    );
    parts.push(...commandLines);
    return parts.join(' && ');
  }

  /**
   * Check if a shell exists at the given path
   * @param shellPath Path to the shell executable
   * @returns true if the shell exists and is executable
   */
  static isShellAvailable(shellPath: string): boolean {
    try {
      fs.accessSync(shellPath, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
}