/**
 * AgentEditorForm — the main editing surface of the Agent editor modal.
 *
 * Blocks:
 *   - Identity: a NAME field (read-only for built-ins; editable only in 'create'
 *     mode for customs), a colored role chip, and a REQUIRED + always-editable
 *     DESCRIPTION field (client-validated to reject the reserved `cyboflow_`
 *     substring so a description can never name an MCP write tool).
 *   - System prompt: a hero textarea. NO {{var}} chips — agents are prose, not
 *     templated; variable interpolation is a workflow-step concern, not an agent
 *     one.
 *   - Tools: a 2-col grid of Switch toggles over the 8 CLI_TOOLS, with a live
 *     "N of 8 enabled" count. The grid never offers a `cyboflow_*` tool (the
 *     single-writer invariant — CLI_TOOLS excludes them by construction).
 *
 * There is intentionally NO model block: agents are model-agnostic and inherit
 * the run's model. The model surfaces only as a read-only Stats key/value in
 * AgentUsageInspector.
 */
import { useMemo } from 'react';
import { Switch } from '../../ui/Switch';
import { CLI_TOOLS, roleColorVar, estimateTokens } from './agentEditorTokens';
import type { AgentDraft, AgentEditorAction } from './useAgentEditorState';

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
  // The READ-ONLY name field shows the BARE key — strip the load-bearing
  // `cyboflow-` prefix the server persists on `name` — so it matches the
  // de-prefixed modal title and gallery card. The EDITABLE create-mode input
  // stays bound to the raw `draft.name` (the user's typed name feeds
  // createCustom unchanged); create-mode drafts carry no prefix anyway.
  const displayName = nameEditable ? draft.name : draft.name.replace(/^cyboflow-/, '');
  const enabled = useMemo(() => new Set(draft.enabledTools), [draft.enabledTools]);
  const promptTokens = estimateTokens(draft.systemPrompt);

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
    </div>
  );
}
