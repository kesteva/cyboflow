/**
 * WorkflowStepCard — single step card with five visual variants.
 *
 * Variants: pending, running, done, human, optional.
 * Variants compose: done+human+optional are all valid simultaneously.
 *
 * TASK-769 / IDEA-026
 */
import type { WorkflowStep, WorkflowPhase } from '../../../../shared/types/workflows';
import { resolveStepAgentKey } from '../../../../shared/types/agentIdentity';
import { MODEL_FAMILY_COLORS } from '../../../../shared/types/agents';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * 'paused' = the run is parked on THIS step by a systemic pause (a
 * `gate:systemic-pause:<stepId>` item — usage / session limit). The run row
 * stays 'running' while parked, so without this state the card read RUNNING
 * for the whole wait. Styled amber (at rest), never the pulsing red outline.
 */
export type StepStatus = 'pending' | 'running' | 'paused' | 'done';

export interface WorkflowStepCardProps {
  step: WorkflowStep;
  phase: WorkflowPhase;
  /** 1-based global step index across all phases. */
  stepIndex: number;
  status: StepStatus;
  /**
   * Resolved model label for this step (IDEA-061 per-step model rail), e.g.
   * "Opus 5" or "Auto". Absent for human/gate steps (never fabricated) and
   * while the backing `runs.getStepModels` query hasn't resolved yet — in
   * both cases the row renders exactly as it did before this prop existed.
   */
  modelLabel?: string | null;
  /**
   * Swatch hex for `modelLabel`'s {@link ModelFamily} bucket — see
   * MODEL_FAMILY_COLORS. Defaults to the `other` swatch rather than being
   * left unset: the dot reserves layout whenever `modelLabel` renders, so an
   * omitted/unresolvable color must still paint something visible instead of
   * an invisible 4px hole.
   */
  modelFamilyColor?: string;
}

// ---------------------------------------------------------------------------
// WorkflowStepCard
// ---------------------------------------------------------------------------

