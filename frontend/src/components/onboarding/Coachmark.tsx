import { useEffect, useRef, useState } from 'react';
import { ONBOARDING_ANCHOR_ATTR, ONBOARDING_ANCHORS, ONBOARDING_STEP_COUNT } from '../../utils/onboarding';
import { ONBOARDING_TITLES } from './copy';
import { OnboardingDots } from './OnboardingDots';

/**
 * Coachmark — the anchored popover for every coach step (4-9). Resolves its
 * target exclusively by the `data-onboarding` attribute, tracks the target rect
 * on a rAF loop (robust to layout shifts / scroll), and draws a 4-rectangle
 * scrim that leaves a transparent hole over the target so the real element stays
 * clickable — no z-index mutation of the (cross-lane) target is required.
 *
 * Two flavors, per the spec's `pointer` flag:
 * - "try it" do-steps (4/8/9): a capture-phase document click listener detects
 *   the real action on the target and calls anchorActioned(); no Next button.
 * - pointer steps (5-7, the wizard-Configure trio): informational — a Next
 *   button advances via onNext(); interacting with the anchored control (e.g.
 *   picking a permission option through the hole) never advances.
 *
 * If the anchor is absent (e.g. the wizard hasn't mounted the card yet) the
 * overlay renders nothing and retries next frame — the gate's step-4 wizard
 * precondition re-creates the anchor.
 */
interface CoachmarkProps {
  step: number;
  maxVisitedStep: number;
  onBack: () => void;
  onSkip: () => void;
  onGoTo: (step: number) => void;
  onAnchorActioned: () => void;
  onNext: () => void;
}

/**
 * Which popover edge carries the arrow — 'left' puts the popover to the RIGHT
 * of the anchor, 'right' puts it to the LEFT, 'up' puts it below. Horizontal
 * sides are a preference: they auto-flip when the preferred side has no room,
 * so the viewport clamp never drags the popover back over its own anchor.
 */
type ArrowSide = 'left' | 'up' | 'right';

interface CoachSpec {
  anchorId: string;
  arrow: ArrowSide;
  /** Informational pointer: Next-advanced, anchor interaction never advances. */
  pointer?: boolean;
  body: React.ReactNode;
}

const POPOVER_WIDTH = 298;
const HOLE_PAD = 6;

const COACH: Record<number, CoachSpec> = {
  4: {
    // The card sits near the wizard's right edge — popover goes to its LEFT.
    anchorId: ONBOARDING_ANCHORS.quickSessionCard,
    arrow: 'right',
    body: (
      <>
        Spin up a <b className="text-[var(--paper)]">quick session</b> — an ad-hoc Claude Code chat in its own worktree.
        Pick the <b className="text-[var(--paper)]">Quick Session</b> card to begin.
      </>
    ),
  },
  5: {
    anchorId: ONBOARDING_ANCHORS.sessionPermission,
    arrow: 'up',
    pointer: true,
    body: (
      <>
        How much this session's agent may do <b className="text-[var(--paper)]">without asking you</b>. It starts from
        the default you picked earlier — change it here for this session only. Anything blocked lands in Human review.
      </>
    ),
  },
  6: {
    anchorId: ONBOARDING_ANCHORS.modelSelect,
    arrow: 'up',
    pointer: true,
    body: (
      <>
        The Claude model powering this session. <b className="text-[var(--paper)]">Opus</b> is a highly capable
        default; smaller models are faster and cheaper for lighter tasks.
      </>
    ),
  },
  7: {
    anchorId: ONBOARDING_ANCHORS.substrateSelect,
    arrow: 'up',
    pointer: true,
    body: (
      <>
        How the agent runs under the hood: the bundled <b className="text-[var(--paper)]">SDK</b> (default — nothing to
        install) or your own Claude Code CLI in an interactive terminal. Keep SDK for now, then hit{' '}
        <b className="text-[var(--paper)]">Start quick session</b> below.
      </>
    ),
  },
  8: {
    anchorId: ONBOARDING_ANCHORS.shipChip,
    arrow: 'up',
    body: (
      <>
        Drop a structured pipeline onto your session. Pick <b className="text-[var(--paper)]">/ship</b> — it plans an
        idea and executes it end to end, pausing at your checkpoints.
      </>
    ),
  },
  9: {
    anchorId: ONBOARDING_ANCHORS.humanReview,
    arrow: 'left',
    body: (
      <>
        Open the <b className="text-[var(--paper)]">Human review</b> queue to watch /ship run. Approvals and decisions
        collect here — blocking items pause the run until you decide.
        <span className="mt-2 block text-[var(--paper)]/60">j/k move · y approve · n reject</span>
      </>
    ),
  },
};

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function rectsEqual(a: Rect | null, b: Rect | null): boolean {
  if (a === null || b === null) return a === b;
  return a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;
}

