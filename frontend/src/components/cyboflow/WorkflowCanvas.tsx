/**
 * WorkflowCanvas — visual shell for the Active Workflow surface.
 *
 * Renders a meta row + horizontal phase columns (138px wide, 14px gap) with
 * step cards (86px row height) stacked vertically. State derivation:
 *   - steps before currentStepId → done
 *   - step matching currentStepId → running
 *   - steps after currentStepId → pending
 *   - currentStepId null / not found → all pending
 *
 * Measures step-card rects via ResizeObserver and useLayoutEffect, runs the RAF
 * token clock via useWorkflowTokenAnimation, and renders the SVG edge overlay
 * via WorkflowCanvasEdges.
 *
 * TASK-769 / TASK-780 / IDEA-026
 */
import { useState, useRef, useLayoutEffect, useMemo } from 'react';
import { PauseCircle } from 'lucide-react';
import type { WorkflowDefinition, WorkflowStep } from '../../../../shared/types/workflows';
import { WorkflowStepCard } from './WorkflowStepCard';
import type { StepStatus } from './WorkflowStepCard';
import { WorkflowCanvasEdges, HEAD_BAR_CENTER_Y } from './WorkflowCanvasEdges';
import { useWorkflowTokenAnimation } from '../../hooks/useWorkflowTokenAnimation';
import { useCenterPaneStore } from '../../stores/centerPaneStore';
import { ARTIFACT_COLORS, ARTIFACT_GLYPHS, ARTIFACT_RENDER_MODE } from '../../../../shared/types/artifacts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkflowCanvasProps {
  definition: WorkflowDefinition;
  currentStepId?: string | null;
  runLabel?: string;
  workflowTitle?: string;
  /** Worktree path of the run; rendered (basename) as a "folder" chip in the meta row. */
  folderPath?: string | null;
  /** Branch name of the run; rendered as a "branch" chip in the meta row. */
  branchName?: string | null;
  elapsed?: string;
  tokenCount?: string;
  isRunning?: boolean;
  /**
   * The run is parked in the NON-terminal 'paused' status (SDK-only Pause, Phase
   * 4b). When true the meta row renders an amber PauseCircle pill INSTEAD of the
   * pulsing 'running' pill, and the running pill + token animation are suppressed
   * (CyboflowRoot also passes isRunning=false while paused, but this guard makes
   * the canvas robust on its own).
   */
  paused?: boolean;
  /**
   * The run's raw lifecycle status. When it is a terminal self-completion
   * ('completed' / 'failed'), the meta row renders a static outcome pill (green /
   * red) so the finished state reads clearly while the operator decides to "End
   * workflow" (return to the session's resting view). Ignored while running /
   * paused (those pills take precedence).
   */
  status?: string;
  /**
   * Center-pane session key (run's parent session_id ?? runId) for the
   * "creates ⟨artifact⟩" footer chip on step cards. Threaded down by
   * RunCenterPane (which owns the key). When omitted the chip is non-interactive
   * (still renders, but clicking is a no-op) — keeps the canvas usable in
   * contexts without a center-pane session (tests / previews).
   */
  sessionKey?: string | null;
}

// ---------------------------------------------------------------------------
// "creates ⟨artifact⟩" footer chip — rendered under a step card whose
// definition declares an `outputArtifact`. Dashed top rule, glyph from
// ARTIFACT_GLYPHS (solid/dashed border per ARTIFACT_RENDER_MODE), color =
// ARTIFACT_COLORS[atype]. Click opens/focuses that artifact's tab.
//
// Inline design hexes (warm-paper; M7 tokenizes): hover bg #faf7ef, 8.5px text.
// ---------------------------------------------------------------------------

