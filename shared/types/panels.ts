import type { CliSubstrate } from './substrate';

export interface ToolPanel {
  id: string;                    // Unique panel instance ID (uuid)
  sessionId: string;             // Associated session/worktree
  type: ToolPanelType;
  title: string;                 // Display title (e.g., "Terminal 1" or "Chat 1")
  state: ToolPanelState;         // Panel-specific state
  metadata: ToolPanelMetadata;   // Creation time, position, etc.
  /** Optional per-panel substrate; absent inherits the session substrate. */
  substrate?: CliSubstrate;
}

export type ToolPanelType = 'terminal' | 'claude' | 'diff' | 'logs';

export interface ToolPanelState {
  isActive: boolean;
  isPinned?: boolean;
  hasBeenViewed?: boolean;       // Track if panel has ever been viewed
  customState?: TerminalPanelState | ClaudePanelState | LogsPanelState | Record<string, unknown>;
}

export interface TerminalPanelState {
  isInitialized?: boolean;       // Whether PTY process has been started
  cwd?: string;                  // Current working directory
  shellType?: string;            // bash, zsh, etc.
  scrollbackBuffer?: string;     // Full terminal output history
  commandHistory?: string[];     // Commands entered by user
  dimensions?: { cols: number; rows: number }; // Terminal size
  lastActiveCommand?: string;    // Command running when closed
  lastActivityTime?: string;     // For "idle since" indicators
}

// Panel status type - mirrors session status but at panel level
export type PanelStatus = 'idle' | 'running' | 'waiting' | 'stopped' | 'completed_unviewed' | 'error';

// Base interface for AI panel states (Claude, Codex, etc.)
export interface BaseAIPanelState {
  // Common state for all AI tools
  isInitialized?: boolean;       // Whether AI process has been started
  lastPrompt?: string;           // Last user prompt
  model?: string;                // Model being used
  lastActivityTime?: string;     // For "idle since" indicators
  lastInput?: string;            // Last input sent to the AI

  // Panel-level status tracking (independent per panel)
  panelStatus?: PanelStatus;     // Current panel execution status
  hasUnviewedContent?: boolean;  // Whether panel has content not yet viewed

  // Generic agent session ID for resume functionality (used by all AI agents)
  agentSessionId?: string;        // The AI agent's session ID for resuming conversations

  // Legacy fields for backward compatibility (will be migrated to agentSessionId)
  claudeSessionId?: string;       // Deprecated: Use agentSessionId instead
  claudeResumeId?: string;        // Deprecated: Claude's old resume ID
}

export interface ClaudePanelState extends BaseAIPanelState {
  // Claude-specific state
  permissionMode?: 'approve' | 'ignore'; // Permission mode for Claude

  // Context meter, refreshed after each successful turn from the turn's own
  // SDK usage data (see the exit handler in main/src/events.ts)
  contextUsage?: string | null;          // Latest context usage summary (e.g., "54k/200k tokens (27%)")
}

/**
 * Fast-mode state as REPORTED by the CLI per turn (`fast_mode_state` on the
 * system/init and result stream events). This is the ground truth for whether
 * fast mode is actually active — the per-panel toggle only records the user's
 * request; the CLI's boot-time org/entitlement check (paid subscription /
 * usage credits) or a rate-limit cooldown can decline it.
 */
export type FastModeState = 'off' | 'cooldown' | 'on';

/**
 * Live per-turn fast-mode report, pushed main → renderer on change over the
 * `fast-mode-state` channel (claudeCodeManager event of the same name) so the
 * composer's Fast pill can reflect reality rather than the toggle.
 */
export interface FastModeStateNotice {
  panelId: string;
  sessionId: string;
  /** What the CLI reported for the turn. */
  state: FastModeState;
  /** Whether the spawn that produced this report actually requested fast mode. */
  requestedFast: boolean;
}

/**
 * A single mid-turn-queued chat message for a quick-session Claude panel ("always
 * allow messaging a running quick session"). The `id` is the CLIENT pending-send
 * id (pendingSendStore), so a dequeue (click-to-reopen) targets this exact entry.
 * Buffered in ClaudeCodeManager and delivered as one combined continuation at the
 * turn's rest boundary.
 */
export interface QueuedPanelInput {
  id: string;
  text: string;
}

export interface LogsPanelState {
  isRunning: boolean;             // Process currently running
  processId?: number;             // Active process PID
  command?: string;               // Command being executed
  startTime?: string;             // When process started
  endTime?: string;               // When process ended
  exitCode?: number;              // Process exit code
  outputBuffer?: string[];        // Recent output lines
  errorCount?: number;            // Number of errors detected
  warningCount?: number;          // Number of warnings detected
  lastActivityTime?: string;      // Last output received
}

export interface ToolPanelMetadata {
  createdAt: string;
  lastActiveAt: string;
  position: number;              // Tab order
  permanent?: boolean;           // Cannot be closed (for diff panel)
}

export interface CreatePanelRequest {
  sessionId: string;
  type: ToolPanelType;
  title?: string;                // Optional custom title
  initialState?: TerminalPanelState | ClaudePanelState | LogsPanelState | { customState?: unknown };
  metadata?: Partial<ToolPanelMetadata>; // Optional metadata overrides
  /** Optional per-panel substrate override; absent inherits the session. */
  substrate?: CliSubstrate;
}

// Panel Event System Types
export interface PanelEvent {
  type: PanelEventType;
  source: {
    panelId: string;
    panelType: ToolPanelType;
    sessionId: string;
  };
  data: unknown;
  timestamp: string;
}

// Panel events ride the main-process panelEventBus: terminalPanelManager emits
// terminal:* / files:changed, logsManager emits process:*, and gitOps emits
// git:operation_* (which AbstractAIPanelManager subscribes to).
export type PanelEventType = 
  // Terminal panel events
  | 'terminal:command_executed'  // When a command is run in terminal
  | 'terminal:exit'              // When terminal process exits
  | 'files:changed'              // When terminal detects file system changes
  // Logs panel events
  | 'process:started'            // When a script process starts
  | 'process:output'             // When process produces output
  | 'process:ended'              // When process exits
  // Git operation events
  | 'git:operation_started'      // When a git operation begins
  | 'git:operation_completed'    // When a git operation succeeds
  | 'git:operation_failed'        // When a git operation fails

export interface PanelEventSubscription {
  panelId: string;
  eventTypes: PanelEventType[];
  callback: (event: PanelEvent) => void;
}

/**
 * Type guard: narrows ToolPanelState['customState'] to `{ cwd: string }` when
 * it is an object with a non-empty string `cwd` property.
 *
 * Use this guard at every site that needs to read `customState.cwd` to avoid
 * the unsafe `as TerminalPanelState | undefined` cast pattern. Returns false
 * for null, undefined, empty-string cwd, or non-string cwd values.
 */
export function hasCwdString(
  state: ToolPanelState['customState']
): state is { cwd: string } {
  return (
    typeof state === 'object' &&
    state !== null &&
    'cwd' in state &&
    typeof (state as Record<string, unknown>).cwd === 'string' &&
    ((state as Record<string, unknown>).cwd as string).length > 0
  );
}
