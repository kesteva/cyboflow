/**
 * FindingProjectTag — a small, subtle tag naming the project a finding came
 * from. The compounding backlog (untriaged + ready) is cross-project until a
 * selection locks it to one project, so each row carries its origin project as
 * a tag for at-a-glance disambiguation.
 *
 * Resolves the name reactively from the landing projects slice by the finding's
 * `project_id`. Renders nothing when the project is unknown (e.g. deleted) so a
 * stale id never shows an empty chip.
 */
import { useLandingProjects } from '../../stores/landingStore';

interface FindingProjectTagProps {
  projectId: number;
}

/** FindingProjectTag — see the file header. */
export function FindingProjectTag({ projectId }: FindingProjectTagProps): React.JSX.Element | null {
  const projects = useLandingProjects();
  const name = projects.find((p) => p.id === projectId)?.name;
  if (!name) return null;

  return (
    <span
      className="shrink-0 rounded-badge border border-border-primary px-1.5 py-px text-[10px] text-text-secondary"
      title={name}
      data-testid="finding-project-tag"
    >
      {name}
    </span>
  );
}
