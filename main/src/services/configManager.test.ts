import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron before importing modules that depend on it
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/mock/path'),
    getName: vi.fn(() => 'Cyboflow'),
    getVersion: vi.fn(() => '0.1.0'),
  },
}));

// Mock the cyboflow directory utility to avoid real fs reads
vi.mock('../utils/cyboflowDirectory', () => ({
  getCyboflowDirectory: vi.fn(() => '/mock/cyboflow'),
}));

// Mock shellPath to avoid subprocess calls
vi.mock('../utils/shellPath', () => ({
  clearShellPathCache: vi.fn(),
}));

// Mock fs/promises with an in-memory file store
const mockFiles: Record<string, string> = {};
vi.mock('fs/promises', () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn(async (filePath: string) => {
      if (filePath in mockFiles) return mockFiles[filePath];
      const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      throw err;
    }),
    writeFile: vi.fn(async (filePath: string, data: string) => {
      mockFiles[filePath] = data;
    }),
  },
}));

// Defer the import so the mocks above are in place first
let ConfigManager: typeof import('./configManager').ConfigManager;

describe('ConfigManager migration: enableCrystalFooter → enableCyboflowFooter', () => {
  const CONFIG_PATH = '/mock/cyboflow/config.json';

  beforeEach(async () => {
    vi.resetModules();
    // Reset the in-memory store between tests
    for (const key of Object.keys(mockFiles)) delete mockFiles[key];
    // Re-import after resetModules so module-level state is fresh
    ({ ConfigManager } = await import('./configManager'));
  });

  it('Case A: legacy-only — copies value to enableCyboflowFooter, deletes legacy key, and saves', async () => {
    // Pre-populate config.json with legacy key only
    mockFiles[CONFIG_PATH] = JSON.stringify({
      gitRepoPath: '/some/repo',
      enableCrystalFooter: false,
    });

    const mgr = new ConfigManager();
    await mgr.initialize();

    const config = mgr.getConfig();

    // New key must carry the migrated value
    expect(config.enableCyboflowFooter).toBe(false);

    // Legacy key must be gone from in-memory config
    expect('enableCrystalFooter' in config).toBe(false);

    // The saved file must not contain the legacy key
    const saved = JSON.parse(mockFiles[CONFIG_PATH]);
    expect(saved.enableCyboflowFooter).toBe(false);
    expect('enableCrystalFooter' in saved).toBe(false);
  });

  it('Case B: both keys — new key wins, legacy key is deleted on save', async () => {
    // Pre-populate with both keys: new key set to false, legacy set to true
    mockFiles[CONFIG_PATH] = JSON.stringify({
      gitRepoPath: '/some/repo',
      enableCyboflowFooter: false,
      enableCrystalFooter: true,
    });

    const mgr = new ConfigManager();
    await mgr.initialize();

    const config = mgr.getConfig();

    // New key wins (false), not the legacy value (true)
    expect(config.enableCyboflowFooter).toBe(false);

    // Legacy key must be gone from in-memory config
    expect('enableCrystalFooter' in config).toBe(false);

    // The saved file must reflect the same
    const saved = JSON.parse(mockFiles[CONFIG_PATH]);
    expect(saved.enableCyboflowFooter).toBe(false);
    expect('enableCrystalFooter' in saved).toBe(false);
  });

  it('Case C: neither key — no migration write, enableCyboflowFooter stays undefined', async () => {
    // Pre-populate with no footer keys at all
    const initialJson = JSON.stringify({ gitRepoPath: '/some/repo' });
    mockFiles[CONFIG_PATH] = initialJson;

    const mgr = new ConfigManager();

    // Spy on saveConfig via writeFile call count before initialize
    const { default: fsMock } = await import('fs/promises');
    const writeFileSpy = vi.mocked(fsMock.writeFile);
    const callCountBefore = writeFileSpy.mock.calls.length;

    await mgr.initialize();

    const config = mgr.getConfig();

    // Neither key was in the file, so enableCyboflowFooter stays undefined
    expect(config.enableCyboflowFooter).toBeUndefined();

    // No extra save triggered by the migration block (write count unchanged after initialize)
    const callCountAfter = writeFileSpy.mock.calls.length;
    expect(callCountAfter).toBe(callCountBefore);
  });
});
