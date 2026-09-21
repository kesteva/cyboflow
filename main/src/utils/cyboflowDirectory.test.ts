import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { app } from 'electron';
import { homedir } from 'os';
import { join } from 'path';
import * as fs from 'fs';

// Mock electron before importing the module under test
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/mock/path'),
    getName: vi.fn(() => 'Cyboflow'),
    getVersion: vi.fn(() => '0.1.0'),
  },
}));

// Partial-mock fs so the packaged-variant probe (existsSync/readFileSync of
// buildInfo.json) is controllable per-test; everything else stays real.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    readFileSync: vi.fn(actual.readFileSync),
  };
});

// Toggle the mocked app.isPackaged per-test to exercise both branches.
function setPackaged(value: boolean): void {
  (app as unknown as { isPackaged: boolean }).isPackaged = value;
}

// Point the variant probe at a fake buildInfo.json carrying the given variant.
function stubBuildInfoVariant(variant: 'stable' | 'dev'): void {
  (process as unknown as { resourcesPath: string }).resourcesPath = '/mock/resources';
  vi.mocked(fs.existsSync).mockImplementation(
    (p) => typeof p === 'string' && p.includes('buildInfo.json'),
  );
  vi.mocked(fs.readFileSync).mockImplementation((p) => {
    if (typeof p === 'string' && p.includes('buildInfo.json')) {
      return JSON.stringify({ variant });
    }
    throw new Error(`unexpected readFileSync: ${String(p)}`);
  });
}

