/**
 * GalleryStacked — the stacked gallery body: a Workflows section over an Agents
 * section, both on one scrolling surface (the chosen direction in the design
 * reference's `GalleryStacked`). PURELY presentational — it takes the resolved
 * slices + the thin action props and owns no store wiring; {@link WorkflowsView}
 * passes everything down.
 *
 * Section invariants:
 *   - The count pill reflects the REAL card count, EXCLUDING the dashed New card
 *     ({@link GallerySection} renders the pill from `count`, and we append the
 *     New card into `children` AFTER passing `entries.length`).
 *   - The Workflows section is never truly empty — a builtin-only project still
 *     shows its flow cards plus the New card.
 *   - The Agents section FEATURE-GATES: when agents are unavailable (the store
 *     flags it) or the list is empty, we render an empty-state row INSTEAD of a
 *     broken grid (the New-agent card is still offered so the section is usable).
 *
 * Action props are forwarded verbatim to the cards; their handler bodies are
 * TODO no-ops wired in P4 / the editor integration.
 */
import { GallerySection } from './GallerySection';
import { WorkflowCard } from './WorkflowCard';
import { AgentCard } from './AgentCard';
import { NewWorkflowCard } from './NewWorkflowCard';
import { NewAgentCard } from './NewAgentCard';
import type { WorkflowGalleryEntry, AgentGalleryEntry } from '../../stores/workflowsStore';
import type { McpEntry, PluginEntry } from '../../../../shared/types/integrations';

export interface GalleryStackedProps {
  /** Workflow cards across the resolved project set. */
  workflows: WorkflowGalleryEntry[];
  /** Agent cards across the resolved project set (deduped by agentKey). */
  agents: AgentGalleryEntry[];
  /**
   * True when the gallery is in the cross-project "All projects" view — drives
   * the per-card owning-project chip.
   */
  showProjectChip: boolean;
  /**
   * True when the Agents catalogue is unavailable for the resolved scope (no
   * agents.list data). Renders the Agents empty-state instead of a grid.
   */
  agentsUnavailable: boolean;
  /** CLI-configured MCP servers (machine-global, read-only). */
  mcps: McpEntry[];
  /** Installed Claude Code plugins (machine-global, read-only). */
  plugins: PluginEntry[];

  // Thin action props — wired in P4 / the editor integration.
  onRunWorkflow?: (entry: WorkflowGalleryEntry) => void;
  onEditWorkflow?: (entry: WorkflowGalleryEntry) => void;
  onDuplicateWorkflow?: (entry: WorkflowGalleryEntry) => void;
  onDeleteWorkflow?: (entry: WorkflowGalleryEntry) => void;
  onNewWorkflow?: () => void;
  onEditAgent?: (entry: AgentGalleryEntry) => void;
  onNewAgent?: () => void;
}

