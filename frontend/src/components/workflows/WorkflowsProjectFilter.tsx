/**
 * WorkflowsProjectFilter — the compact project-scope control in the Workflows
 * gallery header. The workflows-store twin of Insights' `ProjectFilter`: it
 * reflects {@link useWorkflowsStore}'s `projectFilter` (null = ALL projects) and
 * pushes changes back through `setProjectFilter`, which re-runs the fan-out.
 *
 * Like the Insights control it uses a plain styled native `<select>` (inheriting
 * the surrounding mono font) over the Radix primitives, and degrades to the
 * "All projects" sentinel alone on a project-load failure so the header never
 * blanks.
 */
import { useEffect, useState } from 'react';
import { API } from '../../utils/api';
import type { Project } from '../../types/project';
import { useWorkflowsStore } from '../../stores/workflowsStore';

/** Sentinel `<option>` value for the "All projects" (null filter) choice. */
const ALL_PROJECTS_VALUE = 'all';

/** WorkflowsProjectFilter — see the file header. Named export, no props. */
export function WorkflowsProjectFilter(): React.JSX.Element {
  const projectFilter = useWorkflowsStore((s) => s.projectFilter);
  const [projects, setProjects] = useState<Project[]>([]);

  useEffect(() => {
    let active = true;
    void API.projects
      .getAll()
      .then((res) => {
        if (!active) return;
        if (res.success && Array.isArray(res.data)) {
          setProjects(res.data as Project[]);
        }
      })
      .catch(() => {
        // Swallow — the header must keep rendering with "All projects" only.
      });
    return () => {
      active = false;
    };
  }, []);

  const handleChange = (event: React.ChangeEvent<HTMLSelectElement>): void => {
    const raw = event.target.value;
    const idOrNull = raw === ALL_PROJECTS_VALUE ? null : Number(raw);
    void useWorkflowsStore.getState().setProjectFilter(idOrNull);
  };

  return (
    <label className="flex items-center gap-2">
      <span className="eyebrow text-text-tertiary">Project</span>
      <select
        data-testid="workflows-project-filter"
        aria-label="Filter workflows by project"
        value={projectFilter === null ? ALL_PROJECTS_VALUE : String(projectFilter)}
        onChange={handleChange}
        className="rounded-button border border-border-primary bg-bg-primary px-2.5 py-1 font-mono text-xs text-text-secondary transition-colors hover:border-border-emphasized hover:text-text-primary focus:border-border-emphasized focus:outline-none"
      >
        <option value={ALL_PROJECTS_VALUE}>All projects</option>
        {projects.map((project) => (
          <option key={project.id} value={String(project.id)}>
            {project.name}
          </option>
        ))}
      </select>
    </label>
  );
}
