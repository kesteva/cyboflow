import { useEffect, useRef } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import { useErrorStore } from '../stores/errorStore';
import { usePanelStore } from '../stores/panelStore';
import { usePanelLiveEventsStore } from '../stores/panelLiveEventsStore';
import { API } from '../utils/api';
import type { Session, SessionOutput, GitStatus } from '../types/session';
import type { ToolPanel } from '../../../shared/types/panels';
import type { StreamEvent as LiveTailEnvelope } from '../utils/cyboflowApi';
import type { StreamEvent as RawStreamEvent, ResultEvent as RawResultEvent } from '../../../shared/types/claudeStream';

interface SessionEventData {
  sessionId: string;
  [key: string]: unknown;
}

type ValidatedEventData = SessionEventData | SessionOutput;

interface SessionDeletedEventData {
  id?: string;
  sessionId?: string;
}

// Frontend validation helpers
function validateEventSession(eventData: ValidatedEventData, activeSessionId?: string): boolean {
  if (!eventData || !eventData.sessionId) {
    console.warn('[useIPCEvents] Event missing sessionId:', eventData);
    return false;
  }
  
  // If we have an active session context, validate the event matches
  if (activeSessionId && eventData.sessionId !== activeSessionId) {
    console.warn(`[useIPCEvents] Event sessionId ${eventData.sessionId} does not match active session ${activeSessionId}`);
    return false;
  }
  
  return true;
}


/**
 * Narrow a raw `session-output` JSON payload down to the two envelope kinds
 * the LiveTail progressive-render buffer needs (`stream_event`, `result`) —
 * see panelLiveEventsStore.ts. The wire shape here is the RAW SDK/CLI event
 * (claudeCodeManager.ts forwards `data: event`, the pre-narrowed message —
 * NOT the renderer's wrapped StreamEnvelope), so a `type: 'stream_event'` /
 * `type: 'result'` payload is already shaped like the corresponding
 * StreamEnvelopePayload arm's `payload` field. One audited cast at this
 * boundary, mirroring the precedent documented on StreamEnvelope itself
 * (shared/types/claudeStream.ts, runEventBridge.ts:237). Returns null for
 * every other payload (stdout/stderr text, other json message types) —
 * those are still handled entirely by the existing debounced-refetch path.
 */
function toLiveTailEnvelope(raw: unknown, timestamp: string): LiveTailEnvelope | null {
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (obj.type === 'stream_event' && typeof obj.event === 'object' && obj.event !== null) {
    const envelope: LiveTailEnvelope = { type: 'stream_event', payload: obj as unknown as RawStreamEvent, timestamp };
    return envelope;
  }
  if (obj.type === 'result') {
    const envelope: LiveTailEnvelope = { type: 'result', payload: obj as unknown as RawResultEvent, timestamp };
    return envelope;
  }
  return null;
}

// Throttle utility function
function throttle<T extends (...args: never[]) => void>(
  func: T,
  delay: number
): (...args: Parameters<T>) => void {
  let lastCall = 0;
  let timeoutId: NodeJS.Timeout | null = null;
  const pendingCalls = new Map<string, Parameters<T>>();

  return (...args: Parameters<T>) => {
    const now = Date.now();
    const timeSinceLastCall = now - lastCall;
    
    // Store the latest args for this session
    const firstArg = args[0] as Record<string, unknown> | undefined;
    const rawKey = firstArg?.sessionId || firstArg?.id || 'default';
    const key = String(rawKey);
    pendingCalls.set(key, args);

    if (timeSinceLastCall >= delay) {
      // Execute immediately
      lastCall = now;
      pendingCalls.forEach((pendingArgs) => {
        func(...pendingArgs);
      });
      pendingCalls.clear();
    } else {
      // Schedule execution
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      
      timeoutId = setTimeout(() => {
        lastCall = Date.now();
        pendingCalls.forEach((pendingArgs) => {
          func(...pendingArgs);
        });
        pendingCalls.clear();
        timeoutId = null;
      }, delay - timeSinceLastCall);
    }
  };
}

