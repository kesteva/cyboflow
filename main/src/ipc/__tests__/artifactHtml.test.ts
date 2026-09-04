/**
 * Unit tests for registerArtifactHtmlHandlers (main/src/ipc/artifactHtml.ts) —
 * the static-mockup ui-prototype/generic HTML loader (artifacts:load-html).
 *
 * Covers:
 *   - registers the channel;
 *   - reads the canonical run-subtree prototype/index.html and injects the CSP
 *     <meta> as the first <head> child;
 *   - synthesizes a <head> when the document has none;
 *   - fail-soft null for a missing file, a symlinked index.html, and an
 *     oversized file (never fatal — the renderer shows an empty state);
 *   - committed source: with committed:true it reads the committed snapshot store
 *     (run subtree absent) and injects CSP;
 *   - injectPrototypeCsp unit behavior.
 *
 * cyboflowDirectory is mocked to a per-test tmp dir so the run-subtree read hits
 * real bytes off disk without Electron app paths; the committed store is a second
 * tmp dir wired through a stubbed databaseService/configManager.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { mkdtempSync, rmSync, symlinkSync } from 'fs';
import Database from 'better-sqlite3';
import type { AppServices } from '../types';
import {
  ARTIFACT_PROTOTYPE_CSP,
  ARTIFACT_INTERACTIVE_CSP,
  MAX_PROTOTYPE_HTML_BYTES,
} from '../../../../shared/types/artifacts';

let tmpRoot = '';
vi.mock('../../utils/cyboflowDirectory', () => ({
  getCyboflowSubdirectory: (...sub: string[]) => path.join(tmpRoot, ...sub),
}));

// File-level electron mock (overrides the global setup mock): the
// open-in-browser handler needs app.getPath('temp') to land inside the test
// tmp root and a spyable shell.openExternal.
const mockOpenExternal = vi.fn(async (..._args: unknown[]) => {});
vi.mock('electron', () => ({
  app: { getPath: () => path.join(tmpRoot, 'electron-temp') },
  shell: { openExternal: (...args: unknown[]) => mockOpenExternal(...args) },
}));

import {
  registerArtifactHtmlHandlers,
  injectPrototypeCsp,
  injectAfterLeadingDoctype,
} from '../artifactHtml';
import { safeRunId } from '../../orchestrator/artifactSnapshot';

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
): Promise<LoadHtmlResult> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for channel: ${channel}`);
  return (await fn({} as unknown, args)) as LoadHtmlResult;
}

interface LoadHtmlResult {
  success: boolean;
  data?: { html: string | null };
  error?: string;
}

const RUN_ID = 'run-proto';

/** Absolute path to the run subtree's canonical prototype file. */
function runProtoFile(runId: string): string {
  return path.join(tmpRoot, 'artifacts', 'runs', safeRunId(runId), 'prototype', 'index.html');
}

async function writeRunProto(runId: string, html: string): Promise<void> {
  const file = runProtoFile(runId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, html, 'utf-8');
}

/** A committed-store services stub reading from `storeDir` (absolute commit dir). */
function makeCommittedServices(runId: string, projectId: number, storeDir: string): AppServices {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, project_id INTEGER)');
  db.prepare('INSERT INTO workflow_runs (id, project_id) VALUES (?, ?)').run(runId, projectId);
  return {
    databaseService: {
      getDb: () => db,
      getProject: (_id: number) => ({ path: '/tmp/does-not-matter' }),
    },
    configManager: {
      getArtifactCommitDir: () => storeDir,
    },
  } as unknown as AppServices;
}

