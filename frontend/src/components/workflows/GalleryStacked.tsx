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

  // Thin action props — wired in P4 / the editor integration.
  onRunWorkflow?: (entry: WorkflowGalleryEntry) => void;
  onEditWorkflow?: (entry: WorkflowGalleryEntry) => void;
  onDuplicateWorkflow?: (entry: WorkflowGalleryEntry) => void;
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
  onRunWorkflow,
  onEditWorkflow,
  onDuplicateWorkflow,
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
    </div>
  );
}
