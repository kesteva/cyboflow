import { IpcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import { randomBytes } from 'crypto';
import type { AppServices } from './types';
import { getCyboflowSubdirectory } from '../utils/cyboflowDirectory';
import type { IdeaAttachment } from '../../../shared/types/tasks';

/**
 * IPC handlers for idea file attachments (migration 028).
 *
 * The attachment BYTES live on disk under CYBOFLOW_DIR/artifacts/ideas/<ownerKey>/ —
 * the same artifact machinery as sessions:save-images, but WITHOUT a session
 * existence check (an idea — or a not-yet-created idea, keyed by a `pending_*`
 * id — is the owner). Only the small IdeaAttachment METADATA is persisted in the
 * DB (ideas.attachments, written through the TaskChangeRouter chokepoint); these
 * handlers move bytes both ways:
 *
 *   ideas:save-attachments  base64 dataURL[] -> files on disk -> IdeaAttachment[]
 *   ideas:load-attachments  absolute path[]  -> { path, dataURL }[] (for previews)
 *
 * load is path-validated: a requested path is only read when it resolves INSIDE
 * the artifacts directory, so the renderer cannot read arbitrary files.
 *
 * Any file type is accepted (not just images) — the on-disk extension is taken
 * from the ORIGINAL filename when present (sanitized, alphanumeric, length-bounded),
 * falling back to one derived from the MIME subtype, and finally to a safe 'bin'
 * default. The containment guard on load applies regardless of file type.
 */

/** Sanitize an owner key into a safe single path segment (no traversal). */
function safeOwnerKey(ownerKey: string): string {
  const cleaned = ownerKey.replace(/[^a-zA-Z0-9_-]/g, '_');
  return cleaned.length > 0 ? cleaned : 'unknown';
}

/** Bounds a derived extension's length regardless of input (e.g. a long MIME subtype). */
const MAX_EXTENSION_LENGTH = 12;

/** Reduce to a safe alphanumeric extension, bounded in length. */
function sanitizeExtension(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9]/g, '').slice(0, MAX_EXTENSION_LENGTH);
}

/** The extension from an original filename (e.g. "report.pdf" -> "pdf"), or '' if absent/unsafe. */
function extensionFromName(name: string): string {
  const match = /\.([a-zA-Z0-9]+)$/.exec(name);
  return match ? sanitizeExtension(match[1]) : '';
}

/** Known image extensions -> MIME, used to reconstruct a data URL for thumbnails on load. */
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
};

export function registerIdeaAttachmentHandlers(ipcMain: IpcMain, _services: AppServices): void {
  // Persist pasted/dropped/picked files to disk and return their metadata.
  ipcMain.handle(
    'ideas:save-attachments',
    async (
      _event,
      ownerKey: string,
      files: Array<{ name: string; dataUrl: string; type: string }>,
    ): Promise<IdeaAttachment[]> => {
      const dir = getCyboflowSubdirectory('artifacts', 'ideas', safeOwnerKey(ownerKey));
      if (!existsSync(dir)) {
        await fs.mkdir(dir, { recursive: true });
      }

      const saved: IdeaAttachment[] = [];
      for (const file of files) {
        // Prefer the original filename's extension; fall back to one derived from
        // the MIME subtype, then to a safe default — never trust either blindly.
        const extension =
          extensionFromName(file.name) || sanitizeExtension(file.type.split('/')[1] || '') || 'bin';
        const id = `att_${randomBytes(8).toString('hex')}`;
        const filename = `${id}.${extension}`;
        const filePath = path.join(dir, filename);

        // dataURL form: "data:<mime>;base64,<payload>"
        const base64Data = file.dataUrl.split(',')[1] ?? '';
        const buffer = Buffer.from(base64Data, 'base64');
        await fs.writeFile(filePath, buffer);

        saved.push({
          id,
          name: file.name || filename,
          path: filePath,
          type: file.type || 'application/octet-stream',
          size: buffer.byteLength,
        });
      }
      return saved;
    },
  );

  // Read saved attachment files back as data URLs for in-renderer previews
  // (only image types render a thumbnail client-side; other types return the
  // bytes as a data URL too, but the renderer only uses it for image previews).
  ipcMain.handle(
    'ideas:load-attachments',
    async (_event, paths: string[]): Promise<Array<{ path: string; dataUrl: string }>> => {
      const artifactsRoot = path.resolve(getCyboflowSubdirectory('artifacts'));
      const results: Array<{ path: string; dataUrl: string }> = [];
      for (const p of paths) {
        try {
          const resolved = path.resolve(p);
          // Containment guard: only read files inside the artifacts directory.
          if (resolved !== artifactsRoot && !resolved.startsWith(artifactsRoot + path.sep)) {
            continue;
          }
          if (!existsSync(resolved)) continue;
          const buffer = await fs.readFile(resolved);
          const ext = path.extname(resolved).slice(1).toLowerCase();
          const mime = IMAGE_MIME_BY_EXTENSION[ext] ?? 'application/octet-stream';
          results.push({ path: p, dataUrl: `data:${mime};base64,${buffer.toString('base64')}` });
        } catch {
          // Skip unreadable files — a missing preview must not fail the batch.
        }
      }
      return results;
    },
  );
}
