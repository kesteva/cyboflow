import { ToolPanel } from '../../../shared/types/panels';

export type PanelContext = 'project' | 'worktree';

export interface PanelTabBarProps {
  panels: ToolPanel[];
  activePanel?: ToolPanel;
  onPanelSelect: (panel: ToolPanel) => void;
  onPanelClose: (panel: ToolPanel) => void;
  context?: PanelContext;  // Optional context to filter available panels
  onAddTerminal?: () => void | Promise<void>;
  onAddClaude?: () => void | Promise<void>;
}

export interface PanelContainerProps {
  panel: ToolPanel;
  isActive: boolean;
  isMainRepo?: boolean;
}

export interface TerminalPanelProps {
  panel: ToolPanel;
  isActive: boolean;
}
