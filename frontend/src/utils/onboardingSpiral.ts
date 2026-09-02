/**
 * Spiral-reveal geometry — the pure half of the onboarding wrapper.
 *
 * Kept out of OnboardingSpiralReveal.tsx so that file exports a component and
 * nothing else (fast refresh degrades to a full reload otherwise, which is
 * exactly wrong for a surface whose whole point is motion you tune by eye).
 */
import { ONBOARDING_HANDOFF_STEP } from './onboarding';

/** Tiles per side. 6×6 = 36 tiles ≈ 6 per band across the 6 transitions. */
export const SPIRAL_GRID = 6;
export const SPIRAL_TILE_COUNT = SPIRAL_GRID * SPIRAL_GRID;

/**
 * The step at which the wrapper is fully peeled: the handoff card ("You're set
 * up"), the LAST modal step. Transitions 0→1→…→6 each peel ~1/6 of the sheet,
 * so the sheet is gone exactly as the tour's modal run ends; the guided steps
 * (7, 8) sit on the bare surface with nothing left to unwrap.
 *
 * A run that SKIPS the conditional Default-agent step (2) peels two bands in one
 * transition; the wrapper is a progress flourish, not a step counter, so landing
 * fully open on the same step is what matters.
 */
export const REVEAL_COMPLETE_STEP = ONBOARDING_HANDOFF_STEP;

/**
 * Spiral rank per tile: `ranks[flatIndex]` = that tile's position in a clockwise
 * walk starting at the top-left corner (right along the top edge, down the right
 * edge, left along the bottom, up the left, then inward one ring and repeat).
 * Tiles peel in ascending rank, so the wrapper unwinds from the outside in.
 */
export function spiralRanks(grid: number): number[] {
  const ranks = new Array<number>(grid * grid).fill(0);
  let top = 0;
  let bottom = grid - 1;
  let left = 0;
  let right = grid - 1;
  let rank = 0;
  while (top <= bottom && left <= right) {
    for (let c = left; c <= right; c++) ranks[top * grid + c] = rank++;
    top++;
    for (let r = top; r <= bottom; r++) ranks[r * grid + right] = rank++;
    right--;
    if (top <= bottom) {
      for (let c = right; c >= left; c--) ranks[bottom * grid + c] = rank++;
      bottom--;
    }
    if (left <= right) {
      for (let r = bottom; r >= top; r--) ranks[r * grid + left] = rank++;
      left++;
    }
  }
  return ranks;
}

/**
 * Fraction of the wrapper that should be gone at `step`, clamped to [0,1].
 * A function of the LIVE step, not maxVisitedStep — Back re-wraps its band, so
 * the wrapping reads as a direct progress indicator.
 */
export function revealFraction(step: number): number {
  if (step <= 0) return 0;
  if (step >= REVEAL_COMPLETE_STEP) return 1;
  return step / REVEAL_COMPLETE_STEP;
}

/** How many tiles are peeled at `step` — the boundary of the spiral walk. */
export function hiddenTileCount(step: number, tileCount: number = SPIRAL_TILE_COUNT): number {
  return Math.round(revealFraction(step) * tileCount);
}
