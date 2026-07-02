/**
 * Cross-boundary drift guard for the contextBridge surface (B11 + C6 preload half).
 *
 * The renderer reaches main ONLY through `window.electronAPI`, which the preload
 * builds and hands to `contextBridge.exposeInMainWorld`. If the frontend facade
 * (frontend/src/utils/api.ts) calls `window.electronAPI.<path>` for a path the
 * preload never exposed, TypeScript can't catch it — the two files sit on opposite
 * sides of an untyped runtime bridge (`window.electronAPI` is declared, but a
 * missing method is `undefined` at call time and crashes only in a packaged app).
 * This test imports the REAL preload with a mocked electron, captures the exposed
 * object, and asserts every path api.ts consumes actually resolves on it.
 *
 * Also the C6 preload smoke: assert `contextBridge.exposeInMainWorld` fired for
 * both bridge names ('electronAPI' and 'electron').
 *
 * Covered:
 *   1. exposeInMainWorld fired for 'electronAPI' and 'electron' (boot smoke).
 *   2. every `window.electronAPI.<ns>.<method>` consumed by api.ts exists on the
 *      exposed bridge (silent-drop drift guard).
 *   3. the CreateSessionRequest request-interface twins stay structurally
 *      identical frontend↔main (compile-time mutual-assignability check).
 */

// Force the non-production console-override branch OFF so importing preload does
// not monkeypatch the global console under the test runner.
process.env.NODE_ENV = 'production';

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Capture store (hoisted so the vi.mock factory can reference it).
// ---------------------------------------------------------------------------
const { exposed } = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: unknown) => {
      exposed.set(key, api);
    },
  },
  ipcRenderer: {
    invoke: vi.fn(),
    send: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    setMaxListeners: vi.fn(),
  },
}));

vi.mock('trpc-electron/main', () => ({ exposeElectronTRPC: vi.fn() }));
vi.mock('@sentry/electron/preload', () => ({}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Walk a dotted path (e.g. "sessions.getAll") against the captured bridge. */
function resolvePath(root: unknown, dottedPath: string): unknown {
  let cur: unknown = root;
  for (const part of dottedPath.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * Statically extract every `window.electronAPI.<a>.<b>...` access from api.ts.
 * Returns the set of dotted sub-paths (without the `window.electronAPI.` prefix).
 */
function extractConsumedPaths(source: string): Set<string> {
  const re = /window\.electronAPI((?:\.[A-Za-z0-9_]+)+)/g;
  const paths = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    paths.add(m[1].replace(/^\./, ''));
  }
  return paths;
}

describe('preload ↔ api.ts contextBridge parity (B11 + C6)', () => {
  let electronAPI: unknown;
  let consumedPaths: Set<string>;

  beforeAll(async () => {
    // Dynamic import so the module mocks above are in place before preload runs.
    await import('../preload');
    electronAPI = exposed.get('electronAPI');

    // __dirname = main/src/__tests__ → ../../../ = repo root.
    const apiTsPath = join(__dirname, '../../../frontend/src/utils/api.ts');
    consumedPaths = extractConsumedPaths(readFileSync(apiTsPath, 'utf8'));
  });

  it('exposes both bridges (electronAPI + electron) — C6 boot smoke', () => {
    expect(exposed.has('electronAPI')).toBe(true);
    expect(exposed.has('electron')).toBe(true);
    expect(electronAPI).toBeTypeOf('object');
  });

  it('api.ts consumes a non-trivial set of bridge paths (extraction sanity)', () => {
    // Guards against the regex silently matching nothing (which would make the
    // parity assertion below vacuously pass).
    expect(consumedPaths.size).toBeGreaterThan(30);
    // Spot-check a representative nested path was captured.
    expect(consumedPaths.has('sessions.getAll')).toBe(true);
  });

  it('every bridge path consumed by api.ts resolves on the exposed electronAPI', () => {
    const missing: string[] = [];
    for (const path of consumedPaths) {
      const target = resolvePath(electronAPI, path);
      // A leaf method resolves to a function; an intermediate namespace probe
      // (e.g. the `!window.electronAPI.models` skew guard) resolves to an object.
      if (typeof target !== 'function' && (target == null || typeof target !== 'object')) {
        missing.push(path);
      }
    }
    // If this fails, api.ts calls a bridge path the preload never exposed — the
    // exact silent-drop IPC class CLAUDE.md warns about.
    expect(missing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// CreateSessionRequest request-interface parity (compile-time).
//
// The two twins live in separate files (main/src/types/session.ts and
// frontend/src/types/session.ts) and are kept in sync BY HAND. Mutual
// assignability fails `tsc` the moment a field is added to one side only —
// turning the "forgot to update the other twin" drift into a build error.
// ---------------------------------------------------------------------------
import type { CreateSessionRequest as MainCreateSessionRequest } from '../types/session';
import type { CreateSessionRequest as FrontendCreateSessionRequest } from '../../../frontend/src/types/session';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _AssertMainSatisfiesFrontend = MainCreateSessionRequest extends FrontendCreateSessionRequest
  ? true
  : never;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _AssertFrontendSatisfiesMain = FrontendCreateSessionRequest extends MainCreateSessionRequest
  ? true
  : never;

// Materialize the assertions so an accidental `never` (drift) is a value error too.
const _mainOk: _AssertMainSatisfiesFrontend = true;
const _frontendOk: _AssertFrontendSatisfiesMain = true;

describe('CreateSessionRequest request-interface parity (frontend ↔ main)', () => {
  it('the two twins are mutually assignable (compile-time enforced)', () => {
    expect(_mainOk).toBe(true);
    expect(_frontendOk).toBe(true);
  });
});
