/**
 * SessionSettings — the AI tab's "Session settings" group (what a new session or
 * run starts with). Pins the eight sections the user-approved classification
 * assigns to this group, the "Global defaults" sub-block that per-run-type
 * overrides will hang below, and that every control is a pure
 * props-in/callback-out surface (`Settings.tsx` still owns state + the save).
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { SessionSettings } from '../SessionSettings';
import type { SessionSettingsProps } from '../SessionSettings';
import { MODEL_OPTIONS } from '../../cyboflow/unified/ModelPill';
import {
  SESSION_AGENT_RUNTIMES,
  WORKFLOW_AGENT_RUNTIMES,
} from '../../../../../shared/types/agentRuntime';
import { isRuntimeSelectableInPickers } from '../../../../../shared/types/agentCapabilities';
import { SPRINT_BATCH_MAX_TASKS_DEFAULTS } from '../../../../../shared/types/sprintBatch';

vi.mock('../../../utils/telemetry', () => ({
  trackEvent: vi.fn(),
}));

/**
 * The Codex model catalog the Default-Launch-Model picker reads once the global
 * runtime is Codex — faked at the store (the pattern `RunTypeOverridesSection`'s
 * spec uses) so the option set is deterministic; the real store fetches
 * `model/list` off the bundled runtime.
 */
const CODEX_MODEL_OPTIONS = [
  { id: 'auto', label: 'Auto/default', description: 'Use the Codex runtime default', isDefault: false },
  { id: 'gpt-5-codex', label: 'GPT-5 Codex', description: 'Codex-tuned', isDefault: true },
  { id: 'gpt-5', label: 'GPT-5', description: 'General purpose', isDefault: false },
];

/**
 * Mutable so the Codex-catalog states can be exercised. The catalog is fetched
 * from the Codex CLI, so under a Codex runtime the list legitimately holds only
 * the synthetic 'auto' entry while loading, on failure, or when the CLI reports
 * nothing — each of which must read differently in the UI.
 */
const codexCatalogState: {
  options: typeof CODEX_MODEL_OPTIONS;
  loading: boolean;
  error: string | null;
} = { options: CODEX_MODEL_OPTIONS, loading: false, error: null };

function setCodexCatalog(over: Partial<typeof codexCatalogState> = {}): void {
  codexCatalogState.options = over.options ?? CODEX_MODEL_OPTIONS;
  codexCatalogState.loading = over.loading ?? false;
  codexCatalogState.error = over.error ?? null;
}

vi.mock('../../../stores/codexModelCatalogStore', () => ({
  useCodexModelCatalog: () => ({
    options: codexCatalogState.options,
    defaultModel: 'gpt-5-codex',
    loading: codexCatalogState.loading,
    error: codexCatalogState.error,
  }),
}));

/**
 * The OMP catalog, faked the same way. Ids are the canonical `<vendor>/<id>`
 * form `OmpModelOption` composes — the slash is what `isOmpModelFamily` keys on,
 * so a bare id here would silently stop exercising the coercion.
 */
const OMP_MODEL_OPTIONS = [
  { id: 'anthropic/claude-opus-4-5', label: 'claude-opus-4-5', ompProvider: 'anthropic' },
  { id: 'openrouter/qwen3-coder', label: 'qwen3-coder', ompProvider: 'openrouter' },
];

const ompCatalogState: { options: typeof OMP_MODEL_OPTIONS; loading: boolean; error: string | null } =
  { options: OMP_MODEL_OPTIONS, loading: false, error: null };

vi.mock('../../../stores/ompModelCatalogStore', () => ({
  useOmpModelCatalog: () => ({
    options: ompCatalogState.options,
    loading: ompCatalogState.loading,
    error: ompCatalogState.error,
  }),
}));

