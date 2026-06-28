/**
 * pixelDiff tests — the zero-dep SSIM/pixel pre-diff math (no Electron).
 *
 * The comparison is exercised on raw RGBA buffers (compareBitmaps) and through the
 * file path (comparePngFiles) with an INJECTED fake decoder, so nothing here
 * touches nativeImage. Cases (per the S5 testPlan):
 *   - identical buffers          -> 1.0
 *   - fully different            -> ~0
 *   - small AA noise             -> stays above the match threshold
 *   - mismatched dimensions      -> 0 (definite mismatch, no throw)
 *   - undecodable file           -> 0 (no throw)
 */
import { describe, it, expect } from 'vitest';
import {
  compareBitmaps,
  comparePngFiles,
  DEFAULT_BASELINE_MATCH_THRESHOLD,
  AA_NOISE_TOLERANCE,
  type RgbaBitmap,
  type PngDecoder,
} from '../pixelDiff';

/** Build a w*h RGBA bitmap, filling every pixel with [r,g,b,a]. */
function solid(width: number, height: number, rgba: [number, number, number, number]): RgbaBitmap {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgba[0];
    data[i * 4 + 1] = rgba[1];
    data[i * 4 + 2] = rgba[2];
    data[i * 4 + 3] = rgba[3];
  }
  return { width, height, data };
}

describe('pixelDiff.compareBitmaps', () => {
  it('returns 1.0 for byte-identical buffers', () => {
    const a = solid(8, 8, [120, 130, 140, 255]);
    const b = solid(8, 8, [120, 130, 140, 255]);
    expect(compareBitmaps(a, b)).toBe(1);
  });

  it('returns ~0 for fully opposite buffers (black vs white)', () => {
    const black = solid(8, 8, [0, 0, 0, 255]);
    const white = solid(8, 8, [255, 255, 255, 255]);
    const score = compareBitmaps(black, white);
    expect(score).toBeLessThan(0.01);
    expect(score).toBeGreaterThanOrEqual(0);
  });

  it('keeps a small AA-noise difference ABOVE the match threshold', () => {
    const base = solid(16, 16, [128, 128, 128, 255]);
    // Jitter every channel by exactly the AA tolerance — should be zeroed out.
    const jittered = solid(16, 16, [128 + AA_NOISE_TOLERANCE, 128, 128 - AA_NOISE_TOLERANCE, 255]);
    const score = compareBitmaps(base, jittered);
    expect(score).toBe(1); // within-tolerance diffs are ignored entirely
    expect(score).toBeGreaterThanOrEqual(DEFAULT_BASELINE_MATCH_THRESHOLD);
  });

  it('a few pixels just over tolerance still scores above threshold (not a full mismatch)', () => {
    const base = solid(32, 32, [100, 100, 100, 255]);
    const data = Buffer.from(base.data);
    // Bump ONE pixel's red channel well past tolerance.
    data[0] = 255;
    const nudged: RgbaBitmap = { width: 32, height: 32, data };
    const score = compareBitmaps(base, nudged);
    expect(score).toBeGreaterThan(DEFAULT_BASELINE_MATCH_THRESHOLD);
    expect(score).toBeLessThan(1);
  });

  it('returns 0 for mismatched dimensions (never throws)', () => {
    const a = solid(8, 8, [10, 20, 30, 255]);
    const b = solid(8, 9, [10, 20, 30, 255]);
    expect(() => compareBitmaps(a, b)).not.toThrow();
    expect(compareBitmaps(a, b)).toBe(0);
  });

  it('ignores the alpha channel (alpha-only difference is still a match)', () => {
    const opaque = solid(8, 8, [50, 60, 70, 255]);
    const transparent = solid(8, 8, [50, 60, 70, 0]);
    expect(compareBitmaps(opaque, transparent)).toBe(1);
  });
});

describe('pixelDiff.comparePngFiles', () => {
  it('compares via the injected decoder (identical -> 1.0)', () => {
    const bmp = solid(4, 4, [200, 100, 50, 255]);
    const decoder: PngDecoder = () => bmp;
    expect(comparePngFiles('/cap.png', '/base.png', { decoder })).toBe(1);
  });

  it('returns 0 when either file fails to decode (no throw)', () => {
    const decoder: PngDecoder = (p) => (p === '/cap.png' ? solid(4, 4, [1, 2, 3, 255]) : null);
    expect(() => comparePngFiles('/cap.png', '/missing.png', { decoder })).not.toThrow();
    expect(comparePngFiles('/cap.png', '/missing.png', { decoder })).toBe(0);
  });

  it('returns 0 on mismatched dimensions through the file path', () => {
    const decoder: PngDecoder = (p) =>
      p === '/cap.png' ? solid(4, 4, [9, 9, 9, 255]) : solid(8, 8, [9, 9, 9, 255]);
    expect(comparePngFiles('/cap.png', '/base.png', { decoder })).toBe(0);
  });
});
