/**
 * useIdeaAttachments — image-attachment state for the idea editors (migration 028).
 *
 * Owns the list of an idea's image attachments while the editor is open and
 * exposes the handlers the editor wires onto its body textarea / drop zone:
 *   - handlePaste  : intercept image items pasted INTO the body text box
 *   - handleDrop   : accept images dropped on the editor
 *   - addFiles     : the "Attach image" file-picker path
 *   - remove       : drop one attachment
 *
 * Image BYTES are written to disk immediately on add (window.electronAPI.ideas
 * .saveAttachments → CYBOFLOW_DIR/artifacts/ideas/<ownerKey>/), returning the
 * IdeaAttachment METADATA the editor persists through tasks.create/update. For
 * RENDERING, freshly-added images keep their in-memory data URL; pre-existing
 * attachments (on reopen) are hydrated from disk via ideas.loadAttachments.
 *
 * The metadata array (`attachments`) is what the editor submits; `previews`
 * (metadata + an optional data URL) is what it renders.
 */
import { useCallback, useEffect, useState } from 'react';
import type { IdeaAttachment } from '../../../shared/types/tasks';

/** Max per-file size accepted, mirroring the chat image flow (10MB). */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** A renderable attachment: persisted metadata + an optional in-memory preview. */
export interface AttachmentPreview extends IdeaAttachment {
  /** data: URL for the <img> thumbnail; undefined while a saved file is still loading. */
  dataUrl?: string;
}

export interface UseIdeaAttachments {
  /** Metadata to submit through tasks.create/update (no data URLs). */
  attachments: IdeaAttachment[];
  /** Metadata + data URLs for rendering thumbnails. */
  previews: AttachmentPreview[];
  busy: boolean;
  error: string | null;
  addFiles: (files: FileList | File[]) => Promise<void>;
  handlePaste: (e: React.ClipboardEvent) => void;
  handleDrop: (e: React.DragEvent) => void;
  remove: (id: string) => void;
  /** Clear all in-memory previews + error (e.g. after a create-form submit). */
  reset: () => void;
}

function readAsDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve((e.target?.result as string) ?? null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

export function useIdeaAttachments(ownerKey: string, initial: IdeaAttachment[]): UseIdeaAttachments {
  const [previews, setPreviews] = useState<AttachmentPreview[]>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed from `initial` and hydrate data URLs for already-saved files from disk.
  // Keyed on the joined paths so a reseed (different idea / new version) re-runs.
  const initialKey = initial.map((a) => a.path).join('|');
  useEffect(() => {
    let cancelled = false;
    setPreviews(initial);
    setError(null);
    if (initial.length === 0) return;
    void window.electronAPI.ideas
      .loadAttachments(initial.map((a) => a.path))
      .then((loaded) => {
        if (cancelled) return;
        const byPath = new Map(loaded.map((l) => [l.path, l.dataUrl]));
        setPreviews((prev) => prev.map((p) => ({ ...p, dataUrl: byPath.get(p.path) ?? p.dataUrl })));
      })
      .catch(() => {
        /* thumbnails are best-effort; the metadata is still valid */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialKey]);

  const addFiles = useCallback(
    async (files: FileList | File[]): Promise<void> => {
      const images = Array.from(files).filter((f) => f.type.startsWith('image/'));
      if (images.length === 0) return;

      setBusy(true);
      setError(null);
      try {
        const payload: Array<{ name: string; dataUrl: string; type: string }> = [];
        for (const file of images) {
          if (file.size > MAX_FILE_BYTES) {
            setError(`"${file.name || 'image'}" is larger than 10MB and was skipped.`);
            continue;
          }
          const dataUrl = await readAsDataUrl(file);
          if (dataUrl) {
            payload.push({ name: file.name || 'pasted-image.png', dataUrl, type: file.type });
          }
        }
        if (payload.length === 0) return;

        const saved = await window.electronAPI.ideas.saveAttachments(ownerKey, payload);
        // saveAttachments preserves input order — zip the in-memory data URLs back
        // on so the new thumbnails render without a disk round-trip.
        const withPreview: AttachmentPreview[] = saved.map((meta, i) => ({
          ...meta,
          dataUrl: payload[i]?.dataUrl,
        }));
        setPreviews((prev) => [...prev, ...withPreview]);
      } catch {
        setError('Failed to save attachment.');
      } finally {
        setBusy(false);
      }
    },
    [ownerKey],
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent): void => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
          const file = items[i].getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length === 0) return; // let normal text paste through
      e.preventDefault();
      void addFiles(files);
    },
    [addFiles],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent): void => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      void addFiles(e.dataTransfer.files);
    },
    [addFiles],
  );

  const remove = useCallback((id: string): void => {
    // Drops the metadata only; the on-disk file is left as a harmless orphan
    // (consistent with how chat image artifacts are never reaped).
    setPreviews((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const reset = useCallback((): void => {
    setPreviews([]);
    setError(null);
  }, []);

  const attachments: IdeaAttachment[] = previews.map(({ dataUrl: _dataUrl, ...meta }) => meta);

  return { attachments, previews, busy, error, addFiles, handlePaste, handleDrop, remove, reset };
}