function StepArtifactChip({
  outputArtifact,
  sessionKey,
}: {
  outputArtifact: NonNullable<WorkflowStep['outputArtifact']>;
  sessionKey: string | null | undefined;
}) {
  const { atype, label } = outputArtifact;
  const color = ARTIFACT_COLORS[atype];
  const glyph = ARTIFACT_GLYPHS[atype];
  const dashed = ARTIFACT_RENDER_MODE[atype] === 'canvas';

  const handleClick = (e: React.MouseEvent): void => {
    e.stopPropagation();
    if (sessionKey == null) return;
    useCenterPaneStore.getState().openArtifactTab(sessionKey, { atype, label });
  };

  return (
    <button
      type="button"
      data-testid={`canvas-step-artifact-chip-${atype}`}
      onClick={handleClick}
      disabled={sessionKey == null}
      title={`creates ${label}`}
      style={{
        marginTop: 3,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        maxWidth: '100%',
        padding: '2px 4px',
        fontSize: 8.5,
        lineHeight: 1.2,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        color,
        background: 'transparent',
        border: 'none',
        borderTop: `1px ${dashed ? 'dashed' : 'solid'} ${color}`,
        cursor: sessionKey == null ? 'default' : 'pointer',
        textAlign: 'left',
      }}
      onMouseEnter={(e) => {
        if (sessionKey != null) e.currentTarget.style.background = '#faf7ef';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
      }}
    >
      <span aria-hidden style={{ fontSize: 10, lineHeight: 1 }}>
        {glyph}
      </span>
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        creates {label}
      </span>
    </button>
  );
}

/**
 * 24px dotted-grid backdrop (Protoflow flow canvas) — shared by the workflow
 * phase canvas and the end-of-workflow summary module so both read as the same
 * graph-paper surface. Assign to a container's `background`.
 */
export const GRAPH_PAPER_BACKGROUND =
  'linear-gradient(var(--color-grid-line, rgba(106,94,68,0.06)) 1px, transparent 1px) 0 0 / 24px 24px, ' +
  'linear-gradient(90deg, var(--color-grid-line, rgba(106,94,68,0.06)) 1px, transparent 1px) 0 0 / 24px 24px, ' +
  'var(--color-bg-primary)';

