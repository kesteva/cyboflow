/**
 * Unit tests for verifyConfigLoader — the SOLE reader of a project's
 * `.cyboflow/verify.json` (see docs/proposals/visual-verification-design.md §"Config homes").
 *
 * The loader's whole job is its fail-soft contract: absent file => null;
 * malformed JSON => logger.warn + null; valid JSON => parsed VerifyConfigFile.
 * Tests use a real temp dir (the loader reads from disk via node:fs/promises) and
 * a vitest-spy logger to assert the warn path without coupling to a concrete
 * logger. No electron / DB / runtime is touched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { loadVerifyConfig, VERIFY_CONFIG_RELATIVE_PATH } from '../verifyConfigLoader';
import type { LoggerLike } from '../types';
import type { VerifyConfigFile } from '../../../../shared/types/visualVerification';

function makeLogger(): LoggerLike {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/** Write `<projectPath>/.cyboflow/verify.json` with the given raw text. */
async function writeVerifyJson(projectPath: string, raw: string): Promise<void> {
  const dir = join(projectPath, '.cyboflow');
  await mkdir(dir, { recursive: true });
  await writeFile(join(projectPath, VERIFY_CONFIG_RELATIVE_PATH), raw, 'utf-8');
}

describe('loadVerifyConfig', () => {
  let projectPath: string;

  beforeEach(async () => {
    projectPath = await mkdtemp(join(tmpdir(), 'cyboflow-verify-'));
  });

  afterEach(async () => {
    await rm(projectPath, { recursive: true, force: true });
  });

  it('returns null when the file is absent (ENOENT is not fatal)', async () => {
    const logger = makeLogger();
    expect(await loadVerifyConfig(projectPath, logger)).toBeNull();
    // Absent is the expected common case — it must NOT warn.
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns null without throwing when no logger is supplied and the file is absent', async () => {
    expect(await loadVerifyConfig(projectPath)).toBeNull();
  });

  it('parses a valid JSON document into a VerifyConfigFile', async () => {
    const config: VerifyConfigFile = {
      enabled: true,
      defaultType: 'interactive-web-behavior',
    };
    await writeVerifyJson(projectPath, JSON.stringify(config));

    const logger = makeLogger();
    const loaded = await loadVerifyConfig(projectPath, logger);
    expect(loaded).toEqual(config);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('tolerates a legacy `deliverables` list (written for the removed capture engine) without failing the read', async () => {
    await writeVerifyJson(
      projectPath,
      JSON.stringify({
        enabled: false,
        defaultType: 'responsive-multi-viewport',
        deliverables: [{ id: 'a' }, { id: 'b', url: 'http://x' }],
      }),
    );
    const loaded = await loadVerifyConfig(projectPath);
    expect(loaded?.enabled).toBe(false);
    expect(loaded?.defaultType).toBe('responsive-multi-viewport');
  });

  it('accepts an empty {} document (every member optional)', async () => {
    await writeVerifyJson(projectPath, '{}');
    expect(await loadVerifyConfig(projectPath)).toEqual({});
  });

  it('returns null + warns on malformed JSON (never throws)', async () => {
    await writeVerifyJson(projectPath, '{ "enabled": true, ');
    const logger = makeLogger();
    const loaded = await loadVerifyConfig(projectPath, logger);
    expect(loaded).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [msg, ctx] = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(msg)).toMatch(/malformed JSON/i);
    // The constant is authored with forward slashes; the logged configPath uses
    // the platform's native separators (path.join of the same components).
    expect(ctx).toMatchObject({
      configPath: expect.stringContaining(VERIFY_CONFIG_RELATIVE_PATH.split('/').join(sep)),
    });
  });

  it('returns null on malformed JSON even with no logger (silent fail-soft)', async () => {
    await writeVerifyJson(projectPath, 'not json at all');
    expect(await loadVerifyConfig(projectPath)).toBeNull();
  });
});
