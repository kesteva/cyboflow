/**
 * AgentCard — one agent tile in the stacked gallery's Agents section.
 *
 * Renders an {@link AgentGalleryEntry}: the agent name, a role chip, the
 * description, a READ-ONLY "inherits run model" chip (agents are MODEL-AGNOSTIC
 * — there is deliberately NO model picker anywhere), the tools count as
 * "N of {@link CLI_TOOLS.length}", and a footer carrying the token estimate
 * (or an EMPTY slot when `tokensEstimate === null` — never a fabricated number)
 * plus an Edit action. A custom or override agent shows a source badge.
 *
 * Mirrors the design reference's `.GB-acard` block re-created with repo tokens:
 * white surface, hairline border, SQUARE corners, and a
 * `0 2px 0 var(--color-text-primary)` hover lift.
 *
 * `onEdit` is a thin prop from WorkflowsView; its body is wired in the editor
 * integration. Optional so render never crashes before wiring.
 */
import { CLI_TOOLS } from '../../../../shared/types/cliTools';
import type { AgentGalleryEntry } from '../../stores/workflowsStore';

export interface AgentCardProps {
  /** The adapted agent gallery row. */
  entry: AgentGalleryEntry;
  /** Open this agent in the editor. Wired in the editor integration. */
  onEdit?: (entry: AgentGalleryEntry) => void;
}

/** AgentCard — see the file header. */
export function AgentCard({ entry, onEdit }: AgentCardProps): React.JSX.Element {
  const sourceBadge = entry.isCustom ? 'custom' : entry.isOverride ? 'override' : null;

  return (
    <div
      data-testid={`agent-card-${entry.id}`}
      className="flex flex-col gap-2.5 border border-border-primary bg-surface-primary p-4 transition-[border-color,box-shadow] duration-150 hover:border-text-primary"
      onMouseEnter={(e) => {
        e.currentTarget.style.boxShadow = '0 2px 0 var(--color-text-primary)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.boxShadow = 'none';
      }}
    >
      <div className="flex items-center gap-2">
        {/* Render the bare agent key (entry.id === agentKey), NOT entry.name:
            the persisted `cyboflow-` prefix is load-bearing for session injection
            / dispatch but redundant noise in this catalogue. Customs show their
            kebab key (no separate display_name column). */}
        <span className="min-w-0 flex-1 truncate text-[13px] font-bold tracking-[-0.005em] text-text-primary">
          {entry.id}
        </span>
        {sourceBadge !== null && (
          <span
            data-testid="agent-card-source-badge"
            className="shrink-0 rounded-badge border border-border-primary bg-bg-secondary px-1.5 py-px text-[8.5px] font-bold uppercase tracking-[0.08em] text-text-tertiary"
          >
            {sourceBadge}
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {entry.role !== '' && (
          <span className="rounded-badge border border-border-emphasized px-1.5 py-px text-[9.5px] font-semibold text-text-secondary">
            {entry.role}
          </span>
        )}
        {/* Read-only — agents inherit the run model; NO model picker. */}
        <span
          data-testid="agent-card-model-chip"
          className="rounded-badge border border-border-primary bg-bg-secondary px-1.5 py-px text-[9.5px] text-text-tertiary"
        >
          inherits run model
        </span>
      </div>

      <p className="flex-1 text-[11px] leading-relaxed text-text-secondary">
        {entry.description}
      </p>

      <div className="flex items-center gap-2 border-t border-dashed border-border-primary pt-2.5 text-[9.5px] tracking-[0.04em] text-text-tertiary">
        <span>
          <b className="font-bold tabular-nums text-text-primary">{entry.tools.length}</b> of{' '}
          {CLI_TOOLS.length} tools
        </span>
        {/* tokensEstimate === null leaves an EMPTY slot — never a fabricated 0. */}
        {entry.tokensEstimate !== null && (
          <span data-testid="agent-card-tokens">
            <b className="font-bold tabular-nums text-text-primary">
              {entry.tokensEstimate.toLocaleString()}
            </b>{' '}
            tokens
          </span>
        )}
        <span className="flex-1" />
        <button
          type="button"
          data-testid={`agent-card-edit-${entry.id}`}
          onClick={onEdit !== undefined ? () => onEdit(entry) : undefined}
          className="border border-border-primary bg-surface-primary px-2.5 py-1.5 text-[9px] font-bold uppercase tracking-[0.1em] text-text-primary transition-colors hover:border-text-primary"
        >
          Edit
        </button>
      </div>
    </div>
  );
}
