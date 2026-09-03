/**
 * GuidedLeader — the design canvas's dashed, curved arrow from a guided
 * callout to the shell element it describes, with a filled arrowhead. An
 * S-curve that leaves the callout's numbered chip to the LEFT and lands on the
 * target's right edge (Sidebar targets), or leaves the callout CARD's right
 * edge and lands on the target's left edge (AgentRail targets) — picked by
 * where the target sits relative to the card. Rendered as a fixed, pointer-transparent SVG overlay
 * portalled onto <body>, so it can cross the centre → Sidebar boundary.
 *
 * Targets are found by `[data-guided-target="<key>"]` (see GUIDED_TARGETS);
 * the host element declares the attribute unconditionally and this component
 * decides whether anything shows. Geometry is re-measured each animation
 * frame while mounted — cheap (two getBoundingClientRect calls) and it
 * follows Sidebar resizes, scrolls, and layout shifts without a listener per
 * cause. Nothing renders until both boxes have a size (jsdom, or a target
 * that has not mounted yet).
 */
import { useEffect, useId, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';

/** The shell elements guided callouts may point at. */
export const GUIDED_TARGETS = {
  /** The Sidebar empty state's "Add Project" button (no-project step 9). */
  addProject: 'add-project',
  /** The guided project's row in the project tree (step 9). */
  projectRow: 'project-row',
  /** The guided project's "Start new session" button (step 9). */
  startSession: 'start-session',
  /** The Sidebar's Human review item (step 14). */
  humanReview: 'human-review',
  /** The AgentRail's header (step 12). */
  assistantHeader: 'assistant-header',
  /** The AgentRail's composer (step 12). */
  assistantComposer: 'assistant-composer',
} as const;

export type GuidedTarget = (typeof GUIDED_TARGETS)[keyof typeof GUIDED_TARGETS];

export interface GuidedLeaderProps {
  /** The callout chip the arrow leaves from when pointing left. */
  from: RefObject<HTMLElement | null>;
  /** The callout card the arrow leaves from when pointing right. */
  card: RefObject<HTMLElement | null>;
  /** Which shell element the arrow lands on. */
  to: GuidedTarget;
  testId?: string;
}

interface Geometry {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  /** +1 when the arrow travels right (rail target), -1 when left (Sidebar target). */
  dir: 1 | -1;
}

const STROKE = 'var(--color-interactive-primary)';

function measure(
  from: HTMLElement | null,
  card: HTMLElement | null,
  to: GuidedTarget,
): Geometry | null {
  const target = document.querySelector<HTMLElement>(`[data-guided-target="${to}"]`);
  if (from === null || card === null || target === null) return null;
  const a = from.getBoundingClientRect();
  const c = card.getBoundingClientRect();
  const b = target.getBoundingClientRect();
  if (a.width === 0 || a.height === 0 || c.width === 0 || b.width === 0 || b.height === 0) return null;
  const ty = b.top + b.height / 2;
  if (b.left + b.width / 2 > c.left + c.width / 2) {
    // Rightward: card's right edge → target's left edge.
    return { sx: c.right + 4, sy: a.top + a.height / 2, tx: b.left - 6, ty, dir: 1 };
  }
  return { sx: a.left - 4, sy: a.top + a.height / 2, tx: b.right + 6, ty, dir: -1 };
}

function sameGeometry(x: Geometry | null, y: Geometry | null): boolean {
  if (x === null || y === null) return x === y;
  return x.sx === y.sx && x.sy === y.sy && x.tx === y.tx && x.ty === y.ty && x.dir === y.dir;
}

export function GuidedLeader({ from, card, to, testId }: GuidedLeaderProps): React.JSX.Element | null {
  const [geo, setGeo] = useState<Geometry | null>(null);
  const markerId = useId();

  useEffect(() => {
    let frame = 0;
    let last: Geometry | null = null;
    const tick = (): void => {
      const next = measure(from.current, card.current, to);
      if (!sameGeometry(next, last)) {
        last = next;
        setGeo(next);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [from, card, to]);

  if (geo === null) return null;

  // Same curve as the design canvas: leave horizontally, arrive horizontally
  // (control points 50px past the source, 45px before the target).
  const d =
    `M ${geo.sx} ${geo.sy} C ${geo.sx + 50 * geo.dir} ${geo.sy}, ` +
    `${geo.tx - 45 * geo.dir} ${geo.ty}, ${geo.tx} ${geo.ty}`;

  return createPortal(
    <svg
      aria-hidden="true"
      data-testid={testId}
      className="pointer-events-none fixed inset-0 z-50 h-screen w-screen"
    >
      <defs>
        <marker id={markerId} markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
          <path d="M0 0 L8 4 L0 8 z" fill={STROKE} />
        </marker>
      </defs>
      <path
        d={d}
        fill="none"
        stroke={STROKE}
        strokeWidth="1.6"
        strokeDasharray="5 4"
        markerEnd={`url(#${markerId})`}
      />
    </svg>,
    document.body,
  );
}
