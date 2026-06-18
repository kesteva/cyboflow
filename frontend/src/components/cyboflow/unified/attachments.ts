/**
 * Attachment model + helpers for the unified composer, ported from the Crystal
 * superset composer (ClaudeInputWithImages) so the SDK send paths keep
 * image/large-text attachment support after unification.
 *
 * Structurally compatible with useClaudePanel's handleSendInput /
 * handleContinueConversation signatures (AttachedImage[] / AttachedText[]).
 */

export interface AttachedImage {
  id: string;
  name: string;
  dataUrl: string;
  size: number;
  type: string;
}

export interface AttachedText {
  id: string;
  name: string;
  content: string;
  size: number;
}

export interface ComposerAttachments {
  images: AttachedImage[];
  texts: AttachedText[];
}

export const emptyAttachments = (): ComposerAttachments => ({ images: [], texts: [] });

export const hasAttachments = (a: ComposerAttachments): boolean =>
  a.images.length > 0 || a.texts.length > 0;

/** Large pasted text (chars) is converted into a text attachment, not inlined. */
export const LARGE_TEXT_THRESHOLD = 5000;

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB

let counter = 0;
const uid = (prefix: string): string => {
  counter += 1;
  // Avoids Date.now()/Math.random() so this stays deterministic-friendly; the
  // monotonic counter is unique within a session, which is all attachment ids need.
  return `${prefix}_${counter}_${performance.now().toString(36).replace('.', '')}`;
};

/** Read an image File into an AttachedImage, or null if invalid/too large. */
export async function processImageFile(file: File): Promise<AttachedImage | null> {
  if (!file.type.startsWith('image/')) return null;
  if (file.size > MAX_IMAGE_BYTES) return null;

  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const result = e.target?.result;
      if (typeof result === 'string') {
        resolve({ id: uid('img'), name: file.name, dataUrl: result, size: file.size, type: file.type });
      } else {
        resolve(null);
      }
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

export function makeTextAttachment(content: string): AttachedText {
  return {
    id: uid('txt'),
    name: `Pasted Text (${content.length.toLocaleString()} chars)`,
    content,
    size: content.length,
  };
}
