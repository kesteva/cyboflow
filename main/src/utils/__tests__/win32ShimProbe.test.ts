import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  isWindowsShellShim,
  planWindowsShimVersionProbes,
  siblingNativeExecutable,
} from '../win32ShimProbe';

const COMSPEC = process.env.comspec || 'cmd.exe';

describe('isWindowsShellShim', () => {
  it('matches .cmd and .bat (case-insensitive) on win32', () => {
    expect(isWindowsShellShim('C:\\npm\\claude.cmd', 'win32')).toBe(true);
    expect(isWindowsShellShim('C:\\npm\\claude.CMD', 'win32')).toBe(true);
    expect(isWindowsShellShim('C:\\npm\\run.bat', 'win32')).toBe(true);
  });

  it('rejects native executables and suffix-less paths', () => {
    expect(isWindowsShellShim('C:\\npm\\claude.exe', 'win32')).toBe(false);
    expect(isWindowsShellShim('C:\\npm\\claude', 'win32')).toBe(false);
    expect(isWindowsShellShim('C:\\npm\\claude.cmd.exe', 'win32')).toBe(false);
  });

  it('is always false off win32 (macOS behavior unchanged)', () => {
    expect(isWindowsShellShim('C:\\npm\\claude.cmd', 'darwin')).toBe(false);
    expect(isWindowsShellShim('/opt/bin/claude.cmd', 'linux')).toBe(false);
  });
});

describe('siblingNativeExecutable', () => {
  it('maps a shim to the .exe next to it', () => {
    expect(siblingNativeExecutable('C:\\npm\\claude.cmd')).toBe('C:\\npm\\claude.exe');
    expect(siblingNativeExecutable('C:\\npm\\run.BAT')).toBe('C:\\npm\\run.exe');
  });

  it('returns null for non-shims', () => {
    expect(siblingNativeExecutable('C:\\npm\\claude.exe')).toBeNull();
    expect(siblingNativeExecutable('C:\\npm\\claude')).toBeNull();
  });
});

describe('planWindowsShimVersionProbes', () => {
  it('returns the plain direct plan for non-shims on any platform', () => {
    expect(planWindowsShimVersionProbes('/opt/homebrew/bin/claude')).toEqual([
      { command: '/opt/homebrew/bin/claude', args: ['--version'] },
    ]);
    expect(planWindowsShimVersionProbes('C:\\npm\\claude.exe')).toEqual([
      { command: 'C:\\npm\\claude.exe', args: ['--version'] },
    ]);
  });

  it('prefers the sibling native .exe when it exists', () => {
    const plans = planWindowsShimVersionProbes('C:\\npm\\claude.cmd', (p) => p === 'C:\\npm\\claude.exe', 'win32');
    expect(plans[0]).toEqual({ command: 'C:\\npm\\claude.exe', args: ['--version'] });
    // The cmd.exe wrapper is still the second plan.
    expect(plans).toHaveLength(2);
  });

  it('wraps the shim in cmd.exe /d /s /c when no sibling exists', () => {
    const plans = planWindowsShimVersionProbes('C:\\Users\\dev\\npm\\claude.cmd', () => false, 'win32');
    expect(plans).toHaveLength(1);
    const plan = plans[0];
    expect(plan.command).toBe(COMSPEC);
    expect(plan.args[0]).toBe('/d');
    expect(plan.args[1]).toBe('/s');
    expect(plan.args[2]).toBe('/c');
    // The /c string is the whole line wrapped in ONE extra quote pair: with /s,
    // cmd strips the outer pair, leaving `<path> --version`.
    expect(plan.args[3]).toBe('"C:\\Users\\dev\\npm\\claude.cmd --version"');
    // Verbatim: Node's argv quoting would backslash-escape the inner quotes,
    // which cmd.exe does not understand.
    expect(plan.windowsVerbatimArguments).toBe(true);
  });

  it('inner-quotes paths with spaces or cmd metacharacters', () => {
    const spaced = planWindowsShimVersionProbes('C:\\Program Files\\npm\\claude.cmd', () => false, 'win32');
    expect(spaced[0].args[3]).toBe('""C:\\Program Files\\npm\\claude.cmd" --version"');
    const meta = planWindowsShimVersionProbes('C:\\npm (x86)\\claude.cmd', () => false, 'win32');
    expect(meta[0].args[3]).toBe('""C:\\npm (x86)\\claude.cmd" --version"');
    const plain = planWindowsShimVersionProbes('C:\\npm\\claude.cmd', () => false, 'win32');
    expect(plain[0].args[3]).toBe('"C:\\npm\\claude.cmd --version"');
  });

  it('actually spawns a real .cmd shim through the plan on Windows', { skip: process.platform !== 'win32' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'win32shim-'));
    try {
      const shim = path.join(dir, 'echo-args.cmd');
      // Echoes its args so the test proves the /c line survives cmd's quote
      // stripping intact.
      fs.writeFileSync(shim, '@echo off\r\necho SHIM:%*\r\n', 'utf8');
      const plan = planWindowsShimVersionProbes(shim, () => false, 'win32')[0];
      const out = execFileSync(plan.command, plan.args, {
        encoding: 'utf8',
        // Conditional spread (not a literal property): ExecFileSyncOptions'
        // typing is narrower than the runtime, which passes the flag through
        // spawnSync's argument normalization.
        ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
      expect(out).toContain('SHIM:--version');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the real cmd.exe parse of a SPACED shim path keeps the path whole', { skip: process.platform !== 'win32' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'win32shim-sp-'));
    try {
      const spacedDir = path.join(dir, 'with space');
      fs.mkdirSync(spacedDir);
      const shim = path.join(spacedDir, 'echo-args.cmd');
      fs.writeFileSync(shim, '@echo off\r\necho SHIM:%*\r\n', 'utf8');
      const plan = planWindowsShimVersionProbes(shim, () => false, 'win32')[0];
      const out = execFileSync(plan.command, plan.args, {
        encoding: 'utf8',
        ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
      // A quoting bug would split the path at the space ("'with' is not
      // recognized") instead of running the shim.
      expect(out).toContain('SHIM:--version');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never consults the filesystem for non-shims', () => {
    const fileExists = vi.fn(() => true);
    planWindowsShimVersionProbes('/usr/local/bin/claude', fileExists);
    expect(fileExists).not.toHaveBeenCalled();
  });
});
