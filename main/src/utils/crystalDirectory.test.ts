import { describe, it, expect, vi, beforeEach } from 'vitest';
import { homedir } from 'os';
import { join } from 'path';

// Mock electron before importing the module under test
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/mock/path'),
    getName: vi.fn(() => 'Cyboflow'),
    getVersion: vi.fn(() => '0.1.0'),
  },
}));

describe('crystalDirectory', () => {
  beforeEach(() => {
    // Reset the custom directory by reimporting (module-level state)
    vi.resetModules();
    delete process.env.CYBOFLOW_DIR;
  });

  it('getCrystalDirectory() returns a path ending in .cyboflow when no override is set', async () => {
    const { getCrystalDirectory } = await import('./crystalDirectory');
    const dir = getCrystalDirectory();
    expect(dir).toBe(join(homedir(), '.cyboflow'));
  });

  it('getCrystalDirectory() respects CYBOFLOW_DIR environment variable', async () => {
    process.env.CYBOFLOW_DIR = '/custom/cyboflow/path';
    const { getCrystalDirectory } = await import('./crystalDirectory');
    const dir = getCrystalDirectory();
    expect(dir).toBe('/custom/cyboflow/path');
    delete process.env.CYBOFLOW_DIR;
  });

  it('getCrystalDirectory() does NOT read CRYSTAL_DIR', async () => {
    process.env.CRYSTAL_DIR = '/legacy/crystal/path';
    const { getCrystalDirectory } = await import('./crystalDirectory');
    const dir = getCrystalDirectory();
    // Should default to .cyboflow, not .crystal
    expect(dir).toBe(join(homedir(), '.cyboflow'));
    delete process.env.CRYSTAL_DIR;
  });

  it('getCrystalDirectory() respects programmatic override via setCrystalDirectory', async () => {
    const { getCrystalDirectory, setCrystalDirectory } = await import('./crystalDirectory');
    setCrystalDirectory('/programmatic/override');
    const dir = getCrystalDirectory();
    expect(dir).toBe('/programmatic/override');
  });

  it('getCrystalSubdirectory() appends subpaths to the crystal directory', async () => {
    const { getCrystalSubdirectory } = await import('./crystalDirectory');
    const socketsDir = getCrystalSubdirectory('sockets');
    expect(socketsDir).toContain('.cyboflow');
    expect(socketsDir).toMatch(/sockets$/);
  });
});
