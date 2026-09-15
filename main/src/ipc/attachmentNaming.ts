/**
 * Shared naming/validation helpers for composer + idea file attachments.
 *
 * Consumers:
 *  - main/src/ipc/session.ts — `isPendingAttachmentOwner` gates the `pending_*`
 *    short-circuit in `assertAttachmentOwner` (which both sessions:save-images
 *    and sessions:save-large-text call); `attachmentExtension` names the file
 *    written by sessions:save-images (save-large-text always writes `.txt`).
 *  - main/src/ipc/ideaAttachments.ts — ideas:save-attachments reuses
 *    `sanitizeExtension` / `extensionFromName` in its own extension ladder.
 *
 * The extension ladder (original filename extension, falling back to the MIME
 * subtype, falling back to a caller-supplied default) is intentionally NOT an
 * allowlist. Attachment consumers (the agent reading the file,
 * ideas:load-attachments' thumbnail mime lookup) dispatch on the extension, so
 * silently renaming an accepted `image/avif`, `image/tiff`, or `image/svg+xml`
 * upload to `.png` would lie about the file's actual encoding. Instead every
 * candidate is sanitized to a short alphanumeric token before it ever reaches a
 * path segment, which is enough to keep it inert as a traversal vector while
 * preserving its meaning.
 */

/** Bounds a derived extension's length regardless of input (e.g. a long MIME subtype). */
export const MAX_EXTENSION_LENGTH = 12;

/** Reduce to a safe alphanumeric extension, bounded in length. */
export function sanitizeExtension(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9]/g, '').slice(0, MAX_EXTENSION_LENGTH);
}

/** The extension from an original filename (e.g. "report.pdf" -> "pdf"), or '' if absent/unsafe. */
export function extensionFromName(name: string): string {
  const match = /\.([a-zA-Z0-9]+)$/.exec(name);
  return match ? sanitizeExtension(match[1]) : '';
}

/**
 * Resolve the extension to save an attachment under: prefer the original
 * filename's extension, fall back to one derived from the MIME subtype
 * (everything after the type's first `/`, sanitized — so a subtype that itself
 * contains `/` or `.` characters, e.g. a hostile `image/../../etc/passwd`
 * mimeType, still reduces to a short alnum token rather than leaking path
 * separators into the fallback), and finally to the caller-supplied default.
 */
export function attachmentExtension(
  name: string | undefined,
  mimeType: string | undefined,
  fallback: string,
): string {
  const fromName = extensionFromName(name ?? '');
  if (fromName) return fromName;

  const mime = mimeType ?? '';
  const slashIndex = mime.indexOf('/');
  const subtype = slashIndex >= 0 ? mime.slice(slashIndex + 1) : mime;
  const fromMime = sanitizeExtension(subtype);
  if (fromMime) return fromMime;

  return fallback;
}

/**
 * Whether `id` has the exact shape a `pending_*` attachment owner is minted
 * with — an owner key assigned before its backing row exists. The only
 * `pending_*` minting sites in the app produce it as
 * `pending_${Math.random().toString(36).slice(2)}` at:
 *   - frontend/src/components/Backlog/NewTaskDialog.tsx:66
 *   - frontend/src/components/cyboflow/IdeaPickerModal.tsx:110
 * i.e. always `pending_` followed by one or more base36-safe characters, never
 * a path separator or `.`.
 *
 * This is the shape check that closes the composer-attachment traversal
 * bypass: `assertAttachmentOwner` used to skip its ownership check for ANY id
 * starting with `pending_`, so an id like `pending_/../../../x` sailed through
 * unvalidated and was then joined verbatim into the artifacts directory path.
 * Requiring the full minted shape means a malformed pending id no longer
 * short-circuits the check — it falls through to the session/run lookups and
 * is rejected as an unknown owner.
 */
export function isPendingAttachmentOwner(id: string): boolean {
  return /^pending_[A-Za-z0-9_-]+$/.test(id);
}
