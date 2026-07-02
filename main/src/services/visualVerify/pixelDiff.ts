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
 * difference (with a small anti-aliasing noise tolerance) aggregated as a
 * WORST-TILE score: the image is partitioned into a fixed tile grid, each tile
 * gets its own mean normalized channel difference, and the overall score is the
 * MINIMUM per-tile similarity. This keeps a localized fully-changed region from
 * being diluted by an unchanged majority — the worst tile decides — while a
 * near-identical render (sub-tolerance AA noise spread thinly) still scores ~1.0.
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
 * The side length (px) of a square comparison tile. The image is partitioned into a
 * grid of TILE_SIZE×TILE_SIZE tiles (edge tiles may be smaller); each tile is scored
 * independently and the overall score is the MINIMUM tile similarity. Small enough
 * that a localized regression fully saturates at least one tile (driving its
 * similarity toward 0), large enough that thinly-spread sub-tolerance AA noise never
 * dominates any single tile.
 */
export const TILE_SIZE = 32;

/**
 * Compute a structural-similarity-style score in [0, 1] between two decoded RGBA
 * bitmaps. 1.0 = identical (or differ only within the AA-noise tolerance).
 *
 * WORST-TILE metric: the overlapping image area is partitioned into a grid of
 * TILE_SIZE×TILE_SIZE tiles (edge tiles may be smaller). For each tile we compute
 * `1 - meanNormalizedChannelDifference` over the RGB channels (alpha is ignored — an
 * opaque screenshot's alpha is a constant 255 and contributes noise), with
 * per-channel differences at/under AA_NOISE_TOLERANCE zeroed out. The FINAL score is
 * the MINIMUM per-tile similarity — the worst tile decides. A fully-changed localized
 * region drives its tile(s) toward 0 (so the overall score falls far below any sane
 * threshold and cannot be diluted by the unchanged majority), while a true
 * near-identical render (AA jitter under tolerance everywhere) still scores ~1.0.
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
  const { width, height } = a;
  const pixels = width * height;
  if (pixels === 0) return 0;
  const needed = pixels * 4;
  // Defensive: a buffer shorter than its declared dimensions cannot be compared.
  if (aData.length < needed || bData.length < needed) return 0;

  let worst = 1;
  for (let ty = 0; ty < height; ty += TILE_SIZE) {
    const yEnd = Math.min(ty + TILE_SIZE, height);
    for (let tx = 0; tx < width; tx += TILE_SIZE) {
      const xEnd = Math.min(tx + TILE_SIZE, width);
      let tileDiff = 0;
      for (let y = ty; y < yEnd; y++) {
        let i = (y * width + tx) * 4;
        for (let x = tx; x < xEnd; x++, i += 4) {
          // RGB only (skip alpha at +3).
          for (let c = 0; c < 3; c++) {
            const diff = Math.abs(aData[i + c] - bData[i + c]);
            if (diff > tolerance) tileDiff += diff;
          }
        }
      }
      // Normalize per tile: max accumulated diff is (RGB channels) * 255 per pixel.
      const tilePixels = (xEnd - tx) * (yEnd - ty);
      const tileScore = 1 - tileDiff / (tilePixels * 3 * 255);
      if (tileScore < worst) worst = tileScore;
    }
  }
  // Clamp into [0, 1] against any float drift.
  return worst < 0 ? 0 : worst > 1 ? 1 : worst;
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
