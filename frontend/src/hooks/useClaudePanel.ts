import { useState, useEffect, useRef } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import { API } from '../utils/api';
import { GitCommands } from '../types/session';
import type { AttachedImage, AttachedText, Session } from '../types/session';
import type { CliSubstrate } from '../../../shared/types/substrate';
import { usePanelStore } from '../stores/panelStore';

export async function dispatchQuickSessionInput(
  session: Session,
  panelId: string,
  input: string,
  mode: 'initial' | 'continue',
  modelOverride?: string,
  interrupt?: boolean,
  pendingId?: string,
  /**
   * The panel's OWN substrate override, when it has one (set by the Add-chat
   * picker). Absent means the panel inherits its session.
   */
  panelSubstrate?: CliSubstrate | null,
): Promise<{ success: boolean; error?: string; queued?: boolean }> {
  // An overridden panel does not run what its session runs, so it can never use
  // the SESSION-scoped path: sessions:input resolves the session's FIRST chat
  // panel, which would answer on the inherited lane instead of this panel's.
  const inherits = panelSubstrate === undefined || panelSubstrate === null;
  // omp-sdk takes the SAME route as codex-sdk (docs/proposals/omp-provider-
  // integration.md §5.5): first message via sessions:input, follow-ups via the
  // panel-scoped panels:continue. omp-pty mirrors codex-pty the same way for the
  // panel-substrate-override case.
  const isStructuredSdkPanel =
    session.agentRuntime === 'codex-sdk' ||
    session.agentRuntime === 'omp-sdk' ||
    session.agentRuntime === 'pi-sdk'
      ? panelSubstrate !== 'interactive'
      : (session.agentRuntime === 'codex-pty' ||
           session.agentRuntime === 'omp-pty' ||
           session.agentRuntime === 'pi-pty') &&
        panelSubstrate === 'sdk';

  if (isStructuredSdkPanel) {
    // The FIRST message starts the turn via the session-scoped input path (the
    // panel is idle, so there is nothing to guard against). A CONTINUE routes
    // through the panel-scoped panels:continue — the structured-runtime branch
    // there gives it the SAME mid-turn queue guard + Interrupt & send behavior
    // Claude gets, instead of the old sessions:input hard-reject ("Codex is
    // still processing") that turned a mid-turn send into a FAILED row.
    if (mode === 'initial' && inherits) {
      const response = await API.sessions.sendInput(session.id, input);
      return { success: response.success, error: response.error };
    }
    const response = await API.panels.continue(panelId, input, modelOverride, interrupt, pendingId);
    const queued = (response.data as { queued?: boolean } | undefined)?.queued === true;
    return { success: response.success, error: response.error, queued };
  }
  if (mode === 'initial') {
    const response = await API.panels.sendInput(panelId, `${input}\n`);
    return { success: response.success, error: response.error };
  }
  const response = await API.panels.continue(panelId, input, modelOverride, interrupt, pendingId);
  // A status-flap continue that reached an already-running backend turn is
  // queued (keyed by pendingId) rather than dispatched — surface it so the
  // caller can flip the pending-send row to the addressable 'queued' state.
  const queued = (response.data as { queued?: boolean } | undefined)?.queued === true;
  return { success: response.success, error: response.error, queued };
}

