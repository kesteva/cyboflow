/**
 * ConfigManager.getFanOutDispatch coverage — the global fan-out dispatch mode
 * for orchestrated INTERACTIVE runs ('prose' = today's agent-driven lanes,
 * 'workflow' = batched lane-major dispatch to installed dynamic-workflow scripts).
 *
 * Mirrors configManagerExecutionModel.test.ts. The contract that matters is the
 * DEFAULT: dispatch ships ON, so an absent key, an absent config.json, and a
 * bogus persisted value all read 'workflow'. 'prose' is reachable only as an
 * explicit, VALID opt-out — which is why the bogus-value case must land on the
 * default rather than falling back to the old behavior.
 *
 * Hermetic: each test points ConfigManager at a unique temp dir via
 * setCyboflowDirectory(), so the real ~/.cyboflow config is never touched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { ConfigManager } from '../configManager';
import { setCyboflowDirectory } from '../../utils/cyboflowDirectory';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cyboflow-fanoutdispatch-test-'));
  setCyboflowDirectory(tempDir);
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('ConfigManager.getFanOutDispatch', () => {
  it("defaults to 'workflow' on a fresh instance (before initialize)", () => {
    const mgr = new ConfigManager();
    expect(mgr.getFanOutDispatch()).toBe('workflow');
  });

  it('is NOT seeded into the constructor defaults (config.json stays byte-identical)', () => {
    const mgr = new ConfigManager();
    expect(mgr.getConfig().fanOutDispatch).toBeUndefined();
    expect(mgr.getFanOutDispatch()).toBe('workflow');
  });

  it("reads 'workflow' from a config.json with no fanOutDispatch key", async () => {
    await fs.writeFile(
      path.join(tempDir, 'config.json'),
      JSON.stringify({ gitRepoPath: '/some/repo' }, null, 2),
    );

    const mgr = new ConfigManager();
    await mgr.initialize();

    expect(mgr.getConfig().fanOutDispatch).toBeUndefined();
    expect(mgr.getFanOutDispatch()).toBe('workflow');
  });

  it("round-trips an explicit 'workflow' through a fresh initialize()", async () => {
    const mgr = new ConfigManager();
    await mgr.initialize();
    await mgr.updateConfig({ fanOutDispatch: 'workflow' });

    const reopened = new ConfigManager();
    await reopened.initialize();

    expect(reopened.getFanOutDispatch()).toBe('workflow');
  });

  it("floors a BOGUS persisted value to the default rather than trusting it", async () => {
    await fs.writeFile(
      path.join(tempDir, 'config.json'),
      JSON.stringify({ gitRepoPath: '/some/repo', fanOutDispatch: 'ultracode' }, null, 2),
    );

    const mgr = new ConfigManager();
    await mgr.initialize();

    expect(mgr.getFanOutDispatch()).toBe('workflow');
  });

  it("honors an explicit 'prose' opt-out", async () => {
    await fs.writeFile(
      path.join(tempDir, 'config.json'),
      JSON.stringify({ gitRepoPath: '/some/repo', fanOutDispatch: 'prose' }, null, 2),
    );

    const mgr = new ConfigManager();
    await mgr.initialize();

    expect(mgr.getFanOutDispatch()).toBe('prose');
  });
});
