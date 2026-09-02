import { useEffect, useMemo, useRef, useState } from 'react';
import {
  hiddenTileCount,
  SPIRAL_GRID,
  spiralRanks,
  REVEAL_COMPLETE_STEP,
} from '../../utils/onboardingSpiral';

/**
 * OnboardingSpiralReveal — the tan wrapper the tour arrives inside.
 *
 * The tour opens fully covered: a SPIRAL_GRID² sheet of opaque tan tiles over
 * the whole viewport, with the step-0 welcome card centered on top of it. Each
 * modal-step advance peels one band of tiles away in a CLOCKWISE SPIRAL
 * starting top-left, so the wrapping unwinds across the modal run as a
 * progress flourish.
 *
 * What it exposes is the bare onboarding surface (App.tsx unmounts the shell
 * for the tour's whole duration), which is why the wrapper is a DARKER paper
 * than the surface: the effect has to read as a material lifting off the page,
 * not cream fading into cream. There is no blur layer for the same reason —
 * a `backdrop-filter` over a flat surface is a GPU pass that softens nothing.
 *
 * The reveal completes at REVEAL_COMPLETE_STEP — the handoff card, the last
 * modal step — so the guided steps (7, 8) never mount under a surviving tile.
 * Past that the component renders null.
 *
 * Progress tracks the LIVE step, not maxVisitedStep: Back visibly re-wraps its
 * band, so the wrapping reads as a direct progress indicator. Skip needs no
 * handling here — the gate unmounts on a non-active status, which is exactly the
 * "snaps open" behaviour.
 *
 * Pointer-events stay off. The modal card above already owns its own full-screen
 * scrim, so input is blocked for every step this component is visible.
 */

/**
 * The wrapper's material. --line (#d8cfb8) is the palette's deepest warm
 * neutral before the ink ramp: the paper primitives (--paper-2/-4) are too
 * close to the --paper surface underneath to read as a separate sheet, while
 * --ink-3 tips into a muddy brown. The --line/--paper primitives are NOT
 * remapped by the `.dark` theme blocks (only the semantic --color-* tokens
 * are), which is deliberate: the wrapping is a physical material, not a themed
 * surface, so a dark-mode user unwraps the same tan sheet.
 *
 * Swap here to retune.
 */
const WRAPPER_COLOR = 'var(--line)';

/**
 * Per-tile peel duration, and the gap between consecutive tiles in a band.
 *
 * STAGGER_MS is what makes the spiral legible as tiles rather than as one wave:
 * a band is ~6 tiles, so at a 26ms gap the whole band was airborne at once and
 * read as a single sheet dissolving. At 95ms the leading tile is most of the way
 * gone before the next commits, so the eye can follow the path around the ring.
 * Band duration works out ~1.1s (5 gaps + one tile's travel).
 */
const TILE_MS = 620;
const STAGGER_MS = 95;
/** Reduced-motion path: one flat cross-fade for the whole band, no stagger. */
const REDUCED_MS = 260;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

export function OnboardingSpiralReveal({ step }: { step: number }): React.JSX.Element | null {
  const reducedMotion = usePrefersReducedMotion();
  const ranks = useMemo(() => spiralRanks(SPIRAL_GRID), []);
  const hidden = hiddenTileCount(step);

  // Previous boundary, so a band's stagger is measured from where the peel
  // actually starts. Going forward the band unwinds in ascending spiral order;
  // going back it re-wraps in reverse, closing back toward the top-left.
  const prevHiddenRef = useRef(hidden);
  const prevHidden = prevHiddenRef.current;
  useEffect(() => {
    prevHiddenRef.current = hidden;
  }, [hidden]);

  if (step >= REVEAL_COMPLETE_STEP) return null;

  const delayFor = (rank: number): number => {
    if (reducedMotion) return 0;
    if (hidden > prevHidden && rank >= prevHidden && rank < hidden) {
      return (rank - prevHidden) * STAGGER_MS;
    }
    if (hidden < prevHidden && rank >= hidden && rank < prevHidden) {
      return (prevHidden - 1 - rank) * STAGGER_MS;
    }
    return 0;
  };

  return (
    <div className="pointer-events-none fixed inset-0" aria-hidden="true" data-testid="onboarding-spiral-reveal">
      <div
        className="absolute inset-0 grid"
        style={{
          gridTemplateColumns: `repeat(${SPIRAL_GRID}, 1fr)`,
          gridTemplateRows: `repeat(${SPIRAL_GRID}, 1fr)`,
        }}
      >
        {ranks.map((rank, flatIndex) => {
          const gone = rank < hidden;
          return (
            <div
              key={flatIndex}
              style={{
                background: WRAPPER_COLOR,
                opacity: gone ? 0 : 1,
                // Scaling the tile down as it goes opens a seam against its
                // neighbours — the tile reads as lifting off rather than fading.
                transform: gone && !reducedMotion ? 'scale(0.86)' : 'scale(1)',
                // Hairline guard: 1fr rounding can leave sub-pixel gaps between
                // tiles that would show the surface through an intact wrapper.
                boxShadow: gone ? 'none' : `0 0 0 0.5px ${WRAPPER_COLOR}`,
                transition: reducedMotion
                  ? `opacity ${REDUCED_MS}ms ease-out`
                  : `opacity ${TILE_MS}ms ease-out, transform ${TILE_MS}ms cubic-bezier(.22,.61,.36,1), box-shadow ${TILE_MS}ms linear`,
                transitionDelay: `${delayFor(rank)}ms`,
                willChange: 'opacity, transform',
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
