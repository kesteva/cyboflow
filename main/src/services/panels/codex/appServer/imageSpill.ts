/**
 * Spill the assistant composer's in-memory image attachments to disk so the
 * Codex app-server can read them.
 *
 * The two providers take images by opposite means. The Claude SDK takes an
 * INLINE base64 `image` content block, so nothing ever touches the filesystem
 * there. The Codex app-server's `turn/start` input has no inline-bytes variant
 * at all — its only image items are `image` (a URL) and `localImage` (a PATH,
 * see {@link AppServerUserInput}) — so the bytes must exist as a real file the
 * Codex process can open. This module owns that one asymmetry.
 *
 * Files are written under the app data dir, NEVER a project worktree: the
 * assistant's spawn cwd is its neutral home dir and an attachment is not part
 * of anyone's repo. They are left in place after the turn on purpose — Codex
 * resolves a `localImage` path lazily and a later resumed turn can re-read it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentThreadImageAttachment } from '../../../../../../shared/types/agentThread';
import type { AppServerUserInput } from './protocol';

/** File extension for each accepted media type. */
const EXTENSION_BY_MEDIA_TYPE: Record<AgentThreadImageAttachment['mediaType'], string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * Write one attachment into `dir` under a fresh uuid name and return its
 * absolute path. The attachment's own `name` is display-only and never used as
 * a path component — it is renderer-supplied and would be a traversal seam.
 */
export function spillImageAttachment(dir: string, image: AgentThreadImageAttachment): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${randomUUID()}.${EXTENSION_BY_MEDIA_TYPE[image.mediaType]}`);
  writeFileSync(path, Buffer.from(image.base64, 'base64'));
  return path;
}

/**
 * Build the Codex `turn/start` input for a turn that may carry images.
 *
 * With NO images this returns `null`, and the caller passes the plain prompt
 * string to `startTurn` exactly as before (turnSession wraps a string itself) —
 * so a text-only turn is byte-identical. With images it returns the text item
 * followed by one `localImage` item per spilled file.
 */
export function buildCodexTurnInput(
  prompt: string,
  images: readonly AgentThreadImageAttachment[] | undefined,
  dir: string,
): AppServerUserInput[] | null {
  if (images === undefined || images.length === 0) return null;
  const input: AppServerUserInput[] = [{ type: 'text', text: prompt, text_elements: [] }];
  for (const image of images) {
    input.push({ type: 'localImage', path: spillImageAttachment(dir, image) });
  }
  return input;
}
