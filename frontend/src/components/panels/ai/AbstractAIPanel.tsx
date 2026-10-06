import { ToolPanel } from '../../../../../shared/types/panels';

/**
 * Display settings for the chat transcript (ChatTranscript / UnifiedChatView).
 */
export interface RichOutputSettings {
  showToolCalls: boolean;
  compactMode: boolean;
  collapseTools: boolean;
  showThinking: boolean;
  showSessionInit: boolean;
}

/**
 * Props for AI agent panels (ClaudePanel).
 */
export interface AIPanelProps {
  panel: ToolPanel;
  isActive: boolean;
}
