/**
 * OpenInIdeButton — the "Open in IDE" action in the right-rail Diff tab
 * header (RunRightRail, beside BaseSelector). Runs the project's configured
 * "Open IDE Command" (ProjectSettings → `projects.open_ide_command`) inside the
 * session's worktree via `API.sessions.openIDE` (`sessions:open-ide`).
 *
 * Renders NOTHING unless both a session is selected and its project has a
 * non-blank open_ide_command — an unconfigured project shows no dead button.
 * The project row comes from the cross-project landing store (already loaded
 * at boot and patched on `project:updated`), so this adds no fetch of its own.
 *
 * A `{ success: false }` envelope (command not found, non-zero exit, …) or a
 * rejected call is surfaced through the app-wide error dialog (errorStore),
 * which fits the handler's multi-line diagnosis messages.
 */
import { useState } from 'react';
import type { ReactElement } from 'react';
import { Code2 } from 'lucide-react';
import { API } from '../../utils/api';
import { useLandingStore } from '../../stores/landingStore';
import { useErrorStore } from '../../stores/errorStore';

const ERROR_TITLE = 'Failed to open IDE';

export interface OpenInIdeButtonProps {
  /** The session whose worktree the IDE opens in; null renders nothing. */
  sessionId: string | null;
  /** The session's project, whose open_ide_command gates visibility. */
  projectId: number | null;
}

export function OpenInIdeButton({ sessionId, projectId }: OpenInIdeButtonProps): ReactElement | null {
  const ideCommand = useLandingStore((s) =>
    projectId === null ? null : (s.projects.find((p) => p.id === projectId)?.open_ide_command ?? null),
  );
  const [opening, setOpening] = useState(false);

  if (sessionId === null || !ideCommand || ideCommand.trim() === '') return null;

  const handleClick = async (): Promise<void> => {
    setOpening(true);
    try {
      const res = await API.sessions.openIDE(sessionId);
      if (!res.success) {
        useErrorStore.getState().showError({ title: ERROR_TITLE, error: res.error ?? ERROR_TITLE });
      }
    } catch (err: unknown) {
      useErrorStore.getState().showError({
        title: ERROR_TITLE,
        error: err instanceof Error ? err.message : ERROR_TITLE,
      });
    } finally {
      setOpening(false);
    }
  };

  const title = `Open in IDE (${ideCommand.trim()})`;
  return (
    <button
      type="button"
      data-testid="diff-open-in-ide"
      aria-label="Open in IDE"
      title={title}
      disabled={opening}
      onClick={() => void handleClick()}
      className="shrink-0 rounded-button border border-border-primary bg-bg-primary p-1 text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Code2 size={12} />
    </button>
  );
}
