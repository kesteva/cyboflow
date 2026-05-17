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

describe('cyboflowDirectory', () => {
  beforeEach(() => {
    // Reset the custom directory by reimporting (module-level state)
    vi.resetModules();
    delete process.env.CYBOFLOW_DIR;
  });

  it('getCyboflowDirectory() returns a path ending in .cyboflow when no override is set', async () => {
    const { getCyboflowDirectory } = await import('./cyboflowDirectory');
    const dir = getCyboflowDirectory();
    expect(dir).toBe(join(homedir(), '.cyboflow'));
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
    const { getCyboflowDirectory } = await import('./cyboflowDirectory');
    const dir = getCyboflowDirectory();
    // Should default to .cyboflow, not .crystal
    expect(dir).toBe(join(homedir(), '.cyboflow'));
    delete process.env.CRYSTAL_DIR;
  });

  it('getCyboflowDirectory() respects programmatic override via setCyboflowDirectory', async () => {
    const { getCyboflowDirectory, setCyboflowDirectory } = await import('./cyboflowDirectory');
    setCyboflowDirectory('/programmatic/override');
    const dir = getCyboflowDirectory();
    expect(dir).toBe('/programmatic/override');
  });

  it('getCyboflowSubdirectory() appends subpaths to the cyboflow directory', async () => {
    const { getCyboflowSubdirectory } = await import('./cyboflowDirectory');
    const socketsDir = getCyboflowSubdirectory('sockets');
    expect(socketsDir).toContain('.cyboflow');
    expect(socketsDir).toMatch(/sockets$/);
  });
});