function emptyServices(): AppServices {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, project_id INTEGER)');
  return {
    databaseService: { getDb: () => db, getProject: () => undefined },
    configManager: { getArtifactCommitDir: () => '' },
  } as unknown as AppServices;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'cyboflow-artifact-html-'));
});
afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe('injectPrototypeCsp', () => {
  const META = `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_PROTOTYPE_CSP}">`;

  it('prepends the CSP meta as the document first token (parser hoists it into <head>)', () => {
    const out = injectPrototypeCsp('<html><head><title>x</title></head><body>hi</body></html>');
    expect(out).toBe(`${META}<html><head><title>x</title></head><body>hi</body></html>`);
  });

  it('prepends the meta AHEAD of a leading <!doctype> (srcdoc keeps no-quirks mode)', () => {
    // The meta must be byte 0 — nothing, not even the doctype, precedes it. The
    // srcdoc render context defaults to no-quirks, so fidelity is preserved.
    const out = injectPrototypeCsp('<!DOCTYPE html><html><head></head><body>hi</body></html>');
    expect(out).toBe(`${META}<!DOCTYPE html><html><head></head><body>hi</body></html>`);
    expect(out.startsWith(META)).toBe(true);
  });

  it('is NOT bypassable by a comment-spoofed <head> (regex-splice regression)', () => {
    // A `<!-- <head> -->` comment must not capture the injection: the meta has to
    // land BEFORE the comment / real content so the CSP still governs the doc.
    const spoof = '<!-- <head> --><head><img src="https://evil/beacon"></head><body>x</body>';
    const out = injectPrototypeCsp(spoof);
    expect(out.startsWith(META)).toBe(true);
    // The meta was NOT spliced inside the comment.
    expect(out).not.toContain('<!-- <head><meta');
    expect(out).toBe(`${META}${spoof}`);
  });

  it('is NOT bypassable by a parser-differential prefix (BOM / NBSP / vertical tab)', () => {
    // JS `\s` matches these but HTML does NOT treat them as pre-doctype whitespace,
    // so a `/^\s*<!doctype/` probe would splice AFTER the doctype while the parser
    // pushes the meta out of <head>. Absolute-prepend closes that: the meta is byte
    // 0 regardless of what the document begins with.
    for (const prefix of ['\uFEFF', '\u00A0', '\u000B']) {
      const doc = `${prefix}<!doctype html><img src="https://evil/beacon">`;
      const out = injectPrototypeCsp(doc);
      // The meta is byte 0; the prefix (and everything else) follows it verbatim.
      expect(out.startsWith(META)).toBe(true);
      expect(out.slice(META.length)).toBe(doc);
    }
  });

  it('prepends the meta when there is no <html>/<head> at all', () => {
    const out = injectPrototypeCsp('<body>hi</body>');
    expect(out).toBe(`${META}<body>hi</body>`);
  });
});

// For app-owned NON-CSP injections into http-served documents (the comment-mode
// capture serializer / inspector), where the CSP arrives as a response header
// and placement is not security-load-bearing — the doctype must stay first so
// the document keeps no-quirks parse mode over http.
describe('injectAfterLeadingDoctype', () => {
  const TAG = '<script>app()</script>';

  it('inserts after a leading doctype, keeping the doctype first', () => {
    const out = injectAfterLeadingDoctype('<!doctype html><body>hi</body>', TAG);
    expect(out).toBe(`<!doctype html>${TAG}<body>hi</body>`);
  });

  it('tolerates case and HTML pre-doctype whitespace (space/tab/LF/FF/CR)', () => {
    const out = injectAfterLeadingDoctype('\n\t <!DOCTYPE html>\n<body>hi</body>', TAG);
    expect(out).toBe(`\n\t <!DOCTYPE html>${TAG}\n<body>hi</body>`);
  });

  it('falls back to position 0 when there is no doctype', () => {
    const out = injectAfterLeadingDoctype('<body>hi</body>', TAG);
    expect(out).toBe(`${TAG}<body>hi</body>`);
  });

  it('does NOT honor a doctype behind a parser-differential prefix (BOM / NBSP / VT)', () => {
    // HTML treats these as content, so the parser ignores the doctype anyway —
    // the probe must agree and fall back to prepending at position 0.
    for (const prefix of ['\uFEFF', '\u00A0', '\u000B']) {
      const doc = `${prefix}<!doctype html><body>hi</body>`;
      expect(injectAfterLeadingDoctype(doc, TAG)).toBe(`${TAG}${doc}`);
    }
  });
});

