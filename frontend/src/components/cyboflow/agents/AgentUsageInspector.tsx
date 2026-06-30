/**
 * AgentUsageInspector — the right-rail of the Agent editor modal.
 *
 * Sections:
 *   - "Bound to N steps": one row per workflow that binds this agent via a
 *     `step.agent` reference (entry.usage.usedBy), showing the phase color swatch,
 *     workflow name, the bound step names, and a step count.
 *   - "Dispatched by: <names>": a single line for workflows whose PROSE dispatches
 *     this agent without a step binding (entry.usage.dispatchedBy). This is what
 *     keeps a step-unbound prose agent from rendering a bare "0 workflows".
 *   - "Stats": Model (live echo of the picker — "inherits run model" or the
 *     pinned model label), Prompt (~N tokens est), Tools (n of 8), Last edited.
 *   - A case note: built-in → "Edits apply to every workflow that references this
 *     agent"; custom → "Available to @-mention, not auto-dispatched by built-in
 *     flows."
 *
 * Model is edited in the form's picker; here it is a live read-only echo
 * (mirroring liveTokens / liveToolsEnabled), not a separate control.
 */
import { useMemo } from 'react';
import type { AgentEntry } from '../../../../../shared/types/agents';

export interface AgentUsageInspectorProps {
  entry: AgentEntry;
  /** Live prompt token estimate (echoes the editing draft, not the seeded stat). */
  liveTokens: number;
  /** Live enabled-tool count from the draft (echoes the form's toggles). */
  liveToolsEnabled: number;
  /** Live model display label from the draft (echoes the form's model picker). */
  liveModel: string;
}

/** Format an ISO timestamp into a short, human "last edited" string. */
function formatLastEdited(iso: string | null): string {
  if (iso === null) return 'never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'never';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function AgentUsageInspector({
  entry,
  liveTokens,
  liveToolsEnabled,
  liveModel,
}: AgentUsageInspectorProps): React.JSX.Element {
  const { usage, stats, isCustom } = entry;
  const boundCount = usage.usedBy.length;
  const dispatchedBy = usage.dispatchedBy;

  const caseNote = useMemo(
    () =>
      isCustom
        ? 'Available to @-mention, not auto-dispatched by built-in flows.'
        : 'Edits apply to every workflow that references this agent.',
    [isCustom],
  );

  return (
    <div
      className="w-[312px] flex-shrink-0 border-l border-border-subtle bg-surface-secondary overflow-auto"
      data-testid="agent-usage-inspector"
    >
      <div className="p-4">
        {/* ── Bound steps ─────────────────────────────────────────────── */}
        <div className="text-[9px] font-bold uppercase tracking-[0.18em] text-text-tertiary mb-3">
          {`Bound to ${boundCount} step${boundCount === 1 ? '' : 's'}`}
        </div>

        {boundCount > 0 ? (
          usage.usedBy.map((u) => (
            <div
              key={u.workflowName}
              className="flex items-center gap-2.5 py-2 border-b border-dashed border-border-subtle"
              data-testid={`agent-usage-bound-${u.workflowName}`}
            >
              <span
                className="w-2 h-4 rounded-[1px] flex-shrink-0"
                style={{ background: u.phaseColor }}
                aria-hidden="true"
              />
              <span className="flex-1 min-w-0">
                <span className="block text-xs font-bold text-text-primary truncate">
                  {u.workflowName}
                </span>
                <span className="block text-[10px] text-text-tertiary truncate">
                  {u.stepNames.join(' · ')}
                </span>
              </span>
              <span className="text-[10px] text-text-tertiary tabular-nums">
                {u.stepNames.length}×
              </span>
            </div>
          ))
        ) : (
          <p className="text-xs text-text-tertiary" data-testid="agent-usage-no-bound">
            Not bound to any workflow step.
          </p>
        )}

        {/* ── Dispatched by (prose dispatch, no step binding) ─────────── */}
        {dispatchedBy.length > 0 && (
          <p className="mt-3 text-[11px] text-text-secondary" data-testid="agent-usage-dispatched">
            <span className="font-semibold text-text-primary">Dispatched by: </span>
            {dispatchedBy.join(', ')}
          </p>
        )}

        {/* ── Stats ───────────────────────────────────────────────────── */}
        <div className="text-[9px] font-bold uppercase tracking-[0.18em] text-text-tertiary mt-6 mb-3">
          Stats
        </div>
        <dl data-testid="agent-stats">
          <div className="flex justify-between py-1.5 border-b border-dotted border-border-subtle text-[11px]">
            <dt className="text-text-secondary">model</dt>
            <dd className="font-bold text-text-primary">{liveModel}</dd>
          </div>
          <div className="flex justify-between py-1.5 border-b border-dotted border-border-subtle text-[11px]">
            <dt className="text-text-secondary">prompt</dt>
            <dd className="font-bold text-text-primary tabular-nums">~{liveTokens} tokens</dd>
          </div>
          <div className="flex justify-between py-1.5 border-b border-dotted border-border-subtle text-[11px]">
            <dt className="text-text-secondary">tools enabled</dt>
            <dd className="font-bold text-text-primary tabular-nums">
              {liveToolsEnabled} of {stats.toolsTotal}
            </dd>
          </div>
          <div className="flex justify-between py-1.5 border-b border-dotted border-border-subtle text-[11px]">
            <dt className="text-text-secondary">last edited</dt>
            <dd className="font-bold text-text-primary">{formatLastEdited(stats.lastEditedAt)}</dd>
          </div>
        </dl>

        <p className="mt-3.5 text-[10px] leading-relaxed text-text-tertiary" data-testid="agent-case-note">
          {caseNote}
        </p>
      </div>
    </div>
  );
}
