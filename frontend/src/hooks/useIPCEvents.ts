import { useEffect } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import { usePanelStore } from '../stores/panelStore';
import { usePanelLiveEventsStore } from '../stores/panelLiveEventsStore';
import { API } from '../utils/api';
import type { Session, SessionOutput } from '../types/session';
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

/**
 * Detect the user-cancel (Stop) message the main process emits over
 * `session-output` — `{ type: 'session', data: { status: 'cancelled', … } }`
 * (see ipc/session.ts stop handler). It is NOT a `result`/`stream_event`
 * envelope, so it slips past toLiveTailEnvelope; the live-tail buffer needs a
 * turn-end reset on it regardless, else `isGenerating` sticks after Stop.
 */
function isCancellationOutput(raw: unknown): boolean {
  if (raw === null || typeof raw !== 'object') return false;
  const obj = raw as Record<string, unknown>;
  if (obj.type !== 'session') return false;
  const inner = obj.data;
  if (inner === null || typeof inner !== 'object') return false;
  return (inner as Record<string, unknown>).status === 'cancelled';
}

export function useIPCEvents() {
  const { setSessions, loadSessions, addSession, updateSession, deleteSession } = useSessionStore();

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
    });
    unsubscribeFunctions.push(unsubscribeSessionCreated);

    const unsubscribeSessionUpdated = window.electronAPI.events.onSessionUpdated((session: Session) => {
      console.log('[useIPCEvents] Session updated event received:', {
        id: session.id,
        status: session.status
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
      console.log(`[useIPCEvents] Sessions: ${sessions.length} loaded`);

      const sessionsWithJsonMessages = sessions.map(session => ({
        ...session,
        jsonMessages: session.jsonMessages || []
      }));
      loadSessions(sessionsWithJsonMessages);
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
        } else if (isCancellationOutput(output.data)) {
          // A user cancel (Stop) emits a `{ type: 'session', status: 'cancelled' }`
          // message, NOT a `result` — the SDK loop breaks before the result is
          // handled. Reset the live-tail buffer so `isGenerating` clears (freeing
          // the working spinner + the composer's Stop button); see clearPanel.
          usePanelLiveEventsStore.getState().clearPanel(output.panelId);
        }
      }

      // Just emit custom event to notify that new output is available
      // Include panelId (if present) so panel-based views can react precisely
      window.dispatchEvent(new CustomEvent('session-output-available', {
        detail: { sessionId: output.sessionId, panelId: output.panelId }
      }));
    });
    unsubscribeFunctions.push(unsubscribeSessionOutput);

    const unsubscribeOutputAvailable = window.electronAPI.events.onSessionOutputAvailable((info) => {
      // Validate event has required session context
      if (!validateEventSession(info)) {
        return; // Ignore invalid events
      }

      // NOTE: this dispatches the same 'session-output-available' CustomEvent
      // as the onSessionOutput handler above, and downstream listeners debounce
      // so a same-tick double-fire is cheap — but the two IPC channels are NOT
      // always paired (main emits 'session-output-available' alone for codex-sdk
      // panel output, and 'session-output' alone for panel-cancellation messages —
      // see sessionManager.ts addPanelOutput / ipc/session.ts stop handler), so
      // both dispatches are load-bearing and must stay.
      // Emit custom event to notify that output is available
      window.dispatchEvent(new CustomEvent('session-output-available', {
        detail: {
          sessionId: info.sessionId,
          ...(info.panelId ? { panelId: info.panelId } : {}),
        }
      }));
    });
    unsubscribeFunctions.push(unsubscribeOutputAvailable);

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
  }, [setSessions, loadSessions, addSession, updateSession, deleteSession]);
  
  // Return a mock socket object for compatibility
  return {
    connected: true,
    disconnect: () => {},
  };
}
