/**
 * Unit tests for the Codex image spill.
 *
 * Codex's `turn/start` has no inline-bytes image item — only a URL or a PATH —
 * so the assistant's attachments have to become real files before a Codex turn
 * can see them. These pin the two things that make that safe: a text-only turn
 * spills nothing at all (byte-identical to the pre-attachment path), and the
 * renderer-supplied display name never becomes a path component.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentThreadImageAttachment } from '../../../../../../../shared/types/agentThread';
import { buildCodexTurnInput, spillImageAttachment } from '../imageSpill';

const PNG: AgentThreadImageAttachment = {
  name: 'shot.png',
  mediaType: 'image/png',
  base64: Buffer.from('fake-png-bytes').toString('base64'),
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cyboflow-image-spill-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('spillImageAttachment', () => {
  it('writes the decoded bytes and returns the path', () => {
    const path = spillImageAttachment(dir, PNG);

    expect(readFileSync(path).toString()).toBe('fake-png-bytes');
    expect(path.endsWith('.png')).toBe(true);
  });

  it('maps each accepted media type to its own extension', () => {
    const jpeg = spillImageAttachment(dir, { ...PNG, mediaType: 'image/jpeg' });
    const gif = spillImageAttachment(dir, { ...PNG, mediaType: 'image/gif' });
    const webp = spillImageAttachment(dir, { ...PNG, mediaType: 'image/webp' });

    expect(jpeg.endsWith('.jpg')).toBe(true);
    expect(gif.endsWith('.gif')).toBe(true);
    expect(webp.endsWith('.webp')).toBe(true);
  });

  it('never uses the attachment name as a path component (traversal seam)', () => {
    const path = spillImageAttachment(dir, { ...PNG, name: '../../escaped.png' });

    expect(path.startsWith(dir)).toBe(true);
    expect(path).not.toContain('escaped');
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it('two attachments with the same name land in distinct files', () => {
    const first = spillImageAttachment(dir, PNG);
    const second = spillImageAttachment(dir, PNG);

    expect(first).not.toBe(second);
    expect(readdirSync(dir)).toHaveLength(2);
  });
});

describe('buildCodexTurnInput', () => {
  it('returns null for a text-only turn so the caller sends the bare prompt string', () => {
    expect(buildCodexTurnInput('hello', undefined, dir)).toBeNull();
    expect(buildCodexTurnInput('hello', [], dir)).toBeNull();
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it('builds the text item followed by one localImage item per attachment', () => {
    const input = buildCodexTurnInput('look at this', [PNG, { ...PNG, name: 'other.png' }], dir);

    expect(input).not.toBeNull();
    expect(input![0]).toEqual({ type: 'text', text: 'look at this', text_elements: [] });
    expect(input!.slice(1).map((item) => item.type)).toEqual(['localImage', 'localImage']);
    expect(readdirSync(dir)).toHaveLength(2);
  });
});
