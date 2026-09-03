/**
 * ShellDetector.buildCommandString unit tests.
 *
 * This helper builds the RUN/BUILD script command strings that
 * getShellCommandArgs then routes to the user's shell. On Windows that shell
 * is PowerShell, where `export` does not exist and `&&` is a parse error on
 * the PS 5.1 every Windows host ships — the POSIX-shaped strings runCommandManager
 * and sessionManager used to build NEVER executed there. The `platform`
 * parameter is injectable (the TerminalSessionManagerOptions.platform template)
 * so both dialects are pinned deterministically on any host.
 */
import { describe, it, expect } from 'vitest';
import { ShellDetector } from '../shellDetector';

describe('ShellDetector.buildCommandString — POSIX dialect', () => {
  it('assigns env vars via export and joins statements with &&', () => {
    expect(
      ShellDetector.buildCommandString({ WORKTREE_PATH: '/repo dir' }, ['npm run build'], 'linux')
    ).toBe("export WORKTREE_PATH='/repo dir' && npm run build");
  });

  it('joins multiple command lines with &&', () => {
    expect(
      ShellDetector.buildCommandString({}, ['npm install', 'npm test'], 'darwin')
    ).toBe('npm install && npm test');
  });

  it('escapes single quotes in values shell-style (prevents injection)', () => {
    expect(
      ShellDetector.buildCommandString({ WORKTREE_PATH: "/repo/it's" }, ['true'], 'linux')
    ).toBe("export WORKTREE_PATH='/repo/it'\\''s' && true");
  });
});

describe('ShellDetector.buildCommandString — win32 (PowerShell) dialect', () => {
  // PS 5.1 has no `&&`, so each line is followed by an explicit failure check.
  const GUARD = 'if (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }';

  it('assigns env vars via $env: and guards the command line', () => {
    expect(
      ShellDetector.buildCommandString(
        { WORKTREE_PATH: 'C:\\Dev\\repo dir' },
        ['npm run build'],
        'win32'
      )
    ).toBe(`$env:WORKTREE_PATH = 'C:\\Dev\\repo dir'\nnpm run build\n${GUARD}`);
  });

  it('doubles embedded single quotes (PowerShell escaping)', () => {
    expect(
      ShellDetector.buildCommandString(
        { WORKTREE_PATH: "C:\\repo'x" },
        ['npm run build'],
        'win32'
      )
    ).toBe(`$env:WORKTREE_PATH = 'C:\\repo''x'\nnpm run build\n${GUARD}`);
  });

  it('stops at the first failing line instead of running the rest', () => {
    expect(ShellDetector.buildCommandString({}, ['npm install', 'npm test'], 'win32')).toBe(
      `npm install\n${GUARD}\nnpm test\n${GUARD}`
    );
  });

  it('guards the last line too, so the script exits with the failing code', () => {
    const built = ShellDetector.buildCommandString({}, ['npm test'], 'win32');
    expect(built.endsWith(GUARD)).toBe(true);
  });

  it('emits env assignments alone when there are no command lines', () => {
    expect(ShellDetector.buildCommandString({ A: 'b' }, [], 'win32')).toBe("$env:A = 'b'");
  });
});
