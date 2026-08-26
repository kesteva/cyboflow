import { useState, useEffect, useRef, useCallback } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import { useTheme } from '../contexts/ThemeContext';
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
   * The panel's OWN substrate override, when it has one (Add-chat picker /
   * claude-panels:set-substrate). Absent means the panel inherits its session.
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

export const useClaudePanel = (
  panelId: string,
  isActive: boolean
) => {
  const { theme } = useTheme();
  
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
  const [isLoadingOutput, setIsLoadingOutput] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [outputLoadState, setOutputLoadState] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle');
  const [gitCommands, setGitCommands] = useState<GitCommands | null>(null);
  const [contextCompacted, setContextCompacted] = useState(false);
  const [compactedContext, setCompactedContext] = useState<string | null>(null);
  const [hasConversationHistory, setHasConversationHistory] = useState(false);

  // Refs
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const loadingRef = useRef(false);
  const loadingPanelIdRef = useRef<string | null>(null);
  const isContinuingConversationRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const outputLoadTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Force reset stuck state
  const forceResetLoadingState = useCallback(() => {
    loadingRef.current = false;
    loadingPanelIdRef.current = null;
    setIsLoadingOutput(false);
    setOutputLoadState('idle');
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    if (outputLoadTimeoutRef.current) {
      clearTimeout(outputLoadTimeoutRef.current);
      outputLoadTimeoutRef.current = null;
    }
  }, [panelId]);

  // Load output content for the panel's associated session
  const loadOutputContent = useCallback(async (sessionId: string, retryCount = 0) => {
    
    // Cancel any existing load request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    
    // Clear any pending timeout
    if (outputLoadTimeoutRef.current) {
      clearTimeout(outputLoadTimeoutRef.current);
      outputLoadTimeoutRef.current = null;
    }
    
    // Check if already loading this session for this panel
    if (loadingRef.current && loadingPanelIdRef.current === panelId) {
      return;
    }
    
    // Check if session is still active
    const currentActiveSession = useSessionStore.getState().getActiveSession();
    if (!currentActiveSession || currentActiveSession.id !== sessionId) {
      return;
    }

    // Set loading state
    loadingRef.current = true;
    loadingPanelIdRef.current = panelId;
    setIsLoadingOutput(true);
    setOutputLoadState('loading');
    setLoadError(null);
    
    // Create new AbortController for this request
    abortControllerRef.current = new AbortController();

    try {
      // Use panel-based API for Claude data
      const response = await API.panels.getOutput(panelId);
      if (!response.success) {
        if (response.error && response.error.includes('not found')) {
          loadingRef.current = false;
          loadingPanelIdRef.current = null;
          setIsLoadingOutput(false);
          setOutputLoadState('idle');
          return;
        }
        throw new Error(response.error || 'Failed to load output');
      }
      
      const outputs = response.data || [];
      
      // Check if still the active session after async operation
      const stillActiveSession = useSessionStore.getState().getActiveSession();
      if (!stillActiveSession || stillActiveSession.id !== sessionId) {
        loadingRef.current = false;
        loadingPanelIdRef.current = null;
        setIsLoadingOutput(false);
        setOutputLoadState('idle');
        return;
      }
      
      // Set outputs in the session store
      useSessionStore.getState().setSessionOutputs(sessionId, outputs);
      
      setOutputLoadState('loaded');
      
      // Reset continuing conversation flag after successfully loading output
      if (isContinuingConversationRef.current) {
        isContinuingConversationRef.current = false;
      }
      
      setLoadError(null);
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        loadingRef.current = false;
        loadingPanelIdRef.current = null;
        setIsLoadingOutput(false);
        setOutputLoadState('idle');
        return;
      }
      
      console.error(`[loadOutputContent] Error loading output for session ${sessionId} (panel ${panelId}):`, error);
      setOutputLoadState('error');
      
      // Retry logic for new sessions only
      const isNewSession = activeSession?.status === 'initializing';
      const maxRetries = isNewSession ? 3 : 0;
      
      if (retryCount < maxRetries) {
        const delay = 1000 * (retryCount + 1);
        loadingRef.current = false;
        loadingPanelIdRef.current = null;
        setIsLoadingOutput(false);
        outputLoadTimeoutRef.current = setTimeout(() => {
          const currentActiveSession = useSessionStore.getState().getActiveSession();
          if (currentActiveSession && currentActiveSession.id === sessionId) {
            loadOutputContent(sessionId, retryCount + 1);
          }
        }, delay);
      } else {
        setLoadError(error instanceof Error ? error.message : 'Failed to load output content');
      }
    } finally {
      // Always reset loading state
      loadingRef.current = false;
      loadingPanelIdRef.current = null;
      setIsLoadingOutput(false);
    }
  }, [panelId, activeSession?.status]);

  // Auto-resize textarea is now handled in ClaudeInputWithImages component
  // Removed duplicate effect to prevent performance issues

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

  // Check if session has conversation history
  useEffect(() => {
    if (!activeSession) {
      setHasConversationHistory(false);
      return;
    }
    
    const checkConversationHistory = async () => {
      try {
        // Use panel-based API for Claude conversation data
        const response = await API.panels.getConversationMessages(panelId);
        if (response.success && response.data) {
          setHasConversationHistory((response.data as unknown[]).length > 0);
        }
      } catch (error) {
        console.error('Failed to check conversation history:', error);
        setHasConversationHistory(false);
      }
    };
    checkConversationHistory();
  }, [activeSession?.id]);

  // Load output when panel becomes active and has an associated session
  useEffect(() => {
    if (isActive && activeSession && outputLoadState === 'idle') {
      loadOutputContent(activeSession.id);
    }
  }, [isActive, activeSession?.id, outputLoadState, loadOutputContent, panelId]);

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
    
    // Check if we have compacted context to inject
    if (contextCompacted && compactedContext) {
      finalInput = `<session_context>\n${compactedContext}\n</session_context>\n\n${finalInput}`;
      
      // Clear the compacted context after using it
      setContextCompacted(false);
      setCompactedContext(null);
    }
    
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

    // Mark that we're continuing a conversation to prevent output reload
    isContinuingConversationRef.current = true;

    let finalInput = text;
    
    // Check if we have compacted context to inject
    if (contextCompacted && compactedContext) {
      finalInput = `<session_context>\n${compactedContext}\n</session_context>\n\n${finalInput}`;
      
      // Clear the compacted context after using it
      setContextCompacted(false);
      setCompactedContext(null);
    }
    
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
    
    // Output will be loaded automatically when session status changes.
    return dispatchQuickSessionInput(activeSession, panelId, finalInput, 'continue', modelOverride, interrupt, pendingId, panelSubstrate);
  };

  const handleTerminalCommand = async () => {
    if (!input.trim() || !activeSession) return;
    const response = await API.sessions.runTerminalCommand(activeSession.id, input);
    if (response.success) setInput('');
  };

  const handleStopSession = async () => {
    if (activeSession) await API.sessions.stop(activeSession.id);
  };

  const handleCompactContext = async () => {
    if (!activeSession) return;
    
    try {
      
      // Generate the compacted context
      const response = await API.sessions.generateCompactedContext(activeSession.id);
      
      if (response.success && response.data) {
        const summary = response.data.summary;
        setCompactedContext(summary);
        setContextCompacted(true);
      } else {
        console.error('[Context Compaction] Failed to compact context:', response.error);
      }
    } catch (error) {
      console.error('[Context Compaction] Error during compaction:', error);
    }
  };

  // Cleanup on unmount or panel change
  useEffect(() => {
    return () => {
      // Cancel any pending operations
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      if (outputLoadTimeoutRef.current) {
        clearTimeout(outputLoadTimeoutRef.current);
      }
    };
  }, [panelId]);
  
  return {
    // Session and panel info
    activeSession,
    panelId,
    isActive,
    
    // UI state
    theme,
    input,
    setInput,
    isLoadingOutput,
    outputLoadState,
    loadError,
    textareaRef,
    contextCompacted,
    compactedContext,
    hasConversationHistory,
    gitCommands,
    
    // Actions
    handleSendInput,
    handleContinueConversation,
    handleTerminalCommand,
    handleStopSession,
    handleCompactContext,
    
    // Utilities
    loadOutputContent,
    forceResetLoadingState,
  };
};
