/**
 * DynamicWorkflowAgents — the expandable AGENTS section shared by both
 * dynamic-workflow surfaces (the run-pane {@link DynamicWorkflowPanel} and the
 * landing/review-queue DynamicWorkflowAgentCard).
 *
 * Two render modes, chosen by {@link groupAgentsByPhase}:
 *   - `phased`  — when EVERY agent maps cleanly to one declared phase, agents
 *     are bucketed under collapsible stage headers (number · title · live ✓/●
 *     glyph). Clicking a stage reveals the agents in it; the running stage opens
 *     by default so "where are we" is answered at a glance. A phase with no
 *     agents yet renders as a non-interactive "pending" row (stage not reached).
 *   - `flat`    — the honest fallback whenever attribution is not unanimous
 *     (unmatched / ambiguous agents, or excerpts not yet parsed): a plain agent
 *     list with no fabricated stage status.
 *
 * Agent labels never reach disk, so display names fall back to each agent's
 * prompt excerpt with the longest shared prologue stripped (see
 * computeAgentDisplayNames). This module owns AgentRow + the name/model/duration
 * formatting so both surfaces render identical rows.
 */
import { useMemo, useState } from 'react';
import { formatTokenCount } from '../../hooks/useSessionMetrics';
import {
  groupAgentsByPhase,
  type PhaseBucket,
  type PhaseBucketStatus,
} from '../../utils/dynamicWorkflowGrouping';
import type {
  DynamicWorkflowAgent,
  DynamicWorkflowRunState,
} from '../../../../shared/types/dynamicWorkflows';

/** A running agent with no transcript line for this long is flagged "idle Ns". */
const AGENT_IDLE_THRESHOLD_MS = 30_000;

/** Max length of a derived agent display name (post prologue-strip). */
const AGENT_NAME_MAX_CHARS = 60;

/**
 * Compact duration label matching formatElapsed's shape ("1h 12m" / "6m 36s" /
 * "12s").
 */
export function formatDurationMs(ms: number): string {
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
 * One subagent row — status glyph, derived display name and a " · "-joined meta
 * cluster (model / tokens / tools / idle-or-elapsed). Every meta field is
 * optional; an empty cluster renders an em-dash.
 */
export function AgentRow({
  agent,
  displayName,
  nowMs,
}: {
  agent: DynamicWorkflowAgent;
  displayName: string;
  nowMs: number;
}): React.JSX.Element {
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

/** Status glyph for a stage header (matches AgentRow's running/done glyphs). */
function StageGlyph({ status }: { status: PhaseBucketStatus }): React.JSX.Element {
  if (status === 'running') {
    return (
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 shrink-0 rounded-full animate-pulse motion-reduce:animate-none"
        style={{ background: 'var(--color-phase-execute)' }}
      />
    );
  }
  if (status === 'done') {
    return (
      <span aria-hidden="true" className="shrink-0" style={{ color: 'var(--color-status-success)', fontSize: 10 }}>
        ✓
      </span>
    );
  }
  return (
    <span aria-hidden="true" className="shrink-0 text-text-tertiary" style={{ fontSize: 10 }}>
      ◦
    </span>
  );
}

/** Short right-aligned tally for a stage header. */
function stageTally(bucket: PhaseBucket): string {
  const running = bucket.agents.filter((a) => a.status === 'running').length;
  const done = bucket.agents.length - running;
  if (bucket.agents.length === 0) return 'pending';
  if (running > 0) return done > 0 ? `${running} running · ${done} done` : `${running} running`;
  return `${done} done`;
}

/** One collapsible stage bucket (phased mode). Pending stages are inert rows. */
function StageBucket({
  bucket,
  displayNames,
  nowMs,
}: {
  bucket: PhaseBucket;
  displayNames: Map<string, string>;
  nowMs: number;
}): React.JSX.Element {
  // Running stage opens by default (surface "now"); others start collapsed so
  // clicking a stage reveals its agents.
  const [open, setOpen] = useState<boolean>(bucket.status === 'running');
  const hasAgents = bucket.agents.length > 0;
  const label = `${bucket.phaseIndex + 1} · ${bucket.title}`;

  const headerInner = (
    <>
      {hasAgents && (
        <span aria-hidden="true" className="shrink-0 text-text-tertiary" style={{ fontSize: 9, width: 8 }}>
          {open ? '▾' : '▸'}
        </span>
      )}
      {!hasAgents && <span aria-hidden="true" className="shrink-0" style={{ width: 8 }} />}
      <StageGlyph status={bucket.status} />
      <span className="min-w-0 flex-1 truncate text-text-secondary" style={{ fontSize: 11 }} title={bucket.detail}>
        {label}
      </span>
      <span
        className="shrink-0 text-text-tertiary"
        style={{ fontSize: 10, fontVariantNumeric: 'tabular-nums' }}
      >
        {stageTally(bucket)}
      </span>
    </>
  );

  return (
    <div data-testid={`dynamic-workflow-stage-${bucket.phaseIndex}`}>
      {hasAgents ? (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left transition-colors hover:bg-surface-hover"
          data-testid={`dynamic-workflow-stage-toggle-${bucket.phaseIndex}`}
        >
          {headerInner}
        </button>
      ) : (
        <div className="flex w-full items-center gap-2 px-1 py-0.5 opacity-70">{headerInner}</div>
      )}
      {hasAgents && open && (
        <div className="ml-3 flex flex-col border-l border-border-primary pl-2">
          {bucket.agents.map((agent) => (
            <AgentRow
              key={agent.agentId}
              agent={agent}
              displayName={displayNames.get(agent.agentId) ?? agent.agentId}
              nowMs={nowMs}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export interface DynamicWorkflowAgentsProps {
  state: DynamicWorkflowRunState;
  /** Wall-clock epoch ms, owned by the caller's elapsed ticker (idle hints). */
  nowMs: number;
}

/**
 * The shared AGENTS section: a stage-bucketed accordion when agents map cleanly
 * to the phase plan, else a flat agent list. Renders nothing when there are no
 * agents yet.
 */
export function DynamicWorkflowAgents({
  state,
  nowMs,
}: DynamicWorkflowAgentsProps): React.JSX.Element | null {
  const displayNames = useMemo(() => computeAgentDisplayNames(state.agents), [state.agents]);
  const grouping = useMemo(
    () => groupAgentsByPhase(state.agents, state.phases),
    [state.agents, state.phases],
  );

  if (state.agents.length === 0) return null;

  return (
    <div className="mt-2.5 border-t border-border-primary pt-2" data-testid="dynamic-workflow-agents">
      <span className="eyebrow text-text-tertiary">agents</span>
      {grouping.mode === 'phased' ? (
        <div className="mt-1 flex flex-col gap-0.5">
          {grouping.buckets.map((bucket) => (
            <StageBucket
              key={bucket.phaseIndex}
              bucket={bucket}
              displayNames={displayNames}
              nowMs={nowMs}
            />
          ))}
        </div>
      ) : (
        <div className="mt-1 flex flex-col">
          {state.agents.map((agent) => (
            <AgentRow
              key={agent.agentId}
              agent={agent}
              displayName={displayNames.get(agent.agentId) ?? agent.agentId}
              nowMs={nowMs}
            />
          ))}
        </div>
      )}
    </div>
  );
}
