/**
 * Behavioral tests for the ideas:save-attachments / ideas:load-attachments IPC
 * handlers (main/src/ipc/ideaAttachments.ts, migration 028).
 *
 * These handlers move attachment BYTES (any file type, not just images) to/from
 * disk under CYBOFLOW_DIR/artifacts/ideas/<ownerKey>/. The security-critical
 * behaviors are:
 *  - ownerKey sanitization: a traversal-shaped key can NEVER escape the
 *    artifacts/ideas/ directory (retires directory-escape data placement).
 *  - duplicate filenames DON'T overwrite: two files with the same display name
 *    each get a unique on-disk file (randomBytes id), so a paste of two
 *    same-named screenshots keeps both.
 *  - load containment guard: a path OUTSIDE the artifacts root is skipped, so the
 *    renderer cannot read arbitrary files via ideas:load-attachments.
 *  - extension handling: the original filename's extension is preserved where
 *    present, falling back to one derived from the MIME subtype, then to 'bin'.
 *
 * Real fs under an os.tmpdir() CYBOFLOW_DIR (set via setCyboflowDirectory) — the
 * assertions are about real on-disk effects, so no fs mock.
 *
 * NOTE (deviation): the batch spec also lists "delete removes only the targeted
 * file", but ideaAttachments.ts exposes NO delete handler (only save + load), so
 * that case has no handler to exercise and is omitted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

// getCyboflowDirectory (imported transitively) pulls electron's `app`; stub it.
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: vi.fn(() => '/mock') } }));

import { registerIdeaAttachmentHandlers } from '../ideaAttachments';
import { setCyboflowDirectory, getCyboflowSubdirectory } from '../../utils/cyboflowDirectory';
import type { AppServices } from '../types';
import type { IdeaAttachment } from '../../../../shared/types/tasks';

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

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cyboflow-idea-att-'));
  setCyboflowDirectory(tmpRoot);
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

describe('ideas:save-attachments — ownerKey sanitization', () => {
  it('neutralizes a traversal-shaped ownerKey so bytes stay inside artifacts/ideas', async () => {
    const { ipcMain, handlers } = makeHandlerCapture();
    registerIdeaAttachmentHandlers(ipcMain as unknown as Parameters<typeof registerIdeaAttachmentHandlers>[0], {} as AppServices);

    const saved = (await invoke(handlers, 'ideas:save-attachments', '../../etc/evil', [
      { name: 'shot.png', dataUrl: PNG_DATA_URL, type: 'image/png' },
    ])) as IdeaAttachment[];

    expect(saved).toHaveLength(1);
    // The file must be created UNDER artifacts/ideas — never at a parent path.
    const ideasRoot = path.resolve(getCyboflowSubdirectory('artifacts', 'ideas'));
    expect(path.resolve(saved[0].path).startsWith(ideasRoot + path.sep)).toBe(true);
    expect(existsSync(saved[0].path)).toBe(true);
    // The owner segment is a single sanitized token — the traversal `..`/`/` are gone.
    const segment = path.relative(ideasRoot, path.dirname(saved[0].path));
    expect(segment).not.toContain('..');
    expect(segment).not.toContain(path.sep);
  });

  it('falls back to an "unknown" owner segment when the key sanitizes to empty', async () => {
    const { ipcMain, handlers } = makeHandlerCapture();
    registerIdeaAttachmentHandlers(ipcMain as unknown as Parameters<typeof registerIdeaAttachmentHandlers>[0], {} as AppServices);

    // An empty ownerKey sanitizes to length 0 -> the 'unknown' fallback segment.
    const saved = (await invoke(handlers, 'ideas:save-attachments', '', [
      { name: 'x.png', dataUrl: PNG_DATA_URL, type: 'image/png' },
    ])) as IdeaAttachment[];

    const ideasRoot = path.resolve(getCyboflowSubdirectory('artifacts', 'ideas'));
    expect(path.dirname(path.resolve(saved[0].path))).toBe(path.join(ideasRoot, 'unknown'));
  });
});

describe('ideas:save-attachments — arbitrary (non-image) file types', () => {
  it('preserves the original filename extension for a PDF and round-trips it through load', async () => {
    const { ipcMain, handlers } = makeHandlerCapture();
    registerIdeaAttachmentHandlers(ipcMain as unknown as Parameters<typeof registerIdeaAttachmentHandlers>[0], {} as AppServices);

    // Arbitrary bytes — only the extension/round-trip behavior is under test.
    const pdfDataUrl = 'data:application/pdf;base64,JVBERi0xLjQKJcTl8uXrp/Og==';
    const saved = (await invoke(handlers, 'ideas:save-attachments', 'idea-77', [
      { name: 'report.pdf', dataUrl: pdfDataUrl, type: 'application/pdf' },
    ])) as IdeaAttachment[];

    expect(saved).toHaveLength(1);
    expect(saved[0].path.endsWith('.pdf')).toBe(true);
    expect(saved[0].name).toBe('report.pdf');
    expect(saved[0].type).toBe('application/pdf');
    expect(existsSync(saved[0].path)).toBe(true);

    const loaded = (await invoke(handlers, 'ideas:load-attachments', [saved[0].path])) as Array<{
      path: string;
      dataUrl: string;
    }>;
    expect(loaded).toHaveLength(1);
    // Non-image extensions fall back to a generic octet-stream data URL mime.
    expect(loaded[0].dataUrl.startsWith('data:application/octet-stream;base64,')).toBe(true);
  });

  it('falls back to a safe "bin" extension when the filename has none and no mime type is given', async () => {
    const { ipcMain, handlers } = makeHandlerCapture();
    registerIdeaAttachmentHandlers(ipcMain as unknown as Parameters<typeof registerIdeaAttachmentHandlers>[0], {} as AppServices);

    const saved = (await invoke(handlers, 'ideas:save-attachments', 'idea-78', [
      { name: 'noextension', dataUrl: 'data:application/octet-stream;base64,AAAA', type: '' },
    ])) as IdeaAttachment[];

    expect(saved).toHaveLength(1);
    expect(saved[0].path.endsWith('.bin')).toBe(true);
    // Falsy type also gets a safe default persisted, not an empty string.
    expect(saved[0].type).toBe('application/octet-stream');
  });

  it('sanitizes and bounds an unwieldy MIME subtype used as a fallback extension', async () => {
    const { ipcMain, handlers } = makeHandlerCapture();
    registerIdeaAttachmentHandlers(ipcMain as unknown as Parameters<typeof registerIdeaAttachmentHandlers>[0], {} as AppServices);

    // Long, punctuation-heavy MIME subtype (docx) and no filename extension.
    const saved = (await invoke(handlers, 'ideas:save-attachments', 'idea-79', [
      {
        name: 'contract',
        dataUrl: 'data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,AAAA',
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
    ])) as IdeaAttachment[];

    expect(saved).toHaveLength(1);
    const ext = saved[0].path.split('.').pop() ?? '';
    expect(ext.length).toBeLessThanOrEqual(12);
    expect(/^[a-zA-Z0-9]+$/.test(ext)).toBe(true);
  });
});

describe('ideas:save-attachments — duplicate filenames do not overwrite', () => {
  it('writes two distinct files for two images sharing the same display name', async () => {
    const { ipcMain, handlers } = makeHandlerCapture();
    registerIdeaAttachmentHandlers(ipcMain as unknown as Parameters<typeof registerIdeaAttachmentHandlers>[0], {} as AppServices);

    const saved = (await invoke(handlers, 'ideas:save-attachments', 'idea-42', [
      { name: 'Screenshot.png', dataUrl: PNG_DATA_URL, type: 'image/png' },
      { name: 'Screenshot.png', dataUrl: PNG_DATA_URL, type: 'image/png' },
    ])) as IdeaAttachment[];

    expect(saved).toHaveLength(2);
    // Distinct on-disk paths + distinct ids — neither clobbers the other.
    expect(saved[0].path).not.toBe(saved[1].path);
    expect(saved[0].id).not.toBe(saved[1].id);
    // Both still on disk (a same-name overwrite would leave only one).
    expect(existsSync(saved[0].path)).toBe(true);
    expect(existsSync(saved[1].path)).toBe(true);
    // The display name is preserved even though the on-disk filename is id-based.
    expect(saved[0].name).toBe('Screenshot.png');
  });

  it('records the decoded byte length as size and derives the extension from the mime type', async () => {
    const { ipcMain, handlers } = makeHandlerCapture();
    registerIdeaAttachmentHandlers(ipcMain as unknown as Parameters<typeof registerIdeaAttachmentHandlers>[0], {} as AppServices);

    const saved = (await invoke(handlers, 'ideas:save-attachments', 'idea-42', [
      { name: '', dataUrl: PNG_DATA_URL, type: 'image/jpeg' },
    ])) as IdeaAttachment[];

    const base64 = PNG_DATA_URL.split(',')[1];
    const expectedBytes = Buffer.from(base64, 'base64').byteLength;
    expect(saved[0].size).toBe(expectedBytes);
    expect(saved[0].path.endsWith('.jpeg')).toBe(true);
    // Empty display name falls back to the on-disk filename.
    expect(saved[0].name).toBe(path.basename(saved[0].path));
  });
});

describe('ideas:load-attachments — containment guard', () => {
  it('reads a saved attachment back as a data URL but skips a path outside the artifacts root', async () => {
    const { ipcMain, handlers } = makeHandlerCapture();
    registerIdeaAttachmentHandlers(ipcMain as unknown as Parameters<typeof registerIdeaAttachmentHandlers>[0], {} as AppServices);

    const saved = (await invoke(handlers, 'ideas:save-attachments', 'idea-99', [
      { name: 'a.png', dataUrl: PNG_DATA_URL, type: 'image/png' },
    ])) as IdeaAttachment[];

    // Plant a readable file OUTSIDE the artifacts root — the guard must refuse it.
    const outsideFile = path.join(tmpRoot, 'outside-secret.txt');
    await fs.writeFile(outsideFile, 'top secret');

    const loaded = (await invoke(handlers, 'ideas:load-attachments', [
      saved[0].path,
      outsideFile,
    ])) as Array<{ path: string; dataUrl: string }>;

    // Only the in-artifacts attachment is returned; the outside file is dropped.
    expect(loaded).toHaveLength(1);
    expect(loaded[0].path).toBe(saved[0].path);
    expect(loaded[0].dataUrl.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('applies the same containment guard to a non-image attachment', async () => {
    const { ipcMain, handlers } = makeHandlerCapture();
    registerIdeaAttachmentHandlers(ipcMain as unknown as Parameters<typeof registerIdeaAttachmentHandlers>[0], {} as AppServices);

    const saved = (await invoke(handlers, 'ideas:save-attachments', 'idea-98', [
      { name: 'notes.log', dataUrl: 'data:text/plain;base64,aGVsbG8=', type: 'text/plain' },
    ])) as IdeaAttachment[];

    const outsideFile = path.join(tmpRoot, 'outside-notes.log');
    await fs.writeFile(outsideFile, 'top secret log');

    const loaded = (await invoke(handlers, 'ideas:load-attachments', [
      saved[0].path,
      outsideFile,
    ])) as Array<{ path: string; dataUrl: string }>;

    // The non-image attachment inside artifacts/ is still readable; the escape is not.
    expect(loaded).toHaveLength(1);
    expect(loaded[0].path).toBe(saved[0].path);
  });

  it('skips a traversal path that resolves outside artifacts even when it exists', async () => {
    const { ipcMain, handlers } = makeHandlerCapture();
    registerIdeaAttachmentHandlers(ipcMain as unknown as Parameters<typeof registerIdeaAttachmentHandlers>[0], {} as AppServices);

    const artifactsRoot = getCyboflowSubdirectory('artifacts');
    // A path that climbs out of artifacts back into tmpRoot.
    const escapePath = path.join(artifactsRoot, '..', 'outside-secret.txt');
    await fs.mkdir(artifactsRoot, { recursive: true });
    await fs.writeFile(path.join(tmpRoot, 'outside-secret.txt'), 'secret');

    const loaded = (await invoke(handlers, 'ideas:load-attachments', [escapePath])) as unknown[];
    expect(loaded).toHaveLength(0);
  });
});
