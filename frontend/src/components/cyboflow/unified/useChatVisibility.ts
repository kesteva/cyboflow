/**
 * useChatVisibility — the single source of truth for the Unified Chat View's
 * adaptive chrome.
 *
 * Everything the unified surface shows/hides is derived from three inputs —
 * `transport` (the design's sdk|pty, which is the codebase's substrate
 * sdk|interactive), `mode` (quick|flow), and `running` — plus the local
 * `ptyOpen` (⌃G reveal) state. This replaces the scattered per-button
 * visibility checks that used to drift between the SDK and PTY surfaces.
 *
 * This is a PURE function (no React, no store reads) so the whole matrix is
 * unit-testable in isolation. The parent `UnifiedChat` derives the four inputs
 * from real app state and passes them in.
 *
 * Terminology bridge: design `transport=sdk|pty` === codebase
 * `substrate=sdk|interactive`. We keep a local union (mirroring RunChatView's
 * deliberate re-declaration) so this module stays free of cross-package imports
 * and `isSDK = transport !== 'interactive'`.
 */

/** design `transport`; mirrors `CliSubstrate` ('sdk' | 'interactive'). */
export type ChatTransport = 'sdk' | 'interactive';

/** quick session vs. flow run. */
export type ChatMode = 'quick' | 'flow';

/** The four states of the mode-identity status pill. */
export type ChatStatusKind = 'interactive' | 'generating' | 'paused' | 'executing';

export interface ChatVisibilityInput {
  transport: ChatTransport;
  mode: ChatMode;
  /** the agent is actively producing output (flow executing / quick generating). */
  running: boolean;
  /** ⌃G reveal state for the PTY composer (ignored for SDK). */
  ptyOpen: boolean;
}

export interface ChatVisibility {
  /** transport === sdk (design `isSDK`). */
  isSDK: boolean;
  /** mode === quick. */
  isQuick: boolean;

  /** prompt-history right rail — SDK + quick only. */
  showRail: boolean;
  /** checkpoint-rewind control — quick only. */
  showCheckpoint: boolean;
  /** ⚙ display-settings popover — SDK only. */
  showSettings: boolean;
  /** model + effort selectors — SDK only (rendered read-only for v1). */
  showModelEffort: boolean;
  /**
   * design lock: model/effort disabled (not hidden) while a flow runs. In v1
   * model/effort are always read-only (session config), so this is advisory —
   * kept so re-enabling per-turn editing later only flips the composer, not the
   * matrix.
   */
  modelEffortDisabled: boolean;
  /** composer text input visible — SDK always; PTY only after ⌃G. */
  inputVisible: boolean;
  /** inline thinking/tools segmented toggle lives in the PTY composer. */
  showThinkingToolsInline: boolean;
  /** the same disp toggles live behind the ⚙ menu for SDK. */
  showSettingsToggles: boolean;
}

/**
 * Resolve the full visibility record from the three driving inputs.
 */
export function resolveChatVisibility(input: ChatVisibilityInput): ChatVisibility {
  const isSDK = input.transport !== 'interactive';
  const isQuick = input.mode === 'quick';
  const running = input.running;

  return {
    isSDK,
    isQuick,
    showRail: isSDK && isQuick,
    showCheckpoint: isQuick,
    showSettings: isSDK,
    showModelEffort: isSDK,
    modelEffortDisabled: !isQuick && running,
    inputVisible: isSDK || input.ptyOpen,
    showThinkingToolsInline: !isSDK,
    showSettingsToggles: isSDK,
  };
}

/**
 * The mode-identity status pill, derived purely from (mode, running):
 *   flow  → executing (running) | paused (idle, waiting at a gate)
 *   quick → generating (running) | interactive (idle)
 */
export function resolveChatStatus(input: Pick<ChatVisibilityInput, 'mode' | 'running'>): ChatStatusKind {
  if (input.mode === 'flow') {
    return input.running ? 'executing' : 'paused';
  }
  return input.running ? 'generating' : 'interactive';
}
