import { IpcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import { randomBytes } from 'crypto';
import type { AppServices } from './types';
import { getCyboflowSubdirectory } from '../utils/cyboflowDirectory';
import type { IdeaAttachment } from '../../../shared/types/tasks';

/**
 * IPC handlers for idea image attachments (migration 028).
 *
 * The image BYTES live on disk under CYBOFLOW_DIR/artifacts/ideas/<ownerKey>/ —
 * the same artifact machinery as sessions:save-images, but WITHOUT a session
 * existence check (an idea — or a not-yet-created idea, keyed by a `pending_*`
 * id — is the owner). Only the small IdeaAttachment METADATA is persisted in the
 * DB (ideas.attachments, written through the TaskChangeRouter chokepoint); these
 * handlers move bytes both ways:
 *
 *   ideas:save-attachments  base64 dataURL[] -> files on disk -> IdeaAttachment[]
 *   ideas:load-attachments  absolute path[]  -> { path, dataURL }[] (for thumbnails)
 *
 * load is path-validated: a requested path is only read when it resolves INSIDE
 * the artifacts directory, so the renderer cannot read arbitrary files.
 */

/** Sanitize an owner key into a safe single path segment (no traversal). */
function safeOwnerKey(ownerKey: string): string {
  const cleaned = ownerKey.replace(/[^a-zA-Z0-9_-]/g, '_');
  return cleaned.length > 0 ? cleaned : 'unknown';
}

export function registerIdeaAttachmentHandlers(ipcMain: IpcMain, _services: AppServices): void {
  // Persist pasted/dropped/picked images to disk and return their metadata.
  ipcMain.handle(
    'ideas:save-attachments',
    async (
      _event,
      ownerKey: string,
      images: Array<{ name: string; dataUrl: string; type: string }>,
    ): Promise<IdeaAttachment[]> => {
      const dir = getCyboflowSubdirectory('artifacts', 'ideas', safeOwnerKey(ownerKey));
      if (!existsSync(dir)) {
        await fs.mkdir(dir, { recursive: true });
      }

      const saved: IdeaAttachment[] = [];
      for (const image of images) {
        const extension = (image.type.split('/')[1] || 'png').replace(/[^a-zA-Z0-9]/g, '') || 'png';
        const id = `att_${randomBytes(8).toString('hex')}`;
        const filename = `${id}.${extension}`;
        const filePath = path.join(dir, filename);

        // dataURL form: "data:<mime>;base64,<payload>"
        const base64Data = image.dataUrl.split(',')[1] ?? '';
        const buffer = Buffer.from(base64Data, 'base64');
        await fs.writeFile(filePath, buffer);

        saved.push({
          id,
          name: image.name || filename,
          path: filePath,
          type: image.type || `image/${extension}`,
          size: buffer.byteLength,
        });
      }
      return saved;
    },
  );

  // Read saved attachment files back as data URLs for in-renderer thumbnails.
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
          const ext = (path.extname(resolved).slice(1) || 'png').toLowerCase();
          const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
          results.push({ path: p, dataUrl: `data:${mime};base64,${buffer.toString('base64')}` });
        } catch {
          // Skip unreadable files — a missing thumbnail must not fail the batch.
        }
      }
      return results;
    },
  );
}