describe('registerArtifactHtmlHandlers — artifacts:load-html', () => {
  it('registers the channel', () => {
    const { ipcMain, handlers } = makeHandlerCapture();
    registerArtifactHtmlHandlers(
      ipcMain as unknown as Parameters<typeof registerArtifactHtmlHandlers>[0],
      emptyServices(),
    );
    expect(handlers.has('artifacts:load-html')).toBe(true);
  });

  it('reads the run-subtree prototype and injects the CSP meta', async () => {
    await writeRunProto(RUN_ID, '<html><head></head><body>mock</body></html>');
    const { ipcMain, handlers } = makeHandlerCapture();
    registerArtifactHtmlHandlers(
      ipcMain as unknown as Parameters<typeof registerArtifactHtmlHandlers>[0],
      emptyServices(),
    );
    const res = await invoke(handlers, 'artifacts:load-html', { runId: RUN_ID, atype: 'ui-prototype' });
    expect(res.success).toBe(true);
    expect(res.data?.html).toContain('<body>mock</body>');
    expect(res.data?.html).toContain(`content="${ARTIFACT_PROTOTYPE_CSP}"`);
    // CSP meta is prepended as the document's first token.
    expect(res.data?.html?.startsWith(`<meta http-equiv="Content-Security-Policy"`)).toBe(true);
  });

  it('returns null (fail-soft) when the prototype file is absent', async () => {
    const { ipcMain, handlers } = makeHandlerCapture();
    registerArtifactHtmlHandlers(
      ipcMain as unknown as Parameters<typeof registerArtifactHtmlHandlers>[0],
      emptyServices(),
    );
    const res = await invoke(handlers, 'artifacts:load-html', { runId: RUN_ID, atype: 'ui-prototype' });
    expect(res.success).toBe(true);
    expect(res.data?.html).toBeNull();
  });

  // POSIX-only fixture: staging a symlinked FILE requires privileges on win32
  // (no unprivileged stand-in — a junction cannot point at a file).
  it.skipIf(process.platform === 'win32')(
    'rejects a symlinked index.html (fail-soft null)',
    async () => {
    const outside = path.join(tmpRoot, 'evil.html');
    await fs.writeFile(outside, '<html><body>evil</body></html>', 'utf-8');
    const file = runProtoFile(RUN_ID);
    await fs.mkdir(path.dirname(file), { recursive: true });
    symlinkSync(outside, file);
    const { ipcMain, handlers } = makeHandlerCapture();
    registerArtifactHtmlHandlers(
      ipcMain as unknown as Parameters<typeof registerArtifactHtmlHandlers>[0],
      emptyServices(),
    );
    const res = await invoke(handlers, 'artifacts:load-html', { runId: RUN_ID, atype: 'ui-prototype' });
    expect(res.success).toBe(true);
    expect(res.data?.html).toBeNull();
    },
  );

  it('rejects an oversized prototype (fail-soft null)', async () => {
    await writeRunProto(RUN_ID, 'x'.repeat(MAX_PROTOTYPE_HTML_BYTES + 1));
    const { ipcMain, handlers } = makeHandlerCapture();
    registerArtifactHtmlHandlers(
      ipcMain as unknown as Parameters<typeof registerArtifactHtmlHandlers>[0],
      emptyServices(),
    );
    const res = await invoke(handlers, 'artifacts:load-html', { runId: RUN_ID, atype: 'ui-prototype' });
    expect(res.success).toBe(true);
    expect(res.data?.html).toBeNull();
  });

  it('reads the committed snapshot store when committed:true (run subtree absent)', async () => {
    const storeDir = mkdtempSync(path.join(os.tmpdir(), 'cyboflow-artifact-store-'));
    try {
      // Write a committed snapshot: <store>/<safeRunId>/ui-prototype/files/prototype/index.html
      const filesProto = path.join(storeDir, safeRunId(RUN_ID), 'ui-prototype', 'files', 'prototype');
      await fs.mkdir(filesProto, { recursive: true });
      await fs.writeFile(path.join(filesProto, 'index.html'), '<html><head></head><body>committed</body></html>', 'utf-8');

      const { ipcMain, handlers } = makeHandlerCapture();
      registerArtifactHtmlHandlers(
        ipcMain as unknown as Parameters<typeof registerArtifactHtmlHandlers>[0],
        makeCommittedServices(RUN_ID, 7, storeDir),
      );
      const res = await invoke(handlers, 'artifacts:load-html', {
        runId: RUN_ID,
        atype: 'ui-prototype',
        committed: true,
      });
      expect(res.success).toBe(true);
      expect(res.data?.html).toContain('<body>committed</body>');
      expect(res.data?.html).toContain(`content="${ARTIFACT_PROTOTYPE_CSP}"`);
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
    }
  });

  it('falls back to the committed store when the run subtree misses (committed omitted)', async () => {
    const storeDir = mkdtempSync(path.join(os.tmpdir(), 'cyboflow-artifact-store-'));
    try {
      const filesProto = path.join(storeDir, safeRunId(RUN_ID), 'ui-prototype', 'files', 'prototype');
      await fs.mkdir(filesProto, { recursive: true });
      await fs.writeFile(path.join(filesProto, 'index.html'), '<html><head></head><body>fallback</body></html>', 'utf-8');

      const { ipcMain, handlers } = makeHandlerCapture();
      registerArtifactHtmlHandlers(
        ipcMain as unknown as Parameters<typeof registerArtifactHtmlHandlers>[0],
        makeCommittedServices(RUN_ID, 7, storeDir),
      );
      // No run-subtree file written → run source misses → committed fallback.
      const res = await invoke(handlers, 'artifacts:load-html', { runId: RUN_ID, atype: 'ui-prototype' });
      expect(res.success).toBe(true);
      expect(res.data?.html).toContain('<body>fallback</body>');
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
    }
  });

  it('serves an interactive-prototype from the run subtree with the INTERACTIVE CSP (scripts allowed, egress blocked)', async () => {
    await writeRunProto(RUN_ID, '<html><head></head><body><script>1</script></body></html>');
    const { ipcMain, handlers } = makeHandlerCapture();
    registerArtifactHtmlHandlers(
      ipcMain as unknown as Parameters<typeof registerArtifactHtmlHandlers>[0],
      emptyServices(),
    );
    const res = await invoke(handlers, 'artifacts:load-html', { runId: RUN_ID, atype: 'interactive-prototype' });
    expect(res.success).toBe(true);
    expect(res.data?.html).toContain('<script>1</script>');
    // The registry selects the interactive CSP for this atype — NOT the static one.
    expect(res.data?.html).toContain(`content="${ARTIFACT_INTERACTIVE_CSP}"`);
    expect(res.data?.html).not.toContain(`content="${ARTIFACT_PROTOTYPE_CSP}"`);
    expect(res.data?.html?.startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true);
  });

  it('serves an interactive-prototype from the committed store with the INTERACTIVE CSP (subtree absent)', async () => {
    const storeDir = mkdtempSync(path.join(os.tmpdir(), 'cyboflow-artifact-store-'));
    try {
      const filesProto = path.join(storeDir, safeRunId(RUN_ID), 'interactive-prototype', 'files', 'prototype');
      await fs.mkdir(filesProto, { recursive: true });
      await fs.writeFile(
        path.join(filesProto, 'index.html'),
        '<html><head></head><body>committed-interactive</body></html>',
        'utf-8',
      );
      const { ipcMain, handlers } = makeHandlerCapture();
      registerArtifactHtmlHandlers(
        ipcMain as unknown as Parameters<typeof registerArtifactHtmlHandlers>[0],
        makeCommittedServices(RUN_ID, 7, storeDir),
      );
      const res = await invoke(handlers, 'artifacts:load-html', {
        runId: RUN_ID,
        atype: 'interactive-prototype',
        committed: true,
      });
      expect(res.success).toBe(true);
      expect(res.data?.html).toContain('committed-interactive');
      expect(res.data?.html).toContain(`content="${ARTIFACT_INTERACTIVE_CSP}"`);
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
    }
  });

  it('rejects an unrecognized atype (fail-soft null — no wrong-file read)', async () => {
    // A ui-prototype file exists, but a { atype: 'screenshots' } request must NOT
    // be defaulted to ui-prototype and read it.
    await writeRunProto(RUN_ID, '<html><body>proto</body></html>');
    const { ipcMain, handlers } = makeHandlerCapture();
    registerArtifactHtmlHandlers(
      ipcMain as unknown as Parameters<typeof registerArtifactHtmlHandlers>[0],
      emptyServices(),
    );
    const res = await invoke(handlers, 'artifacts:load-html', { runId: RUN_ID, atype: 'screenshots' });
    expect(res.success).toBe(true);
    expect(res.data?.html).toBeNull();
  });

  it('reads the run subtree even when committed:true (reap may preserve live bytes)', async () => {
    // committed:true no longer SKIPS the live subtree — a committed artifact whose
    // snapshot is not yet durable keeps its bytes there, so it must still resolve.
    await writeRunProto(RUN_ID, '<html><head></head><body>live</body></html>');
    const { ipcMain, handlers } = makeHandlerCapture();
    registerArtifactHtmlHandlers(
      ipcMain as unknown as Parameters<typeof registerArtifactHtmlHandlers>[0],
      emptyServices(),
    );
    const res = await invoke(handlers, 'artifacts:load-html', {
      runId: RUN_ID,
      atype: 'ui-prototype',
      committed: true,
    });
    expect(res.success).toBe(true);
    expect(res.data?.html).toContain('<body>live</body>');
  });

  it('returns null for an empty runId (no read attempted)', async () => {
    const { ipcMain, handlers } = makeHandlerCapture();
    registerArtifactHtmlHandlers(
      ipcMain as unknown as Parameters<typeof registerArtifactHtmlHandlers>[0],
      emptyServices(),
    );
    const res = await invoke(handlers, 'artifacts:load-html', { runId: '', atype: 'ui-prototype' });
    expect(res.success).toBe(true);
    expect(res.data?.html).toBeNull();
  });
});