/** GalleryStacked — see the file header. */
export function GalleryStacked({
  workflows,
  agents,
  showProjectChip,
  agentsUnavailable,
  mcps,
  plugins,
  onRunWorkflow,
  onEditWorkflow,
  onDuplicateWorkflow,
  onDeleteWorkflow,
  onNewWorkflow,
  onEditAgent,
  onNewAgent,
}: GalleryStackedProps): React.JSX.Element {
  const showAgentsGrid = !agentsUnavailable && agents.length > 0;

  return (
    <div className="pb-11" data-testid="gallery-stacked">
      <GallerySection
        title="Workflows"
        count={workflows.length}
        subtitle="Reusable agent pipelines — run with one command"
        data-testid="gallery-section-workflows"
      >
        {workflows.map((entry) => (
          <WorkflowCard
            key={entry.row.id}
            entry={entry}
            showProjectChip={showProjectChip}
            onRun={onRunWorkflow}
            onEdit={onEditWorkflow}
            onDuplicate={onDuplicateWorkflow}
            onDelete={onDeleteWorkflow}
          />
        ))}
        <NewWorkflowCard onClick={onNewWorkflow} />
      </GallerySection>

      <GallerySection
        title="Agents"
        count={showAgentsGrid ? agents.length : 0}
        subtitle="Pre-configured roles the workflows above draw from"
        gridClassName="grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        data-testid="gallery-section-agents"
      >
        {showAgentsGrid ? (
          <>
            {agents.map((entry) => (
              <AgentCard key={entry.id} entry={entry} onEdit={onEditAgent} />
            ))}
            <NewAgentCard onClick={onNewAgent} />
          </>
        ) : (
          <>
            <div
              data-testid="gallery-agents-empty"
              className="col-span-full border border-dashed border-border-primary bg-bg-secondary p-6 text-center text-[11px] leading-relaxed text-text-tertiary"
            >
              No agents are available for this scope yet. Built-in roles appear
              once a project's flows resolve; create one to get started.
            </div>
            <NewAgentCard onClick={onNewAgent} />
          </>
        )}
      </GallerySection>

      <GallerySection
        title="MCPs"
        count={mcps.length}
        subtitle="Model Context Protocol servers from your CLI config"
        gridClassName="grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        data-testid="gallery-section-mcps"
      >
        {mcps.length > 0 ? (
          mcps.map((entry) => (
            <div
              key={`${entry.scope}:${entry.name}`}
              data-testid={`mcp-card-${entry.name}`}
              className="flex flex-col gap-2.5 border border-border-primary bg-surface-primary p-4 transition-[border-color,box-shadow] duration-150 hover:border-text-primary"
              onMouseEnter={(e) => {
                e.currentTarget.style.boxShadow = '0 2px 0 var(--color-text-primary)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.boxShadow = 'none';
              }}
            >
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[13px] font-bold tracking-[-0.005em] text-text-primary">
                  {entry.name}
                </span>
                <span className="shrink-0 rounded-badge border border-border-primary bg-bg-secondary px-1.5 py-px text-[8.5px] font-bold uppercase tracking-[0.08em] text-text-tertiary">
                  {entry.transport}
                </span>
              </div>
              <p className="flex-1 truncate text-[11px] leading-relaxed text-text-secondary">
                {entry.url ?? entry.command ?? '—'}
              </p>
              <div className="flex items-center gap-2 border-t border-dashed border-border-primary pt-2.5 text-[9.5px] tracking-[0.04em] text-text-tertiary">
                <span className="truncate">{entry.scope === 'global' ? 'global' : entry.scope}</span>
              </div>
            </div>
          ))
        ) : (
          <div
            data-testid="gallery-mcps-empty"
            className="col-span-full border border-dashed border-border-primary bg-bg-secondary p-6 text-center text-[11px] leading-relaxed text-text-tertiary"
          >
            No MCP servers are configured in your CLI yet.
          </div>
        )}
      </GallerySection>

      <GallerySection
        title="Plugins"
        count={plugins.length}
        subtitle="Installed Claude Code plugins"
        gridClassName="grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        data-testid="gallery-section-plugins"
      >
        {plugins.length > 0 ? (
          plugins.map((entry) => (
            <div
              key={`${entry.id}:${entry.scope}:${entry.projectPath ?? ''}`}
              data-testid={`plugin-card-${entry.name}`}
              className="flex flex-col gap-2.5 border border-border-primary bg-surface-primary p-4 transition-[border-color,box-shadow] duration-150 hover:border-text-primary"
              onMouseEnter={(e) => {
                e.currentTarget.style.boxShadow = '0 2px 0 var(--color-text-primary)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.boxShadow = 'none';
              }}
            >
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[13px] font-bold tracking-[-0.005em] text-text-primary">
                  {entry.name}
                </span>
                <span className="shrink-0 rounded-badge border border-border-primary bg-bg-secondary px-1.5 py-px text-[8.5px] font-bold uppercase tracking-[0.08em] text-text-tertiary">
                  {entry.scope}
                </span>
              </div>
              <p className="flex-1 truncate text-[11px] leading-relaxed text-text-secondary">
                {entry.marketplace}
              </p>
              <div className="flex items-center gap-2 border-t border-dashed border-border-primary pt-2.5 text-[9.5px] tracking-[0.04em] text-text-tertiary">
                <span>
                  <b className="font-bold tabular-nums text-text-primary">{entry.version}</b>
                </span>
              </div>
            </div>
          ))
        ) : (
          <div
            data-testid="gallery-plugins-empty"
            className="col-span-full border border-dashed border-border-primary bg-bg-secondary p-6 text-center text-[11px] leading-relaxed text-text-tertiary"
          >
            No plugins are installed yet.
          </div>
        )}
      </GallerySection>
    </div>
  );
}
