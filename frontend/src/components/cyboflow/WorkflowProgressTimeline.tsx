/**
 * WorkflowProgressTimeline — vertical per-phase step feed wired to live phase state
 * via a phaseState prop (prop-drilled from CyboflowRoot via RunRightRail).
 *
 * Consumes:
 *   phaseState prop (UseWorkflowPhaseStateResult) — caller owns tRPC lifecycle
 *   useCyboflowStore                              — streamEvents for log-line projection
 *
 * Renders protoflow §4a: vertical feed with phase sections (colored swatch + label +
 * step count), timeline step items with state-keyed 2px left borders + 8px bullet +
 * name + agent + uppercase status, log lines below non-pending steps with mono prefix
 * glyph + 42px tabular timestamp + message.
 *
 * 1.4s opacity+scale pulse on running step bullet only.
 * Uses existing cyboflow Tailwind tokens — NOT protoflow paper-cream palette.
 *
 * TASK-768 / TASK-781 / TASK-783 / IDEA-026
 */
import { useEffect, type ReactElement } from 'react';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { useActiveRunsStore } from '../../stores/activeRunsStore';
import { useCenterPaneStore } from '../../stores/centerPaneStore';
import type { UseWorkflowPhaseStateResult } from '../../hooks/useWorkflowPhaseState';
import type { WorkflowStepState, WorkflowStep } from '../../../../shared/types/workflows';
import { resolveStepAgentKey } from '../../../../shared/types/agentIdentity';
import type { StreamEvent } from '../../utils/cyboflowApi';
import { ARTIFACT_COLORS, ARTIFACT_GLYPHS, ARTIFACT_RENDER_MODE } from '../../../../shared/types/artifacts';

// ---------------------------------------------------------------------------
// LogLine — projected from streamEvents
// ---------------------------------------------------------------------------

type LogKind = 'edit' | 'tool' | 'note' | 'done' | 'running';

interface LogLine {
  kind: LogKind;
  t: number; // Unix ms
  text: string;
}

// ---------------------------------------------------------------------------
// Glyph map for log line prefix
// ---------------------------------------------------------------------------

const GLYPH: Record<LogKind, string> = {
  tool:    '▸',
  edit:    '✎',
  note:    '·',
  done:    '✓',
  running: '●',
};

// Edit tool names — assistant tool_use blocks with these names are classified 'edit'.
const EDIT_TOOL_NAMES = new Set(['Edit', 'Write', 'MultiEdit']);

// ---------------------------------------------------------------------------
// Time-window helpers
//
// WorkflowStepState (TASK-763) has no timestamps. Degrade gracefully:
// walk streamEvents for `workflow_step_transition` events when available,
// else return null (empty log block with TODO comment).
// ---------------------------------------------------------------------------

interface TimeWindow {
  start: number; // Unix ms
  end: number | null; // null = open (still running)
}

/**
 * Attempt to derive time-window for a step from streamEvents.
 * Currently no `workflow_step_transition` event type is in the StreamEvent union,
 * so this always returns null in v1.
 *
 * TODO(TASK-765): when step-transition timestamps land on WorkflowStepState,
 * read them here directly instead of walking streamEvents.
 */
function getStepTimeWindow(
  _stepId: string,
  _stepStates: WorkflowStepState[],
  _events: StreamEvent[],
): TimeWindow | null {
  // v1 degraded mode — no timestamp data available on WorkflowStepState
  // and no `workflow_step_transition` event type in the stream union.
  return null;
}

// ---------------------------------------------------------------------------
// Log-line projection
// ---------------------------------------------------------------------------

/**
 * Project log lines from stream events filtered to a step's time window.
 * Returns an empty array when window is null (degraded mode).
 */
function projectLogLines(
  events: StreamEvent[],
  window: TimeWindow | null,
): LogLine[] {
  if (window === null) return [];

  return events
    .filter((e) => {
      const ts = new Date(e.timestamp).getTime();
      if (ts < window.start) return false;
      if (window.end !== null && ts > window.end) return false;
      return true;
    })
    .map((e): LogLine | null => {
      const ts = new Date(e.timestamp).getTime();
      if (e.type === 'assistant') {
        const content = e.payload.message?.content ?? [];
        for (const block of content) {
          if (block.type === 'tool_use') {
            const kind: LogKind = EDIT_TOOL_NAMES.has(block.name) ? 'edit' : 'tool';
            return { kind, t: ts, text: block.name };
          }
          if (block.type === 'text' && block.text.trim()) {
            return { kind: 'note', t: ts, text: block.text.slice(0, 80) };
          }
        }
      }
      if (e.type === 'result') {
        return { kind: 'done', t: ts, text: `result: ${e.payload.subtype}` };
      }
      return null;
    })
    .filter((l): l is LogLine => l !== null);
}

