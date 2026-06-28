/**
 * pixelDiff — a ZERO-DEP pixel/SSIM-style pre-diff for the L5 golden-baseline tier
 * (see docs/visual-verification-design.md §"Golden baselines"). It compares a
 * freshly-captured PNG against an accepted baseline PNG and returns a similarity
 * score in [0, 1] (1.0 = identical). The scheduler gates the paid VLM on this: a
 * score >= the baseline-match threshold is a cheap deterministic PASS (no vision
 * call); below it the request falls through to the VlmJudge.
 *
 * DELIBERATELY no heavy image dependency (no pixelmatch / sharp / ssim.js) — those
 * carry native-binary / ABI / packaging baggage exactly like better-sqlite3, which
 * we will NOT add for a pre-diff. PNGs are decoded to a raw RGBA bitmap via
 * Electron's `nativeImage` (already in the runtime) behind the injectable
 * `PngDecoder` seam, and the comparison itself is a tiny hand-rolled per-channel
 * mean-difference with a small anti-aliasing noise tolerance.
 *
 * This file lives under main/src/services/* and MAY import 'electron' (the default
 * decoder) — it is the concrete half injected into the (electron-free) scheduler
 * as a narrow function. The scheduler never imports this; index.ts wires it in.
 * The PngDecoder seam keeps the math unit-testable on raw buffers with no Electron.
 */
import { nativeImage } from 'electron';

/**
 * A decoded raw bitmap: a tightly-packed RGBA byte buffer (4 bytes/pixel, row-major)
 * plus its dimensions. `data.length` MUST equal `width * height * 4`.
 */
export interface RgbaBitmap {
  width: number;
  height: number;
  data: Buffer | Uint8Array;
}

/**
 * Decode a PNG file at `absPath` to a raw RGBA bitmap, or null when it cannot be
 * read/decoded (missing file, not an image, empty bitmap). NEVER throws — a decode
 * failure is a "cannot compare" signal the caller treats as a non-match (score 0),
 * exactly like a dimension mismatch. Injected so the comparison math is testable
 * without Electron; the default uses nativeImage.
 */
export type PngDecoder = (absPath: string) => RgbaBitmap | null;

/**
 * The default Electron-backed decoder: nativeImage.createFromPath(...).toBitmap()
 * yields a raw RGBA buffer (Electron's documented bitmap format). Returns null
 * (never throws) on any failure so the scheduler's pre-diff degrades to "no match
 * → run the VLM" rather than crashing the drain loop.
 */
export const nativeImageDecoder: PngDecoder = (absPath) => {
  try {
    const img = nativeImage.createFromPath(absPath);
    if (img.isEmpty()) return null;
    const { width, height } = img.getSize();
    if (width <= 0 || height <= 0) return null;
    const data = img.toBitmap();
    if (data.length < width * height * 4) return null;
    return { width, height, data };
  } catch {
    return null;
  }
};

/**
 * The default baseline-match threshold (decision #5). A captured PNG scoring at or
 * above this against its baseline is a deterministic PASS that skips the VLM; below
 * it the request falls through to the vision judge. Chosen high enough that only a
 * near-pixel-identical render (modulo sub-threshold AA noise) short-circuits the
 * judge — a genuine visual change always reaches the VLM.
 */
export const DEFAULT_BASELINE_MATCH_THRESHOLD = 0.98;

/**
 * Per-channel absolute difference (0..255) at or below which two pixels are treated
 * as EQUAL — the anti-aliasing noise tolerance. Sub-pixel AA / font-hinting jitter
 * routinely differs by a few levels between otherwise-identical renders; counting
 * those as mismatches would push a true match below threshold and waste a vision
 * call. A difference ABOVE this still contributes its full normalized magnitude.
 */
export const AA_NOISE_TOLERANCE = 6;

/**
 * Compute a structural-similarity-style score in [0, 1] between two decoded RGBA
 * bitmaps. 1.0 = identical (or differ only within the AA-noise tolerance). The
 * score is `1 - meanNormalizedChannelDifference` over the RGB channels (alpha is
 * ignored — an opaque screenshot's alpha is a constant 255 and contributes noise),
 * with per-channel differences at/under AA_NOISE_TOLERANCE zeroed out.
 *
 * MISMATCHED DIMENSIONS → 0 (a definite mismatch; never throws): two renders of
 * different sizes are not the same view, so the VLM must judge them.
 */
export function compareBitmaps(
  a: RgbaBitmap,
  b: RgbaBitmap,
  tolerance: number = AA_NOISE_TOLERANCE,
): number {
  if (a.width !== b.width || a.height !== b.height) return 0;
  const aData = a.data;
  const bData = b.data;
  const pixels = a.width * a.height;
  if (pixels === 0) return 0;
  const needed = pixels * 4;
  // Defensive: a buffer shorter than its declared dimensions cannot be compared.
  if (aData.length < needed || bData.length < needed) return 0;

  let totalDiff = 0;
  for (let i = 0; i < needed; i += 4) {
    // RGB only (skip alpha at +3).
    for (let c = 0; c < 3; c++) {
      const diff = Math.abs(aData[i + c] - bData[i + c]);
      if (diff > tolerance) totalDiff += diff;
    }
  }
  // Normalize: max possible accumulated diff is (RGB channels) * 255 per pixel.
  const maxDiff = pixels * 3 * 255;
  const score = 1 - totalDiff / maxDiff;
  // Clamp into [0, 1] against any float drift.
  return score < 0 ? 0 : score > 1 ? 1 : score;
}

/**
 * Compare two PNG FILES via the injected decoder and return their similarity in
 * [0, 1]. NEVER throws: if either file fails to decode the result is 0 (treated as
 * "cannot match → run the VLM"), and mismatched dimensions are 0 (definite
 * mismatch). The decoder defaults to nativeImageDecoder; tests inject a fake that
 * returns raw RGBA buffers with no Electron.
 */
export function comparePngFiles(
  capturedPath: string,
  baselinePath: string,
  opts: { decoder?: PngDecoder; tolerance?: number } = {},
): number {
  const decode = opts.decoder ?? nativeImageDecoder;
  const captured = decode(capturedPath);
  const baseline = decode(baselinePath);
  if (!captured || !baseline) return 0;
  return compareBitmaps(captured, baseline, opts.tolerance);
}
