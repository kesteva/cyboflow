/**
 * C6 boot smoke + IPC channel drift guard.
 *
 * Two complementary halves close the "silently drops an IPC channel" class
 * without a real Electron runtime:
 *
 *   A. RUNTIME registration smoke — call a representative self-contained
 *      register* module with a fake ipcMain and assert it invoked
 *      `ipcMain.handle` with exactly the channel names it owns. Proves the
 *      register-handler wiring actually fires (the C6 assertion).
 *
 *   B. STATIC full-surface drift guard — every channel the preload `invoke`s
 *      must have a matching `ipcMain.handle('<channel>')` somewhere under
 *      main/src. Registering ALL handlers at runtime is impractical (the full
 *      service graph is a 2066-line bootstrap), so this half parses the source —
 *      the AST/regex extraction the plan explicitly sanctions.
 *
 * The static half asserts the preload's invoked-channel surface is FULLY handled
 * (KNOWN_ORPHANS is empty). The three former orphans — file:list-project,
 * permission:respond, permission:getPending — were stale wiring for a dead
 * permission modal chain (the live approval flow is tRPC/canUseTool → the review
 * queue) and were removed from the preload + api.ts in the same change. The guard
 * fails the moment a NEW orphan appears.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Mock electron so importing the register module (which imports { dialog } etc.)
// does not touch a real Electron runtime.
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  app: { isPackaged: false, getPath: vi.fn(() => '/mock/path') },
}));

import { registerDialogHandlers } from '../dialog';
import type { AppServices } from '../types';

// ---------------------------------------------------------------------------
// A. Runtime registration smoke
// ---------------------------------------------------------------------------

function makeIpcMainCapture() {
  const channels: string[] = [];
  const ipcMain = {
    handle: vi.fn((channel: string) => {
      channels.push(channel);
    }),
  };
  return { ipcMain, channels };
}

describe('C6 — register* module fires ipcMain.handle with its channel set', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registerDialogHandlers registers exactly its two dialog channels', () => {
    const { ipcMain, channels } = makeIpcMainCapture();
    // registerDialogHandlers only needs getMainWindow from services.
    const services = { getMainWindow: () => null } as unknown as AppServices;

    registerDialogHandlers(
      ipcMain as unknown as Parameters<typeof registerDialogHandlers>[0],
      services,
    );

    expect(ipcMain.handle).toHaveBeenCalledTimes(2);
    expect(new Set(channels)).toEqual(
      new Set(['dialog:open-file', 'dialog:open-directory']),
    );
  });
});

// ---------------------------------------------------------------------------
// B. Static full-surface drift guard
// ---------------------------------------------------------------------------

// __dirname = main/src/ipc/__tests__ → ../../ = main/src.
const SRC_DIR = join(__dirname, '../../');

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      out.push(...walkTsFiles(p));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(p);
    }
  }
  return out;
}

/** All channel names passed to `ipcMain.handle(...)` across main/src. */
function collectHandledChannels(): Set<string> {
  const re = /ipcMain\.handle\(\s*[`'"]([^`'"]+)[`'"]/g;
  const handled = new Set<string>();
  for (const file of walkTsFiles(SRC_DIR)) {
    const text = readFileSync(file, 'utf8');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) handled.add(m[1]);
  }
  return handled;
}

/** All channel names passed to `ipcRenderer.invoke(...)` in the preload. */
function collectInvokedChannels(): Set<string> {
  const preload = readFileSync(join(SRC_DIR, 'preload.ts'), 'utf8');
  const re = /ipcRenderer\.invoke\(\s*[`'"]([^`'"]+)[`'"]/g;
  const invoked = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(preload)) !== null) invoked.add(m[1]);
  return invoked;
}

/**
 * Channels the preload invokes that have NO ipcMain.handle registration today.
 * Now EMPTY: the former orphans (file:list-project, permission:respond,
 * permission:getPending) were stale wiring for a dead permission-modal chain and
 * were removed from the preload + api.ts. Any entry here is a latent bug (invoke →
 * hangs/rejects at runtime, never in CI); keep this set empty and instead remove
 * the stale preload entry or add the missing handler.
 */
const KNOWN_ORPHANS = new Set<string>([]);

describe('C6 — every preload-invoked IPC channel has a handler (drift guard)', () => {
  it('the extraction found the expected order-of-magnitude of channels', () => {
    // Vacuous-pass guard: if either regex silently matched nothing, the parity
    // assertion below would be meaningless.
    expect(collectHandledChannels().size).toBeGreaterThan(100);
    expect(collectInvokedChannels().size).toBeGreaterThan(100);
  });

  it('no preload channel is unhandled except the documented known orphans', () => {
    const handled = collectHandledChannels();
    const invoked = collectInvokedChannels();

    const orphaned = [...invoked].filter((c) => !handled.has(c)).sort();
    // Pin CURRENT behavior: the orphan set must equal exactly the documented
    // KNOWN_ORPHANS. A NEW unhandled channel (regression) fails here; fixing an
    // existing orphan (removing it from preload or adding its handler) also fails
    // here and forces KNOWN_ORPHANS to be updated in the same change.
    expect(orphaned).toEqual([...KNOWN_ORPHANS].sort());
  });

  it('the known orphans are genuinely absent from the handler set (regression pins)', () => {
    const handled = collectHandledChannels();
    for (const orphan of KNOWN_ORPHANS) {
      expect(handled.has(orphan)).toBe(false);
    }
  });
});