interface OpenInBrowserResult {
  success: boolean;
  data?: { opened: boolean };
  error?: string;
}

describe('registerArtifactHtmlHandlers — artifacts:open-in-browser', () => {
  beforeEach(() => {
    mockOpenExternal.mockClear();
  });

  function register() {
    const { ipcMain, handlers } = makeHandlerCapture();
    registerArtifactHtmlHandlers(
      ipcMain as unknown as Parameters<typeof registerArtifactHtmlHandlers>[0],
      emptyServices(),
    );
    return handlers;
  }

  it('registers the channel', () => {
    const handlers = register();
    expect(handlers.has('artifacts:open-in-browser')).toBe(true);
  });

  it('writes a RAW temp copy (no CSP meta) and opens it via shell.openExternal', async () => {
    const doc = '<html><head></head><body>external</body></html>';
    await writeRunProto(RUN_ID, doc);
    const handlers = register();
    const res = (await invoke(
      handlers,
      'artifacts:open-in-browser',
      { runId: RUN_ID, atype: 'ui-prototype' },
    )) as unknown as OpenInBrowserResult;

    expect(res.success).toBe(true);
    expect(res.data?.opened).toBe(true);
    expect(mockOpenExternal).toHaveBeenCalledTimes(1);
    const url = mockOpenExternal.mock.calls[0]?.[0] as unknown as string;
    expect(url.startsWith('file://')).toBe(true);
    // The temp copy carries the RAW document — the CSP meta is an in-app iframe
    // egress control and must NOT be baked into the user's external copy.
    const written = await fs.readFile(new URL(url), 'utf-8');
    expect(written).toBe(doc);
    expect(written).not.toContain('Content-Security-Policy');
  });

  it('fails (no browser launch) when the prototype is absent', async () => {
    const handlers = register();
    const res = (await invoke(
      handlers,
      'artifacts:open-in-browser',
      { runId: RUN_ID, atype: 'ui-prototype' },
    )) as unknown as OpenInBrowserResult;
    expect(res.success).toBe(false);
    expect(mockOpenExternal).not.toHaveBeenCalled();
  });

  it('rejects an unrecognized atype and an empty runId', async () => {
    await writeRunProto(RUN_ID, '<html><body>x</body></html>');
    const handlers = register();
    const bad = (await invoke(
      handlers,
      'artifacts:open-in-browser',
      { runId: RUN_ID, atype: 'screenshots' },
    )) as unknown as OpenInBrowserResult;
    expect(bad.success).toBe(false);
    const empty = (await invoke(
      handlers,
      'artifacts:open-in-browser',
      { runId: '', atype: 'ui-prototype' },
    )) as unknown as OpenInBrowserResult;
    expect(empty.success).toBe(false);
    expect(mockOpenExternal).not.toHaveBeenCalled();
  });
});