describe('cyboflowDirectory', () => {
  beforeEach(() => {
    // Reset the custom directory by reimporting (module-level state)
    vi.resetModules();
    vi.mocked(fs.existsSync).mockReset();
    vi.mocked(fs.readFileSync).mockReset();
    delete process.env.CYBOFLOW_DIR;
    delete (process as unknown as { resourcesPath?: string }).resourcesPath;
    setPackaged(false);
  });

  it('getCyboflowDirectory() returns the production dir ~/.cyboflow for the packaged STABLE variant', async () => {
    setPackaged(true);
    stubBuildInfoVariant('stable');
    const { getCyboflowDirectory } = await import('./cyboflowDirectory');
    const dir = getCyboflowDirectory();
    expect(dir).toBe(join(homedir(), '.cyboflow'));
  });

  it('getCyboflowDirectory() returns ~/.cyboflow_dev_dmg for the packaged DEV DMG variant', async () => {
    setPackaged(true);
    stubBuildInfoVariant('dev');
    const { getCyboflowDirectory } = await import('./cyboflowDirectory');
    const dir = getCyboflowDirectory();
    expect(dir).toBe(join(homedir(), '.cyboflow_dev_dmg'));
  });

  it('getCyboflowDirectory() falls back to ~/.cyboflow when buildInfo is unreadable (no resourcesPath)', async () => {
    // resourcesPath left undefined (as in a unit-test / pre-fix artifact) → stable.
    setPackaged(true);
    const { getCyboflowDirectory } = await import('./cyboflowDirectory');
    const dir = getCyboflowDirectory();
    expect(dir).toBe(join(homedir(), '.cyboflow'));
  });

  it('getCyboflowDirectory() returns the isolated dir ~/.cyboflow_dev for the dev server (not packaged)', async () => {
    setPackaged(false);
    const { getCyboflowDirectory } = await import('./cyboflowDirectory');
    const dir = getCyboflowDirectory();
    expect(dir).toBe(join(homedir(), '.cyboflow_dev'));
  });

  it('appIconBasename() picks the blue dev icon for the packaged DEV variant', async () => {
    setPackaged(true);
    stubBuildInfoVariant('dev');
    const { appIconBasename } = await import('./cyboflowDirectory');
    expect(appIconBasename()).toBe('icon-dev.png');
  });

  it('appIconBasename() keeps the stable icon for the packaged STABLE variant', async () => {
    setPackaged(true);
    stubBuildInfoVariant('stable');
    const { appIconBasename } = await import('./cyboflowDirectory');
    expect(appIconBasename()).toBe('icon.png');
  });

  it('appIconBasename() keeps the stable icon for the dev SERVER (not packaged) — the variant probe is meaningless there', async () => {
    setPackaged(false);
    // Even a stray dev buildInfo must not flip an unpackaged app's icon.
    stubBuildInfoVariant('dev');
    const { appIconBasename } = await import('./cyboflowDirectory');
    expect(appIconBasename()).toBe('icon.png');
  });

  it('getCyboflowDirectory() respects CYBOFLOW_DIR environment variable', async () => {
    process.env.CYBOFLOW_DIR = '/custom/cyboflow/path';
    const { getCyboflowDirectory } = await import('./cyboflowDirectory');
    const dir = getCyboflowDirectory();
    expect(dir).toBe('/custom/cyboflow/path');
    delete process.env.CYBOFLOW_DIR;
  });

  it('getCyboflowDirectory() does NOT read CRYSTAL_DIR', async () => {
    process.env.CRYSTAL_DIR = '/legacy/crystal/path';
    setPackaged(true);
    stubBuildInfoVariant('stable');
    const { getCyboflowDirectory } = await import('./cyboflowDirectory');
    const dir = getCyboflowDirectory();
    // Should resolve to the production .cyboflow dir, not the legacy .crystal path
    expect(dir).toBe(join(homedir(), '.cyboflow'));
    delete process.env.CRYSTAL_DIR;
  });

  it('getCyboflowDirectory() respects programmatic override via setCyboflowDirectory', async () => {
    const { getCyboflowDirectory, setCyboflowDirectory } = await import('./cyboflowDirectory');
    setCyboflowDirectory('/programmatic/override');
    const dir = getCyboflowDirectory();
    expect(dir).toBe('/programmatic/override');
  });

  describe('--cyboflow-dir CLI flag (import-order-independent)', () => {
    let originalArgv: string[];

    beforeEach(() => {
      originalArgv = process.argv;
    });

    afterEach(() => {
      process.argv = originalArgv;
    });

    it('resolves the flag on first call, before index.ts arg parsing runs (space form)', async () => {
      process.argv = ['electron', '.', '--remote-debugging-port=9223', '--cyboflow-dir', '/flag/dir'];
      const { getCyboflowDirectory } = await import('./cyboflowDirectory');
      // No setCyboflowDirectory call — simulates an import-time consumer like
      // the services/database.ts singleton, which runs before index.ts's body.
      expect(getCyboflowDirectory()).toBe('/flag/dir');
    });

    it('supports the = form and the deprecated --crystal-dir alias, last occurrence winning', async () => {
      process.argv = ['electron', '.', '--crystal-dir=/legacy/dir', '--cyboflow-dir=/newer/dir'];
      const { getCyboflowDirectory } = await import('./cyboflowDirectory');
      expect(getCyboflowDirectory()).toBe('/newer/dir');
    });

    it('CLI flag takes precedence over CYBOFLOW_DIR env', async () => {
      process.argv = ['electron', '.', '--cyboflow-dir', '/flag/dir'];
      process.env.CYBOFLOW_DIR = '/env/dir';
      const { getCyboflowDirectory } = await import('./cyboflowDirectory');
      expect(getCyboflowDirectory()).toBe('/flag/dir');
    });

    it('programmatic setCyboflowDirectory still takes precedence over the flag', async () => {
      process.argv = ['electron', '.', '--cyboflow-dir', '/flag/dir'];
      const { getCyboflowDirectory, setCyboflowDirectory } = await import('./cyboflowDirectory');
      setCyboflowDirectory('/programmatic/dir');
      expect(getCyboflowDirectory()).toBe('/programmatic/dir');
    });

    it('ignores a trailing valueless flag and an empty = value', async () => {
      process.argv = ['electron', '.', '--cyboflow-dir=', '--cyboflow-dir'];
      const { getCyboflowDirectory } = await import('./cyboflowDirectory');
      expect(getCyboflowDirectory()).toBe(join(homedir(), '.cyboflow_dev'));
    });
  });

  it('getCyboflowSubdirectory() appends subpaths to the cyboflow directory', async () => {
    const { getCyboflowSubdirectory } = await import('./cyboflowDirectory');
    const socketsDir = getCyboflowSubdirectory('sockets');
    expect(socketsDir).toContain('.cyboflow');
    expect(socketsDir).toMatch(/sockets$/);
  });
});
