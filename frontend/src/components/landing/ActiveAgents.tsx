/**
 * ActiveAgents — the landing-home "Active agents" section, grouped by project.
 *
 * Surfaces every workflow run currently classified as ACTIVE (queued / starting
 * / running — see {@link classifyRun}) across all projects. Renders nothing when
 * none are active.
 *
 * Layout (protoflow §active-agents): a dashed section divider header ("Active
 * agents" + "<N> running" + a right-aligned descriptor), then one block per
 * project — a small folder-glyph sub-header with the project name, its running
 * count, and a hairline rule — followed by an {@link ActiveAgentCard} per run.
 *
 * Self-contained, no props: reads the aggregated runs + projects directly from
 * {@link landingStore}. Each card opens exactly one phase subscription, so cards
 * are mapped (one hook-bearing component per run) rather than calling hooks in a
 * loop here.
 */
import { useMemo } from 'react';
import { Folder } from 'lucide-react';
import { useAggregatedRuns, useLandingProjects } from '../../stores/landingStore';
import { classifyRun } from '../../utils/homeClassify';
import type { ActiveRunRow } from '../../stores/activeRunsStore';
import { ActiveAgentCard } from './ActiveAgentCard';

/** A project bucket: the project's display name + its active runs. */
interface ProjectGroup {
  projectId: number;
  projectName: string;
  runs: ActiveRunRow[];
}

export function ActiveAgents(): React.JSX.Element | null {
  const runs = useAggregatedRuns();
  const projects = useLandingProjects();

  const activeRuns = useMemo(
    () => runs.filter((run) => classifyRun(run.status) === 'active'),
    [runs],
  );

  // Group active runs by project_id, resolving each project's display name from
  // the project list (fallback to a generic label if a project is missing).
  const groups = useMemo<ProjectGroup[]>(() => {
    const nameById = new Map<number, string>();
    for (const project of projects) nameById.set(project.id, project.name);

    const byProject = new Map<number, ActiveRunRow[]>();
    for (const run of activeRuns) {
      const bucket = byProject.get(run.project_id);
      if (bucket === undefined) {
        byProject.set(run.project_id, [run]);
      } else {
        bucket.push(run);
      }
    }

    return Array.from(byProject.entries()).map(([projectId, projectRuns]) => ({
      projectId,
      projectName: nameById.get(projectId) ?? 'Project',
      runs: projectRuns,
    }));
  }, [activeRuns, projects]);

  if (activeRuns.length === 0) return null;

  return (
    <section data-testid="active-agents" className="w-full">
      {/* Section header */}
      <div className="flex items-baseline gap-2 border-t border-dashed border-border-primary pt-4">
        <span className="text-[12px] font-bold text-text-primary">Active agents</span>
        <span className="eyebrow text-text-tertiary">{activeRuns.length} running</span>
        <span className="ml-auto text-[11px] text-text-muted">unblocked · grouped by project</span>
      </div>

      {/* Per-project groups */}
      <div className="mt-4 flex flex-col gap-5">
        {groups.map((group) => (
          <div key={group.projectId}>
            {/* Project sub-header */}
            <div className="flex items-center gap-2">
              <Folder className="h-3.5 w-3.5 shrink-0 text-text-tertiary" strokeWidth={2} />
              <span className="truncate text-[11px] font-bold text-text-secondary" title={group.projectName}>
                {group.projectName}
              </span>
              <span className="eyebrow shrink-0 text-text-muted">{group.runs.length} running</span>
              <span className="ml-2 h-px flex-1 bg-border-primary" />
            </div>

            {/* Run cards */}
            <div className="mt-2 flex flex-col gap-2">
              {group.runs.map((run) => (
                <ActiveAgentCard key={run.id} run={run} projectName={group.projectName} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