export function useIPCEvents() {
  const { setSessions, loadSessions, addSession, updateSession, deleteSession } = useSessionStore();
  const { showError } = useErrorStore();
  
  // Create throttled handlers for git status events
  const throttledGitStatusLoading = useRef(
    throttle((data: { sessionId: string }) => {
      // Validate event has required session context
      if (!validateEventSession(data)) {
        return; // Ignore invalid events
      }
      useSessionStore.getState().setGitStatusLoading(data.sessionId, true);
      
      // Also emit a custom event for individual components to listen to
      window.dispatchEvent(new CustomEvent('git-status-loading', {
        detail: { sessionId: data.sessionId }
      }));
    }, 100)
  ).current;
  
  const throttledGitStatusUpdated = useRef(
    throttle((data: { sessionId: string; gitStatus: GitStatus }) => {
      // Validate event has required session context
      if (!validateEventSession(data)) {
        return; // Ignore invalid events
      }

      // Only log significant status changes in production
      if (data.gitStatus.state !== 'clean' || process.env.NODE_ENV === 'development') {
        console.log(`[useIPCEvents] Git status: ${data.sessionId.substring(0, 8)} → ${data.gitStatus.state}`);
      }
      
      // Update the store and clear loading state
      useSessionStore.getState().updateSessionGitStatus(data.sessionId, data.gitStatus);
      useSessionStore.getState().setGitStatusLoading(data.sessionId, false);
      
      // Also emit a custom event for individual components to listen to
      window.dispatchEvent(new CustomEvent('git-status-updated', {
        detail: { sessionId: data.sessionId, gitStatus: data.gitStatus }
      }));
    }, 100)
  ).current;
  
  useEffect(() => {
    // Check if we're in Electron environment
    if (!window.electronAPI) {
      console.warn('Electron API not available, events will not work');
      return;
    }

    // Set up IPC event listeners
    const unsubscribeFunctions: (() => void)[] = [];

    // Listen for session events
    const unsubscribeSessionCreated = window.electronAPI.events.onSessionCreated((session: Session) => {
      console.log('[useIPCEvents] Session created:', session.id);
      addSession({...session, output: session.output || [], jsonMessages: session.jsonMessages || []});
      // Set git status as loading for new sessions
      useSessionStore.getState().setGitStatusLoading(session.id, true);
    });
    unsubscribeFunctions.push(unsubscribeSessionCreated);

    const unsubscribeSessionUpdated = window.electronAPI.events.onSessionUpdated((session: Session) => {
      console.log('[useIPCEvents] Session updated event received:', {
        id: session.id,
        status: session.status,
        commitMode: session.commitMode,
        commitModeSettings: session.commitModeSettings
      });
      
      // Ensure we have valid session data
      if (!session || !session.id) {
        console.error('[useIPCEvents] Invalid session data received:', session);
        return;
      }
      
      // Update the session with initialized arrays
      const sessionWithArrays = {
        ...session,
        output: session.output || [],
        jsonMessages: session.jsonMessages || []
      };
      
      updateSession(sessionWithArrays);
      
      // Force a re-render if this is the active session and status changed to stopped
      const state = useSessionStore.getState();
      if (state.activeSessionId === session.id && 
          (session.status === 'stopped' || session.status === 'completed_unviewed' || session.status === 'error')) {
        // Emit a custom event to trigger UI updates
        window.dispatchEvent(new CustomEvent('session-status-changed', { 
          detail: { sessionId: session.id, status: session.status } 
        }));
      }
    });
    unsubscribeFunctions.push(unsubscribeSessionUpdated);

    const unsubscribeSessionDeleted = window.electronAPI.events.onSessionDeleted((sessionData: SessionDeletedEventData | string) => {
      console.log('[useIPCEvents] Session deleted:', sessionData);
      // The backend sends just { id } for deleted sessions
      const sessionId = typeof sessionData === 'string' ? sessionData : sessionData.id || sessionData.sessionId;
      
      // Dispatch a custom event for other components to listen to
      window.dispatchEvent(new CustomEvent('session-deleted', {
        detail: { id: sessionId }
      }));
      
      // Create a minimal session object for deletion
      deleteSession({ id: sessionId } as Session);
    });
    unsubscribeFunctions.push(unsubscribeSessionDeleted);

    const unsubscribeSessionsLoaded = window.electronAPI.events.onSessionsLoaded((sessions: Session[]) => {
      // Group logging for session loading
      const withStatus = sessions.filter(s => s.gitStatus).length;
      const withoutStatus = sessions.filter(s => !s.gitStatus).length;
      if (withoutStatus > 0) {
        console.log(`[useIPCEvents] Sessions: ${sessions.length} total (${withStatus} with status, ${withoutStatus} pending)`);
      } else {
        console.log(`[useIPCEvents] Sessions: ${sessions.length} loaded`);
      }
      
      const sessionsWithJsonMessages = sessions.map(session => ({
        ...session,
        jsonMessages: session.jsonMessages || []
      }));
      loadSessions(sessionsWithJsonMessages);
      // Set git status as loading for sessions without git status
      sessions.forEach(session => {
        if (!session.gitStatus && !session.archived) {
          useSessionStore.getState().setGitStatusLoading(session.id, true);
        }
      });
    });
    unsubscribeFunctions.push(unsubscribeSessionsLoaded);

    // Listen for panel state updates — keep the panel store in sync with backend
    // customState changes (e.g. the SDK context-% meter, refreshed per completed
    // turn via updateClaudePanelCustomState → panel:updated). Without this, the
    // panel:updated IPC event has NO renderer consumer, so ClaudePanel only
    // re-reads panel.state.customState on a panel re-open and the live context
    // meter never ticks. updatePanelState replaces the panel by id and is a
    // no-op when that session's panels are not loaded in the store, so this is
    // safe for background sessions.
    const unsubscribePanelUpdated = window.electronAPI.events.onPanelUpdated((panel: ToolPanel) => {
      if (!panel || !panel.id || !panel.sessionId) {
        console.warn('[useIPCEvents] panel:updated event missing id/sessionId:', panel);
        return;
      }
      usePanelStore.getState().updatePanelState(panel);
    });
    unsubscribeFunctions.push(unsubscribePanelUpdated);

    const unsubscribeSessionOutput = window.electronAPI.events.onSessionOutput((output: SessionOutput) => {
      // Validate event has required session context
      if (!validateEventSession(output)) {
        return; // Ignore invalid events
      }

      console.log(`[useIPCEvents] Received session output for ${output.sessionId}, type: ${output.type}`);

      // Feed the LiveTail progressive-render buffer (panelLiveEventsStore) for
      // quick-session panels — see toLiveTailEnvelope's doc comment. No-ops
      // for non-panel output or any payload that isn't a stream_event/result.
      if (output.panelId && output.type === 'json') {
        // output.timestamp is declared `string` here, but the IPC bridge
        // structured-clones the main process's `new Date()` verbatim — guard
        // both shapes rather than trust the (pre-existing, out-of-scope) type.
        const rawTimestamp: unknown = output.timestamp;
        const timestamp =
          rawTimestamp instanceof Date ? rawTimestamp.toISOString() : String(rawTimestamp);
        const envelope = toLiveTailEnvelope(output.data, timestamp);
        if (envelope !== null) {
          usePanelLiveEventsStore.getState().appendEvent(output.panelId, envelope);
        }
      }

      // Just emit custom event to notify that new output is available
      // Include panelId (if present) so panel-based views can react precisely
      window.dispatchEvent(new CustomEvent('session-output-available', {
        detail: { sessionId: output.sessionId, panelId: output.panelId }
      }));
    });
    unsubscribeFunctions.push(unsubscribeSessionOutput);

    const unsubscribeTerminalOutput = window.electronAPI.events.onTerminalOutput((output: { sessionId: string; type: 'stdout' | 'stderr'; data: string }) => {
      // Validate event has required session context
      if (!validateEventSession(output)) {
        return; // Ignore invalid events
      }

      console.log(`[useIPCEvents] Received terminal output for ${output.sessionId}`);
      // Store terminal output in session store for display
      useSessionStore.getState().addTerminalOutput(output);
    });
    unsubscribeFunctions.push(unsubscribeTerminalOutput);
    
    const unsubscribeOutputAvailable = window.electronAPI.events.onSessionOutputAvailable((info: { sessionId: string }) => {
      // Validate event has required session context
      if (!validateEventSession(info)) {
        return; // Ignore invalid events
      }

      console.log(`[useIPCEvents] Output available notification for session ${info.sessionId}`);
      
      // Emit custom event to notify that output is available
      window.dispatchEvent(new CustomEvent('session-output-available', {
        detail: { sessionId: info.sessionId }
      }));
    });
    unsubscribeFunctions.push(unsubscribeOutputAvailable);
    
    // Listen for zombie process detection
    const unsubscribeZombieProcesses = window.electronAPI.events.onZombieProcessesDetected((data: { sessionId?: string | null; pids?: number[]; message: string }) => {
      console.error('[useIPCEvents] Zombie processes detected:', data);
      
      // Show error to user
      const errorMessage = data.message || 'Some child processes could not be terminated. Please check your system process list.';
      const details = data.pids && data.pids.length > 0 
        ? `Unable to terminate process IDs: ${data.pids.join(', ')}\n\nYou may need to manually kill these processes.`
        : undefined;
      
      showError({
        title: 'Zombie Processes Detected',
        error: errorMessage,
        details
      });
      
      // Also log PIDs if available
      if (data.pids && data.pids.length > 0) {
        console.error(`Zombie process PIDs: ${data.pids.join(', ')}`);
      }
    });
    unsubscribeFunctions.push(unsubscribeZombieProcesses);

    // Listen for git status updates (throttled)
    const unsubscribeGitStatusUpdated = window.electronAPI.events.onGitStatusUpdated(throttledGitStatusUpdated);
    unsubscribeFunctions.push(unsubscribeGitStatusUpdated);

    // Listen for git status loading events (throttled)
    const unsubscribeGitStatusLoading = window.electronAPI.events.onGitStatusLoading?.(throttledGitStatusLoading);
    if (unsubscribeGitStatusLoading) {
      unsubscribeFunctions.push(unsubscribeGitStatusLoading);
    }
    
    // Listen for batch git status events
    const unsubscribeGitStatusLoadingBatch = window.electronAPI.events.onGitStatusLoadingBatch?.((sessionIds: string[]) => {
      const updates = sessionIds.map(sessionId => ({ sessionId, loading: true }));
      useSessionStore.getState().setGitStatusLoadingBatch(updates);
      
      // Dispatch custom events for each session
      sessionIds.forEach(sessionId => {
        window.dispatchEvent(new CustomEvent('git-status-loading', {
          detail: { sessionId }
        }));
      });
    });
    if (unsubscribeGitStatusLoadingBatch) {
      unsubscribeFunctions.push(unsubscribeGitStatusLoadingBatch);
    }
    
    const unsubscribeGitStatusUpdatedBatch = window.electronAPI.events.onGitStatusUpdatedBatch?.((updates: Array<{ sessionId: string; status: GitStatus }>) => {
      console.log(`[useIPCEvents] Git status batch update: ${updates.length} sessions`);
      useSessionStore.getState().updateSessionGitStatusBatch(updates);
      
      // Dispatch custom events for each session
      updates.forEach(({ sessionId, status }) => {
        window.dispatchEvent(new CustomEvent('git-status-updated', {
          detail: { sessionId, gitStatus: status }
        }));
      });
    });
    if (unsubscribeGitStatusUpdatedBatch) {
      unsubscribeFunctions.push(unsubscribeGitStatusUpdatedBatch);
    }

    // Load initial sessions
    API.sessions.getAll()
      .then(response => {
        if (response.success && response.data) {
          const sessionsWithJsonMessages = response.data.map((session: Session) => ({
            ...session,
            jsonMessages: session.jsonMessages || []
          }));
          loadSessions(sessionsWithJsonMessages);
        }
      })
      .catch(error => {
        console.error('Failed to load initial sessions:', error);
      });

    return () => {
      // Clean up all event listeners
      unsubscribeFunctions.forEach(unsubscribe => unsubscribe());
    };
  }, [setSessions, loadSessions, addSession, updateSession, deleteSession, showError]);
  
  // Return a mock socket object for compatibility
  return {
    connected: true,
    disconnect: () => {},
  };
}
