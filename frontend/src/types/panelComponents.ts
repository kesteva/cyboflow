import { ToolPanel } from '../../../shared/types/panels';
import type { CliSubstrate } from '../../../shared/types/substrate';

export type PanelContext = 'project' | 'worktree';

export interface PanelTabBarProps {
  panels: ToolPanel[];
  activePanel?: ToolPanel;
  onPanelSelect: (panel: ToolPanel) => void;
  onPanelClose: (panel: ToolPanel) => void;
  context?: PanelContext;  // Optional context to filter available panels
  onAddTerminal?: () => void | Promise<void>;
  /** Optional substrate override for the new panel; omitted inherits the session. */
  onAddChat?: (substrate?: CliSubstrate) => void | Promise<void>;
}

export interface PanelContainerProps {
  panel: ToolPanel;
  isActive: boolean;
}

export interface TerminalPanelProps {
  panel: ToolPanel;
  isActive: boolean;
}