/** Frames without an anchor before the centered fallback shell appears (~0.5s). */
const ANCHOR_LOST_FRAMES = 30;

export function Coachmark({
  step,
  maxVisitedStep,
  onBack,
  onSkip,
  onGoTo,
  onAnchorActioned,
  onNext,
}: CoachmarkProps): React.JSX.Element | null {
  const spec = COACH[step];
  const [rect, setRect] = useState<Rect | null>(null);
  const rectRef = useRef<Rect | null>(null);
  // Anchor-lost fallback: a coach step can be re-entered (Back from step 9,
  // dot navigation) after its target unmounted — e.g. the /ship chip disappears
  // once the run takes over the canvas. The tour must NEVER render nothing
  // while 'active' (all its controls live inside this component), so after a
  // grace period we show a centered shell with the same body + Back/Skip/dots.
  const [anchorLost, setAnchorLost] = useState(false);
  const missingFramesRef = useRef(0);

  // Track the target rect every frame; only re-render when it actually moves.
  useEffect(() => {
    if (!spec) return;
    let raf = 0;
    const tick = (): void => {
      const el = document.querySelector(`[${ONBOARDING_ANCHOR_ATTR}="${spec.anchorId}"]`);
      let next: Rect | null = null;
      if (el) {
        const r = el.getBoundingClientRect();
        next = { top: r.top, left: r.left, width: r.width, height: r.height };
        missingFramesRef.current = 0;
        setAnchorLost(false);
      } else {
        missingFramesRef.current += 1;
        if (missingFramesRef.current >= ANCHOR_LOST_FRAMES) setAnchorLost(true);
      }
      if (!rectsEqual(rectRef.current, next)) {
        rectRef.current = next;
        setRect(next);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [spec]);

  // Capture-phase detection of the real action on the target — do-steps only.
  // Pointer steps leave the anchored control freely usable (picking a
  // permission option / model must not advance the tour).
  useEffect(() => {
    if (!spec || spec.pointer) return;
    const onClick = (e: MouseEvent): void => {
      const el = document.querySelector(`[${ONBOARDING_ANCHOR_ATTR}="${spec.anchorId}"]`);
      if (el && e.target instanceof Node && el.contains(e.target)) onAnchorActioned();
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [spec, onAnchorActioned]);

  if (!spec || (rect === null && !anchorLost)) return null;

  const popoverInner = (
    <>
      <div className="px-[17px] pb-1 pt-[15px]">
        <div className="mb-1.5 text-[9px] font-bold uppercase tracking-[.16em] text-interactive">
          Step {step + 1} / {ONBOARDING_STEP_COUNT}
          {!spec.pointer && ' · try it'}
        </div>
        <div className="mb-[7px] text-[15px] font-bold tracking-[-.01em]">{ONBOARDING_TITLES[step]}</div>
        <div className="text-[11px] leading-[1.55] text-[var(--paper)]/80">{spec.body}</div>
        {rect === null && (
          <div className="mt-2 text-[10px] leading-[1.5] text-[var(--paper)]/60">
            The highlighted control isn't on screen right now — use Back to revisit a step, or Skip and resume later
            from the rail.
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 px-[17px] pb-3.5 pt-[11px]">
        <div className="flex flex-1 items-center">
          <OnboardingDots step={step} maxVisitedStep={maxVisitedStep} onGoTo={onGoTo} />
        </div>
        <button
          type="button"
          onClick={onSkip}
          className="border-none bg-transparent px-0.5 py-1.5 text-[9.5px] font-semibold uppercase tracking-[.1em] text-[var(--paper)]/55 transition-colors hover:text-[var(--paper)]"
        >
          Skip
        </button>
        <button
          type="button"
          onClick={onBack}
          className="border border-[var(--paper)]/40 bg-transparent px-2.5 py-[7px] text-[9.5px] font-bold uppercase tracking-[.12em] text-[var(--paper)] transition-colors hover:border-[var(--paper)]"
        >
          Back
        </button>
        {spec.pointer && (
          <button
            type="button"
            onClick={onNext}
            className="border border-transparent bg-[var(--terracotta)] px-2.5 py-[7px] text-[9.5px] font-bold uppercase tracking-[.12em] text-[var(--paper)] transition-opacity hover:opacity-90"
          >
            Next →
          </button>
        )}
      </div>
    </>
  );

  // Anchor-lost fallback: full scrim + the same popover centered, so the tour
  // keeps its Back/Skip/dots controls even when the target has unmounted.
  if (rect === null) {
    return (
      <>
        <div className="pointer-events-auto absolute inset-0 bg-modal-overlay" />
        <div
          role="dialog"
          aria-label={ONBOARDING_TITLES[step]}
          className="pointer-events-auto absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-[var(--ink)] text-[var(--paper)] shadow-[0_24px_60px_rgba(0,0,0,.5)]"
          style={{ width: POPOVER_WIDTH }}
        >
          {popoverInner}
        </div>
      </>
    );
  }

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clampLeft = (l: number): number => Math.min(Math.max(l, 8), Math.max(8, vw - POPOVER_WIDTH - 8));
  const clampTop = (t: number): number => Math.min(Math.max(t, 8), Math.max(8, vh - 190));

  const fitsRightSide = rect.left + rect.width + 14 + POPOVER_WIDTH <= vw - 8;
  const fitsLeftSide = rect.left - 14 - POPOVER_WIDTH >= 8;
  const side: ArrowSide =
    spec.arrow === 'up'
      ? 'up'
      : spec.arrow === 'right'
        ? fitsLeftSide || !fitsRightSide
          ? 'right'
          : 'left'
        : fitsRightSide || !fitsLeftSide
          ? 'left'
          : 'right';

  const sideTop = clampTop(rect.top + rect.height / 2 - 24);
  const pop =
    side === 'up'
      ? { left: clampLeft(rect.left + rect.width / 2 - 30), top: clampTop(rect.top + rect.height + 14) }
      : side === 'right'
        ? { left: clampLeft(rect.left - POPOVER_WIDTH - 14), top: sideTop }
        : { left: clampLeft(rect.left + rect.width + 14), top: sideTop };

  // Transparent hole (padded) that lets clicks reach the real target.
  const hole = {
    top: Math.max(rect.top - HOLE_PAD, 0),
    left: Math.max(rect.left - HOLE_PAD, 0),
    right: Math.min(rect.left + rect.width + HOLE_PAD, vw),
    bottom: Math.min(rect.top + rect.height + HOLE_PAD, vh),
  };
  const scrim = 'absolute bg-modal-overlay pointer-events-auto';

  return (
    <>
      {/* 4-rect scrim leaving the target hole open. */}
      <div className={scrim} style={{ top: 0, left: 0, width: vw, height: hole.top }} />
      <div className={scrim} style={{ top: hole.bottom, left: 0, width: vw, height: vh - hole.bottom }} />
      <div className={scrim} style={{ top: hole.top, left: 0, width: hole.left, height: hole.bottom - hole.top }} />
      <div
        className={scrim}
        style={{ top: hole.top, left: hole.right, width: vw - hole.right, height: hole.bottom - hole.top }}
      />

      {/* Highlight ring over the lifted target (design shadow has no token). */}
      <div
        className="pointer-events-none absolute border-[1.4px] border-interactive"
        style={{
          top: hole.top,
          left: hole.left,
          width: hole.right - hole.left,
          height: hole.bottom - hole.top,
          boxShadow: '0 0 0 3px rgba(201,100,66,.3), 0 12px 30px rgba(0,0,0,.35)',
        }}
      />

      {/* Popover */}
      <div
        role="dialog"
        aria-label={ONBOARDING_TITLES[step]}
        className="pointer-events-auto absolute bg-[var(--ink)] text-[var(--paper)] shadow-[0_24px_60px_rgba(0,0,0,.5)]"
        style={{ left: pop.left, top: pop.top, width: POPOVER_WIDTH }}
      >
        {side === 'left' && (
          <span
            className="absolute"
            style={{
              left: -8,
              top: 24,
              width: 0,
              height: 0,
              borderTop: '8px solid transparent',
              borderBottom: '8px solid transparent',
              borderRight: '8px solid var(--ink)',
            }}
          />
        )}
        {side === 'right' && (
          <span
            className="absolute"
            style={{
              right: -8,
              top: 24,
              width: 0,
              height: 0,
              borderTop: '8px solid transparent',
              borderBottom: '8px solid transparent',
              borderLeft: '8px solid var(--ink)',
            }}
          />
        )}
        {side === 'up' && (
          <span
            className="absolute"
            style={{
              top: -8,
              left: 30,
              width: 0,
              height: 0,
              borderLeft: '8px solid transparent',
              borderRight: '8px solid transparent',
              borderBottom: '8px solid var(--ink)',
            }}
          />
        )}
        {popoverInner}
      </div>
    </>
  );
}
