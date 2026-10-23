/**
 * Remote environments (M2): the features that only work on This Mac's own disk, and the words both processes use
 * when they decline them for a session or run that lives on a remote environment.
 *
 * A remote session's worktree_path is a path ON its environment, so anything that reads the worktree with local git /
 * fs / a local shell (git status, the Diff tab, the File Explorer, Open in IDE, the run Shell tab, composer
 * attachments) is turned off for it instead of failing against a path that does not exist here. Pure; imported by
 * main and the renderer.
 */
import { isRemoteHostId } from './hosts';

/** The empty-state line the renderer shows in place of a local-only feature. */
export const REMOTE_UNAVAILABLE_MESSAGE = 'Not available on remote environments';

/** The run Shell tab's refusal: a remote worktree is reached through the environment's own terminal. */
export const REMOTE_SHELL_MESSAGE = 'Use Open terminal on the environment card';

/** `<feature> is not available on remote environments.` — the readable error main returns for a refused call. */
export function remoteUnavailableError(feature: string): string {
  return `${feature} is not available on remote environments.`;
}

/** True when the session (or run-like record) lives on a remote environment. null / undefined / 'local' = This Mac. */
export function isRemoteSession(session: { hostId?: string | null } | null | undefined): boolean {
  return isRemoteHostId(session?.hostId);
}
