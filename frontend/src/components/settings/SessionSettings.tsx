import { Bot, Cpu, FileText, FolderOpen, Layers, ShieldCheck, SlidersHorizontal, Terminal, Zap } from 'lucide-react';
import { Checkbox, Textarea } from '../ui/Input';
import { CollapsibleCard } from '../ui/CollapsibleCard';
import { SettingsSection } from '../ui/SettingsSection';
import { PERMISSION_MODE_OPTIONS } from '../cyboflow/AgentPermissionModeSelector';
import { MODEL_OPTIONS } from '../cyboflow/unified/ModelPill';
import { ModelSelector } from '../cyboflow/ModelSelector';
import { RunTypeOverridesSection } from './RunTypeOverridesSection';
import { coerceGlobalLaunchModel, globalRuntimeProvider, runTypeValueLabel } from './runTypeOverrides';
import { useCodexModelCatalog } from '../../stores/codexModelCatalogStore';
import { trackEvent } from '../../utils/telemetry';
import {
  SESSION_AGENT_RUNTIMES,
  isRuntimeProviderEnabled,
  isWorkflowLaunchableRuntime,
  type AgentProviderAccess,
  type AgentRuntime,
} from '../../../../shared/types/agentRuntime';
import { isRuntimeSelectableInPickers } from '../../../../shared/types/agentCapabilities';
import type { ExecutionModel } from '../../../../shared/types/executionModel';
import type { CliSubstrate } from '../../../../shared/types/substrate';
import {
  SPRINT_BATCH_CAP,
  SPRINT_BATCH_MAX_TASKS_DEFAULTS,
  SPRINT_MAX_TASKS_MAX,
  SPRINT_MAX_TASKS_MIN,
} from '../../../../shared/types/sprintBatch';
import type { PermissionMode } from '../../../../shared/types/workflows';
import type { QuickSessionWorktreeMode } from '../../../../shared/types/worktreeMode';

/**
 * The AI tab's "Session settings" group — the knobs that answer *what does a new
 * session or run start with*, as opposed to the "Feature controls" group's *is
 * this capability available at all*.
 *
 * Props-in / callback-out only: every value still lives as lifted state in
 * `Settings.tsx` and is persisted by the shared `handleSubmit` there, so this is
 * a presentation container, not a self-fetching panel like `IntegrationsSettings`.
 */