// ---------------------------------------------------------------------------
// Elapsed time formatter (mm:ss tabular alignment)
// ---------------------------------------------------------------------------

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Border class lookup (status-running not in Tailwind config → fallback to error)
// ---------------------------------------------------------------------------

function borderClassForStatus(status: WorkflowStepState['status']): string {
  switch (status) {
    case 'done':    return 'border-status-success';
    case 'running': return 'border-status-error'; // fallback: status-running absent (IDEA-026 Q5)
    case 'failed':  return 'border-status-error';
    case 'skipped': return 'border-border-secondary'; // muted: an optional/gated-off step, not a defect
    case 'pending': return 'border-border-primary';
  }
}

// ---------------------------------------------------------------------------
// Status badge text color — keeps the uppercase status label consistent with
// its left-border treatment (red for FAILED, muted for SKIPPED, secondary else).
// ---------------------------------------------------------------------------

function badgeClassForStatus(status: WorkflowStepState['status']): string {
  switch (status) {
    case 'failed':  return 'text-status-error';
    case 'skipped': return 'text-text-muted';
    default:        return 'text-text-secondary';
  }
}

// ---------------------------------------------------------------------------
// Pulse animation style injection (module-level — injected once)
// ---------------------------------------------------------------------------

let _pulseStyleInjected = false;

function ensurePulseStyle(): void {
  if (_pulseStyleInjected) return;
  const style = document.createElement('style');
  style.textContent = `
@keyframes workflow-step-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.8); }
}
`;
  document.head.appendChild(style);
  _pulseStyleInjected = true;
}

// ---------------------------------------------------------------------------
// "creates ⟨artifact⟩" footer chip
//
// Rendered under any step whose definition declares an `outputArtifact`. Dashed
// top border, glyph from ARTIFACT_GLYPHS (solid/dashed border per
// ARTIFACT_RENDER_MODE), color = ARTIFACT_COLORS[atype]. Clicking opens (or
// focuses) that artifact's tab in the center pane.
//
// Inline design hexes (warm-paper palette; M7 tokenizes):
//   chip hover bg #faf7ef · dashed-rule border var taken from artifact color.
// ---------------------------------------------------------------------------

