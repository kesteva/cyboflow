/**
 * Remote environments (M2): whether a session lives on a remote environment, from the session store's
 * `hostId` (sessions.host_id). The renderer twin of main's guards — surfaces that read a worktree with local git /
 * fs / a local shell (Diff tab, File Explorer, Open in IDE, run Shell) show "Not available on remote environments"
 * for such a session instead of calling into main. An unknown session reads as This Mac (main still refuses).
 */
import { useSessionStore } from '../stores/sessionStore';
import { isRemoteSession } from '../../../shared/types/remoteEnvironment';

export { isRemoteSession };

export function useIsRemoteSession(sessionId: string | null | undefined): boolean {
  return useSessionStore((s) => {
    if (!sessionId) return false;
    const session = s.sessions.find((x) => x.id === sessionId)
      ?? (s.activeMainRepoSession?.id === sessionId ? s.activeMainRepoSession : undefined);
    return isRemoteSession(session);
  });
}
