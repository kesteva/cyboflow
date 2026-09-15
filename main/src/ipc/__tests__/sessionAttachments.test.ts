/**
 * Behavioral tests for the sessions:save-images IPC handler (GitHub #18 —
 * composer-attachment IPC hardening, main/src/ipc/session.ts).
 *
 * Before the fix, `assertAttachmentOwner` returned early for ANY ownerId
 * starting with `pending_`, and that id then flowed unsanitized into
 * `getCyboflowSubdirectory('artifacts', ownerId)` — a bare path.join — so an
 * id like `pending_/../../../escape` escaped CYBOFLOW_DIR entirely. Covered
 * here:
 *  - a malformed pending-shaped ownerId is REJECTED (falls through to the
 *    session/run lookups instead of short-circuiting) and writes nothing
 *    outside the temp CYBOFLOW_DIR.
 *  - a legitimately-shaped pending owner resolves and the file lands inside
 *    <tmp>/artifacts/pending_<id>/.
 *  - the extension is derived from the original filename when present.
 *  - a hostile mime type never leaks '/' into the saved extension.
 *
 * Follows the sessionDelete.test.ts harness: electron/panelManager/database/
 * telemetry/questionRouter/approvalRouter are module-mocked so
 * registerSessionHandlers can be imported and its ipcMain.handle
 * registrations captured directly, without a real Electron runtime. Real fs
 * under an os.tmpdir() CYBOFLOW_DIR (via setCyboflowDirectory), matching the
 * ideaAttachments.test.ts pattern — the assertions are about real on-disk
 * containment, so no fs mock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import { existsSync, readdirSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/mock/path'),
    getName: vi.fn(() => 'Cyboflow'),
    getVersion: vi.fn(() => '0.1.0'),
  },
}));

vi.mock('../../services/panelManager', () => ({
  panelManager: {
    getPanel: vi.fn(),
    getAllPanels: vi.fn(() => []),
    getPanelsForSession: vi.fn(() => []),
  },
}));

vi.mock('../../services/database', () => ({
  databaseService: { getSession: vi.fn(() => undefined) },
}));

// session.ts imports telemetry; keep this IPC harness independent of Sentry's
// Electron runtime module (expects Electron's native exports under host Node).
vi.mock('../../services/telemetry', () => ({
  trackUsage: vi.fn(),
}));

vi.mock('../../orchestrator/questionRouter', () => ({
  QuestionRouter: { getInstance: vi.fn(() => ({ clearPendingForRun: vi.fn() })) },
}));

vi.mock('../../orchestrator/approvalRouter', () => ({
  ApprovalRouter: { getInstance: vi.fn(() => ({ clearPendingForRun: vi.fn() })) },
}));

import { registerSessionHandlers } from '../session';
import { setCyboflowDirectory, getCyboflowSubdirectory } from '../../utils/cyboflowDirectory';
import type { AppServices } from '../types';

type Handler = (...args: unknown[]) => Promise<unknown>;

function makeHandlerCapture() {
  const handlers = new Map<string, Handler>();
  const ipcMain = { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) };
  return { ipcMain, handlers };
}

function invoke(handlers: Map<string, Handler>, channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler for channel: ${channel}`);
  return fn({} as unknown, ...args);
}

// 1x1 transparent PNG payload — arbitrary bytes are fine, only round-trip matters.
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMEAYHwPzYAAAAASUVORK5CYII=';

let tmpRoot: string;

function makeServices(): AppServices {
  return {
    sessionManager: { getSession: vi.fn(async () => undefined) },
    cyboflow: { workflowRegistry: { getRunById: vi.fn(() => undefined) } },
  } as unknown as AppServices;
}

function register() {
  const { ipcMain, handlers } = makeHandlerCapture();
  registerSessionHandlers(ipcMain as unknown as Parameters<typeof registerSessionHandlers>[0], makeServices());
  return handlers;
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cyboflow-session-attachments-'));
  setCyboflowDirectory(tmpRoot);
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

describe('sessions:save-images — ownerId containment', () => {
  it('rejects a malformed pending-shaped ownerId and writes nothing outside CYBOFLOW_DIR', async () => {
    const handlers = register();

    await expect(
      invoke(handlers, 'sessions:save-images', 'pending_/../../../escape', [
        { name: 'shot.png', dataUrl: PNG_DATA_URL, type: 'image/png' },
      ]),
    ).rejects.toThrow(/Attachment owner not found/);

    // Nothing escaped the temp CYBOFLOW_DIR: only whatever the artifacts root
    // itself contains (nothing, since the handler threw before creating it).
    const artifactsRoot = getCyboflowSubdirectory('artifacts');
    expect(existsSync(artifactsRoot)).toBe(false);
    // And nothing was written anywhere above/outside tmpRoot either.
    const entriesAboveTmp = readdirSync(path.dirname(tmpRoot));
    expect(entriesAboveTmp).not.toContain('escape');
  });

  it('resolves for a legitimately-shaped pending owner, saving inside artifacts/<ownerId>/ as .png', async () => {
    const handlers = register();

    const saved = (await invoke(handlers, 'sessions:save-images', 'pending_abc123', [
      { name: 'shot.png', dataUrl: PNG_DATA_URL, type: 'image/png' },
    ])) as string[];

    expect(saved).toHaveLength(1);
    const expectedDir = path.resolve(getCyboflowSubdirectory('artifacts', 'pending_abc123'));
    expect(path.resolve(saved[0])).toContain(expectedDir);
    expect(saved[0].endsWith('.png')).toBe(true);
    expect(existsSync(saved[0])).toBe(true);
  });

  it('preserves the original filename extension (.svg) for an svg+xml image', async () => {
    const handlers = register();

    const saved = (await invoke(handlers, 'sessions:save-images', 'pending_abc123', [
      { name: 'diagram.svg', dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+', type: 'image/svg+xml' },
    ])) as string[];

    expect(saved).toHaveLength(1);
    expect(saved[0].endsWith('.svg')).toBe(true);
    expect(existsSync(saved[0])).toBe(true);
  });

  it('sanitizes a hostile mime type / empty filename into an alnum-only extension', async () => {
    const handlers = register();

    const saved = (await invoke(handlers, 'sessions:save-images', 'pending_abc123', [
      { name: '', dataUrl: PNG_DATA_URL, type: 'image/../../x' },
    ])) as string[];

    expect(saved).toHaveLength(1);
    const basename = path.basename(saved[0]);
    expect(basename).not.toContain('/');
    const ext = basename.split('.').pop() ?? '';
    expect(/^[a-zA-Z0-9]+$/.test(ext)).toBe(true);
  });
});