export const useClaudePanel = (panelId: string) => {
  // Get the session associated with this panel
  // For now, we'll get the active session since panels are session-scoped
  // In the future, this could be refactored to store session association in panel metadata
  const activeSession = useSessionStore((state) => {
    if (!state.activeSessionId) return undefined;
    if (state.activeMainRepoSession && state.activeMainRepoSession.id === state.activeSessionId) {
      return state.activeMainRepoSession;
    }
    return state.sessions.find(session => session.id === state.activeSessionId);
  });

  const activeSessionId = activeSession?.id;

  // This panel's OWN substrate override, if any. The dispatcher needs it because
  // an overridden panel runs a different lane than its session (an interactive
  // chat on a Codex SDK session, say) and so must never take a session-scoped
  // path, which would answer on the session's first panel instead.
  const panelSubstrate = usePanelStore((state) =>
    activeSessionId
      ? state.panels[activeSessionId]?.find((p) => p.id === panelId)?.substrate ?? null
      : null,
  );

  // States specific to Claude functionality
  const [input, setInput] = useState('');
  const [gitCommands, setGitCommands] = useState<GitCommands | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Load git commands when session changes
  useEffect(() => {
    if (!activeSession) {
      setGitCommands(null);
      return;
    }
    const loadGitData = async () => {
      try {
        const commandsResponse = await API.sessions.getGitCommands(activeSession.id);
        if (commandsResponse.success) setGitCommands(commandsResponse.data);
      } catch (error) { 
        console.error('Error loading git data:', error); 
      }
    };
    loadGitData();
  }, [activeSessionId]);

  // Dispatch a message to the panel. The composer owns the draft (it clears the
  // input INSTANTLY on submit and tracks a pending-send entry), so these handlers
  // no longer read/clear `input` and no longer restore it on failure — they take
  // the text explicitly and RETURN the dispatch outcome so the composer can flip
  // its pending entry to 'failed' instead of silently stuffing text back.
  const handleSendInput = async (
    text: string,
    attachedImages?: AttachedImage[],
    attachedTexts?: AttachedText[],
  ): Promise<{ success: boolean; error?: string }> => {
    if (!text.trim() || !activeSession) {
      return { success: false, error: 'Nothing to send' };
    }

    let finalInput = text;

    // Collect all attachments (text and images)
    const attachmentPaths = [];
    
    // If there are attached texts, save them and collect paths
    if (attachedTexts && attachedTexts.length > 0) {
      try {
        for (const text of attachedTexts) {
          // Save text to file via IPC
          const textFilePath = await window.electronAPI.sessions.saveLargeText(
            activeSession.id,
            text.content
          );
          
          attachmentPaths.push(textFilePath);
        }
      } catch (error) {
        console.error('Failed to save attached text to file:', error);
        // Continue without text files on error
      }
    }
    
    // If there are attached images, save them and collect paths
    if (attachedImages && attachedImages.length > 0) {
      try {
        // Save images via IPC
        const imagePaths = await window.electronAPI.sessions.saveImages(
          activeSession.id,
          attachedImages.map(img => ({
            name: img.name,
            dataUrl: img.dataUrl,
            type: img.type,
          }))
        );
        
        attachmentPaths.push(...imagePaths);
      } catch (error) {
        console.error('Failed to save images:', error);
        // Continue without images on error
      }
    }
    
    // If we have any attachments, wrap them in <attachments> tags
    if (attachmentPaths.length > 0) {
      const attachmentsMessage = `\n\n<attachments>\nPlease look at these files which may provide additional instructions or context:\n${attachmentPaths.join('\n')}\n</attachments>`;
      finalInput = `${finalInput}${attachmentsMessage}`;
    }
    
    return dispatchQuickSessionInput(activeSession, panelId, finalInput, 'initial', undefined, undefined, undefined, panelSubstrate);
  };

  const handleContinueConversation = async (
    text: string,
    attachedImages?: AttachedImage[],
    attachedTexts?: AttachedText[],
    modelOverride?: string,
    interrupt?: boolean,
    pendingId?: string,
  ): Promise<{ success: boolean; error?: string; queued?: boolean }> => {
    if (!text.trim() || !activeSession) return { success: false, error: 'Nothing to send' };

    let finalInput = text;

    // Collect all attachments (text and images)
    const attachmentPaths = [];
    
    // If there are attached texts, save them and collect paths
    if (attachedTexts && attachedTexts.length > 0) {
      try {
        for (const text of attachedTexts) {
          // Save text to file via IPC
          const textFilePath = await window.electronAPI.sessions.saveLargeText(
            activeSession.id,
            text.content
          );
          
          attachmentPaths.push(textFilePath);
        }
      } catch (error) {
        console.error('Failed to save attached text to file:', error);
        // Continue without text files on error
      }
    }
    
    // If there are attached images, save them and collect paths
    if (attachedImages && attachedImages.length > 0) {
      try {
        // Save images via IPC
        const imagePaths = await window.electronAPI.sessions.saveImages(
          activeSession.id,
          attachedImages.map(img => ({
            name: img.name,
            dataUrl: img.dataUrl,
            type: img.type,
          }))
        );
        
        attachmentPaths.push(...imagePaths);
      } catch (error) {
        console.error('Failed to save images:', error);
        // Continue without images on error
      }
    }
    
    // If we have any attachments, wrap them in <attachments> tags
    if (attachmentPaths.length > 0) {
      const attachmentsMessage = `\n\n<attachments>\nPlease look at these files which may provide additional instructions or context:\n${attachmentPaths.join('\n')}\n</attachments>`;
      finalInput = `${finalInput}${attachmentsMessage}`;
    }
    
    return dispatchQuickSessionInput(activeSession, panelId, finalInput, 'continue', modelOverride, interrupt, pendingId, panelSubstrate);
  };

  const handleStopSession = async () => {
    if (activeSession) await API.sessions.stop(activeSession.id);
  };

  return {
    activeSession,
    input,
    setInput,
    textareaRef,
    gitCommands,
    handleSendInput,
    handleContinueConversation,
    handleStopSession,
  };
};