export interface SessionSettingsProps {
  globalSystemPrompt: string;
  onGlobalSystemPromptChange: (prompt: string) => void;
  defaultAgentPermissionMode: PermissionMode;
  onDefaultAgentPermissionModeChange: (mode: PermissionMode) => void;
  /**
   * `config.defaultLaunchModel` — the GLOBAL middle rung of
   * `resolveRunTypeLaunchDefaults`. `''` means the field is absent, i.e. every
   * launch kind falls through to its own floor; the save path in `Settings.tsx`
   * turns `''` back into `undefined` so config.json stays free of the key.
   */
  defaultLaunchModel: string;
  onDefaultLaunchModelChange: (model: string) => void;
  /**
   * `config.defaultAgentRuntime` — ONE global runtime shared by both launch
   * surfaces, coerced per surface (a quick-only runtime is dropped by a flow
   * launch). `undefined` means absent: no runtime is sent at all, which is what
   * keeps an unconfigured install's launch payload byte-identical.
   */
  defaultAgentRuntime: AgentRuntime | undefined;
  onDefaultAgentRuntimeChange: (runtime: AgentRuntime | undefined) => void;
  /**
   * Per-provider access toggles (Settings → Integrations). A runtime whose
   * provider is switched off must not be selectable here, exactly as in every
   * other runtime picker — the renderer read is a courtesy, the launch seams
   * still fail closed.
   *
   * MUST be the ARIA-GATED map (`useAgentProviderAccess`), not the raw
   * `AppConfig.agentProviderAccess` field. The raw field still carries a stored
   * `true` for an Aria-gated provider, which would render that provider's
   * runtime as a selectable default on an install whose Settings shows no card
   * for it.
   */
  agentProviderAccess?: AgentProviderAccess;
  defaultExecutionModel: ExecutionModel;
  onDefaultExecutionModelChange: (model: ExecutionModel) => void;
  quickSessionWorktreeMode: QuickSessionWorktreeMode;
  onQuickSessionWorktreeModeChange: (mode: QuickSessionWorktreeMode) => void;
  quickSessionDefaultSubstrate: CliSubstrate;
  onQuickSessionDefaultSubstrateChange: (substrate: CliSubstrate) => void;
  /**
   * `config.sprintMaxTasks.sdk` / `.interactive` — how many tasks may be
   * multi-selected into ONE sprint batch, per substrate. `number | ''` so
   * clearing the field renders empty rather than `NaN`; the save path in
   * `Settings.tsx` floors an empty/invalid entry back to the built-in default and
   * clamps to [SPRINT_MAX_TASKS_MIN, SPRINT_MAX_TASKS_MAX].
   */
  sprintMaxTasksSdk: number | '';
  onSprintMaxTasksSdkChange: (value: number | '') => void;
  sprintMaxTasksInteractive: number | '';
  onSprintMaxTasksInteractiveChange: (value: number | '') => void;
  codeReviewEvalEnabled: boolean;
  onCodeReviewEvalEnabledChange: (enabled: boolean) => void;
  autoGradeVariantRuns: boolean;
  onAutoGradeVariantRunsChange: (enabled: boolean) => void;
}

