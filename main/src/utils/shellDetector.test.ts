/**
 * ShellDetector.detectWindowsShell unit tests (win32 branch via the
 * process.platform override pattern — see dockBadgeService.test.ts).
 *
 * Regression guards for the Store execution-alias hazard: on Windows,
 * fs.accessSync(X_OK) is effectively existence-only, so a 0-byte Microsoft
 * Store stub at `...\Microsoft\WindowsApps\pwsh.exe` used to win the PATH
 * scan and every spawn of it failed, never reaching the guaranteed System32
 * powershell.exe. The fixed order is:
 *   1. %ProgramFiles%\PowerShell\7\pwsh.exe   (MSI location — never a stub)
 *   2. PATH scan, skipping 0-byte candidates
 *   3. System32 powershell.exe
 *   4. System32 cmd.exe
 *
 * fs's own exports are non-configurable, so vi.spyOn can't redefine them —
 * wrap the real implementations in vi.fn() instead (see nodeFinder.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    accessSync: vi.fn(actual.accessSync),
    statSync: vi.fn(actual.statSync),
  };
});

import { ShellDetector } from './shellDetector';

const STUB_DIR = '/profile-stub/Microsoft/WindowsApps';
const REAL_DIR = '/tools/pwsh7';
const PROGRAM_FILES_PWSH = path.join('/Program Files', 'PowerShell', '7', 'pwsh.exe');
const STUB_PWSH = path.join(STUB_DIR, 'pwsh.exe');
const REAL_PWSH = path.join(REAL_DIR, 'pwsh.exe');

describe('ShellDetector.detectWindowsShell (win32)', () => {
  const originalPlatform = process.platform;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, 'platform', { value: 'win32', writable: true });
    for (const key of ['SystemRoot', 'ProgramFiles', 'PATH']) {
      savedEnv[key] = process.env[key];
    }
    process.env.SystemRoot = '/SystemRoot';
    process.env.ProgramFiles = '/Program Files';
    // Default posture for most cases: no PowerShell 7 in Program Files, and a
    // PATH offering the 0-byte Store stub before a real pwsh.
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.accessSync).mockImplementation(() => undefined);
    vi.mocked(fs.statSync).mockImplementation((p) => {
      throw Object.assign(new Error(`ENOENT: ${String(p)}`), { code: 'ENOENT' });
    });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
    for (const key of ['SystemRoot', 'ProgramFiles', 'PATH']) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    vi.restoreAllMocks();
  });

  it('probes %ProgramFiles%\\PowerShell\\7\\pwsh.exe FIRST, before any PATH candidate', () => {
    process.env.PATH = [STUB_DIR, REAL_DIR].join(path.delimiter);
    vi.mocked(fs.existsSync).mockImplementation((p) => p === PROGRAM_FILES_PWSH);

    const shell = ShellDetector.getDefaultShell(true);
    expect(shell.path).toBe(PROGRAM_FILES_PWSH);
    expect(shell.name).toBe('pwsh');
    expect(shell.args).toEqual(['-NoLogo']);
    // The PATH loop never ran.
    expect(fs.accessSync).not.toHaveBeenCalled();
  });

  it('skips a 0-byte execution-alias stub on PATH and selects the real pwsh behind it', () => {
    process.env.PATH = [STUB_DIR, REAL_DIR].join(path.delimiter);
    vi.mocked(fs.existsSync).mockImplementation((p) => p === STUB_PWSH || p === REAL_PWSH);
    vi.mocked(fs.statSync).mockImplementation((p) => {
      if (p === STUB_PWSH) return { size: 0 } as fs.Stats;
      if (p === REAL_PWSH) return { size: 61440 } as fs.Stats;
      throw Object.assign(new Error(`ENOENT: ${String(p)}`), { code: 'ENOENT' });
    });

    const shell = ShellDetector.getDefaultShell(true);
    expect(shell.path).toBe(REAL_PWSH);
    expect(shell.name).toBe('pwsh');
  });

  it('falls through to System32 powershell.exe when every PATH pwsh is a 0-byte stub', () => {
    process.env.PATH = STUB_DIR;
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => p === STUB_PWSH || p === path.join('/SystemRoot', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    );
    vi.mocked(fs.statSync).mockImplementation((p) => {
      if (p === STUB_PWSH) return { size: 0 } as fs.Stats;
      throw Object.assign(new Error(`ENOENT: ${String(p)}`), { code: 'ENOENT' });
    });

    const shell = ShellDetector.getDefaultShell(true);
    expect(shell.path).toBe(path.join('/SystemRoot', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
    expect(shell.name).toBe('powershell');
    expect(shell.args).toEqual(['-NoLogo']);
  });

  it('lands on cmd.exe as the last resort when nothing else exists', () => {
    process.env.PATH = STUB_DIR;
    // existsSync mocked false for everything (beforeEach default); the stub
    // directory candidate never even passes existsSync.
    const shell = ShellDetector.getDefaultShell(true);
    expect(shell.path).toBe(path.join('/SystemRoot', 'System32', 'cmd.exe'));
    expect(shell.name).toBe('cmd');
    expect(shell.args).toEqual([]);
  });

  it('does not hand PowerShell flags to the cmd.exe last resort', () => {
    process.env.PATH = STUB_DIR;
    const { shell, args } = ShellDetector.getShellCommandArgs('echo hi');
    expect(shell).toBe(
      path.join('/SystemRoot', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    );
    expect(args).toContain('-EncodedCommand');
  });
});

describe('ShellDetector.commandShellPath', () => {
  // Runs on any host: the interactive fallback can be cmd.exe, which
  // understands none of the -EncodedCommand flags and cannot run the
  // PowerShell dialect buildCommandString emits.
  const savedRoot = process.env.SystemRoot;

  beforeEach(() => {
    process.env.SystemRoot = '/SystemRoot';
  });

  afterEach(() => {
    if (savedRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = savedRoot;
  });

  it('redirects the cmd.exe fallback to the system PowerShell', () => {
    expect(
      ShellDetector.commandShellPath({ name: 'cmd', path: 'C:\\Windows\\System32\\cmd.exe' })
    ).toBe(path.join('/SystemRoot', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  });

  it('leaves a detected PowerShell alone', () => {
    expect(ShellDetector.commandShellPath({ name: 'pwsh', path: '/tools/pwsh7/pwsh.exe' })).toBe(
      '/tools/pwsh7/pwsh.exe'
    );
    expect(
      ShellDetector.commandShellPath({ name: 'powershell', path: '/ps/powershell.exe' })
    ).toBe('/ps/powershell.exe');
  });
});
