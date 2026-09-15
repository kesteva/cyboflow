/**
 * Unit tests for the composer → wire image conversion.
 *
 * The assistant cannot `Read` a cited path (it spawns with `tools: []`), so an
 * attachment that fails to narrow here is one the model would never see. These
 * pin that every rejection is a `null` the caller can surface, never a silently
 * malformed block.
 */
import { describe, it, expect } from 'vitest';
import type { AttachedImage } from '../cyboflow/unified/attachments';
import { isSendableImage, toAgentThreadImageAttachment } from './agentImageAttachments';

function attached(overrides: Partial<AttachedImage> = {}): AttachedImage {
  return {
    id: 'img_1',
    name: 'shot.png',
    dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    size: 12,
    type: 'image/png',
    ...overrides,
  };
}

describe('toAgentThreadImageAttachment', () => {
  it('strips the data-URL prefix and keeps the raw base64 payload', () => {
    expect(toAgentThreadImageAttachment(attached())).toEqual({
      name: 'shot.png',
      mediaType: 'image/png',
      base64: 'iVBORw0KGgo=',
    });
  });

  it('accepts every media type the Anthropic image block supports', () => {
    for (const mediaType of ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const) {
      const result = toAgentThreadImageAttachment(
        attached({ dataUrl: `data:${mediaType};base64,AAAA`, type: mediaType }),
      );
      expect(result?.mediaType).toBe(mediaType);
    }
  });

  it('rejects an image type outside that set (SVG, HEIC, BMP)', () => {
    for (const mediaType of ['image/svg+xml', 'image/heic', 'image/bmp']) {
      expect(
        toAgentThreadImageAttachment(attached({ dataUrl: `data:${mediaType};base64,AAAA` })),
      ).toBeNull();
    }
  });

  it('rejects a non-base64 data URL and an empty payload', () => {
    expect(toAgentThreadImageAttachment(attached({ dataUrl: 'data:image/png,%89PNG' }))).toBeNull();
    expect(toAgentThreadImageAttachment(attached({ dataUrl: 'data:image/png;base64,' }))).toBeNull();
    expect(toAgentThreadImageAttachment(attached({ dataUrl: 'not-a-data-url' }))).toBeNull();
  });

  it('keeps a base64 payload containing newlines intact (the `s` flag)', () => {
    const result = toAgentThreadImageAttachment(
      attached({ dataUrl: 'data:image/png;base64,AAAA\nBBBB' }),
    );
    expect(result?.base64).toBe('AAAA\nBBBB');
  });
});

describe('isSendableImage', () => {
  it('mirrors whether the conversion succeeds', () => {
    expect(isSendableImage(attached())).toBe(true);
    expect(isSendableImage(attached({ dataUrl: 'data:image/svg+xml;base64,AAAA' }))).toBe(false);
  });
});
