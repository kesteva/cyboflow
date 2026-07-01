/**
 * AgentEditorForm — the main editing surface of the Agent editor modal.
 *
 * Blocks:
 *   - Identity: a NAME field (read-only for built-ins; editable only in 'create'
 *     mode for customs), a colored role chip, and a REQUIRED + always-editable
 *     DESCRIPTION field (client-validated to reject the reserved `cyboflow_`
 *     substring so a description can never name an MCP write tool).
 *   - Model: a picker to PIN this agent's model (Opus / Sonnet / Haiku) or
 *     inherit the run model (the default). The spawn-time overlay resolves the
 *     chosen alias to a concrete snapshot in the subagent `model:` frontmatter;
 *     "Inherit run model" emits no frontmatter line (byte-identical to before).
 *   - System prompt: a hero textarea. NO {{var}} chips — agents are prose, not
 *     templated; variable interpolation is a workflow-step concern, not an agent
 *     one.
 *   - Tools: a 2-col grid of Switch toggles over the 8 CLI_TOOLS, with a live
 *     "N of 8 enabled" count. The grid never offers a `cyboflow_*` tool (the
 *     single-writer invariant — CLI_TOOLS excludes them by construction).
 */
import { useEffect, useMemo, useState } from 'react';
import { Switch } from '../../ui/Switch';
import { trpc } from '../../../trpc/client';
import { CLI_TOOLS, roleColorVar, estimateTokens } from './agentEditorTokens';
import type { AgentDraft, AgentEditorAction } from './useAgentEditorState';
import {
  AGENT_MODEL_ALIASES,
  AGENT_MODEL_LABELS,
  INHERIT_RUN_MODEL_LABEL,
  type AgentModelAlias,
} from '../../../../../shared/types/agents';
import type { McpEntry } from '../../../../../shared/types/integrations';
import { useModelAvailability } from '../../../stores/modelAvailabilityStore';

export interface AgentEditorFormProps {
  draft: AgentDraft;
  dispatch: React.Dispatch<AgentEditorAction>;
  /** 'edit' = built-in/override (name locked) | 'create' = custom (name editable). */
  mode: 'edit' | 'create';
  /** A custom agent's name is editable in create mode; a built-in's name is always locked. */
  isCustom: boolean;
  /** Client-side description error (e.g. empty or contains `cyboflow_`), or null. */
  descriptionError: string | null;
}

