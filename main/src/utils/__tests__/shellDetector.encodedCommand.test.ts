/**
 * ShellDetector.getShellCommandArgs — the win32 -EncodedCommand migration.
 *
 * The old win32 arm emitted `powershell … -Command <string>`: the string
 * carries user content (quoted paths, nested quotes) that -Command's argv
 * quoting could not survive verbatim. The encoded form base64-encodes the
 * SAME string buildCommandString produces (UTF-16LE) and PowerShell decodes
 * it byte-exact — a command containing both `'` and `"` now executes with no
 * escaping layer. POSIX `-c` output is unchanged.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ShellDetector } from '../shellDetector';

const execFileAsync = promisify(execFile);

describe('ShellDetector.getShellCommandArgs — win32 EncodedCommand shape', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
  });

  it('emits the -EncodedCommand form and base64-round-trips the command verbatim', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', writable: true });
    const command = "$env:WORKTREE_PATH = 'C:\\repo dir'; Write-Output 'it''s a \"test\"'";

    const { shell, args } = ShellDetector.getShellCommandArgs(command);

    // A PowerShell, never the cmd.exe interactive fallback: these flags and
    // this payload mean nothing to cmd. Holds on any host, because the win32
    // detection falls through to the fixed System32 path off Windows.
    expect(shell.toLowerCase()).toMatch(/(powershell|pwsh)\.exe$/);
    expect(args.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
    expect(Buffer.from(args[4], 'base64').toString('utf16le')).toBe(command);
    // The raw command string never appears as a bare argv element — that is
    // the quoting-fragility this migration removes.
    expect(args).not.toContain(command);
  });

  it('keeps the POSIX `-c` form byte-identical', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
    const command = "export WORKTREE_PATH='/repo dir' && npm run build";

    const { args } = ShellDetector.getShellCommandArgs(command);

    expect(args).toEqual(['-c', command]);
  });
});

describe('ShellDetector.getShellCommandArgs — real-process encoded execution', () => {
  it.skipIf(process.platform !== 'win32')(
    'executes a command containing both single and double quotes verbatim',
    async () => {
      const command = `Write-Output 'single "and" double'`;
      const { shell, args } = ShellDetector.getShellCommandArgs(command);

      const { stdout } = await execFileAsync(shell, args, { windowsHide: true });

      expect(stdout.trim()).toBe('single "and" double');
    },
    30000,
  );
});
