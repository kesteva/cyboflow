import { useCallback, useRef, useState } from 'react';
import { API } from '../../../utils/api';
import { trackEvent } from '../../../utils/telemetry';
import { ONBOARDING_EVENTS } from '../../../utils/onboarding';
import { continueIntoShell } from './guidedFinish';

/** Trailing path segment, tolerant of either separator + trailing slashes. */
export function basename(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, '');
  const parts = trimmed.split(/[/\\]/);
  return parts[parts.length - 1] || trimmed;
}

/**
 * A project NAME is a single path segment: non-empty once trimmed and free of
 * either separator (the composed path below would otherwise nest silently).
 */
export function isValidProjectName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed !== '' && !/[/\\]/.test(trimmed);
}

/**
 * `<location>/<name>` with any trailing separators on the location dropped.
 * Composed in the RENDERER (no `path` module here) — a forward slash is
 * accepted by Node's path handling on Windows too.
 */
export function composeProjectPath(location: string, name: string): string {
  return `${location.replace(/[/\\]+$/, '')}/${name.trim()}`;
}

/**
 * Raw create failures are SQLite/handler strings; only one of them is a
 * user-actionable condition worth rewording. Everything else surfaces verbatim
 * (it is the only diagnostic the guided screen has).
 */
export function friendlyCreateError(raw: string | undefined): string {
  if (raw === undefined || raw === '') return 'Could not add the project.';
  if (raw.includes('UNIQUE constraint failed: projects.path')) {
    return 'That folder is already a Cyboflow project.';
  }
  return raw;
}

export interface GuidedProjectCreate {
  /** True while a create is in flight (the primary button doubles as retry). */
  creating: boolean;
  /** Inline error from the last attempt, or null. */
  error: string | null;
  create: (input: { name: string; path: string }) => Promise<void>;
}

/**
 * The shared "add this project and move into the shell" handler behind both
 * guided step-8 screens (the folder picker and the create form). Owns the
 * in-flight guard, the inline error, and the exact post-create choreography the
 * app expects — the same broadcast CreateProjectDialog makes, the same telemetry
 * event, then the step-9 transition (see ./guidedFinish continueIntoShell).
 */
export function useGuidedProjectCreate(): GuidedProjectCreate {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const create = useCallback(async ({ name, path }: { name: string; path: string }) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setCreating(true);
    setError(null);
    try {
      // `active: false` is required by the RENDERER-side signature
      // (utils/api.ts takes Omit<Project,'id'|'created_at'|'updated_at'>); the
      // main handler ignores the field — exactly what CreateProjectDialog does.
      const res = await API.projects.create({ name, path, active: false });
      if (!res.success || !res.data) {
        setError(friendlyCreateError(res.error));
        return;
      }
      const project = res.data;
      // Same broadcast CreateProjectDialog makes. The consumer that matters
      // here is App's landingStore listener (it resyncs the project list); the
      // project tree is unmounted until step 9 and discovers the project
      // through its own getAll() on mount.
      window.dispatchEvent(new CustomEvent(ONBOARDING_EVENTS.projectCreated, { detail: project }));
      trackEvent('project_created', {});
      continueIntoShell(project);
    } catch (err: unknown) {
      setError(friendlyCreateError(err instanceof Error ? err.message : String(err)));
    } finally {
      inFlight.current = false;
      setCreating(false);
    }
  }, []);

  return { creating, error, create };
}
