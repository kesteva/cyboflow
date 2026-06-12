/**
 * DynamicWorkflowPanel — one detected Claude Code dynamic workflow (the
 * in-session Workflow tool / `ultracode`), rendered from a tracked
 * {@link DynamicWorkflowRunState} snapshot. Purely presentational — the
 * caller (QuickSessionCanvas) owns store wiring.
 *
 * Card chrome mirrors ActiveAgentCard (square corners, hairline border):
 *   - title row: pulsing rust dot while running (✓ / ✕ when terminal) + the
 *     workflow name + an uppercase status chip,
 *   - description (when the script meta carries one),
 *   - the static phase PLAN as chips — journal lines carry no phase
 *     attribution, so this is explicitly a plan, never per-phase progress,
 *   - a live line: agent tally ("N running · M done" from state.agents) and
 *     elapsed time while running (~30s wall-clock ticker, cleared on unmount —
 *     same pattern as ActiveAgentCard),
 *   - when terminal: the completion summary + totals (agents / tokens / tool
 *     calls / duration) from the wf_<id>.json record.
 *
 * `expanded` (canvas-takeover variant, default false) additionally renders one
 * row per subagent, modeled on the CLI's own TUI workflow view: status glyph,
 * display name, model, output tokens, tool count and idle/elapsed hints. Every
 * per-agent field beyond {agentId, status} is OPTIONAL — an older main build
 * (or the race before the first transcript parse) sends bare agents, and the
 * row degrades to a glyph + "agent N" + an em-dash. Agent labels do NOT exist
 * on disk, so display names fall back to each agent's prompt excerpt with the
 * longest shared prologue stripped (see computeAgentDisplayNames).
 */
import { useEffect, useMemo, useState } from 'react';
import { formatElapsed } from '../../utils/homeClassify';
import { formatTokenCount } from '../../hooks/useSessionMetrics';
import type {
  DynamicWorkflowAgent,
  DynamicWorkflowRunState,
} from '../../../../shared/types/dynamicWorkflows';

/** Wall-clock refresh cadence for the elapsed counter (matches ActiveAgentCard). */
const ELAPSED_TICK_MS = 30_000;

/**
 * Coarser-grained but still-live cadence for the expanded variant — drives the
 * per-agent idle hints, which need finer resolution than the 30s elapsed tick.
 */
const EXPANDED_TICK_MS = 5_000;

/** A running agent with no transcript line for this long is flagged "idle Ns". */
const AGENT_IDLE_THRESHOLD_MS = 30_000;

/** Max length of a derived agent display name (post prologue-strip). */
const AGENT_NAME_MAX_CHARS = 60;

/** Status → accent color (paper-theme CSS vars, matching the app's badges). */
const STATUS_COLOR: Record<DynamicWorkflowRunState['status'], string> = {
  running: 'var(--color-phase-execute)',
  completed: 'var(--color-status-success)',
  failed: 'var(--color-status-error)',
};

/**
 * Compact duration label for the terminal totals row, matching formatElapsed's
 * shape ("1h 12m" / "6m 36s" / "12s").
 */
function formatDurationMs(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * Format a raw model id from an agent transcript for display, generically:
 * strip a leading "claude-", drop a trailing 8-digit date segment, capitalize
 * the first remaining segment and join the rest with ".".
 *
 * "claude-fable-5" → "Fable 5" · "claude-opus-4-8" → "Opus 4.8" ·
 * "claude-haiku-4-5-20251001" → "Haiku 4.5".
 */
export function formatModelName(raw: string): string {
  const parts = raw
    .replace(/^claude-/, '')
    .split('-')
    .filter((p) => p.length > 0);
  if (parts.length > 1 && /^\d{8}$/.test(parts[parts.length - 1])) parts.pop();
  if (parts.length === 0) return raw;
  const [head, ...rest] = parts;
  const display = head.charAt(0).toUpperCase() + head.slice(1);
  return rest.length > 0 ? `${display} ${rest.join('.')}` : display;
}

/**
 * Derive a display name per agent. Agent labels exist only in the CLI's
 * process memory (never on disk), so the best available signal is each agent's
 * prompt excerpt: compute the longest common prefix across ALL excerpts in the
 * workflow (the shared prologue every subagent prompt opens with) and name
 * each agent by the first ~60 chars of its excerpt AFTER that prefix. A lone
 * excerpt has no shared prologue to strip, so it names itself. When the tail
 * is empty or the excerpt is missing → "agent N" by stable order of appearance
 * in `agents`.
 */
export function computeAgentDisplayNames(
  agents: readonly DynamicWorkflowAgent[],
): Map<string, string> {
  const excerpts = agents
    .map((a) => a.promptExcerpt)
    .filter((e): e is string => typeof e === 'string' && e.length > 0);

  let prefixLen = 0;
  if (excerpts.length >= 2) {
    const first = excerpts[0];
    prefixLen = first.length;
    for (const excerpt of excerpts.slice(1)) {
      let i = 0;
      const max = Math.min(prefixLen, excerpt.length);
      while (i < max && excerpt[i] === first[i]) i++;
      prefixLen = i;
      if (prefixLen === 0) break;
    }
  }

  const names = new Map<string, string>();
  agents.forEach((agent, i) => {
    const tail = (agent.promptExcerpt ?? '')
      .slice(prefixLen)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, AGENT_NAME_MAX_CHARS)
      .trim();
    names.set(agent.agentId, tail.length > 0 ? tail : `agent ${i + 1}`);
  });
  return names;
}