export function WorkflowStepCard({
  step,
  phase,
  stepIndex,
  status,
  modelLabel,
  modelFamilyColor = MODEL_FAMILY_COLORS.other,
}: WorkflowStepCardProps) {
  const isPending = status === 'pending';
  const isRunning = status === 'running';
  const isPaused = status === 'paused';
  const isDone = status === 'done';
  const isHuman = step.human === true;
  const isOptional = step.optional === true;

  // State text for the foot area
  const stateLabel = isRunning ? 'RUNNING' : isPaused ? 'PAUSED' : isDone ? 'DONE' : 'PENDING';

  // ── Root styles ────────────────────────────────────────────────────────────
  // Done cards: position relative + GPU promotion via translateZ(0) + will-change
  // Running cards: 2px outline using status-error token (status-running not yet
  //   defined in tailwind.config.js — substituting status-error per plan guidance).
  // Human cards: amber border (status-warning) + inner halo box-shadow.
  const rootStyle: React.CSSProperties = {
    width: 138,
    borderWidth: '1.4px',
    borderStyle: 'solid',
    borderColor: isDone
      ? '#1a1815'
      : isHuman
        ? 'var(--color-status-warning)'
        : isPending
          ? '#d8cfb8'
          : '#1a1815',
    background: isPending ? '#efeadc' : '#fff',
    position: 'relative',
    ...(isDone
      ? {
          // Done: GPU layer promotion per IDEA-026 Area C
          transform: 'translateZ(0)',
          willChange: 'transform',
        }
      : {}),
    ...(isRunning
      ? {
          // Running: 2px outline using status-error token
          // (status-running not defined; status-error is the rust-red #c96442 equivalent)
          outlineStyle: 'solid',
          outlineWidth: '2px',
          outlineColor: 'var(--color-status-error)',
          outlineOffset: '2px',
        }
      : {}),
    ...(isPaused
      ? {
          // Paused: the same outline geometry as running, in the amber
          // status-warning token — "the run is here, but at rest".
          outlineStyle: 'solid',
          outlineWidth: '2px',
          outlineColor: 'var(--color-status-warning)',
          outlineOffset: '2px',
        }
      : {}),
    ...(isHuman
      ? {
          // Human: inner amber halo
          boxShadow: '0 0 0 1px var(--color-status-warning)',
        }
      : {}),
  };

  // ── Head bar background ────────────────────────────────────────────────────
  const headBackground = isHuman
    ? 'repeating-linear-gradient(135deg, #d99a3d 0px 6px, #c98a2d 6px 12px)'
    : phase.color;

  // Phase abbreviation — first 3 characters, uppercase
  const phaseAbbrev = phase.label.slice(0, 3).toUpperCase();

  // Step index — zero-padded 2 digits
  const stepIndexStr = String(stepIndex).padStart(2, '0');

  // ── Dot color (foot) ───────────────────────────────────────────────────────
  const dotColor = isDone
    ? 'var(--color-status-success)'
    : isRunning
      ? 'var(--color-status-error)'
      : isPaused
        ? 'var(--color-status-warning)'
        : '#c8bea3';

  // ── Agent short name — resolved canonical key (legacy labels mapped) ───────
  const agentKey = resolveStepAgentKey(step.id, step.agent);
  const agentShortName = agentKey ?? step.agent;

  // ── Model segment gate ─────────────────────────────────────────────────────
  // A human/gate step NEVER renders a model segment — the approved design
  // calls that a hard rule, not a data accident. `runs.getStepModels` already
  // omits gate steps by the SAME two-part predicate (`human: true` OR an agent
  // that resolves to no key, i.e. `agent: 'human'`), so this is the card-local
  // enforcement of the same rule: even if a caller hands a human step a label,
  // neither the segment nor the "· model" title appears.
  const showModel = !isHuman && agentKey !== null && Boolean(modelLabel);

  return (
    <div style={rootStyle} data-testid={`step-card-${step.id}`}>
      {/* ── Head bar ──────────────────────────────────────────────────────── */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '4px 7px',
          background: headBackground,
          color: '#fff',
          fontSize: 9,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          ...(isPending ? { filter: 'grayscale(0.7)', opacity: 0.55 } : {}),
        }}
        data-testid={`step-card-head-${step.id}`}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span>{phaseAbbrev}</span>
          {isOptional && (
            <span
              style={{
                fontSize: 8.5,
                letterSpacing: '0.14em',
                fontWeight: 700,
                background: 'rgba(255,255,255,0.22)',
                padding: '1px 5px',
                borderRadius: 2,
              }}
              data-testid={`step-card-optional-chip-${step.id}`}
            >
              OPTIONAL
            </span>
          )}
        </span>
        <span style={{ opacity: 0.6 }}>{stepIndexStr}</span>
      </div>

      {/* ── Body ──────────────────────────────────────────────────────────── */}
      <div style={{ padding: '6px 8px 7px', minWidth: 0 }}>
        <div
          style={{
            fontSize: 10.5,
            fontWeight: 600,
            color: isPending ? '#9c8e6c' : '#1a1815',
            lineHeight: 1.25,
            letterSpacing: '-0.005em',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            wordBreak: 'break-word',
          }}
        >
          {step.name}
        </div>
        <div
          style={{
            marginTop: 5,
            fontSize: 9.5,
            color: isPending ? '#b3a685' : '#6a5e44',
            // Three flex segments in ONE row per the approved design: the
            // agent name grows (flex: 1 1 auto below), model + retries hold
            // their intrinsic width, and a single `gap` — not per-segment
            // margins — spaces all three. `justifyContent` is deliberately
            // absent: the growing agent segment already pushes the other two
            // flush right.
            display: 'flex',
            alignItems: 'center',
            gap: 5,
          }}
          title={
            showModel
              ? isPending
                ? `${agentShortName} · configured to run ${modelLabel}`
                : `${agentShortName} · ${modelLabel}`
              : undefined
          }
          data-testid={`step-card-agent-row-${step.id}`}
        >
          <span
            style={{
              flex: '1 1 auto',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
            }}
          >
            {agentShortName}
          </span>
          {showModel && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                whiteSpace: 'nowrap',
                flexShrink: 0,
                // Hard cap from the approved design: the card is a fixed 138px
                // and nothing on the row sets overflow, so an uncapped
                // provider model id (e.g. a long verbatim Codex id) would
                // spill outside the card instead of truncating.
                maxWidth: 62,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
              data-testid={`step-card-model-${step.id}`}
            >
              <span aria-hidden style={{ letterSpacing: '0.02em' }}>
                ·
              </span>
              <span
                aria-hidden
                style={{
                  width: 4,
                  height: 4,
                  borderRadius: '50%',
                  backgroundColor: modelFamilyColor,
                  display: 'inline-block',
                  opacity: isPending ? 0.45 : 1,
                  flexShrink: 0,
                }}
                data-testid={`step-card-model-dot-${step.id}`}
              />
              {/* The ellipsis must live on the TEXT span: the capped
                  inline-flex parent can only clip its child, not ellipsise it. */}
              <span
                style={{
                  fontStyle: isPending ? 'italic' : 'normal',
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
                data-testid={`step-card-model-label-${step.id}`}
              >
                {modelLabel}
              </span>
            </span>
          )}
          <span style={{ flexShrink: 0 }}>×{step.retries}</span>
        </div>
      </div>

      {/* ── Foot ──────────────────────────────────────────────────────────── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          padding: '4px 8px',
          borderTop: isPending ? '1px dashed #e6dec7' : '1px dashed #d8cfb8',
          fontSize: 8.5,
          letterSpacing: '0.08em',
          color: isPending ? '#b3a685' : '#6a5e44',
        }}
      >
        <span
          style={{
            width: 5,
            height: 5,
            borderRadius: '50%',
            background: dotColor,
            flexShrink: 0,
          }}
          data-testid={`step-card-dot-${step.id}`}
        />
        <span>{stateLabel}</span>
      </div>

      {/* ── Human badge ───────────────────────────────────────────────────── */}
      {isHuman && (
        <span
          aria-label="human step"
          style={{
            position: 'absolute',
            top: -9,
            right: -9,
            width: 22,
            height: 22,
            borderRadius: '50%',
            background: '#d99a3d',
            border: '1.5px solid #1a1815',
            color: '#1a1815',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 3,
          }}
          data-testid={`step-card-human-badge-${step.id}`}
        >
          {/* Inline SVG person glyph */}
          <svg
            aria-hidden="true"
            width="11"
            height="11"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="6" cy="4" r="2" />
            <path d="M2 11c.4-2.3 2-3.5 4-3.5s3.6 1.2 4 3.5" />
          </svg>
        </span>
      )}

      {/* ── Done: frosted-glass overlay (DIRECT child of root) ────────────── */}
      {isDone && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(245,241,232,0.62)',
            backdropFilter: 'blur(2px)',
            WebkitBackdropFilter: 'blur(2px)',
            pointerEvents: 'none',
            willChange: 'transform',
          }}
          data-testid={`step-card-frosted-overlay-${step.id}`}
        />
      )}

      {/* ── Done: green check circle ──────────────────────────────────────── */}
      {isDone && (
        <span
          aria-label="completed"
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: 30,
            height: 30,
            borderRadius: '50%',
            background: 'var(--color-status-success)',
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 2,
            boxShadow: '0 2px 6px rgba(45,138,91,0.35)',
          }}
          data-testid={`step-card-check-${step.id}`}
        >
          <svg
            aria-hidden="true"
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M2.5 7.5l3 3 6-6" />
          </svg>
        </span>
      )}
    </div>
  );
}