export function SessionSettings({
  globalSystemPrompt,
  onGlobalSystemPromptChange,
  defaultAgentPermissionMode,
  onDefaultAgentPermissionModeChange,
  defaultLaunchModel,
  onDefaultLaunchModelChange,
  defaultAgentRuntime,
  onDefaultAgentRuntimeChange,
  agentProviderAccess,
  defaultExecutionModel,
  onDefaultExecutionModelChange,
  quickSessionWorktreeMode,
  onQuickSessionWorktreeModeChange,
  quickSessionDefaultSubstrate,
  onQuickSessionDefaultSubstrateChange,
  sprintMaxTasksSdk,
  onSprintMaxTasksSdkChange,
  sprintMaxTasksInteractive,
  onSprintMaxTasksInteractiveChange,
  codeReviewEvalEnabled,
  onCodeReviewEvalEnabledChange,
  autoGradeVariantRuns,
  onAutoGradeVariantRunsChange,
}: SessionSettingsProps): React.JSX.Element {
  // Two independent reasons to omit a runtime. `selectableInPickers` is the
  // capability answer to "may ANY picker offer this?" — false for a runtime with
  // no manager and for one declared ahead of its managers — and it is absolute:
  // unlike the provider toggle below it has no keep-the-current-value carve-out,
  // because a value the surface can never legitimately hold should not be
  // presented as a choice. Provider access is the per-user answer: a runtime on a
  // switched-off provider is not offered either, EXCEPT when it is the stored
  // value, which would otherwise vanish from the UI while still resolving at
  // launch — it renders disabled instead, so it cannot be (re)selected.
  const runtimeOptions = SESSION_AGENT_RUNTIMES.filter(
    (runtime) =>
      isRuntimeSelectableInPickers(runtime) &&
      (isRuntimeProviderEnabled(agentProviderAccess, runtime) || runtime === defaultAgentRuntime),
  );
  // The honest half of "one global runtime, coerced per surface": `codex-pty` is
  // a member of SessionAgentRuntime but NOT of WorkflowAgentRuntime, so a flow
  // launch drops it and falls back to the workflow floor. Decided from the shared
  // guard, never a hardcoded runtime id, so a future quick-only runtime is covered.
  const runtimeIsWorkflowCapable =
    defaultAgentRuntime === undefined || isWorkflowLaunchableRuntime(defaultAgentRuntime);

  /**
   * The two global launch defaults are ONE setting in two halves: a model from
   * another provider's family cannot launch on the chosen runtime, and this rung
   * feeds every launch that has no per-run-type override. The per-type editor
   * (`RunTypeOverrideDetail`) already refuses that pair the same two ways —
   * scope the offered options to the effective runtime, AND coerce on every edit
   * path so no edit ORDER can reassemble it — so the global rung does the same,
   * through the same `coerceModelForRuntime`.
   *
   * Every provider's options come from the SAME catalog its launch pickers
   * render (`ModelSelector` / `ModelPill`), never a second hardcoded list, so
   * Settings cannot offer a model a launch would not.
   */
  const globalProvider = globalRuntimeProvider(defaultAgentRuntime);
  const usesCodex = globalProvider === 'codex';
  const usesOmp = globalProvider === 'omp';
  const {
    options: codexModelOptions,
    loading: codexCatalogLoading,
    error: codexCatalogError,
  } = useCodexModelCatalog(usesCodex);
  /**
   * The catalog is fetched from the Codex CLI, so under a Codex runtime the
   * list is just the synthetic "Auto/default" entry until it arrives — and
   * stays that way if the fetch fails or the CLI reports no models. Rendering
   * that silently looks like the options simply do not follow the runtime, so
   * each of those three states says which one it is.
   */
  const codexCatalogEmpty = usesCodex && !codexCatalogLoading && codexModelOptions.length <= 1;
  const modelOptions: readonly { id: string; label: string; hint: string }[] = usesCodex
    ? codexModelOptions.map((o) => ({ id: o.id, label: o.label, hint: o.description }))
    : MODEL_OPTIONS.map((o) => ({
        id: o.id,
        label: o.label,
        hint: o.context ? `${o.description} · ${o.context}` : o.description,
      }));

  // Model edited last. A cross-family value can still arrive here from a stale
  // render or a hand-edited config.json restored into the field, so the pick is
  // projected onto the runtime's family rather than trusted. "Built-in default"
  // ('') passes through untouched — clearing a setting must stay a clear.
  const handleLaunchModelPick = (model: string): void => {
    onDefaultLaunchModelChange(coerceGlobalLaunchModel(model, defaultAgentRuntime));
  };

  // Runtime edited last — the reverse order, and the one that is reachable with
  // two ordinary clicks: pick a Claude model, then a Codex runtime. The model
  // moves WITH the runtime (to the Codex sentinel, or back to "Built-in default"
  // when a Codex model can no longer launch), so the saved pair always agrees.
  const handleAgentRuntimePick = (runtime: AgentRuntime | undefined): void => {
    onDefaultAgentRuntimeChange(runtime);
    const coerced = coerceGlobalLaunchModel(defaultLaunchModel, runtime);
    if (coerced !== defaultLaunchModel) onDefaultLaunchModelChange(coerced);
  };

  return (
    <section data-testid="settings-session-settings">
      <CollapsibleCard
        title="Session settings"
        subtitle="What a new session or run starts with"
        icon={<SlidersHorizontal className="w-5 h-5" />}
        defaultExpanded={true}
      >
        {/* Global defaults — the baseline every new session or run inherits.
            Per-run-type overrides belong directly BELOW this sub-block. */}
        <section aria-labelledby="session-settings-global-defaults">
          <h4
            id="session-settings-global-defaults"
            className="text-xs font-semibold uppercase tracking-[.08em] text-text-tertiary mb-4"
          >
            Global defaults
          </h4>

          <SettingsSection
            title="Global Instructions"
            description="Add custom instructions that apply to all your projects"
            icon={<FileText className="w-4 h-4" />}
          >
            <Textarea
              label="Global System Prompt"
              value={globalSystemPrompt}
              onChange={(e) => onGlobalSystemPromptChange(e.target.value)}
              placeholder="Always use TypeScript... Follow our team's coding standards..."
              rows={3}
              fullWidth
              helperText="These instructions will be added to every Claude session across all projects."
            />
          </SettingsSection>

          <SettingsSection
            title="Agent Permission Mode"
            description="How workflow agents handle tool use that touches your files"
            icon={<ShieldCheck className="w-4 h-4" />}
          >
            <div className="flex flex-col gap-1.5">
              {PERMISSION_MODE_OPTIONS.map(({ id, label, hint }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    onDefaultAgentPermissionModeChange(id);
                    trackEvent('permission_mode_changed', { mode: id });
                  }}
                  aria-pressed={defaultAgentPermissionMode === id}
                  className={`flex items-center justify-between gap-3 px-3 py-2 rounded-button border transition-colors text-left ${
                    defaultAgentPermissionMode === id
                      ? 'border-interactive bg-interactive-surface'
                      : 'border-border-secondary bg-surface-secondary hover:bg-surface-hover'
                  }`}
                >
                  <span className="text-text-primary font-medium text-sm">{label}</span>
                  <span className="text-xs text-text-tertiary">{hint}</span>
                </button>
              ))}
            </div>
            <p className="text-xs text-text-tertiary mt-2">
              Applies to workflow runs on both CLI substrates. "Auto" uses Claude's native permission classifier; "Don't ask" skips all permission prompts.
            </p>
          </SettingsSection>

          {/* ONE global runtime for both launch surfaces, coerced per surface.
              SESSION_AGENT_RUNTIMES is the superset of the two launch kinds;
              `codex-exec` is deliberately absent (headless — it reaches no launch
              picker). When the pick is not workflow-capable the control SAYS SO
              rather than presenting a setting flow runs silently ignore. */}
          <SettingsSection
            title="Default Agent Runtime"
            description="Which agent runtime a new quick session or flow run starts on"
            icon={<Bot className="w-4 h-4" />}
          >
            <div className="flex flex-col gap-1.5">
              <button
                type="button"
                data-testid="default-agent-runtime-unset"
                onClick={() => handleAgentRuntimePick(undefined)}
                aria-pressed={defaultAgentRuntime === undefined}
                className={`flex items-center justify-between gap-3 px-3 py-2 rounded-button border transition-colors text-left ${
                  defaultAgentRuntime === undefined
                    ? 'border-interactive bg-interactive-surface'
                    : 'border-border-secondary bg-surface-secondary hover:bg-surface-hover'
                }`}
              >
                <span className="text-text-primary font-medium text-sm">Built-in default</span>
                <span className="text-xs text-text-tertiary">Let each launch surface choose</span>
              </button>
              {runtimeOptions.map((runtime) => {
                const enabled = isRuntimeProviderEnabled(agentProviderAccess, runtime);
                const selected = defaultAgentRuntime === runtime;
                return (
                  <button
                    key={runtime}
                    type="button"
                    data-testid={`default-agent-runtime-${runtime}`}
                    disabled={!enabled}
                    onClick={() => handleAgentRuntimePick(runtime)}
                    aria-pressed={selected}
                    className={`flex items-center justify-between gap-3 px-3 py-2 rounded-button border transition-colors text-left disabled:opacity-50 disabled:cursor-not-allowed ${
                      selected
                        ? 'border-interactive bg-interactive-surface'
                        : 'border-border-secondary bg-surface-secondary hover:bg-surface-hover'
                    }`}
                  >
                    <span className="text-text-primary font-medium text-sm">
                      {runTypeValueLabel('agentRuntime', runtime)}
                    </span>
                    <span className="text-xs text-text-tertiary">
                      {!enabled
                        ? 'Provider off'
                        : isWorkflowLaunchableRuntime(runtime)
                          ? 'Quick sessions and flow runs'
                          : 'Quick sessions only'}
                    </span>
                  </button>
                );
              })}
            </div>
            {!runtimeIsWorkflowCapable && (
              <p
                data-testid="default-agent-runtime-workflow-note"
                className="text-xs text-status-warning mt-2"
              >
                Applies to quick sessions only. Flow runs cannot use{' '}
                {defaultAgentRuntime === undefined
                  ? 'this runtime'
                  : runTypeValueLabel('agentRuntime', defaultAgentRuntime)}
                , so they will ignore this setting and start on their own default runtime.
              </p>
            )}
            <p className="text-xs text-text-tertiary mt-2">
              Seeds both quick sessions and flow runs; a per-session-type override (below) or a runtime
              picked at launch still wins. Choosing a Claude runtime also decides that launch's
              substrate — "Claude Interactive (CLI)" runs on the terminal and "Claude SDK" in-process — which
              outranks the "Quick Session Runtime" setting below. Leave this on "Built-in default" for
              that setting to decide the substrate.
            </p>
          </SettingsSection>

          {/* The GLOBAL model rung. "Built-in default" is not a value — it CLEARS
              the field, so the ladder falls through to the per-kind floor
              (DEFAULT_RUN_TYPE_MODEL_FLOORS). Absent must stay distinguishable
              from a set value, hence the explicit choice rather than preselecting
              a model. Options come from the launch pickers' own lists — the
              Claude aliases (MODEL_OPTIONS), the Codex catalog, or the OMP
              catalog — never a second hand-written list.

              OMP gets the shared grouped <ModelSelector> rather than this button
              list because it is a fundamentally different SIZE of catalog: OMP
              fronts many vendors (495 models on the author's host, across
              anthropic / openai-codex / openrouter), so a button per model would
              be an unusable wall. The button list stays for Claude (6 pinned
              aliases) and Codex (~7). */}
          <SettingsSection
            title="Default Launch Model"
            description="Which model a new quick session or flow run starts on"
            icon={<Cpu className="w-4 h-4" />}
          >
            {usesOmp ? (
              <div data-testid="default-launch-model-omp">
                <ModelSelector
                  id="default-launch-model-omp-select"
                  label="Model"
                  value={defaultLaunchModel}
                  onChange={handleLaunchModelPick}
                  agentProvider="omp"
                  {...(defaultAgentRuntime ? { agentRuntime: defaultAgentRuntime } : {})}
                  allowDefaultOption={{ label: 'Built-in default — OMP picks' }}
                />
              </div>
            ) : (
            <div className="flex flex-col gap-1.5">
              <button
                type="button"
                data-testid="default-launch-model-unset"
                onClick={() => handleLaunchModelPick('')}
                aria-pressed={defaultLaunchModel === ''}
                className={`flex items-center justify-between gap-3 px-3 py-2 rounded-button border transition-colors text-left ${
                  defaultLaunchModel === ''
                    ? 'border-interactive bg-interactive-surface'
                    : 'border-border-secondary bg-surface-secondary hover:bg-surface-hover'
                }`}
              >
                <span className="text-text-primary font-medium text-sm">Built-in default</span>
                <span className="text-xs text-text-tertiary">Let each launch kind use its own floor</span>
              </button>
              {modelOptions.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  data-testid={`default-launch-model-${option.id}`}
                  onClick={() => handleLaunchModelPick(option.id)}
                  aria-pressed={defaultLaunchModel === option.id}
                  className={`flex items-center justify-between gap-3 px-3 py-2 rounded-button border transition-colors text-left ${
                    defaultLaunchModel === option.id
                      ? 'border-interactive bg-interactive-surface'
                      : 'border-border-secondary bg-surface-secondary hover:bg-surface-hover'
                  }`}
                >
                  <span className="text-text-primary font-medium text-sm">{option.label}</span>
                  <span className="text-xs text-text-tertiary">{option.hint}</span>
                </button>
              ))}
              {usesCodex && codexCatalogLoading && (
                <p
                  className="text-xs text-text-tertiary px-3 py-2"
                  data-testid="default-launch-model-codex-loading"
                >
                  Loading Codex models…
                </p>
              )}
              {usesCodex && codexCatalogError !== null && (
                <p
                  className="text-xs text-status-warning px-3 py-2"
                  data-testid="default-launch-model-codex-error"
                  role="alert"
                >
                  Couldn't load the Codex model list ({codexCatalogError}). Only Auto/default is
                  available until it loads.
                </p>
              )}
              {codexCatalogEmpty && codexCatalogError === null && (
                <p
                  className="text-xs text-text-tertiary px-3 py-2"
                  data-testid="default-launch-model-codex-empty"
                >
                  The Codex CLI reported no models, so only Auto/default is available.
                </p>
              )}
            </div>
            )}
            <p className="text-xs text-text-tertiary mt-2">
              Seeds both quick sessions and flow runs. A per-session-type override (below) still wins,
              and so does a model picked in the launch wizard. On "Built-in default" nothing is stored:
              quick sessions and flow runs each fall back to their own built-in model
              {usesOmp ? ', and OMP starts on its own default' : ''}. The list follows the agent
              runtime above — switching to a Codex or OMP runtime offers that provider's models and
              moves a Claude model off, since a model can only start on its own provider.
            </p>
          </SettingsSection>

          <SettingsSection
            title="Workflow Orchestration"
            description="Who walks a flow run's steps — the classic orchestrator or the programmatic host loop"
            icon={<Zap className="w-4 h-4" />}
          >
            <div className="flex flex-col gap-1.5">
              {([
                { model: 'programmatic', label: 'Programmatic', hint: 'Default · in-process host walks the DAG' },
                { model: 'orchestrated', label: 'Orchestrated', hint: 'Classic orchestrator-driven steps' },
              ] as const).map(({ model, label, hint }) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => {
                    onDefaultExecutionModelChange(model);
                    trackEvent('execution_model_default_changed', { executionModel: model });
                  }}
                  aria-pressed={defaultExecutionModel === model}
                  className={`flex items-center justify-between gap-3 px-3 py-2 rounded-button border transition-colors text-left ${
                    defaultExecutionModel === model
                      ? 'border-interactive bg-interactive-surface'
                      : 'border-border-secondary bg-surface-secondary hover:bg-surface-hover'
                  }`}
                >
                  <span className="text-text-primary font-medium text-sm">{label}</span>
                  <span className="text-xs text-text-tertiary">{hint}</span>
                </button>
              ))}
            </div>
            <p className="text-xs text-text-tertiary mt-2">
              "Programmatic" hands new SDK flow runs to the in-process host loop, which walks the
              run's steps deterministically instead of the classic orchestrator. Every programmatic
              run always includes a chat supervisor you can query mid-run; escalations always go to
              the human review queue and are also surfaced in chat. Only affects SDK runs started
              after you save — the interactive terminal substrate always runs orchestrated.
            </p>
          </SettingsSection>

          <SettingsSection
            title="Sprint Batch Size"
            description="How many tasks may be selected into a single sprint run, per runtime"
            icon={<Layers className="w-4 h-4" />}
          >
            <div className="flex flex-wrap gap-4">
              {([
                {
                  id: 'sprintMaxTasksSdk',
                  label: 'SDK',
                  value: sprintMaxTasksSdk,
                  onChange: onSprintMaxTasksSdkChange,
                  substrate: 'sdk',
                },
                {
                  id: 'sprintMaxTasksInteractive',
                  label: 'Interactive terminal',
                  value: sprintMaxTasksInteractive,
                  onChange: onSprintMaxTasksInteractiveChange,
                  substrate: 'interactive',
                },
              ] as const).map(({ id, label, value, onChange, substrate }) => (
                <div key={id} className="flex flex-col">
                  <label htmlFor={id} className="block text-sm text-text-secondary mb-1">
                    {label}
                  </label>
                  <input
                    id={id}
                    data-testid={id}
                    type="number"
                    step={1}
                    /* Deliberately NO min/max attributes: native constraint
                       validation would block the WHOLE Settings form (every tab)
                       on an out-of-range entry in this one field. The save path
                       clamps instead, and the IPC boundary clamps again. */
                    value={value}
                    onChange={(e) => onChange(e.target.value === '' ? '' : e.target.valueAsNumber)}
                    className="w-28 px-3 py-2 border border-border-primary rounded-md focus:outline-none focus:ring-2 focus:ring-interactive text-text-primary bg-surface-secondary"
                  />
                  <span className="text-xs text-text-tertiary mt-1">
                    Default {SPRINT_BATCH_MAX_TASKS_DEFAULTS[substrate]}
                  </span>
                </div>
              ))}
            </div>
            <p className="text-xs text-text-tertiary mt-2">
              The cap the sprint task picker enforces (and the launch seams re-check) when you
              multi-select tasks for one sprint run. It bounds how much ONE run takes on, not how many
              tasks execute at once — parallel task agents stay capped at {SPRINT_BATCH_CAP}. Raise it
              when context pressure is not the limiting factor (programmatic runs walk the DAG in the
              host loop rather than through a single orchestrator's context). Values are clamped to{' '}
              {SPRINT_MAX_TASKS_MIN}–{SPRINT_MAX_TASKS_MAX}; leaving a field empty restores its
              default.
            </p>
          </SettingsSection>

          <SettingsSection
            title="Quick Sessions"
            description="Where a new quick session works — an isolated git worktree or your project checkout"
            icon={<FolderOpen className="w-4 h-4" />}
          >
            <div className="flex flex-col gap-1.5">
              {([
                { mode: 'worktree', label: 'Own worktree (default)', hint: 'Isolated git worktree' },
                { mode: 'in-place', label: 'Project checkout (in place)', hint: 'Work directly in your checkout' },
              ] as const).map(({ mode, label, hint }) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => {
                    onQuickSessionWorktreeModeChange(mode);
                    trackEvent('quick_worktree_mode_default_changed', { mode });
                  }}
                  aria-pressed={quickSessionWorktreeMode === mode}
                  className={`flex items-center justify-between gap-3 px-3 py-2 rounded-button border transition-colors text-left ${
                    quickSessionWorktreeMode === mode
                      ? 'border-interactive bg-interactive-surface'
                      : 'border-border-secondary bg-surface-secondary hover:bg-surface-hover'
                  }`}
                >
                  <span className="text-text-primary font-medium text-sm">{label}</span>
                  <span className="text-xs text-text-tertiary">{hint}</span>
                </button>
              ))}
            </div>
            <p className="text-xs text-text-tertiary mt-2">
              "Project checkout (in place)" starts new quick sessions directly in your working copy —
              no worktree, no isolation. It works with both the SDK and interactive terminal runtimes,
              commit automation stays off, and a workflow launched from an in-place session opens in a
              separate worktree-backed session. Only affects sessions created after you save; you can
              override this per session in the launch wizard's Advanced options.
            </p>
          </SettingsSection>

          <SettingsSection
            title="Quick Session Runtime"
            description="Which CLI substrate a new quick session starts on — the live terminal or the SDK"
            icon={<Terminal className="w-4 h-4" />}
          >
            <div className="flex flex-col gap-1.5">
              {([
                { substrate: 'interactive', label: 'Interactive terminal (default)', hint: 'Live CLI — full REPL' },
                { substrate: 'sdk', label: 'SDK', hint: 'In-process Agent SDK' },
              ] as const).map(({ substrate, label, hint }) => (
                <button
                  key={substrate}
                  type="button"
                  onClick={() => {
                    onQuickSessionDefaultSubstrateChange(substrate);
                    trackEvent('quick_substrate_default_changed', { substrate });
                  }}
                  aria-pressed={quickSessionDefaultSubstrate === substrate}
                  className={`flex items-center justify-between gap-3 px-3 py-2 rounded-button border transition-colors text-left ${
                    quickSessionDefaultSubstrate === substrate
                      ? 'border-interactive bg-interactive-surface'
                      : 'border-border-secondary bg-surface-secondary hover:bg-surface-hover'
                  }`}
                >
                  <span className="text-text-primary font-medium text-sm">{label}</span>
                  <span className="text-xs text-text-tertiary">{hint}</span>
                </button>
              ))}
            </div>
            <p className="text-xs text-text-tertiary mt-2">
              Sets which runtime a new quick session starts on. The interactive terminal is the default —
              a full live REPL. This seeds the launch wizard's substrate picker; you can still switch it
              per session. The global "Interactive CLI only" lock and demo mode override this. Workflow
              runs use the separate default above and are unaffected.
            </p>
          </SettingsSection>

          {/* Stays whole in Session settings (sub-toggle included): the launch
              wizard already carries a real per-run "Quality eval" override, the
              same shape as the other session knobs in this group. */}
          <SettingsSection
            title="Code Review Eval"
            description="Automatic LLM-jury quality assessment of a flow's diff at the review step"
            icon={<ShieldCheck className="w-4 h-4" />}
          >
            <div className="flex flex-col gap-1.5">
              {([
                { enabled: true, label: 'On', hint: 'Default · grade every built-in flow run' },
                { enabled: false, label: 'Off', hint: 'Skip the jury pass — no eval cost' },
              ] as const).map(({ enabled, label, hint }) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => onCodeReviewEvalEnabledChange(enabled)}
                  aria-pressed={codeReviewEvalEnabled === enabled}
                  className={`flex items-center justify-between gap-3 px-3 py-2 rounded-button border transition-colors text-left ${
                    codeReviewEvalEnabled === enabled
                      ? 'border-interactive bg-interactive-surface'
                      : 'border-border-secondary bg-surface-secondary hover:bg-surface-hover'
                  }`}
                >
                  <span className="text-text-primary font-medium text-sm">{label}</span>
                  <span className="text-xs text-text-tertiary">{hint}</span>
                </button>
              ))}
            </div>
            <p className="text-xs text-text-tertiary mt-2">
              When a built-in flow (Sprint / Ship) reaches its human-review step, Cyboflow can run a
              Three-slot jury pass (two Opus + one Codex) over the run's diff and file any findings into the review queue. Each
              eval uses real model calls. Turn it off to skip it globally; a per-run "Quality
              eval" override in the launch wizard's Advanced options can force it on or off for a single
              run.
            </p>

            <div className="mt-4 border-t border-border-secondary pt-4">
              <Checkbox
                label="Auto-grade variant & experiment runs"
                checked={autoGradeVariantRuns}
                onChange={(e) => onAutoGradeVariantRunsChange(e.target.checked)}
              />
              <p className="text-xs text-text-tertiary mt-1">
                Extends the jury pass to workflow-variant runs (rotation) and side-by-side A/B
                experiment arms — a per-arm rubric score plus, for experiments, a pairwise judge
                verdict. Default on. Turning it off stops the extra judge cost from activating
                variants or running an A/B test, without touching the global toggle above.
              </p>
            </div>
          </SettingsSection>
        </section>

        {/* Per-run-type overrides land here, directly below Global defaults.
            This one IS self-fetching (workflow rows + config) and writes through
            the dedicated `applyRunTypeDefault` IPC op rather than this group's
            props-in/callback-out contract — see RunTypeOverrideDetail's module
            doc for why Settings.tsx's shared handleSubmit is the wrong channel. */}
        <RunTypeOverridesSection />
      </CollapsibleCard>
    </section>
  );
}
