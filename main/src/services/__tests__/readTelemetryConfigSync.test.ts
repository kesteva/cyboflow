/**
 * readTelemetryConfigSync() coverage — the synchronous telemetry-flag reader the
 * boot seam calls BEFORE app 'ready' (the Aptabase SDK disables itself if
 * initialized post-ready, earlier than the async ConfigManager.initialize() can
 * run; see services/telemetry/index.ts + index.ts).
 *
 * Contract proven here:
 *   - No config.json on disk → build-aware defaults (in the test env `app` has no
 *     isPackaged, so the default is OFF for both flags).
 *   - A telemetry block on disk is honored verbatim (both true / mixed).
 *   - A config.json with NO telemetry block falls back to the default.
 *   - A partial telemetry block defaults only the missing flags.
 *   - installId round-trips ('' when unminted).
 *
 * Hermetic: setCyboflowDirectory() points the reader at a unique temp dir, so the
 * real ~/.cyboflow[_dev] config is never read.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { readTelemetryConfigSync } from '../configManager';
import { setCyboflowDirectory } from '../../utils/cyboflowDirectory';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cyboflow-telemetry-sync-test-'));
  setCyboflowDirectory(tempDir);
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function writeConfig(obj: unknown): Promise<void> {
  await fs.writeFile(path.join(tempDir, 'config.json'), JSON.stringify(obj, null, 2));
}

describe('readTelemetryConfigSync', () => {
  it('returns the build-aware default (OFF in test env) when no config.json exists', () => {
    const t = readTelemetryConfigSync();
    expect(t).toEqual({ errorReportingEnabled: false, usageMetricsEnabled: false, installId: '' });
  });

  it('honors a fully-specified telemetry block verbatim', async () => {
    await writeConfig({
      telemetry: { errorReportingEnabled: true, usageMetricsEnabled: true, installId: 'abc-123' },
    });
    expect(readTelemetryConfigSync()).toEqual({
      errorReportingEnabled: true,
      usageMetricsEnabled: true,
      installId: 'abc-123',
    });
  });

  it('honors a mixed telemetry block (one flag on, one off)', async () => {
    await writeConfig({
      telemetry: { errorReportingEnabled: false, usageMetricsEnabled: true, installId: 'x' },
    });
    const t = readTelemetryConfigSync();
    expect(t.errorReportingEnabled).toBe(false);
    expect(t.usageMetricsEnabled).toBe(true);
    expect(t.installId).toBe('x');
  });

  it('falls back to the default when config.json has no telemetry block', async () => {
    await writeConfig({ gitRepoPath: '/some/repo', defaultModel: 'sonnet' });
    expect(readTelemetryConfigSync()).toEqual({
      errorReportingEnabled: false,
      usageMetricsEnabled: false,
      installId: '',
    });
  });

  it('defaults only the flags missing from a partial telemetry block', async () => {
    // usageMetricsEnabled present (true); errorReportingEnabled absent → default (false).
    await writeConfig({ telemetry: { usageMetricsEnabled: true } });
    const t = readTelemetryConfigSync();
    expect(t.usageMetricsEnabled).toBe(true);
    expect(t.errorReportingEnabled).toBe(false);
    expect(t.installId).toBe('');
  });

  it('falls back to the default on a corrupt (unparseable) config.json', async () => {
    await fs.writeFile(path.join(tempDir, 'config.json'), '{ this is not json');
    expect(readTelemetryConfigSync()).toEqual({
      errorReportingEnabled: false,
      usageMetricsEnabled: false,
      installId: '',
    });
  });
});
