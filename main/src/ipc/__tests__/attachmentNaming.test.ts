/**
 * Unit tests for main/src/ipc/attachmentNaming.ts — the shared naming/shape
 * helpers behind the GitHub #18 composer-attachment IPC hardening.
 *
 * Covered:
 *  - isPendingAttachmentOwner accepts only the exact shape the two minting
 *    sites produce (pending_<base36>), rejecting anything a traversal payload
 *    could smuggle in via the `pending_` prefix.
 *  - attachmentExtension prefers the original filename's extension, falls
 *    back to a SANITIZED mime subtype (alnum-only, length-bounded — never a
 *    raw '/' or '.' from a hostile subtype), and finally to the caller's
 *    default.
 */
import { describe, it, expect } from 'vitest';
import { attachmentExtension, isPendingAttachmentOwner, sanitizeExtension } from '../attachmentNaming';

describe('isPendingAttachmentOwner', () => {
  it('accepts the exact shape the minting sites produce', () => {
    expect(isPendingAttachmentOwner('pending_k3j4h5g6')).toBe(true);
  });

  it.each([
    'pending_/../../../x',
    'pending_../../../../x',
    'pending_',
    'pending_a/b',
    'pending_a\\b',
    'abc',
  ])('rejects %s', (id) => {
    expect(isPendingAttachmentOwner(id)).toBe(false);
  });
});

describe('attachmentExtension', () => {
  it('prefers the original filename extension over the mime type', () => {
    expect(attachmentExtension('shot.svg', 'image/svg+xml', 'png')).toBe('svg');
  });

  it('falls back to a sanitized mime subtype when no filename extension is present', () => {
    expect(attachmentExtension(undefined, 'image/svg+xml', 'png')).toBe('svgxml');
  });

  it('sanitizes a hostile mime subtype to alnum-only, with no "/" or "."', () => {
    const ext = attachmentExtension(undefined, 'image/../../etc/passwd', 'png');
    expect(ext).toBe('etcpasswd');
    expect(ext).not.toContain('/');
    expect(ext).not.toContain('.');
  });

  it('resolves a plain mime type to its subtype', () => {
    expect(attachmentExtension(undefined, 'image/png', 'png')).toBe('png');
  });

  it('falls back to the caller-supplied default when both name and mime are empty', () => {
    expect(attachmentExtension('', '', 'png')).toBe('png');
  });

  it('caps a long mime subtype at MAX_EXTENSION_LENGTH', () => {
    const longSubtype = 'a'.repeat(40);
    const ext = attachmentExtension(undefined, `image/${longSubtype}`, 'png');
    expect(ext).toBe('a'.repeat(12));
    expect(ext.length).toBe(12);
  });
});

describe('sanitizeExtension', () => {
  it('strips non-alphanumeric characters', () => {
    expect(sanitizeExtension('../../etc/passwd')).toBe('etcpasswd');
  });
});
