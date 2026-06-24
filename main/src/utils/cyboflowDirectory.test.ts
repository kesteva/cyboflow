import { describe, it, expect, vi, beforeEach } from 'vitest';
import { app } from 'electron';
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

// Toggle the mocked app.isPackaged per-test to exercise both branches.
function setPackaged(value: boolean): void {
  (app as unknown as { isPackaged: boolean }).isPackaged = value;
}

describe('cyboflowDirectory', () => {
  beforeEach(() => {
    // Reset the custom directory by reimporting (module-level state)
    vi.resetModules();
    delete process.env.CYBOFLOW_DIR;
    setPackaged(false);
  });

  it('getCyboflowDirectory() returns the production dir ~/.cyboflow for packaged builds (stable + dev DMGs share it)', async () => {
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

  it('getCyboflowSubdirectory() appends subpaths to the cyboflow directory', async () => {
    const { getCyboflowSubdirectory } = await import('./cyboflowDirectory');
    const socketsDir = getCyboflowSubdirectory('sockets');
    expect(socketsDir).toContain('.cyboflow');
    expect(socketsDir).toMatch(/sockets$/);
  });
});
