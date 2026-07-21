/**
 * AgentRail — shell for the global "cyboflow assistant" rail (S1.1).
 *
 * Mounted by App.tsx as a flex SIBLING of the view-switch div, gated by
 * {@link shouldShowAgentRail} (`view !== 'session' && view !== 'wizard'`) so
 * it appears on every landing-family surface (home, backlog, insights,
 * workflows, verify-queue, experiment-comparison) but not the session
 * workspace, which keeps its own `RunRightRail`, or the new-flow wizard.
 * See docs/proposals/GLOBAL-AGENT-PLAN.md §2.6 / §3 S1.1.
 *
 * S1.1 shipped the layout: header/body/footer chrome + collapse/resize. S1.2
 * wires the body to the real `agentThread` tRPC router (S0.6) — the thread
 * transcript, composer, and suggestion chips now render through
 * {@link AgentThreadView} (which itself renders through the shared
 * `UnifiedChatView`). Proposal cards land in S1.3.
 *
 * Collapse + resize mirror `RunRightRail` (components/cyboflow/RunRightRail.tsx):
 * a left-edge drag handle using delta-from-drag-start math — the rail is
 * right-anchored, so dragging the handle LEFT (smaller clientX) widens it —
 * and the same absolute/viewport width clamp shape. Unlike RunRightRail,
 * collapse/width state is NOT lifted to a parent: AgentRail owns and persists
 * it itself, so the App.tsx mount stays a single conditional sibling element.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { AgentThreadView } from './AgentThreadView';

/** Default expanded rail width. */
const RAIL_DEFAULT_WIDTH = 320;
/** Resize clamp: never shrink below a usable column. */
const RAIL_MIN_WIDTH = 260;
/** Resize clamp: cap at the smaller of an absolute ceiling or ~50% of viewport. */
const RAIL_MAX_ABS_WIDTH = 560;
/** localStorage key for the persisted rail width. Brand-new key — no migration. */
const WIDTH_KEY = 'cyboflow.agentRail.width';
/** localStorage key for the persisted collapsed state. Brand-new key — no migration. */
const COLLAPSED_KEY = 'cyboflow.agentRail.collapsed';

/** Upper resize bound: absolute cap, but never more than ~50% of the viewport. */
function maxAgentRailWidth(): number {
  const viewportCap =
    typeof window !== 'undefined' && window.innerWidth > 0
      ? Math.round(window.innerWidth * 0.5)
      : RAIL_MAX_ABS_WIDTH;
  return Math.min(RAIL_MAX_ABS_WIDTH, viewportCap);
}

/** Clamp a candidate width into [min, max]. Exported for direct unit testing
 * (drag simulation in jsdom is flaky; this is the math it exercises). */
export function clampAgentRailWidth(w: number): number {
  return Math.max(RAIL_MIN_WIDTH, Math.min(maxAgentRailWidth(), w));
}

/**
 * Gate predicate for the App.tsx mount: the rail shows on every
 * landing-family surface — everywhere except the session workspace (which
 * keeps `RunRightRail`) and the new-flow wizard. Exported so the gating
 * decision is unit-testable without rendering the full App shell.
 */
export function shouldShowAgentRail(view: string): boolean {
  return view !== 'session' && view !== 'wizard';
}

