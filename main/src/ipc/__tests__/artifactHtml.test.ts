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
  MAX_PROTOTYPE_HTML_BYTES,
} from '../../../../shared/types/artifacts';

let tmpRoot = '';
vi.mock('../../utils/cyboflowDirectory', () => ({
  getCyboflowSubdirectory: (...sub: string[]) => path.join(tmpRoot, ...sub),
}));

import { registerArtifactHtmlHandlers, injectPrototypeCsp } from '../artifactHtml';
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

  it('rejects a symlinked index.html (fail-soft null)', async () => {
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
  });

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
