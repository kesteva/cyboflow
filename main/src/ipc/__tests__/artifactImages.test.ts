/**
 * Unit tests for registerArtifactImageHandlers (main/src/ipc/artifactImages.ts) —
 * the FU4 screenshots gallery display half (artifacts:load-images).
 *
 * Covers:
 *   - serves base64 data URLs for PNGs that exist under the run's image root,
 *   - REJECTS a traversal fileName ("../../etc/passwd") via the containment guard
 *     (skipped, not fatal — the batch still succeeds),
 *   - fail-soft: a missing file is skipped, the rest still resolve.
 *
 * cyboflowDirectory is mocked to a per-test tmp dir so the handler reads real
 * bytes off disk without depending on Electron's app paths.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { mkdtempSync, rmSync } from 'fs';
import type { AppServices } from '../types';

// Point getCyboflowSubdirectory at a tmp dir; the handler joins
// (CYBOFLOW_DIR, 'artifacts', 'runs', runId) — mirror that here.
let tmpRoot = '';
vi.mock('../../utils/cyboflowDirectory', () => ({
  getCyboflowSubdirectory: (...sub: string[]) => path.join(tmpRoot, ...sub),
}));

import { registerArtifactImageHandlers } from '../artifactImages';

// ---------------------------------------------------------------------------
// Helpers (mirror cyboflow.test.ts capture pattern)
// ---------------------------------------------------------------------------

function makeHandlerCapture() {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const ipcMain = {
    handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, fn);
    },
  };
  return { ipcMain, handlers };
}

async function invoke(
  handlers: Map<string, (...args: unknown[]) => Promise<unknown>>,
  channel: string,
  args: unknown,
): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for channel: ${channel}`);
  return fn({} as unknown, args);
}

function makeServices(): AppServices {
  return {} as unknown as AppServices;
}

interface LoadImagesResult {
  success: boolean;
  data?: { images: Array<{ fileName: string; dataUrl: string }> };
  error?: string;
}

const RUN_ID = 'run-fu4';

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'cyboflow-artifact-images-'));
});

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe('registerArtifactImageHandlers — artifacts:load-images', () => {
  it('registers the channel', () => {
    const { ipcMain, handlers } = makeHandlerCapture();
    registerArtifactImageHandlers(
      ipcMain as unknown as Parameters<typeof registerArtifactImageHandlers>[0],
      makeServices(),
    );
    expect(handlers.has('artifacts:load-images')).toBe(true);
  });

  it('returns base64 data URLs for files in the run image root', async () => {
    const runDir = path.join(tmpRoot, 'artifacts', 'runs', RUN_ID);
    await fs.mkdir(runDir, { recursive: true });
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await fs.writeFile(path.join(runDir, 'home.png'), pngBytes);
    await fs.writeFile(path.join(runDir, 'detail.jpg'), Buffer.from([0xff, 0xd8, 0xff]));

    const { ipcMain, handlers } = makeHandlerCapture();
    registerArtifactImageHandlers(
      ipcMain as unknown as Parameters<typeof registerArtifactImageHandlers>[0],
      makeServices(),
    );

    const res = (await invoke(handlers, 'artifacts:load-images', {
      runId: RUN_ID,
      fileNames: ['home.png', 'detail.jpg'],
    })) as LoadImagesResult;

    expect(res.success).toBe(true);
    const images = res.data?.images ?? [];
    expect(images).toHaveLength(2);

    const home = images.find((i) => i.fileName === 'home.png');
    expect(home?.dataUrl).toBe(`data:image/png;base64,${pngBytes.toString('base64')}`);

    // .jpg maps to the image/jpeg mime (codec parity with ideaAttachments).
    const detail = images.find((i) => i.fileName === 'detail.jpg');
    expect(detail?.dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  it('REJECTS a traversal fileName (../../etc/passwd) and skips it, not fatal', async () => {
    const runDir = path.join(tmpRoot, 'artifacts', 'runs', RUN_ID);
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, 'ok.png'), Buffer.from([0x89, 0x50]));

    // Plant a readable file OUTSIDE the run root that the traversal would target.
    const outside = path.join(tmpRoot, 'secret.png');
    await fs.writeFile(outside, Buffer.from([0x01, 0x02, 0x03]));

    const { ipcMain, handlers } = makeHandlerCapture();
    registerArtifactImageHandlers(
      ipcMain as unknown as Parameters<typeof registerArtifactImageHandlers>[0],
      makeServices(),
    );

    const res = (await invoke(handlers, 'artifacts:load-images', {
      runId: RUN_ID,
      fileNames: ['../../secret.png', '../secret.png', 'ok.png'],
    })) as LoadImagesResult;

    // Batch succeeds; only the in-root file resolves, traversal paths are dropped.
    expect(res.success).toBe(true);
    const images = res.data?.images ?? [];
    expect(images).toHaveLength(1);
    expect(images[0].fileName).toBe('ok.png');
    expect(images.some((i) => i.fileName.includes('secret'))).toBe(false);
  });

  it('fail-soft: a missing file is skipped, the rest still resolve', async () => {
    const runDir = path.join(tmpRoot, 'artifacts', 'runs', RUN_ID);
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, 'present.png'), Buffer.from([0x89, 0x50]));

    const { ipcMain, handlers } = makeHandlerCapture();
    registerArtifactImageHandlers(
      ipcMain as unknown as Parameters<typeof registerArtifactImageHandlers>[0],
      makeServices(),
    );

    const res = (await invoke(handlers, 'artifacts:load-images', {
      runId: RUN_ID,
      fileNames: ['missing.png', 'present.png'],
    })) as LoadImagesResult;

    expect(res.success).toBe(true);
    const images = res.data?.images ?? [];
    expect(images).toHaveLength(1);
    expect(images[0].fileName).toBe('present.png');
  });

  it('returns an empty image list for empty input', async () => {
    const { ipcMain, handlers } = makeHandlerCapture();
    registerArtifactImageHandlers(
      ipcMain as unknown as Parameters<typeof registerArtifactImageHandlers>[0],
      makeServices(),
    );

    const res = (await invoke(handlers, 'artifacts:load-images', {
      runId: RUN_ID,
      fileNames: [],
    })) as LoadImagesResult;

    expect(res.success).toBe(true);
    expect(res.data?.images).toEqual([]);
  });
});