/**
 * One subagent row (expanded variant) — status glyph, derived display name and
 * a " · "-joined meta cluster (model / tokens / tools / idle-or-elapsed).
 * Every meta field is optional; an empty cluster renders an em-dash.
 */
function AgentRow({
  agent,
  displayName,
  nowMs,
}: {
  agent: DynamicWorkflowAgent;
  displayName: string;
  nowMs: number;
}) {
  const isRunning = agent.status === 'running';

  const segments: string[] = [];
  if (agent.model !== undefined) segments.push(formatModelName(agent.model));
  if (agent.outputTokens !== undefined) {
    segments.push(`${formatTokenCount(agent.outputTokens)} tok`);
  }
  if (agent.toolUses !== undefined) {
    segments.push(`${agent.toolUses} ${agent.toolUses === 1 ? 'tool' : 'tools'}`);
  }
  if (isRunning) {
    if (agent.lastActivityAt !== undefined) {
      const idleMs = nowMs - new Date(agent.lastActivityAt).getTime();
      if (Number.isFinite(idleMs) && idleMs > AGENT_IDLE_THRESHOLD_MS) {
        segments.push(`idle ${formatDurationMs(idleMs)}`);
      }
    }
  } else if (agent.startedAt !== undefined && agent.lastActivityAt !== undefined) {
    const elapsedMs =
      new Date(agent.lastActivityAt).getTime() - new Date(agent.startedAt).getTime();
    if (Number.isFinite(elapsedMs)) segments.push(formatDurationMs(elapsedMs));
  }

  return (
    <div
      className="flex items-center gap-2"
      style={{ padding: '3px 0' }}
      data-testid={`dynamic-workflow-agent-${agent.agentId}`}
    >
      {isRunning ? (
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 shrink-0 rounded-full animate-pulse motion-reduce:animate-none"
          style={{ background: 'var(--color-phase-execute)' }}
        />
      ) : (
        <span
          aria-hidden="true"
          className="shrink-0"
          style={{ color: 'var(--color-status-success)', fontSize: 10 }}
        >
          ✓
        </span>
      )}
      <span
        className="min-w-0 flex-1 truncate text-text-primary"
        style={{ fontSize: 11 }}
        title={agent.promptExcerpt ?? displayName}
        data-testid="dynamic-workflow-agent-name"
      >
        {displayName}
      </span>
      <span
        className="shrink-0 text-text-tertiary"
        style={{ fontSize: 10, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
        data-testid="dynamic-workflow-agent-meta"
      >
        {segments.length > 0 ? segments.join(' · ') : '—'}
      </span>
    </div>
  );
}

/** One totals cell — value over a wide-tracked micro-label (StatCell shape). */
function TotalCell({ value, label, testId }: { value: string; label: string; testId: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span
        data-testid={testId}
        style={{
          fontSize: 12,
          fontWeight: 700,
          color: 'var(--color-text-primary)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </span>
      <span
        style={{
          fontSize: 8.5,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--color-text-tertiary)',
          fontWeight: 700,
        }}
      >
        {label}
      </span>
    </div>
  );
}

export interface DynamicWorkflowPanelProps {
  state: DynamicWorkflowRunState;
  /**
   * Canvas-takeover variant: adds per-agent rows below the live line and
   * tightens the wall-clock tick to drive their idle hints. Default false —
   * the compact card rendering is unchanged.
   */
  expanded?: boolean;
}

export function DynamicWorkflowPanel({
  state,
  expanded = false,
}: DynamicWorkflowPanelProps): React.JSX.Element {
  const isRunning = state.status === 'running';
  const accent = STATUS_COLOR[state.status];

  // Wall-clock counter — bumps every ~30s so elapsed re-renders without a
  // per-second timer (ActiveAgentCard pattern). Only ticks while running;
  // the expanded variant ticks coarsely-but-faster for the agent idle hints.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(
      () => setNowMs(Date.now()),
      expanded ? EXPANDED_TICK_MS : ELAPSED_TICK_MS,
    );
    return () => clearInterval(id);
  }, [isRunning, expanded]);

  const runningAgents = state.agents.filter((a) => a.status === 'running').length;
  const doneAgents = state.agents.filter((a) => a.status === 'done').length;

  // Derived display names — memoized per agents array (the store replaces the
  // whole snapshot on change, so reference identity is the right key).
  const agentNames = useMemo(() => computeAgentDisplayNames(state.agents), [state.agents]);

  return (
    <div
      className="border border-border-primary bg-surface-primary p-3 transition-colors hover:border-border-emphasized"
      data-testid={`dynamic-workflow-panel-${state.wfRunId}`}
    >
      {/* Title row */}
      <div className="flex items-center gap-2">
        {isRunning ? (
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 shrink-0 rounded-full animate-pulse motion-reduce:animate-none"
            style={{ background: accent }}
          />
        ) : (
          <span aria-hidden="true" className="shrink-0" style={{ color: accent, fontSize: 11 }}>
            {state.status === 'completed' ? '✓' : '✕'}
          </span>
        )}
        <span
          className="truncate font-bold text-text-primary"
          style={{ fontSize: '13px' }}
          title={state.name}
          data-testid="dynamic-workflow-name"
        >
          {state.name}
        </span>
        <span className="eyebrow shrink-0 text-text-tertiary">dynamic workflow</span>
        <span
          className="eyebrow ml-auto shrink-0 px-1.5 py-0.5"
          style={{ color: accent, border: `1px solid ${accent}` }}
          data-testid="dynamic-workflow-status"
        >
          {state.status}
        </span>
      </div>

      {/* Description (script meta, when present) */}
      {state.description !== undefined && state.description.length > 0 && (
        <p
          className="mt-1.5 text-text-secondary"
          style={{ fontSize: '11px', lineHeight: 1.45 }}
          data-testid="dynamic-workflow-description"
        >
          {state.description}
        </p>
      )}

      {/* Phase PLAN — static chips. Journal lines carry no phase attribution,
          so there is deliberately no per-phase progress here. */}
      {state.phases.length > 0 && (
        <div className="mt-2.5" data-testid="dynamic-workflow-phases">
          <span className="eyebrow text-text-tertiary">plan</span>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {state.phases.map((phase, i) => (
              <span
                key={`${i}-${phase.title}`}
                className="border border-border-primary px-1.5 py-0.5 text-text-secondary"
                style={{ fontSize: '10px' }}
                title={phase.detail}
              >
                {i + 1} · {phase.title}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Live line — agent tally + elapsed while running */}
      <div
        className="mt-2.5 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-text-tertiary"
        style={{ fontSize: '11px' }}
      >
        <span data-testid="dynamic-workflow-agent-tally">
          <span className="font-bold" style={{ color: runningAgents > 0 ? accent : undefined }}>
            {runningAgents} running
          </span>{' '}
          · <span className="font-bold text-text-secondary">{doneAgents} done</span>
        </span>
        {isRunning && (
          <span data-testid="dynamic-workflow-elapsed">{formatElapsed(state.startedAt, nowMs)}</span>
        )}
      </div>

      {/* Per-agent rows — expanded (takeover) variant only */}
      {expanded && state.agents.length > 0 && (
        <div
          className="mt-2.5 border-t border-border-primary pt-2"
          data-testid="dynamic-workflow-agents"
        >
          <span className="eyebrow text-text-tertiary">agents</span>
          <div className="mt-1 flex flex-col">
            {state.agents.map((agent) => (
              <AgentRow
                key={agent.agentId}
                agent={agent}
                displayName={agentNames.get(agent.agentId) ?? agent.agentId}
                nowMs={nowMs}
              />
            ))}
          </div>
        </div>
      )}

      {/* Terminal block — summary + totals from the wf_<id>.json record */}
      {!isRunning && (
        <div className="mt-2.5 border-t border-border-primary pt-2.5">
          {state.summary !== undefined && state.summary.length > 0 && (
            <p
              className="text-text-secondary"
              style={{ fontSize: '11px', lineHeight: 1.45 }}
              data-testid="dynamic-workflow-summary"
            >
              {state.summary}
            </p>
          )}
          {state.totals !== undefined && (
            <div
              className="mt-2 flex flex-wrap gap-x-5 gap-y-2"
              data-testid="dynamic-workflow-totals"
            >
              {state.totals.agentCount !== undefined && (
                <TotalCell
                  value={String(state.totals.agentCount)}
                  label="agents"
                  testId="dynamic-workflow-total-agents"
                />
              )}
              {state.totals.totalTokens !== undefined && (
                <TotalCell
                  value={state.totals.totalTokens.toLocaleString()}
                  label="tokens"
                  testId="dynamic-workflow-total-tokens"
                />
              )}
              {state.totals.totalToolCalls !== undefined && (
                <TotalCell
                  value={state.totals.totalToolCalls.toLocaleString()}
                  label="tool calls"
                  testId="dynamic-workflow-total-tools"
                />
              )}
              {state.totals.durationMs !== undefined && (
                <TotalCell
                  value={formatDurationMs(state.totals.durationMs)}
                  label="duration"
                  testId="dynamic-workflow-total-duration"
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
