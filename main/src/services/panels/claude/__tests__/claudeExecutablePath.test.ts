/**
 * Tests for resolveClaudeExecutablePath().
 *
 * The helper points the SDK at the asar-UNPACKED native claude binary in
 * packaged builds (the SDK's own require.resolve yields an unspawnable
 * app.asar-internal path). All cases drive the branches via the `overrides`
 * hook, so they are hermetic and never touch the real Electron app or fs.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { resolveClaudeExecutablePath } from '../claudeExecutablePath';

describe('resolveClaudeExecutablePath', () => {
  it('returns undefined in dev (not packaged) regardless of fs state', () => {
    const result = resolveClaudeExecutablePath({
      isPackaged: false,
      resourcesPath: '/whatever/Resources',
      platform: 'darwin',
      arch: 'arm64',
      existsSync: () => true,
    });
    expect(result).toBeUndefined();
  });

  it('returns the asar.unpacked path for the running arch when packaged (arm64)', () => {
    const result = resolveClaudeExecutablePath({
      isPackaged: true,
      resourcesPath: '/App.app/Contents/Resources',
      platform: 'darwin',
      arch: 'arm64',
      existsSync: () => true,
    });
    expect(result).toBe(
      path.join(
        '/App.app/Contents/Resources',
        'app.asar.unpacked',
        'node_modules',
        '@anthropic-ai',
        'claude-agent-sdk-darwin-arm64',
        'claude',
      ),
    );
  });

  it('uses the x64 package name when running under an x64 (Rosetta) build', () => {
    const result = resolveClaudeExecutablePath({
      isPackaged: true,
      resourcesPath: '/App.app/Contents/Resources',
      platform: 'darwin',
      arch: 'x64',
      existsSync: () => true,
    });
    expect(result).toContain('claude-agent-sdk-darwin-x64');
    expect(result).not.toContain('app.asar/'); // must be the unpacked copy, not asar-internal
  });

  it('appends .exe on win32', () => {
    const result = resolveClaudeExecutablePath({
      isPackaged: true,
      resourcesPath: 'C:/App/resources',
      platform: 'win32',
      arch: 'x64',
      existsSync: () => true,
    });
    expect(result).toContain('claude-agent-sdk-win32-x64');
    expect(result?.endsWith('claude.exe')).toBe(true);
  });

  it('returns undefined when the unpacked binary is missing (let the SDK resolve)', () => {
    const result = resolveClaudeExecutablePath({
      isPackaged: true,
      resourcesPath: '/App.app/Contents/Resources',
      platform: 'darwin',
      arch: 'arm64',
      existsSync: () => false,
    });
    expect(result).toBeUndefined();
  });

  it('probes exactly the resources-relative unpacked path', () => {
    const probed: string[] = [];
    resolveClaudeExecutablePath({
      isPackaged: true,
      resourcesPath: '/R',
      platform: 'darwin',
      arch: 'arm64',
      existsSync: (p) => {
        probed.push(p);
        return true;
      },
    });
    expect(probed).toEqual([
      path.join('/R', 'app.asar.unpacked', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-darwin-arm64', 'claude'),
    ]);
  });
});