/** Last path segment of a worktree path, for a compact "folder" chip. */
function basename(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

// ---------------------------------------------------------------------------
// WorkflowCanvas
// ---------------------------------------------------------------------------

export function WorkflowCanvas({
  definition,
  currentStepId = null,
  runLabel,
  workflowTitle,
  folderPath,
  branchName,
  elapsed,
  tokenCount,
  isRunning = false,
  paused = false,
  status,
  sessionKey,
}: WorkflowCanvasProps) {
  // A paused run is, by definition, not actively running — suppress the running
  // pill and the token animation regardless of the isRunning prop so the canvas
  // is self-consistent even if a caller passes a stale isRunning.
  const effectiveRunning = isRunning && !paused;
  // ── Flatten all step ids for state derivation ─────────────────────────────
  const stepIds = definition.phases.flatMap((p) => p.steps.map((s) => s.id));
  const currentIdx = currentStepId != null ? stepIds.indexOf(currentStepId) : -1;

  // Derive per-step status
  const statusFor = (flatIdx: number): StepStatus => {
    if (currentIdx === -1) return 'pending';
    if (flatIdx < currentIdx) return 'done';
    if (flatIdx === currentIdx) return 'running';
    return 'pending';
  };

  // ── Layout constants (mirror FlowReadOnly from dashboard.jsx) ─────────────
  const COL_W = 138;
  const COL_GAP = 14;
  const ROW_H = 120; // ≥ tallest card (~106px: head + 2-line title body + foot) + breathing room so cards and the top-right human badge never overlap the card above
  const TOP = 28; // vertical offset from canvas inner top for first card

  // ── Build per-phase column layout ─────────────────────────────────────────
  const columns = definition.phases.map((phase, phaseIdx) => {
    const x = COL_W + phaseIdx * (COL_W + COL_GAP);
    return { phase, x };
  });

  // ── Canvas inner height: tallest column + TOP padding ────────────────────
  const maxSteps = Math.max(...definition.phases.map((p) => p.steps.length), 0);
  const canvasInnerHeight = TOP + maxSteps * ROW_H + 12;

  // ── Refs for rect measurement ─────────────────────────────────────────────
  const innerRef = useRef<HTMLDivElement | null>(null);
  const stepRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());

  // ── DOMRect state ─────────────────────────────────────────────────────────
  const [stepRects, setStepRects] = useState<Map<string, DOMRect>>(new Map());
  const [containerRect, setContainerRect] = useState<DOMRect | null>(null);

  // ── Measure rects via ResizeObserver ──────────────────────────────────────
  useLayoutEffect(() => {
    const container = innerRef.current;
    if (!container) return;

    const measure = () => {
      const cRect = container.getBoundingClientRect();
      setContainerRect(cRect);

      const newStepRects = new Map<string, DOMRect>();
      for (const [id, el] of stepRefs.current.entries()) {
        if (el) {
          const raw = el.getBoundingClientRect();
          // Make container-relative
          newStepRects.set(
            id,
            new DOMRect(raw.x - cRect.x, raw.y - cRect.y, raw.width, raw.height),
          );
        }
      }
      setStepRects(newStepRects);
    };

    measure();

    const ro = new ResizeObserver(measure);
    ro.observe(container);
    for (const el of stepRefs.current.values()) {
      if (el) ro.observe(el);
    }

    return () => {
      ro.disconnect();
    };
  }, [definition]);

  // ── Animated token clock ───────────────────────────────────────────────────
  const t = useWorkflowTokenAnimation({
    enabled: effectiveRunning && currentIdx >= 0 && currentIdx < stepIds.length - 1,
  });

  // ── Token position via linear interpolation ───────────────────────────────
  const token = useMemo<{ x: number; y: number } | null>(() => {
    if (currentIdx < 0 || currentIdx >= stepIds.length - 1) return null;

    const currentId = stepIds[currentIdx];
    const nextId = stepIds[currentIdx + 1];
    if (!currentId || !nextId) return null;

    const fromRect = stepRects.get(currentId);
    const toRect = stepRects.get(nextId);
    if (!fromRect || !toRect) return null;

    const fromX = fromRect.x + fromRect.width / 2;
    const toX = toRect.x + toRect.width / 2;
    const fromY = fromRect.y + HEAD_BAR_CENTER_Y;
    const toY = toRect.y + HEAD_BAR_CENTER_Y;

    return {
      x: fromX + (toX - fromX) * t,
      y: fromY + (toY - fromY) * t,
    };
  }, [t, stepRects, currentIdx, stepIds]);

  // ── Running pill — uses Tailwind animate-pulse (1.4s built-in) ───────────

  return (
    <div
      className="flex flex-col h-full bg-bg-primary"
      data-testid="workflow-canvas"
    >
      {/* ── Meta row ───────────────────────────────────────────────────────── */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '4px 12px',
          fontSize: 10,
          letterSpacing: '0.02em',
          color: 'var(--color-text-secondary)',
          padding: '7px 12px 6px',
          background: 'var(--color-bg-primary)',
          borderBottom: '1px dashed var(--color-border-primary)',
          flexShrink: 0,
        }}
        data-testid="workflow-canvas-meta"
      >
        {workflowTitle && (
          <span data-testid="workflow-canvas-workflow-title">
            <b style={{ color: 'var(--color-text-primary)', fontWeight: 700 }}>
              {workflowTitle}
            </b>
          </span>
        )}
        {runLabel && (
          <span data-testid="workflow-canvas-run-label">
            {' · '}
            {runLabel}
          </span>
        )}
        {folderPath && (
          <span data-testid="workflow-canvas-folder" title={folderPath}>
            folder{' '}
            <b style={{ color: 'var(--color-text-primary)', fontWeight: 700 }}>
              {basename(folderPath)}
            </b>
          </span>
        )}
        {branchName && (
          <span data-testid="workflow-canvas-branch" title={branchName}>
            branch{' '}
            <b style={{ color: 'var(--color-text-primary)', fontWeight: 700 }}>
              {branchName}
            </b>
          </span>
        )}
        {elapsed !== undefined && (
          <span data-testid="workflow-canvas-elapsed">
            elapsed{' '}
            <b style={{ color: 'var(--color-text-primary)', fontWeight: 700 }}>{elapsed}</b>
          </span>
        )}
        {tokenCount !== undefined && (
          <span data-testid="workflow-canvas-tokens">
            tokens{' '}
            <b style={{ color: 'var(--color-text-primary)', fontWeight: 700 }}>{tokenCount}</b>
          </span>
        )}
        {paused ? (
          <span
            style={{
              padding: '2px 8px',
              border: '1px solid var(--color-status-warning)',
              color: 'var(--color-status-warning)',
              textTransform: 'uppercase',
              letterSpacing: '0.18em',
              fontSize: 9,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
            }}
            data-testid="workflow-canvas-paused-pill"
          >
            {/* Static (non-pulsing) PauseCircle — a paused run is at rest. */}
            <PauseCircle size={10} aria-hidden />
            paused
          </span>
        ) : effectiveRunning ? (
          <span
            style={{
              padding: '2px 8px',
              border: '1px solid var(--color-status-error)',
              color: 'var(--color-status-error)',
              textTransform: 'uppercase',
              letterSpacing: '0.18em',
              fontSize: 9,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
            }}
            data-testid="workflow-canvas-running-pill"
          >
            {/* Pulsing dot — Tailwind animate-pulse */}
            <span
              className="animate-pulse"
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: 'var(--color-status-error)',
                display: 'inline-block',
              }}
            />
            running
          </span>
        ) : status === 'completed' || status === 'failed' ? (
          <span
            style={{
              padding: '2px 8px',
              border: `1px solid ${status === 'completed' ? 'var(--color-status-success)' : 'var(--color-status-error)'}`,
              color: status === 'completed' ? 'var(--color-status-success)' : 'var(--color-status-error)',
              textTransform: 'uppercase',
              letterSpacing: '0.18em',
              fontSize: 9,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
            }}
            data-testid={`workflow-canvas-${status}-pill`}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: status === 'completed' ? 'var(--color-status-success)' : 'var(--color-status-error)',
                display: 'inline-block',
              }}
            />
            {status}
          </span>
        ) : null}
      </div>

      {/* ── Canvas inner — phase columns with step cards ───────────────────── */}
      <div
        ref={innerRef}
        style={{
          position: 'relative',
          flex: 1,
          overflowX: 'auto',
          overflowY: 'auto',
          display: 'flex',
          gap: COL_GAP,
          padding: `${TOP}px 12px 12px`,
          minHeight: canvasInnerHeight,
          // 24px dotted-grid backdrop (Protoflow flow canvas)
          background: GRAPH_PAPER_BACKGROUND,
        }}
        data-testid="workflow-canvas-inner"
      >
        {/* SVG edge overlay */}
        <div
          data-testid="workflow-canvas-edges-overlay"
          style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
        >
          <WorkflowCanvasEdges
            definition={definition}
            currentStepIndex={currentIdx}
            stepRects={stepRects}
            containerRect={containerRect}
            token={token}
          />
        </div>

        {columns.map(({ phase }, phaseIdx) => {
          // Track running flat-step index across phases
          let phaseFlatStart = 0;
          for (let i = 0; i < phaseIdx; i++) {
            phaseFlatStart += definition.phases[i].steps.length;
          }

          return (
            <div
              key={phase.id}
              style={{
                width: COL_W,
                flexShrink: 0,
                position: 'relative',
              }}
              data-testid={`phase-column-${phase.id}`}
            >
              {/* Band label — absolute, above the column */}
              <span
                style={{
                  position: 'absolute',
                  top: -20,
                  left: 4,
                  fontSize: 9,
                  letterSpacing: '0.18em',
                  textTransform: 'uppercase',
                  color: phase.color,
                  whiteSpace: 'nowrap',
                }}
                data-testid={`phase-band-${phase.id}`}
              >
                {phase.label.toUpperCase()}
              </span>

              {/* Step cards stacked vertically */}
              {phase.steps.map((step, stepInPhase) => {
                const flatIdx = phaseFlatStart + stepInPhase;
                const derivedStatus = statusFor(flatIdx);
                const globalStepIndex = flatIdx + 1; // 1-based

                return (
                  <div
                    key={step.id}
                    ref={(el) => { stepRefs.current.set(step.id, el); }}
                    style={{ height: ROW_H, position: 'relative' }}
                    data-testid={`step-wrapper-${step.id}`}
                  >
                    <WorkflowStepCard
                      step={step}
                      phase={phase}
                      stepIndex={globalStepIndex}
                      status={derivedStatus}
                    />
                    {/* "creates ⟨artifact⟩" footer chip — absolutely positioned
                        below the card so it never alters the measured card rect
                        (edge-overlay anchoring) or the column grid. */}
                    {step.outputArtifact && (
                      <div
                        style={{
                          position: 'absolute',
                          top: ROW_H - 16,
                          left: 0,
                          right: 0,
                        }}
                      >
                        <StepArtifactChip
                          outputArtifact={step.outputArtifact}
                          sessionKey={sessionKey}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