export function AgentRail() {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(COLLAPSED_KEY) === 'true';
  });
  const [width, setWidth] = useState<number>(() => {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(WIDTH_KEY) : null;
    const parsed = saved !== null ? parseInt(saved, 10) : NaN;
    return clampAgentRailWidth(Number.isFinite(parsed) ? parsed : RAIL_DEFAULT_WIDTH);
  });
  const [isResizing, setIsResizing] = useState(false);
  const startXRef = useRef<number>(0);
  const startWidthRef = useRef<number>(0);

  const handleToggleCollapse = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(COLLAPSED_KEY, next ? 'true' : 'false');
      }
      return next;
    });
  }, []);

  // Persist the chosen width. (Brand-new key — no migrateLocalStorageKey needed.)
  useEffect(() => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(WIDTH_KEY, width.toString());
    }
  }, [width]);

  const handleResizeDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsResizing(true);
      startXRef.current = e.clientX;
      startWidthRef.current = width;
    },
    [width],
  );

  const handleResizeMove = useCallback((e: MouseEvent) => {
    // The rail sits on the right, so dragging its LEFT edge leftward (smaller
    // clientX) grows it.
    const deltaX = startXRef.current - e.clientX;
    setWidth(clampAgentRailWidth(startWidthRef.current + deltaX));
  }, []);

  const handleResizeUp = useCallback(() => {
    setIsResizing(false);
  }, []);

  // Attach global listeners only while actively dragging.
  useEffect(() => {
    if (!isResizing) return;
    document.addEventListener('mousemove', handleResizeMove);
    document.addEventListener('mouseup', handleResizeUp);
    const prevUserSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ew-resize';
    return () => {
      document.removeEventListener('mousemove', handleResizeMove);
      document.removeEventListener('mouseup', handleResizeUp);
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = prevCursor;
    };
  }, [isResizing, handleResizeMove, handleResizeUp]);

  // Collapsed: a thin strip with only a re-expand chevron (mirrors
  // RunRightRail's collapsed strip).
  if (collapsed) {
    return (
      <aside
        data-testid="agent-rail-collapsed"
        className="w-[28px] shrink-0 flex flex-col items-center border-l border-border-primary bg-bg-secondary"
      >
        <button
          type="button"
          data-testid="agent-rail-expand"
          aria-label="Expand cyboflow assistant"
          title="Expand cyboflow assistant"
          onClick={handleToggleCollapse}
          className="flex h-8 w-full items-center justify-center text-text-tertiary hover:text-text-primary"
        >
          <ChevronLeft size={14} />
        </button>
      </aside>
    );
  }

  return (
    <aside
      data-testid="agent-rail"
      className="relative shrink-0 flex flex-col border-l border-border-primary bg-bg-secondary"
      style={{ width }}
    >
      {/* Left-edge drag handle — resize the rail (drag LEFT to widen). */}
      <div
        data-testid="agent-rail-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize cyboflow assistant rail"
        onMouseDown={handleResizeDown}
        title="Drag to resize"
        className="absolute left-0 top-0 z-10 h-full w-1.5 -translate-x-1/2 cursor-ew-resize"
        style={{ background: isResizing ? 'var(--color-border-primary)' : 'transparent' }}
      />

      {/* Header: collapse chevron, glyph mark, title/subtitle, GLOBAL chip. */}
      <div className="flex items-center gap-2 border-b border-border-primary p-3">
        <button
          type="button"
          data-testid="agent-rail-collapse"
          aria-label="Collapse cyboflow assistant"
          title="Collapse cyboflow assistant"
          onClick={handleToggleCollapse}
          className="flex h-6 w-6 shrink-0 items-center justify-center text-text-tertiary hover:text-text-primary"
        >
          <ChevronRight size={14} />
        </button>
        {/* Glyph mark: cream square, emphasized border, rust chevron + ink
            underscore — recreates the design packet's single-glyph agent mark
            (assets/cyboflow-mark.svg at single-glyph scale) purely in CSS/tokens. */}
        <div
          aria-hidden="true"
          data-testid="agent-rail-glyph"
          className="flex h-7 w-7 shrink-0 items-center justify-center border-[1.4px] border-border-emphasized bg-bg-primary text-[13px] font-bold leading-none"
        >
          <span className="text-interactive">&gt;</span>
          <span className="text-text-primary">_</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h2 className="truncate text-[13px] font-bold text-text-primary">cyboflow assistant</h2>
            <span
              data-testid="agent-rail-global-chip"
              className="shrink-0 rounded-[4px] border border-interactive px-1.5 py-px text-[9px] font-bold uppercase tracking-[0.14em] text-interactive"
            >
              Global
            </span>
          </div>
        </div>
      </div>

      {/* Body: the global-agent thread — transcript, composer, suggestion
          chips — rendered through the shared UnifiedChatView (S1.2). */}
      <div data-testid="agent-rail-thread-view" className="flex flex-1 flex-col overflow-hidden">
        <AgentThreadView />
      </div>
    </aside>
  );
}