function renderGroup(over: Partial<SessionSettingsProps> = {}) {
  const props: SessionSettingsProps = {
    globalSystemPrompt: '',
    onGlobalSystemPromptChange: vi.fn(),
    defaultAgentPermissionMode: 'default',
    onDefaultAgentPermissionModeChange: vi.fn(),
    defaultLaunchModel: '',
    onDefaultLaunchModelChange: vi.fn(),
    defaultAgentRuntime: undefined,
    onDefaultAgentRuntimeChange: vi.fn(),
    defaultExecutionModel: 'programmatic',
    onDefaultExecutionModelChange: vi.fn(),
    quickSessionWorktreeMode: 'worktree',
    onQuickSessionWorktreeModeChange: vi.fn(),
    quickSessionDefaultSubstrate: 'interactive',
    onQuickSessionDefaultSubstrateChange: vi.fn(),
    sprintMaxTasksSdk: SPRINT_BATCH_MAX_TASKS_DEFAULTS.sdk,
    onSprintMaxTasksSdkChange: vi.fn(),
    sprintMaxTasksInteractive: SPRINT_BATCH_MAX_TASKS_DEFAULTS.interactive,
    onSprintMaxTasksInteractiveChange: vi.fn(),
    codeReviewEvalEnabled: true,
    onCodeReviewEvalEnabledChange: vi.fn(),
    autoGradeVariantRuns: true,
    onAutoGradeVariantRunsChange: vi.fn(),
    ...over,
  };
  render(<SessionSettings {...props} />);
  return props;
}

/** The frozen membership list for this group (see TASK-158's classification). */
const SESSION_SETTINGS_SECTIONS = [
  'Global Instructions',
  'Agent Permission Mode',
  'Default Launch Model',
  'Default Agent Runtime',
  'Workflow Orchestration',
  'Sprint Batch Size',
  'Quick Sessions',
  'Quick Session Runtime',
  'Code Review Eval',
] as const;

