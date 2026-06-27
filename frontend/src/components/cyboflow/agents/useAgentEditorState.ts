/**
 * useAgentEditorState — pure reducer over an editable agent DRAFT plus a dirty
 * boolean, backing the Agent editor modal (AgentEditorForm + AgentUsageInspector).
 *
 * Design constraints (mirrors useWorkflowEditorState):
 *   - The reducer + `initAgentEditorState` are exported and PURE so they can be
 *     unit-tested without React.
 *   - The draft INCLUDES `description` (a required, editable field for both
 *     overrides and customs) — distinct from the workflow editor whose draft
 *     has no description.
 *   - `dirty` is computed structurally as
 *     `JSON.stringify(draft) !== JSON.stringify(baseline)`, so re-seeding from
 *     a fresh `AgentEntry` (SEED) always resets dirty to false.
 *   - No zod (frontend has no zod dep). The authoritative validation lives in
 *     the `agents.*` tRPC procedures; this reducer only keeps the in-flight
 *     draft coherent (tool toggles stay within the CLI_TOOLS vocabulary).
 */
import { useReducer } from 'react';
import { CLI_TOOLS } from './agentEditorTokens';
import type { CliTool } from './agentEditorTokens';
import type { AgentEntry, AgentModelAlias } from '../../../../../shared/types/agents';

/** The mutable subset of an agent the editor form binds to. */
export interface AgentDraft {
  name: string;
  description: string;
  role: string;
  systemPrompt: string;
  enabledTools: CliTool[];
  /** Pinned model alias, or `null` to inherit the run model. */
  model: AgentModelAlias | null;
  /** MCP server names granted to this agent (rendered as `mcp__<server>__*`). */
  enabledMcps: string[];
}

export interface AgentEditorState {
  /** The working draft bound by the form. */
  draft: AgentDraft;
  /** Snapshot of the last-seeded draft, for the structural dirty check + reset. */
  baseline: AgentDraft;
}

export type AgentEditorAction =
  | { type: 'SEED'; entry: AgentEntry }
  | { type: 'SET_NAME'; name: string }
  | { type: 'SET_DESCRIPTION'; description: string }
  | { type: 'SET_SYSTEM_PROMPT'; systemPrompt: string }
  | { type: 'SET_MODEL'; model: AgentModelAlias | null }
  | { type: 'TOGGLE_TOOL'; tool: CliTool }
  | { type: 'TOGGLE_MCP'; server: string };

/** Build a draft from an effective AgentEntry, preserving CLI_TOOLS order. */
export function draftFromEntry(entry: AgentEntry): AgentDraft {
  // Normalise the enabled set to CLI_TOOLS order so the dirty check is stable
  // regardless of the order the server returned the tools in.
  const enabled = new Set(entry.tools);
  return {
    name: entry.name,
    description: entry.description,
    role: entry.role,
    systemPrompt: entry.systemPrompt,
    enabledTools: CLI_TOOLS.filter((t) => enabled.has(t)),
    model: entry.model,
    // Sort so the structural dirty check is order-independent (the catalogue
    // has no fixed order like CLI_TOOLS); TOGGLE_MCP keeps the array sorted.
    enabledMcps: [...entry.enabledMcps].sort(),
  };
}

export function agentEditorReducer(
  state: AgentEditorState,
  action: AgentEditorAction,
): AgentEditorState {
  switch (action.type) {
    case 'SEED': {
      const draft = draftFromEntry(action.entry);
      // Deep-clone the baseline so later draft mutations never alias it.
      return { draft, baseline: structuredClone(draft) };
    }

    case 'SET_NAME':
      return { ...state, draft: { ...state.draft, name: action.name } };

    case 'SET_DESCRIPTION':
      return { ...state, draft: { ...state.draft, description: action.description } };

    case 'SET_SYSTEM_PROMPT':
      return { ...state, draft: { ...state.draft, systemPrompt: action.systemPrompt } };

    case 'SET_MODEL':
      return { ...state, draft: { ...state.draft, model: action.model } };

    case 'TOGGLE_TOOL': {
      const has = state.draft.enabledTools.includes(action.tool);
      const enabledTools = has
        ? state.draft.enabledTools.filter((t) => t !== action.tool)
        // Re-derive in CLI_TOOLS order so toggling never reorders the array.
        : CLI_TOOLS.filter((t) => state.draft.enabledTools.includes(t) || t === action.tool);
      return { ...state, draft: { ...state.draft, enabledTools } };
    }

    case 'TOGGLE_MCP': {
      const has = state.draft.enabledMcps.includes(action.server);
      // Keep the array sorted so the dirty check stays set-based: toggling a
      // server on then off returns to a baseline-identical array.
      const enabledMcps = has
        ? state.draft.enabledMcps.filter((s) => s !== action.server)
        : [...state.draft.enabledMcps, action.server].sort();
      return { ...state, draft: { ...state.draft, enabledMcps } };
    }

    default:
      return state;
  }
}

/** Build initial state from an entry (or a blank draft when none is loaded yet). */
export function initAgentEditorState(entry: AgentEntry | null): AgentEditorState {
  const draft: AgentDraft = entry
    ? draftFromEntry(entry)
    : { name: '', description: '', role: '', systemPrompt: '', enabledTools: [], model: null, enabledMcps: [] };
  return { draft, baseline: structuredClone(draft) };
}

export interface UseAgentEditorStateResult {
  state: AgentEditorState;
  dispatch: React.Dispatch<AgentEditorAction>;
  /** Structural dirty flag: draft differs from the last-seeded baseline. */
  dirty: boolean;
}

export function useAgentEditorState(entry: AgentEntry | null): UseAgentEditorStateResult {
  const [state, dispatch] = useReducer(
    agentEditorReducer,
    entry,
    (init) => initAgentEditorState(init),
  );
  const dirty = JSON.stringify(state.draft) !== JSON.stringify(state.baseline);
  return { state, dispatch, dirty };
}
