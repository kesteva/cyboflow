/**
 * ProjectFilter — the compact project scope control in the Insights header.
 *
 * The {@link useInsightsStore} already owns cross-project scoping: `projectFilter`
 * (null = ALL projects) and `setProjectFilter(id|null)` re-run the whole fetch
 * fan-out. This component is the missing UI for that store value — it loads the
 * project list ONCE on mount (via `API.projects.getAll()`, the SessionStartWizard
 * pattern), reflects the CURRENT store value, and pushes changes back through
 * `setProjectFilter`.
 *
 * A plain styled `<select>` is used deliberately over the Radix `ui/Select` /
 * `ui/Dropdown` primitives: those carry an `sm`/`md` non-mono trigger that clashes
 * with this view's font-mono `.eyebrow` header idiom. The native control inherits
 * the surrounding mono font and stays compact.
 *
 * Resilience: a failed project load is swallowed — the control simply degrades to
 * a single "All projects" option so the dashboard never blanks on a list error.
 * The select's `value` is driven by the store, so the cross-project default and
 * any external `setProjectFilter` stay reflected.
 */
import { useEffect, useState } from 'react';
import { API } from '../../utils/api';
import type { Project } from '../../types/project';
import { useInsightsStore } from '../../stores/insightsStore';

/** Sentinel `<option>` value for the "All projects" (null filter) choice. */
const ALL_PROJECTS_VALUE = 'all';

/**
 * ProjectFilter — see the file header. Named export, no props; reads + writes the
 * global insights store directly.
 */
export function ProjectFilter(): React.JSX.Element {
  const projectFilter = useInsightsStore((s) => s.projectFilter);
  const [projects, setProjects] = useState<Project[]>([]);

  // One-shot project load on mount. A failure leaves `projects` empty so the
  // control falls back to the "All projects" option alone — never fatal.
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
        // Swallow — the view must keep rendering with "All projects" only.
      });
    return () => {
      active = false;
    };
  }, []);

  // Map the <select> value back to the store's number|null filter and re-run the
  // fan-out via the store's own setter (which owns the refresh).
  const handleChange = (event: React.ChangeEvent<HTMLSelectElement>): void => {
    const raw = event.target.value;
    const idOrNull = raw === ALL_PROJECTS_VALUE ? null : Number(raw);
    void useInsightsStore.getState().setProjectFilter(idOrNull);
  };

  return (
    <label className="flex items-center gap-2">
      <span className="eyebrow text-text-tertiary">Project</span>
      <select
        data-testid="insights-project-filter"
        aria-label="Filter insights by project"
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