describe('SessionSettings', () => {
  it('renders exactly the eight Session-settings sections', () => {
    renderGroup();

    for (const title of SESSION_SETTINGS_SECTIONS) {
      expect(screen.getByRole('heading', { name: title, level: 4 })).toBeInTheDocument();
    }
  });

  it('carries no Feature-control sections', () => {
    renderGroup();

    for (const title of [
      'Cyboflow Attribution',
      'CLI Runtime',
      'Computed Run Cost',
      'Artifact Commit Location',
      'Visual Verification',
      'Idle Session Review',
    ]) {
      expect(screen.queryByRole('heading', { name: title, level: 4 })).not.toBeInTheDocument();
    }
  });

  it('nests all eight under a "Global defaults" sub-block (per-run-type overrides land below it)', () => {
    renderGroup();

    const globalDefaults = screen.getByRole('region', { name: 'Global defaults' });
    for (const title of SESSION_SETTINGS_SECTIONS) {
      expect(within(globalDefaults).getByRole('heading', { name: title, level: 4 })).toBeInTheDocument();
    }
  });

  // The mount point itself: nothing else in the suite would notice if the
  // overrides section were dropped from this group, since it is self-fetching
  // and takes none of this component's props.
  it('mounts the per-run-type overrides section BELOW the Global defaults sub-block', () => {
    renderGroup();

    const globalDefaults = screen.getByRole('region', { name: 'Global defaults' });
    const overrides = screen.getByRole('region', { name: 'Session type overrides' });

    // A sibling, not a child: it writes through its own IPC op, not this
    // group's props-in/callback-out contract.
    expect(globalDefaults).not.toContainElement(overrides);
    expect(
      globalDefaults.compareDocumentPosition(overrides) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Really mounted, not just a heading: the synthetic quick row always renders
    // even with no config and no workflow rows fetched.
    expect(within(overrides).getByTestId('run-type-row-quick')).toBeInTheDocument();
  });

  it('renders every control the sections own', () => {
    renderGroup({ globalSystemPrompt: 'Always use TypeScript' });

    expect(screen.getByLabelText('Global System Prompt')).toHaveValue('Always use TypeScript');
    expect(screen.getByRole('button', { name: /Ask before edits/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Programmatic/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Own worktree/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Interactive terminal/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /^On/ })).toHaveAttribute('aria-pressed', 'true');
    // The auto-grade sub-toggle stays inside Code Review Eval — not split out.
    expect(screen.getByLabelText('Auto-grade variant & experiment runs')).toBeChecked();
  });

  it('reports every change back through its callback (no local state)', () => {
    const props = renderGroup();

    fireEvent.change(screen.getByLabelText('Global System Prompt'), { target: { value: 'be terse' } });
    expect(props.onGlobalSystemPromptChange).toHaveBeenCalledWith('be terse');

    fireEvent.click(screen.getByRole('button', { name: /Allow edits/ }));
    expect(props.onDefaultAgentPermissionModeChange).toHaveBeenCalledWith('acceptEdits');

    fireEvent.click(screen.getByRole('button', { name: /Orchestrated/ }));
    expect(props.onDefaultExecutionModelChange).toHaveBeenCalledWith('orchestrated');

    fireEvent.click(screen.getByRole('button', { name: /Project checkout/ }));
    expect(props.onQuickSessionWorktreeModeChange).toHaveBeenCalledWith('in-place');

    fireEvent.click(screen.getByRole('button', { name: /^SDK/ }));
    expect(props.onQuickSessionDefaultSubstrateChange).toHaveBeenCalledWith('sdk');

    fireEvent.click(screen.getByRole('button', { name: /^Off/ }));
    expect(props.onCodeReviewEvalEnabledChange).toHaveBeenCalledWith(false);

    fireEvent.click(screen.getByLabelText('Auto-grade variant & experiment runs'));
    expect(props.onAutoGradeVariantRunsChange).toHaveBeenCalledWith(false);
  });

  it('reflects stored non-default values as pressed', () => {
    renderGroup({
      defaultAgentPermissionMode: 'dontAsk',
      defaultExecutionModel: 'orchestrated',
      quickSessionWorktreeMode: 'in-place',
      quickSessionDefaultSubstrate: 'sdk',
      codeReviewEvalEnabled: false,
      autoGradeVariantRuns: false,
    });

    expect(screen.getByRole('button', { name: /Don't ask/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Orchestrated/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Project checkout/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /^SDK/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /^Off/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Auto-grade variant & experiment runs')).not.toBeChecked();
  });

  describe('Default Launch Model', () => {
    it('renders the built-in-default state when nothing is stored', () => {
      renderGroup();

      expect(screen.getByTestId('default-launch-model-unset')).toHaveAttribute('aria-pressed', 'true');
      for (const id of ['fable', 'opus', 'sonnet', 'haiku', 'auto']) {
        expect(screen.getByTestId(`default-launch-model-${id}`)).toHaveAttribute('aria-pressed', 'false');
      }
    });

    // The picker must not grow a second hand-written alias list — every option
    // comes from the launch surfaces' shared MODEL_OPTIONS.
    it("offers exactly the launch surfaces' model options, plus the clear choice", () => {
      renderGroup();

      const rendered = Array.from(
        document.body.querySelectorAll('[data-testid^="default-launch-model-"]'),
      ).map((el) => el.getAttribute('data-testid'));
      expect(rendered).toEqual([
        'default-launch-model-unset',
        ...MODEL_OPTIONS.map((o) => `default-launch-model-${o.id}`),
      ]);
    });

    it('reflects a stored model as pressed and reports a pick back through the callback', () => {
      const props = renderGroup({ defaultLaunchModel: 'sonnet' });

      expect(screen.getByTestId('default-launch-model-sonnet')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByTestId('default-launch-model-unset')).toHaveAttribute('aria-pressed', 'false');

      fireEvent.click(screen.getByTestId('default-launch-model-haiku'));
      expect(props.onDefaultLaunchModelChange).toHaveBeenCalledWith('haiku');
    });

    it('clears back to "" (the absent marker Settings.tsx maps to undefined)', () => {
      const props = renderGroup({ defaultLaunchModel: 'opus' });

      fireEvent.click(screen.getByTestId('default-launch-model-unset'));
      expect(props.onDefaultLaunchModelChange).toHaveBeenCalledWith('');
    });
  });

  /**
   * The two global launch defaults are ONE setting in two halves: a model from
   * the other provider's family cannot launch on the chosen runtime. The
   * per-run-type editor already refuses that pair; this rung feeds every launch
   * WITHOUT a per-type override, so it has to refuse it the same two ways —
   * runtime-scoped options, plus coercion on every edit path.
   */
  describe('runtime/model family agreement', () => {
    /** The model option ids currently rendered, in order. */
    const renderedModelIds = (): string[] =>
      Array.from(document.body.querySelectorAll('[data-testid^="default-launch-model-"]'))
        .map((el) => el.getAttribute('data-testid') ?? '')
        .map((id) => id.replace('default-launch-model-', ''));

    it('offers Claude aliases under a Claude runtime (and while unset)', () => {
      renderGroup({ defaultAgentRuntime: 'claude-interactive' });
      expect(renderedModelIds()).toEqual(['unset', ...MODEL_OPTIONS.map((o) => o.id)]);

      cleanup();
      renderGroup({ defaultAgentRuntime: undefined });
      expect(renderedModelIds()).toEqual(['unset', ...MODEL_OPTIONS.map((o) => o.id)]);
    });

    it.each(['codex-sdk', 'codex-pty'] as const)(
      'offers the Codex catalog under %s — no Claude alias in sight',
      (runtime) => {
        renderGroup({ defaultAgentRuntime: runtime });

        expect(renderedModelIds()).toEqual([
          'unset',
          ...CODEX_MODEL_OPTIONS.map((o) => o.id),
        ]);
        for (const claudeOnly of ['opus', 'sonnet', 'haiku', 'fable']) {
          expect(screen.queryByTestId(`default-launch-model-${claudeOnly}`)).not.toBeInTheDocument();
        }
      },
    );

    // The defect this covers: the Default Launch Model list was Codex/Claude
    // BINARY, so selecting an OMP runtime left the Claude aliases on screen —
    // models an OMP launch drops outright.
    it.each(['omp-sdk', 'omp-pty'] as const)(
      'offers the OMP catalog under %s, grouped by vendor, with no Claude alias in sight',
      (runtime) => {
        renderGroup({ defaultAgentRuntime: runtime });

        const select = screen.getByLabelText('Select OMP model');
        expect([...select.querySelectorAll('option')].map((o) => o.value)).toEqual([
          '',
          ...OMP_MODEL_OPTIONS.map((o) => o.id),
        ]);
        expect([...select.querySelectorAll('optgroup')].map((g) => g.label)).toEqual([
          'anthropic',
          'openrouter',
        ]);
        // The Claude/Codex button list is gone entirely — 495 models is a
        // <select>, not a wall of buttons.
        expect(screen.queryByTestId('default-launch-model-unset')).not.toBeInTheDocument();
        for (const claudeOnly of ['opus', 'sonnet', 'haiku', 'fable']) {
          expect(screen.queryByTestId(`default-launch-model-${claudeOnly}`)).not.toBeInTheDocument();
        }
      },
    );

    it('stores an OMP model pick verbatim in its canonical vendor/model form', () => {
      const props = renderGroup({ defaultAgentRuntime: 'omp-sdk' });

      fireEvent.change(screen.getByLabelText('Select OMP model'), {
        target: { value: 'openrouter/qwen3-coder' },
      });

      expect(props.onDefaultLaunchModelChange).toHaveBeenCalledWith('openrouter/qwen3-coder');
    });

    // "Built-in default" stays reachable on OMP — unlike Codex, whose omitted
    // model would resolve to the Claude floor. OMP's spawn seam drops that
    // floor, so absence genuinely means "OMP picks".
    it('keeps a follow-defaults row on the OMP path and clears to it', () => {
      const props = renderGroup({
        defaultAgentRuntime: 'omp-sdk',
        defaultLaunchModel: 'anthropic/claude-opus-4-5',
      });

      fireEvent.change(screen.getByLabelText('Select OMP model'), { target: { value: '' } });

      expect(props.onDefaultLaunchModelChange).toHaveBeenCalledWith('');
    });

    it('moves a stored Claude model off when the runtime flips to OMP', () => {
      // OMP is absent⇒DISABLED (it postdates the provider toggles), so its
      // runtime row only renders with the toggle explicitly on.
      const props = renderGroup({
        defaultLaunchModel: 'opus',
        agentProviderAccess: { omp: true },
      });

      fireEvent.click(screen.getByTestId('default-agent-runtime-omp-sdk'));

      expect(props.onDefaultAgentRuntimeChange).toHaveBeenCalledWith('omp-sdk');
      // No static OMP id exists to swap in (the catalog is per-host), so the
      // honest degradation is "let OMP choose".
      expect(props.onDefaultLaunchModelChange).toHaveBeenCalledWith('');
    });

    it('moves a stored OMP model off when the runtime flips back to Claude', () => {
      const props = renderGroup({
        defaultLaunchModel: 'openrouter/qwen3-coder',
        defaultAgentRuntime: 'omp-sdk',
        agentProviderAccess: { omp: true },
      });

      fireEvent.click(screen.getByTestId('default-agent-runtime-claude-sdk'));

      expect(props.onDefaultAgentRuntimeChange).toHaveBeenCalledWith('claude-sdk');
      expect(props.onDefaultLaunchModelChange).toHaveBeenCalledWith('');
    });

    // Runtime last — the order two ordinary clicks reach: pick a Claude model,
    // then a Codex runtime.
    it('moves a stored Claude model onto the Codex family when the runtime flips', () => {
      const props = renderGroup({ defaultLaunchModel: 'opus' });

      fireEvent.click(screen.getByTestId('default-agent-runtime-codex-sdk'));

      expect(props.onDefaultAgentRuntimeChange).toHaveBeenCalledWith('codex-sdk');
      expect(props.onDefaultLaunchModelChange).toHaveBeenCalledWith('auto');
    });

    it('clears a stored Codex model when the runtime flips back to Claude', () => {
      const props = renderGroup({ defaultLaunchModel: 'gpt-5-codex', defaultAgentRuntime: 'codex-sdk' });

      fireEvent.click(screen.getByTestId('default-agent-runtime-claude-sdk'));

      expect(props.onDefaultAgentRuntimeChange).toHaveBeenCalledWith('claude-sdk');
      expect(props.onDefaultLaunchModelChange).toHaveBeenCalledWith('');
    });

    // Clearing the runtime is NOT a no-op: every launch kind then falls through
    // to its own (Claude) floor, so a Codex model can no longer launch either.
    it('clears a stored Codex model when the runtime is cleared to "Built-in default"', () => {
      const props = renderGroup({ defaultLaunchModel: 'gpt-5-codex', defaultAgentRuntime: 'codex-pty' });

      fireEvent.click(screen.getByTestId('default-agent-runtime-unset'));

      expect(props.onDefaultAgentRuntimeChange).toHaveBeenCalledWith(undefined);
      expect(props.onDefaultLaunchModelChange).toHaveBeenCalledWith('');
    });

    it('leaves a same-family model untouched on a runtime change', () => {
      const props = renderGroup({ defaultLaunchModel: 'sonnet' });

      fireEvent.click(screen.getByTestId('default-agent-runtime-claude-interactive'));

      expect(props.onDefaultAgentRuntimeChange).toHaveBeenCalledWith('claude-interactive');
      expect(props.onDefaultLaunchModelChange).not.toHaveBeenCalled();
    });

    // Model last — the reverse order. A same-family pick rides through verbatim.
    it('reports a Codex model verbatim under a Codex runtime', () => {
      const props = renderGroup({ defaultAgentRuntime: 'codex-sdk' });

      fireEvent.click(screen.getByTestId('default-launch-model-gpt-5-codex'));
      expect(props.onDefaultLaunchModelChange).toHaveBeenCalledWith('gpt-5-codex');
    });

    // "Built-in default" must survive BOTH halves: clearing the model under a
    // Codex runtime stays cleared (the floor applies at launch), and flipping
    // the runtime while the model is unset invents nothing.
    it('never turns "Built-in default" into a concrete model', () => {
      const props = renderGroup({ defaultAgentRuntime: 'codex-sdk' });

      fireEvent.click(screen.getByTestId('default-launch-model-unset'));
      expect(props.onDefaultLaunchModelChange).toHaveBeenCalledWith('');

      cleanup();
      const next = renderGroup({ defaultLaunchModel: '' });
      fireEvent.click(screen.getByTestId('default-agent-runtime-codex-pty'));
      expect(next.onDefaultAgentRuntimeChange).toHaveBeenCalledWith('codex-pty');
      expect(next.onDefaultLaunchModelChange).not.toHaveBeenCalled();
    });
  });

  describe('Default Agent Runtime', () => {
    it('renders the built-in-default state and every OFFERABLE session runtime', () => {
      // All three providers switched on, so the capability filter is the only
      // thing deciding which session runtimes get a button.
      renderGroup({ agentProviderAccess: { claude: true, codex: true, omp: true, pi: true } });

      expect(screen.getByTestId('default-agent-runtime-unset')).toHaveAttribute('aria-pressed', 'true');
      // Session membership is necessary but not sufficient: the control shows a
      // session runtime only when a picker may offer it at all.
      for (const runtime of SESSION_AGENT_RUNTIMES) {
        const button = screen.queryByTestId(`default-agent-runtime-${runtime}`);
        if (!isRuntimeSelectableInPickers(runtime)) {
          expect(button).not.toBeInTheDocument();
          continue;
        }
        expect(button).toHaveAttribute('aria-pressed', 'false');
      }
    });

    // codex-exec is headless — it reaches no launch picker, so it must not be
    // offered here even though it is a member of ALL_AGENT_RUNTIMES.
    it('never offers codex-exec', () => {
      renderGroup();

      expect(screen.queryByTestId('default-agent-runtime-codex-exec')).not.toBeInTheDocument();
    });

    // OMP is picker-selectable since the visibility flip, but its absent access
    // key floors to DISABLED — an install that never opted in must not offer it
    // as a default runtime.
    it('hides the OMP runtimes until the provider is switched on', () => {
      renderGroup();

      expect(screen.queryByTestId('default-agent-runtime-omp-sdk')).not.toBeInTheDocument();
      expect(screen.queryByTestId('default-agent-runtime-omp-pty')).not.toBeInTheDocument();
    });

    it('reports a pick, and clears to undefined (not null, not "")', () => {
      const props = renderGroup({ defaultAgentRuntime: 'claude-interactive' });

      expect(screen.getByTestId('default-agent-runtime-claude-interactive')).toHaveAttribute(
        'aria-pressed',
        'true',
      );

      fireEvent.click(screen.getByTestId('default-agent-runtime-codex-sdk'));
      expect(props.onDefaultAgentRuntimeChange).toHaveBeenCalledWith('codex-sdk');

      fireEvent.click(screen.getByTestId('default-agent-runtime-unset'));
      expect(props.onDefaultAgentRuntimeChange).toHaveBeenLastCalledWith(undefined);
    });

    // The whole point of the note: one global field, coerced per surface. A
    // quick-only runtime is DROPPED by a flow launch, and the control says so.
    it('flags a quick-only runtime as inapplicable to flow runs', () => {
      renderGroup({ defaultAgentRuntime: 'codex-pty' });

      const note = screen.getByTestId('default-agent-runtime-workflow-note');
      expect(note).toHaveTextContent(/quick sessions only/i);
      expect(note).toHaveTextContent(/Codex \(CLI\)/);
    });

    it.each(WORKFLOW_AGENT_RUNTIMES)('renders no note for the workflow-valid runtime %s', (runtime) => {
      renderGroup({ defaultAgentRuntime: runtime });

      expect(screen.queryByTestId('default-agent-runtime-workflow-note')).not.toBeInTheDocument();
    });

    it('renders no note while following the built-in default', () => {
      renderGroup({ defaultAgentRuntime: undefined });

      expect(screen.queryByTestId('default-agent-runtime-workflow-note')).not.toBeInTheDocument();
    });

    it('drops runtimes whose provider is switched off', () => {
      renderGroup({ agentProviderAccess: { claude: true, codex: false } });

      expect(screen.getByTestId('default-agent-runtime-claude-sdk')).toBeEnabled();
      expect(screen.getByTestId('default-agent-runtime-claude-interactive')).toBeEnabled();
      expect(screen.queryByTestId('default-agent-runtime-codex-sdk')).not.toBeInTheDocument();
      expect(screen.queryByTestId('default-agent-runtime-codex-pty')).not.toBeInTheDocument();
    });

    // A stored value on a now-off provider stays VISIBLE (it is still what the
    // launch resolves) but is not selectable — the user clears it instead.
    it('keeps a stored runtime on a disabled provider visible but unselectable', () => {
      const props = renderGroup({
        defaultAgentRuntime: 'codex-sdk',
        agentProviderAccess: { claude: true, codex: false },
      });

      const button = screen.getByTestId('default-agent-runtime-codex-sdk');
      expect(button).toBeDisabled();
      expect(button).toHaveTextContent(/provider off/i);

      fireEvent.click(button);
      expect(props.onDefaultAgentRuntimeChange).not.toHaveBeenCalled();
    });
  });

  describe('runtime precedes model, and the Codex catalog states are legible', () => {
    // The model list is DERIVED from the runtime, so the runtime has to be the
    // earlier choice. With model first a user picks it before the runtime that
    // decides which options are even valid, and the help text has to point
    // backwards to explain itself.
    it('renders Default Agent Runtime BEFORE Default Launch Model', () => {
      renderGroup();

      const html = document.body.innerHTML;
      expect(html.indexOf('Default Agent Runtime')).toBeGreaterThan(-1);
      expect(html.indexOf('Default Launch Model')).toBeGreaterThan(-1);
      expect(html.indexOf('Default Agent Runtime')).toBeLessThan(
        html.indexOf('Default Launch Model'),
      );
    });

    it('offers the Codex catalog under a Codex runtime and Claude aliases otherwise', () => {
      setCodexCatalog();
      renderGroup({ defaultAgentRuntime: 'codex-sdk' });
      expect(screen.getByTestId('default-launch-model-gpt-5-codex')).toBeInTheDocument();
      expect(screen.queryByTestId('default-launch-model-opus')).not.toBeInTheDocument();

      cleanup();
      renderGroup({ defaultAgentRuntime: 'claude-sdk' });
      expect(screen.getByTestId('default-launch-model-opus')).toBeInTheDocument();
      expect(screen.queryByTestId('default-launch-model-gpt-5-codex')).not.toBeInTheDocument();
    });

    it('says it is loading rather than showing a bare Auto-only list', () => {
      setCodexCatalog({ options: [CODEX_MODEL_OPTIONS[0]], loading: true });
      renderGroup({ defaultAgentRuntime: 'codex-sdk' });

      expect(screen.getByTestId('default-launch-model-codex-loading')).toBeInTheDocument();
      expect(screen.queryByTestId('default-launch-model-codex-empty')).not.toBeInTheDocument();
      setCodexCatalog();
    });

    it('surfaces a catalog failure instead of silently offering only Auto', () => {
      setCodexCatalog({ options: [CODEX_MODEL_OPTIONS[0]], error: 'codex CLI not found' });
      renderGroup({ defaultAgentRuntime: 'codex-sdk' });

      const alert = screen.getByTestId('default-launch-model-codex-error');
      expect(alert).toHaveTextContent(/codex CLI not found/);
      // The failure explains itself; it must not ALSO claim the CLI reported none.
      expect(screen.queryByTestId('default-launch-model-codex-empty')).not.toBeInTheDocument();
      setCodexCatalog();
    });

    it('says so when the CLI genuinely reports no models', () => {
      setCodexCatalog({ options: [CODEX_MODEL_OPTIONS[0]] });
      renderGroup({ defaultAgentRuntime: 'codex-sdk' });

      expect(screen.getByTestId('default-launch-model-codex-empty')).toBeInTheDocument();
      setCodexCatalog();
    });

    it('shows none of those notes under a Claude runtime', () => {
      renderGroup({ defaultAgentRuntime: 'claude-sdk' });

      expect(screen.queryByTestId('default-launch-model-codex-loading')).not.toBeInTheDocument();
      expect(screen.queryByTestId('default-launch-model-codex-error')).not.toBeInTheDocument();
      expect(screen.queryByTestId('default-launch-model-codex-empty')).not.toBeInTheDocument();
    });
  });
});
