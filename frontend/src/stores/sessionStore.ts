import { create } from 'zustand';
import type { Session } from '../types/session';
import { API } from '../utils/api';
import { useCenterPaneStore } from './centerPaneStore';

interface SessionStore {
  sessions: Session[];
  activeSessionId: string | null;
  activeMainRepoSession: Session | null; // Special storage for main repo session
  isLoaded: boolean;

  setSessions: (sessions: Session[]) => void;
  loadSessions: (sessions: Session[]) => void;
  addSession: (session: Session) => void;
  updateSession: (session: Session) => void;
  deleteSession: (session: Session) => void;
  setActiveSession: (sessionId: string | null) => Promise<void>;
  markSessionAsViewed: (sessionId: string) => Promise<void>;

  // Performance cleanup methods
  cleanupInactiveSessions: () => void;
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  activeMainRepoSession: null,
  isLoaded: false,

  setSessions: (sessions) => set({ sessions }),
  
  loadSessions: (sessions) => set({ sessions, isLoaded: true }),
  
  addSession: (session) => set((state) => {
    
    // Initialize arrays if they don't exist
    const sessionWithArrays = {
      ...session,
      output: session.output || [],
      jsonMessages: session.jsonMessages || []
    };
    
    return {
      // The database assigns new sessions max(display_order) + 1, so retain the
      // same append semantics in memory instead of briefly showing them at top.
      sessions: [...state.sessions, sessionWithArrays],
      activeSessionId: session.id  // Automatically set as active
    };
  }),
  
  updateSession: (updatedSession) => set((state) => {
    
    // If this is the active main repo session, update it
    if (state.activeMainRepoSession && state.activeMainRepoSession.id === updatedSession.id) {
      const newActiveSession = {
        ...state.activeMainRepoSession,
        ...updatedSession,
        output: state.activeMainRepoSession.output,
        jsonMessages: state.activeMainRepoSession.jsonMessages
      };
      return {
        ...state,
        activeMainRepoSession: newActiveSession
      };
    }
    
    // Otherwise update in regular sessions
    // Performance: Only clone array if session exists
    let newSessions = state.sessions;
    for (let i = 0; i < state.sessions.length; i++) {
      if (state.sessions[i].id === updatedSession.id) {
        newSessions = state.sessions.slice();
        const updatedSessionWithOutput = {
          ...state.sessions[i],
          ...updatedSession,
          output: state.sessions[i].output,
          jsonMessages: state.sessions[i].jsonMessages
        };
        newSessions[i] = updatedSessionWithOutput;
        break;
      }
    }
    
    return {
      ...state,
      sessions: newSessions
    };
  }),
  
  deleteSession: (deletedSession) => set((state) => {
    // Clear the active main repo session if it's being deleted
    const newActiveMainRepoSession = state.activeMainRepoSession?.id === deletedSession.id 
      ? null
      : state.activeMainRepoSession;

    // Reclaim the deleted session's center-pane tab state (otherwise
    // centerPaneStore.bySession grows unbounded — clearSession was never wired in).
    // Note: parentless runs key center-pane state by run id, not session id, so
    // those entries are not reclaimed here (see followUp).
    useCenterPaneStore.getState().clearSession(deletedSession.id);

    return {
      sessions: state.sessions.filter(session => session.id !== deletedSession.id),
      activeSessionId: state.activeSessionId === deletedSession.id ? null : state.activeSessionId,
      activeMainRepoSession: newActiveMainRepoSession
    };
  }),
  
  setActiveSession: async (sessionId) => {
    
    if (!sessionId) {
      set({ activeSessionId: null, activeMainRepoSession: null });
      return;
    }
    
    // Emit session-switched event for cleanup
    if (get().activeSessionId !== sessionId) {
      window.dispatchEvent(new CustomEvent('session-switched', { detail: { sessionId } }));
    }
    
    // First check if the session is already in our local store
    const state = get();
    const existingSession = state.sessions.find(s => s.id === sessionId);
    
    if (existingSession) {
      
      if (existingSession.isMainRepo) {
        // Store main repo session separately with initialized arrays
        set({ 
          activeSessionId: sessionId, 
          activeMainRepoSession: {
            ...existingSession,
            output: existingSession.output || [],
            jsonMessages: existingSession.jsonMessages || []
          }
        });
      } else {
        // Regular session - just set the ID
        set({ activeSessionId: sessionId, activeMainRepoSession: null });
      }
      
      // Only mark session as viewed if it wasn't already active
      // This prevents the blue dot from disappearing when the session completes while you're viewing it
      const wasAlreadyActive = state.activeSessionId === sessionId;
      if (!wasAlreadyActive) {
        get().markSessionAsViewed(sessionId);
      }
      return;
    }
    
    // If not in local store, fetch from backend (this might be a stale UI)
    try {
      const response = await API.sessions.get(sessionId);
      
      if (response.success && response.data) {
        const session = response.data;
        
        // Add the session to local store if not already there
        const currentSessions = get().sessions;
        const sessionExists = currentSessions.find(s => s.id === sessionId);
        if (!sessionExists) {
          set(state => ({
            sessions: [...state.sessions, {
              ...session,
              output: session.output || [],
              jsonMessages: session.jsonMessages || []
            }]
          }));
        }
        
        if (session.isMainRepo) {
          // Store main repo session separately with initialized arrays
          set({ 
            activeSessionId: sessionId, 
            activeMainRepoSession: {
              ...session,
              output: session.output || [],
              jsonMessages: session.jsonMessages || []
            }
          });
        } else {
          // Regular session
          set({ activeSessionId: sessionId, activeMainRepoSession: null });
        }
        // Only mark session as viewed if it wasn't already active
        const currentState = get();
        const wasAlreadyActive = currentState.activeSessionId === sessionId;
        if (!wasAlreadyActive) {
          get().markSessionAsViewed(sessionId);
        }
      } else {
        console.error('[SessionStore] Failed to fetch session:', sessionId, response);
      }
    } catch (error) {
      console.error('[SessionStore] Error setting active session:', error);
      set({ activeSessionId: sessionId, activeMainRepoSession: null });
    }
  },
  
  markSessionAsViewed: async (sessionId) => {
    try {
      const response = await API.sessions.markViewed(sessionId);

      if (!response.success) {
        throw new Error(response.error || 'Failed to mark session as viewed');
      }

      // Session will be updated via IPC events, no need to manually update here
    } catch (error) {
      console.error('Error marking session as viewed:', error);
    }
  },
  
  cleanupInactiveSessions: () => set((state) => {
    // Performance: Clear output data for inactive sessions to free memory
    const activeId = state.activeSessionId;
    const MAX_INACTIVE_OUTPUTS = 50; // Even less for inactive sessions
    
    // Create new sessions array with trimmed outputs for inactive sessions
    const cleanedSessions = state.sessions.map(session => {
      if (session.id === activeId) {
        // Don't touch active session
        return session;
      }
      
      // For inactive sessions, aggressively trim outputs
      if (session.output && session.output.length > MAX_INACTIVE_OUTPUTS) {
        return {
          ...session,
          output: session.output.slice(-MAX_INACTIVE_OUTPUTS),
          jsonMessages: session.jsonMessages ? session.jsonMessages.slice(-25) : []
        };
      }
      
      return session;
    });

    return {
      sessions: cleanedSessions
    };
  })
}));
