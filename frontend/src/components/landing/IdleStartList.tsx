/**
 * IdleStartList — the "idle agents · start one" leaf on the landing home.
 *
 * Self-contained: it reads the aggregated cross-project projects + runs and
 * lists every project that has NO active or blocked run (i.e. nothing in
 * flight). Each row offers a one-click "Start →" into the new-flow wizard,
 * locked to that project with the quick escape hatch.
 *
 * Renders nothing when there are no idle projects (all projects have work in
 * flight).
 */
import { useMemo } from 'react';
import { Folder, ArrowRight } from 'lucide-react';
import { useLandingProjects, useAggregatedRuns } from '../../stores/landingStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { classifyRun } from '../../utils/homeClassify';
import type { Project } from '../../types/project';

/**
 * A project is "busy" when it owns at least one run that classifies as active
 * or blocked. Idle = not busy. We also surface a representative branch for the
 * row label (the first run's branch, if any) — purely cosmetic.
 */
interface IdleProject {
  project: Project;
  branch: string | null;
}

/** IdleStartList takes no props — it derives its own data. */
export function IdleStartList() {
  const projects = useLandingProjects();
  const runs = useAggregatedRuns();

  const idleProjects = useMemo<IdleProject[]>(() => {
    // projectId → does it have any active/blocked run, and a sample branch.
    const busyByProject = new Set<number>();
    const branchByProject = new Map<number, string | null>();

    for (const run of runs) {
      const activity = classifyRun(run.status);
      if (activity === 'active' || activity === 'blocked') {
        busyByProject.add(run.project_id);
      }
      if (!branchByProject.has(run.project_id)) {
        branchByProject.set(run.project_id, run.branch_name);
      }
    }

    return projects
      .filter((p) => !busyByProject.has(p.id))
      .map((project) => ({
        project,
        branch: branchByProject.get(project.id) ?? null,
      }));
  }, [projects, runs]);

  if (idleProjects.length === 0) return null;

  return (
    <div className="px-7 py-5 font-mono">
      <div className="mb-3 border-t border-dashed border-border-primary pt-4">
        <div className="eyebrow text-text-tertiary">Idle agents · start one</div>
      </div>

      <ul className="flex flex-col">
        {idleProjects.map(({ project, branch }) => (
          <li
            key={project.id}
            className="flex items-center justify-between gap-4 border-b border-border-primary py-2.5 last:border-b-0"
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <Folder className="h-4 w-4 shrink-0 text-text-tertiary" strokeWidth={1.5} />
              <span className="truncate text-sm text-text-primary">{project.name}</span>
              <span className="shrink-0 text-xs text-text-muted">
                {branch ? `⌥ ${branch} · idle` : '⌥ idle'}
              </span>
            </div>
            <button
              type="button"
              onClick={() =>
                useNavigationStore
                  .getState()
                  .goToWizard({ lockProjectId: project.id, allowQuick: true })
              }
              className="inline-flex shrink-0 items-center gap-1 text-xs font-bold uppercase tracking-wide text-interactive hover:text-interactive-hover"
            >
              Start
              <ArrowRight className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