export function AgentEditorForm({
  draft,
  dispatch,
  mode,
  isCustom,
  descriptionError,
}: AgentEditorFormProps): React.JSX.Element {
  // Name is editable ONLY for a brand-new custom (create mode). Built-ins and
  // existing customs render the name read-only.
  const nameEditable = mode === 'create' && isCustom;
  // Guarded-model availability (Fable 5): grey out a pinnable model that's pulled.
  const { isAliasUsable } = useModelAvailability();
  // The READ-ONLY name field shows the BARE key — strip the load-bearing
  // `cyboflow-` prefix the server persists on `name` — so it matches the
  // de-prefixed modal title and gallery card. The EDITABLE create-mode input
  // stays bound to the raw `draft.name` (the user's typed name feeds
  // createCustom unchanged); create-mode drafts carry no prefix anyway.
  const displayName = nameEditable ? draft.name : draft.name.replace(/^cyboflow-/, '');
  const enabled = useMemo(() => new Set(draft.enabledTools), [draft.enabledTools]);
  const promptTokens = estimateTokens(draft.systemPrompt);

  // Read-only catalogue of MCP servers configured in the CLI (machine-global).
  // Fetched once on mount; failures degrade to an empty list (no MCP options).
  const [mcps, setMcps] = useState<McpEntry[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await trpc.cyboflow.mcps.list.query();
        if (!cancelled) setMcps(list);
      } catch {
        if (!cancelled) setMcps([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Selectable server names: the catalogue deduped by name (a server can appear
  // at multiple scopes), minus the single-writer `cyboflow` server (never
  // grantable), unioned with any already-granted server so a stale grant stays
  // visible and un-checkable. Sorted for a stable grid order.
  const mcpEnabled = useMemo(() => new Set(draft.enabledMcps), [draft.enabledMcps]);
  const mcpOptions = useMemo(() => {
    const names = new Set<string>();
    for (const entry of mcps) {
      if (entry.name === 'cyboflow' || entry.name.startsWith('cyboflow_')) continue;
      names.add(entry.name);
    }
    for (const server of draft.enabledMcps) names.add(server);
    return Array.from(names).sort();
  }, [mcps, draft.enabledMcps]);

  return (
    <div className="flex-1 overflow-auto px-7 py-6 min-w-0" data-testid="agent-editor-form">
      {/* ── Identity ─────────────────────────────────────────────────────── */}
      <div className="flex items-start gap-4">
        <div className="flex-1 min-w-0">
          <div className="text-[9px] font-bold uppercase tracking-[0.18em] text-text-tertiary mb-2">
            Agent definition
          </div>
          <div className="flex items-center gap-3">
            <input
              type="text"
              value={displayName}
              readOnly={!nameEditable}
              onChange={(e) =>
                nameEditable && dispatch({ type: 'SET_NAME', name: e.target.value })
              }
              aria-label="Agent name"
              placeholder="agent name"
              className={
                'rounded-input border border-border-subtle bg-surface-primary px-3 py-1.5 text-lg font-bold text-text-primary min-w-[300px]' +
                (nameEditable ? '' : ' cursor-default opacity-90')
              }
              data-testid="agent-name-input"
            />
            <span
              className="text-[9px] font-bold uppercase tracking-[0.16em] px-2 py-1 border"
              style={{ color: roleColorVar(draft.role), borderColor: roleColorVar(draft.role) }}
              data-testid="agent-role-chip"
            >
              {draft.role}
            </span>
          </div>
        </div>
      </div>

      {/* ── Description (required, editable for BOTH override + custom) ───── */}
      <div className="mt-6">
        <div className="text-[9px] font-bold uppercase tracking-[0.18em] text-text-tertiary mb-3 flex items-center gap-2">
          <span>Description</span>
          <span className="flex-1 h-px bg-border-subtle" />
        </div>
        <input
          type="text"
          value={draft.description}
          onChange={(e) => dispatch({ type: 'SET_DESCRIPTION', description: e.target.value })}
          aria-label="Agent description"
          placeholder="One-line description of what this agent does"
          className="w-full rounded-input border border-border-subtle bg-surface-primary px-3 py-2 text-sm text-text-primary"
          data-testid="agent-description-input"
          aria-invalid={descriptionError !== null}
        />
        {descriptionError !== null && (
          <p className="mt-1.5 text-xs text-status-error" role="alert" data-testid="agent-description-error">
            {descriptionError}
          </p>
        )}
      </div>

      {/* ── Model (pin a model, or inherit the run model) ─────────────────── */}
      <div className="mt-6">
        <div className="text-[9px] font-bold uppercase tracking-[0.18em] text-text-tertiary mb-3 flex items-center gap-2">
          <span>Model</span>
          <span className="flex-1 h-px bg-border-subtle" />
        </div>
        <select
          value={draft.model ?? ''}
          onChange={(e) =>
            dispatch({
              type: 'SET_MODEL',
              model: e.target.value === '' ? null : (e.target.value as AgentModelAlias),
            })
          }
          aria-label="Agent model"
          className="w-full max-w-[320px] rounded-input border border-border-subtle bg-surface-primary px-3 py-2 text-sm text-text-primary"
          data-testid="agent-model-select"
        >
          <option value="">{INHERIT_RUN_MODEL_LABEL}</option>
          {AGENT_MODEL_ALIASES.map((alias) => {
            const disabled = !isAliasUsable(alias);
            return (
              <option key={alias} value={alias} disabled={disabled}>
                {AGENT_MODEL_LABELS[alias]}
                {disabled ? ' (unavailable)' : ''}
              </option>
            );
          })}
        </select>
        <p className="mt-1.5 text-[10px] text-text-tertiary">
          {draft.model === null
            ? 'This agent runs with whatever model the run uses.'
            : `This agent always runs on ${AGENT_MODEL_LABELS[draft.model]}, regardless of the run model.`}
        </p>
      </div>

      {/* ── System prompt — hero (NO {{var}} chips) ──────────────────────── */}
      <div className="mt-6">
        <div className="text-[9px] font-bold uppercase tracking-[0.18em] text-text-tertiary mb-3 flex items-center gap-2">
          <span>System prompt · instructions</span>
          <span className="flex-1 h-px bg-border-subtle" />
        </div>
        <textarea
          value={draft.systemPrompt}
          onChange={(e) => dispatch({ type: 'SET_SYSTEM_PROMPT', systemPrompt: e.target.value })}
          aria-label="System prompt"
          placeholder="You are the …"
          rows={12}
          className="w-full rounded-input border border-border-subtle bg-surface-primary px-4 py-3 text-sm leading-relaxed text-text-primary resize-y min-h-[196px] font-mono"
          data-testid="agent-system-prompt"
        />
        <div className="mt-1.5 text-right text-[10px] text-text-tertiary tabular-nums">
          ~{promptTokens} tokens · appended to base prompt
        </div>
      </div>

      {/* ── Tools whitelist (2-col Switch grid, live N of 8) ─────────────── */}
      <div className="mt-6">
        <div className="text-[9px] font-bold uppercase tracking-[0.18em] text-text-tertiary mb-3 flex items-center gap-2">
          <span>Tools</span>
          <span className="font-semibold normal-case tracking-normal text-text-secondary" data-testid="agent-tools-count">
            {draft.enabledTools.length} of {CLI_TOOLS.length} enabled
          </span>
          <span className="flex-1 h-px bg-border-subtle" />
        </div>
        <div className="grid grid-cols-2 gap-2" data-testid="agent-tools-grid">
          {CLI_TOOLS.map((tool) => {
            const on = enabled.has(tool);
            const switchId = `agent-tool-${tool}`;
            return (
              <label
                key={tool}
                htmlFor={switchId}
                className={
                  'flex items-center justify-between gap-3 border border-border-subtle bg-surface-primary px-3 py-2.5 cursor-pointer hover:border-border-emphasized' +
                  (on ? '' : ' opacity-70')
                }
                data-testid={`agent-tool-row-${tool}`}
              >
                <span className="text-sm font-semibold text-text-primary">{tool}</span>
                <Switch
                  id={switchId}
                  checked={on}
                  onCheckedChange={() => dispatch({ type: 'TOGGLE_TOOL', tool })}
                  aria-label={`Toggle ${tool}`}
                  data-testid={`agent-tool-switch-${tool}`}
                />
              </label>
            );
          })}
        </div>
      </div>

      {/* ── MCP access (servers this agent may call) ─────────────────────── */}
      <div className="mt-6">
        <div className="text-[9px] font-bold uppercase tracking-[0.18em] text-text-tertiary mb-3 flex items-center gap-2">
          <span>MCP access</span>
          <span className="font-semibold normal-case tracking-normal text-text-secondary" data-testid="agent-mcps-count">
            {draft.enabledMcps.length} enabled
          </span>
          <span className="flex-1 h-px bg-border-subtle" />
        </div>
        {mcpOptions.length === 0 ? (
          <p className="text-xs text-text-tertiary" data-testid="agent-mcps-empty">
            No MCP servers are configured in your CLI. Granted servers expand to
            <span className="font-mono"> mcp__&lt;server&gt;__*</span> on the tools line.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-2" data-testid="agent-mcps-grid">
            {mcpOptions.map((server) => {
              const on = mcpEnabled.has(server);
              const switchId = `agent-mcp-${server}`;
              return (
                <label
                  key={server}
                  htmlFor={switchId}
                  className={
                    'flex items-center justify-between gap-3 border border-border-subtle bg-surface-primary px-3 py-2.5 cursor-pointer hover:border-border-emphasized' +
                    (on ? '' : ' opacity-70')
                  }
                  data-testid={`agent-mcp-row-${server}`}
                >
                  <span className="text-sm font-semibold text-text-primary truncate">{server}</span>
                  <Switch
                    id={switchId}
                    checked={on}
                    onCheckedChange={() => dispatch({ type: 'TOGGLE_MCP', server })}
                    aria-label={`Toggle MCP ${server}`}
                    data-testid={`agent-mcp-switch-${server}`}
                  />
                </label>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
