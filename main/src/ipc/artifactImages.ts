import { IpcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import type { AppServices } from './types';
import { getCyboflowSubdirectory } from '../utils/cyboflowDirectory';

/**
 * IPC handler for the screenshots artifact gallery (FU4 — display half).
 *
 * Mirrors ideaAttachments.ts EXACTLY (codec + containment guard + fail-soft per
 * file), but reads on a per-RUN image root rather than a per-idea owner key.
 *
 * PRODUCER CONVENTION (capture half is environmental / out of scope here):
 *   A visual-verifier agent (e.g. driving Peekaboo) writes PNG bytes onto disk
 *   under CYBOFLOW_DIR/artifacts/runs/<runId>/ — the SAME CYBOFLOW_DIR source
 *   ideaAttachments uses — and then reports a 'screenshots' artifact via the
 *   existing `cyboflow_report_artifact` MCP tool whose `payload.fileNames` are
 *   the BASENAMES of those files (e.g. ["home.png","detail.png"]). The actual
 *   capture is gated on the host's Peekaboo TCC grants and is NOT built here;
 *   this handler only serves whatever PNGs the producer has already laid down.
 *
 *   artifacts:load-images  { runId, fileNames[] } -> { images: {fileName,dataUrl}[] }
 *
 * load is path-validated: a requested fileName is only read when it resolves
 * INSIDE the run's artifact image root, so a traversal basename like
 * "../../etc/passwd" is skipped (NOT fatal) and the renderer cannot read
 * arbitrary files. A missing or oversized file is likewise skipped, never fatal.
 */

/** Max per-image size served back as a data URL (mirrors the chat/idea 10MB cap). */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export interface ArtifactImage {
  fileName: string;
  dataUrl: string;
}

interface LoadImagesRequest {
  runId: string;
  fileNames: string[];
}

/** IPCResponse-compatible result shape (mirrors frontend/src/utils/api.ts). */
interface LoadImagesResponse {
  success: boolean;
  data?: { images: ArtifactImage[] };
  error?: string;
}

/** Sanitize a run id into a safe single path segment (no traversal). */
function safeRunId(runId: string): string {
  const cleaned = runId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return cleaned.length > 0 ? cleaned : 'unknown';
}

export function registerArtifactImageHandlers(ipcMain: IpcMain, _services: AppServices): void {
  // Read on-disk screenshot bytes back as data URLs for the artifact gallery.
  ipcMain.handle(
    'artifacts:load-images',
    async (_event, req: LoadImagesRequest): Promise<LoadImagesResponse> => {
      try {
        const runId = safeRunId(req?.runId ?? '');
        const fileNames = Array.isArray(req?.fileNames) ? req.fileNames : [];
        // The per-run image root; same artifacts subtree the producer writes to.
        const runRoot = path.resolve(getCyboflowSubdirectory('artifacts', 'runs', runId));

        const images: ArtifactImage[] = [];
        for (const fileName of fileNames) {
          try {
            if (typeof fileName !== 'string' || fileName.length === 0) continue;
            const resolved = path.resolve(runRoot, fileName);
            // Containment guard: only read files inside the run's image root, so a
            // traversal path (e.g. "../../etc/passwd") resolving outside is skipped.
            if (resolved !== runRoot && !resolved.startsWith(runRoot + path.sep)) {
              continue;
            }
            if (!existsSync(resolved)) continue;
            const stat = await fs.stat(resolved);
            if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) continue;
            const buffer = await fs.readFile(resolved);
            const ext = (path.extname(resolved).slice(1) || 'png').toLowerCase();
            const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
            images.push({ fileName, dataUrl: `data:${mime};base64,${buffer.toString('base64')}` });
          } catch {
            // Skip unreadable / missing files — one bad image must not fail the batch.
          }
        }
        return { success: true, data: { images } };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to load artifact images.' };
      }
    },
  );
}