function StepArtifactChip({
  outputArtifact,
  sessionKey,
}: {
  outputArtifact: NonNullable<WorkflowStep['outputArtifact']>;
  sessionKey: string | null;
}): ReactElement {
  const { atype, label } = outputArtifact;
  const color = ARTIFACT_COLORS[atype];
  const glyph = ARTIFACT_GLYPHS[atype];
  // Live canvases get a dashed border; templated artifacts a solid one.
  const dashed = ARTIFACT_RENDER_MODE[atype] === 'canvas';

  const handleClick = (e: React.MouseEvent): void => {
    e.stopPropagation();
    if (sessionKey === null) return;
    useCenterPaneStore.getState().openArtifactTab(sessionKey, { atype, label });
  };

  return (
    <button
      type="button"
      data-testid={`step-artifact-chip-${atype}`}
      onClick={handleClick}
      disabled={sessionKey === null}
      className="mt-1 ml-4 flex items-center gap-1.5 self-start rounded-sm bg-transparent px-1.5 py-1 text-left transition-colors hover:bg-[#faf7ef] disabled:cursor-default disabled:opacity-60"
      style={{
        fontSize: '8.5px',
        color,
        borderTop: `1px ${dashed ? 'dashed' : 'solid'} ${color}`,
      }}
      title={`creates ${label}`}
    >
      <span aria-hidden style={{ fontSize: '10px', lineHeight: 1 }}>
        {glyph}
      </span>
      <span className="uppercase tracking-wide">creates {label}</span>
      <span aria-hidden style={{ opacity: 0.7 }}>
        open →
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// WorkflowProgressTimeline
// ---------------------------------------------------------------------------

export function WorkflowProgressTimeline({
  runId,
  phaseState,
}: {
  runId: string | null;
  phaseState: UseWorkflowPhaseStateResult;
}): ReactElement {
  // ── Phase state from prop (caller — CyboflowRoot — owns tRPC lifecycle) ───
  const { definition, stepStates, isLoading, error } = phaseState;

  // Stream events for log-line projection
  const streamEvents = useCyboflowStore((s) => s.streamEvents);

  // ── Center-pane session key for the "creates ⟨artifact⟩" chip ──────────────
  // The chip opens an artifact tab keyed by the run's parent session (the same
  // key RunCenterPane uses: session_id ?? runId). Resolve the run from
  // activeRunsStore to read its session_id; fall back to the runId for legacy
  // parentless runs. Selecting the whole map keeps this reactive to refresh().
  const runsByProject = useActiveRunsStore((s) => s.runsByProject);
  const sessionKey: string | null =
    runId === null
      ? null
      : (Object.values(runsByProject)
          .flat()
          .find((r) => r.id === runId)?.session_id ?? runId);

  // ── Pulse style injection (once) ───────────────────────────────────────────
  useEffect(() => {
    ensurePulseStyle();
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────────

  if (runId === null) {
    return (
      <div
        data-testid="workflow-progress-timeline-empty"
        className="flex h-full items-center justify-center text-xs text-text-secondary"
      >
        No active run
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-text-secondary">
        Loading workflow state…
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="flex h-full items-center justify-center p-3 text-xs text-status-error">
        Failed to load workflow state: {error.message}
      </div>
    );
  }

  if (definition === null) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-text-secondary">
        No workflow data
      </div>
    );
  }

  // Build a lookup map from stepId → status for O(1) access
  const stepStatusMap = new Map<string, WorkflowStepState['status']>(
    stepStates.map((s) => [s.stepId, s.status]),
  );

  return (
    <div className="flex h-full flex-col overflow-y-auto p-3 text-xs text-text-primary">
      {definition.phases.map((phase) => {
        const phaseStepCount = phase.steps.length;

        return (
          <section
            key={phase.id}
            data-testid={`phase-section-${phase.id}`}
            className="mb-4"
          >
            {/* Phase header */}
            <div
              data-testid={`phase-header-${phase.id}`}
              className="mb-2 flex items-center gap-2"
            >
              {/* 8×8 colored swatch */}
              <span
                data-testid={`phase-swatch-${phase.id}`}
                className="inline-block h-2 w-2 shrink-0 rounded-sm"
                style={{ background: phase.color }}
              />
              {/* Phase label — 11px bold */}
              <span
                className="font-bold text-text-primary"
                style={{ fontSize: '11px' }}
              >
                {phase.label}
              </span>
              {/* Right-aligned step count */}
              <span className="ml-auto text-text-secondary">
                {phaseStepCount} steps
              </span>
            </div>

            {/* Step list */}
            <div className="flex flex-col gap-1">
              {phase.steps.map((step) => {
                const status = stepStatusMap.get(step.id) ?? 'pending';
                const borderClass = borderClassForStatus(status);
                const isRunning = status === 'running';
                const isPending = status === 'pending';

                // Log-line projection
                const window = getStepTimeWindow(step.id, stepStates, streamEvents);
                const logLines = isPending
                  ? []
                  : projectLogLines(streamEvents, window);

                // Start timestamp for elapsed time calculation
                // unreachable in v1 — kept for TASK-765 (window is always null until step timestamps land)
                const windowStart = window?.start ?? Date.now();

                return (
                  <div
                    key={step.id}
                    data-testid={`step-item-${step.id}`}
                    className={`flex flex-col border-l-2 pl-3 py-1 ${borderClass}`}
                  >
                    {/* Step header row */}
                    <div className="flex items-center gap-2">
                      {/* Bullet with conditional pulse */}
                      <span
                        data-testid={`step-bullet-${step.id}`}
                        className="inline-block h-2 w-2 shrink-0 rounded-full bg-current"
                        style={
                          isRunning
                            ? {
                                animation:
                                  'workflow-step-pulse 1.4s ease-in-out infinite',
                              }
                            : undefined
                        }
                      />
                      {/* Step name */}
                      <span className="font-medium text-text-primary">
                        {step.name}
                      </span>
                      {/* Status badge */}
                      <span className={`ml-auto uppercase tracking-wide ${badgeClassForStatus(status)}`}>
                        {status}
                      </span>
                    </div>

                    {/* Agent label */}
                    <div className="mt-0.5 pl-4 text-text-tertiary">
                      {resolveStepAgentKey(step.id, step.agent) ?? step.agent}
                    </div>

                    {/* Log lines — only for non-pending steps */}
                    {!isPending && logLines.length > 0 && (
                      <div className="mt-1 flex flex-col gap-0.5 pl-4">
                        {logLines.map((line, idx) => (
                          <div
                            key={idx}
                            data-testid={`log-line-${step.id}-${idx}`}
                            className="flex items-baseline gap-1 font-mono"
                          >
                            {/* Prefix glyph */}
                            <span className="shrink-0 text-text-secondary">
                              {GLYPH[line.kind]}
                            </span>
                            {/* 42px tabular-numerics timestamp column */}
                            <span
                              className="shrink-0 text-text-muted"
                              style={{
                                width: '42px',
                                fontVariantNumeric: 'tabular-nums',
                              }}
                            >
                              {formatElapsed(line.t - windowStart)}
                            </span>
                            {/* Message body */}
                            <span className="truncate text-text-secondary">
                              {line.text}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* "creates ⟨artifact⟩" footer chip — steps that produce an artifact */}
                    {step.outputArtifact && (
                      <StepArtifactChip
                        outputArtifact={step.outputArtifact}
                        sessionKey={sessionKey}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
