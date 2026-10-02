import React, { createContext, useContext, useMemo, ReactNode } from 'react';
import { Session } from '../types/session';

interface SessionContextValue {
  sessionId: string;
  workingDirectory: string;
  projectId: string;
  projectName?: string;
  session: Session;
}

export const SessionContext = createContext<SessionContextValue | undefined>(undefined);

export const SessionProvider: React.FC<{
  children: ReactNode;
  session: Session | null;
  projectName?: string;
}> = ({ children, session, projectName }) => {
  // Memoize the provider value — without it, a fresh object every render
  // re-renders every consumer even when nothing they read actually changed.
  // useMemo must run unconditionally (before the `!session` early return
  // below) to keep hook-call order stable across renders.
  const value = useMemo<SessionContextValue | null>(() => {
    if (!session) return null;
    return {
      sessionId: session.id,
      workingDirectory: session.worktreePath,
      projectId: session.projectId?.toString() || '',
      projectName,
      session,
    };
  }, [session, projectName]);

  // FIX: Don't render children without a valid session
  // This prevents components that require session from rendering
  if (!value) {
    return (
      <div className="flex items-center justify-center h-full text-text-tertiary">
        No session selected
      </div>
    );
  }

  return (
    <SessionContext.Provider value={value}>
      {children}
    </SessionContext.Provider>
  );
};

// Safe hook that doesn't throw
export const useSession = (): SessionContextValue | null => {
  return useContext(SessionContext) || null;
};
