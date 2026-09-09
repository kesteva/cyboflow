/**
 * Settings AI tab — the sections live in two top-level groups inside the SAME
 * tab: "Feature controls" (is the capability available at all) and "Session
 * settings" (what a new session or run starts with). This pins the user-approved,
 * frozen membership of each group — an earlier decomposition pass inverted three
 * rows — plus zero content loss, the surviving `initialTab: 'ai'` entry point,
 * and the unchanged single `API.config.update` round trip (the groups are
 * props-in/callback-out containers over Settings.tsx's lifted state, NOT
 * self-fetching panels like IntegrationsSettings).
 *
 * The two global launch defaults (model + agent runtime) were added to Session
 * settings, taking the original 12 sections to 14; they are the same class as
 * "Agent Permission Mode" (what a launch starts with), not a capability gate.
 * "Sprint Batch Size" (the per-substrate sprint task cap, previously the
 * hardcoded SPRINT_BATCH_MAX_TASKS map) makes 15 — same class again: it bounds
 * what one run starts with, it does not gate a capability.
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { Settings } from '../../Settings';
import type { AppConfig } from '../../../types/config';
import {
  SPRINT_BATCH_MAX_TASKS_DEFAULTS,
  SPRINT_MAX_TASKS_MAX,
} from '../../../../../shared/types/sprintBatch';

const configGet = vi.fn();
const configUpdate = vi.fn();
const getVersionInfo = vi.fn();
const projectsGetAll = vi.fn();

vi.mock('../../../utils/api', () => ({
  API: {
    config: {
      get: (...a: unknown[]) => configGet(...a),
      update: (...a: unknown[]) => configUpdate(...a),
    },
    projects: {
      getAll: (...a: unknown[]) => projectsGetAll(...a),
    },
    getVersionInfo: (...a: unknown[]) => getVersionInfo(...a),
  },
}));

vi.mock('../../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: 'paper', setTheme: vi.fn() }),
}));

vi.mock('../../../stores/configStore', () => ({
  useConfigStore: () => ({ fetchConfig: vi.fn().mockResolvedValue(undefined) }),
}));

/**
 * The Codex model catalog the Default-Launch-Model picker reads under a Codex
 * global runtime — faked at the store so the option set is deterministic (the
 * real one fetches `model/list` off the bundled runtime, which this file's API
 * mock does not carry).
 */
const CODEX_MODEL_OPTIONS = [
  { id: 'auto', label: 'Auto/default', description: 'Use the Codex runtime default', isDefault: false },
  { id: 'gpt-5-codex', label: 'GPT-5 Codex', description: 'Codex-tuned', isDefault: true },
];

vi.mock('../../../stores/codexModelCatalogStore', () => ({
  useCodexModelCatalog: () => ({
    options: CODEX_MODEL_OPTIONS,
    defaultModel: 'gpt-5-codex',
    loading: false,
    error: null,
  }),
}));

/** Frozen classification — do NOT re-derive from section order. */
const FEATURE_CONTROLS = [
  'Cyboflow Attribution',
  'CLI Runtime',
  'Computed Run Cost',
  'Artifact Commit Location',
  'Visual Verification',
  'Idle Session Review',
] as const;

const SESSION_SETTINGS = [
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

function baseConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    gitRepoPath: '/repo',
    ...over,
  };
}

beforeEach(() => {
  configGet.mockReset().mockResolvedValue({ success: true, data: baseConfig() });
  configUpdate.mockReset().mockResolvedValue({ success: true });
  getVersionInfo.mockReset().mockResolvedValue({ success: true, data: { variant: 'dev' } });
  projectsGetAll.mockReset().mockResolvedValue({ success: true, data: [] });
});

describe('Settings — AI tab groups', () => {
  it("still opens on the AI tab for initialTab: 'ai', and the tab strip is unchanged", async () => {
    render(<Settings isOpen onClose={vi.fn()} initialTab="ai" />);

    expect(await screen.findByTestId('settings-feature-controls')).toBeInTheDocument();
    for (const tab of ['General', 'AI', 'Assistant', 'Integrations', 'Notifications', 'Updates']) {
      expect(screen.getByRole('button', { name: tab })).toBeInTheDocument();
    }
  });

  it('renders both groups as top-level blocks of the AI tab', async () => {
    render(<Settings isOpen onClose={vi.fn()} initialTab="ai" />);

    expect(await screen.findByRole('heading', { name: 'Feature controls', level: 3 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Session settings', level: 3 })).toBeInTheDocument();
  });

  it('renders all 15 sections with zero content loss', async () => {
    render(<Settings isOpen onClose={vi.fn()} initialTab="ai" />);
    await screen.findByTestId('settings-feature-controls');

    for (const title of [...FEATURE_CONTROLS, ...SESSION_SETTINGS]) {
      expect(screen.getByRole('heading', { name: title, level: 4 })).toBeInTheDocument();
    }
  });

  it.each(FEATURE_CONTROLS)('places "%s" in Feature controls only', async (title) => {
    render(<Settings isOpen onClose={vi.fn()} initialTab="ai" />);

    const features = await screen.findByTestId('settings-feature-controls');
    const sessions = screen.getByTestId('settings-session-settings');
    expect(within(features).getByRole('heading', { name: title, level: 4 })).toBeInTheDocument();
    expect(within(sessions).queryByRole('heading', { name: title, level: 4 })).not.toBeInTheDocument();
  });

  it.each(SESSION_SETTINGS)('places "%s" in Session settings only', async (title) => {
    render(<Settings isOpen onClose={vi.fn()} initialTab="ai" />);

    const features = await screen.findByTestId('settings-feature-controls');
    const sessions = screen.getByTestId('settings-session-settings');
    expect(within(sessions).getByRole('heading', { name: title, level: 4 })).toBeInTheDocument();
    expect(within(features).queryByRole('heading', { name: title, level: 4 })).not.toBeInTheDocument();
  });

  it('hangs the Session-settings sections off a "Global defaults" sub-block', async () => {
    render(<Settings isOpen onClose={vi.fn()} initialTab="ai" />);

    const globalDefaults = await screen.findByRole('region', { name: 'Global defaults' });
    for (const title of SESSION_SETTINGS) {
      expect(within(globalDefaults).getByRole('heading', { name: title, level: 4 })).toBeInTheDocument();
    }
  });

  it('saves both groups through the one existing API.config.update round trip', async () => {
    configGet.mockResolvedValue({
      success: true,
      data: baseConfig({
        systemPromptAppend: 'be terse',
        enableCyboflowFooter: false,
        defaultAgentPermissionMode: 'acceptEdits',
        interactivePtyOnly: true,
        defaultExecutionModel: 'orchestrated',
        quickSessionWorktreeMode: 'in-place',
        quickSessionDefaultSubstrate: 'sdk',
        codeReviewEvalEnabled: false,
        autoGradeVariantRuns: false,
        computeCostFromRates: true,
        artifactCommitDir: 'docs/artifacts',
        visualVerify: { enabled: true },
        idleSessionReview: { enabled: false, thresholdMinutes: 11 },
      }),
    });
    render(<Settings isOpen onClose={vi.fn()} initialTab="ai" />);
    await screen.findByTestId('settings-feature-controls');

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(configUpdate).toHaveBeenCalledTimes(1));
    expect(configUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        // Feature controls
        enableCyboflowFooter: false,
        interactivePtyOnly: true,
        computeCostFromRates: true,
        artifactCommitDir: 'docs/artifacts',
        // F9: the fetched config omits autoBootstrapRunbook, so the load
        // fallback floors it to the new default (ON).
        visualVerify: { enabled: true, autoBootstrapRunbook: true },
        idleSessionReview: { enabled: false, thresholdMinutes: 11 },
        // Session settings
        systemPromptAppend: 'be terse',
        defaultAgentPermissionMode: 'acceptEdits',
        defaultExecutionModel: 'orchestrated',
        quickSessionWorktreeMode: 'in-place',
        quickSessionDefaultSubstrate: 'sdk',
        codeReviewEvalEnabled: false,
        autoGradeVariantRuns: false,
      }),
    );
  });

  // The sprint task-selection cap used to be a hardcoded per-substrate map. The
  // inputs must SHOW the effective cap (built-in default when unconfigured), ride
  // the same single config.update round trip as everything else in this group,
  // and never let a typo persist an unusable value — the renderer clamps, and the
  // IPC boundary clamps again.
  describe('sprint batch size', () => {
    it('seeds both inputs from the built-in defaults when nothing is configured', async () => {
      render(<Settings isOpen onClose={vi.fn()} initialTab="ai" />);
      await screen.findByTestId('settings-session-settings');

      expect(screen.getByTestId('sprintMaxTasksSdk')).toHaveValue(
        SPRINT_BATCH_MAX_TASKS_DEFAULTS.sdk,
      );
      expect(screen.getByTestId('sprintMaxTasksInteractive')).toHaveValue(
        SPRINT_BATCH_MAX_TASKS_DEFAULTS.interactive,
      );
    });

    it('seeds from the stored override, per substrate', async () => {
      configGet.mockResolvedValue({
        success: true,
        data: baseConfig({ sprintMaxTasks: { sdk: 40 } }),
      });
      render(<Settings isOpen onClose={vi.fn()} initialTab="ai" />);
      await screen.findByTestId('settings-session-settings');

      expect(screen.getByTestId('sprintMaxTasksSdk')).toHaveValue(40);
      // Not overridden → still the built-in default, not 40.
      expect(screen.getByTestId('sprintMaxTasksInteractive')).toHaveValue(
        SPRINT_BATCH_MAX_TASKS_DEFAULTS.interactive,
      );
    });

    it('carries an edit into the SAME single config.update round trip', async () => {
      render(<Settings isOpen onClose={vi.fn()} initialTab="ai" />);
      await screen.findByTestId('settings-session-settings');

      fireEvent.change(screen.getByTestId('sprintMaxTasksSdk'), { target: { value: '40' } });
      fireEvent.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => expect(configUpdate).toHaveBeenCalledTimes(1));
      expect(configUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          sprintMaxTasks: {
            sdk: 40,
            interactive: SPRINT_BATCH_MAX_TASKS_DEFAULTS.interactive,
          },
        }),
      );
    });

    it('clamps an out-of-range entry and restores the default for a cleared field', async () => {
      render(<Settings isOpen onClose={vi.fn()} initialTab="ai" />);
      await screen.findByTestId('settings-session-settings');

      fireEvent.change(screen.getByTestId('sprintMaxTasksSdk'), { target: { value: '9999' } });
      fireEvent.change(screen.getByTestId('sprintMaxTasksInteractive'), { target: { value: '' } });
      fireEvent.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => expect(configUpdate).toHaveBeenCalledTimes(1));
      expect(configUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          sprintMaxTasks: {
            sdk: SPRINT_MAX_TASKS_MAX,
            interactive: SPRINT_BATCH_MAX_TASKS_DEFAULTS.interactive,
          },
        }),
      );
    });
  });

  // The two global launch defaults are the middle rung of
  // resolveRunTypeLaunchDefaults. They must ride the SAME single config.update
  // round trip as every other control in this group — not a standalone save —
  // and "built-in default" must reach config as `undefined`, since that is the
  // only value the ladder reads as absent and falls through on.
  describe('global launch defaults', () => {
    it('renders the built-in-default state and writes nothing on mount when neither is set', async () => {
      render(<Settings isOpen onClose={vi.fn()} initialTab="ai" />);
      await screen.findByTestId('settings-session-settings');

      expect(screen.getByTestId('default-launch-model-unset')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByTestId('default-agent-runtime-unset')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.queryByTestId('default-agent-runtime-workflow-note')).not.toBeInTheDocument();
      expect(configUpdate).not.toHaveBeenCalled();
    });

    it('loads stored values and round-trips them through API.config.update', async () => {
      configGet.mockResolvedValue({
        success: true,
        data: baseConfig({ defaultLaunchModel: 'sonnet', defaultAgentRuntime: 'claude-interactive' }),
      });
      render(<Settings isOpen onClose={vi.fn()} initialTab="ai" />);
      await screen.findByTestId('settings-session-settings');

      expect(screen.getByTestId('default-launch-model-sonnet')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByTestId('default-agent-runtime-claude-interactive')).toHaveAttribute(
        'aria-pressed',
        'true',
      );

      fireEvent.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => expect(configUpdate).toHaveBeenCalledTimes(1));
      expect(configUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultLaunchModel: 'sonnet',
          defaultAgentRuntime: 'claude-interactive',
        }),
      );
    });

    it('carries a changed model and runtime into the one shared save', async () => {
      render(<Settings isOpen onClose={vi.fn()} initialTab="ai" />);
      await screen.findByTestId('settings-session-settings');

      fireEvent.click(screen.getByTestId('default-launch-model-haiku'));
      fireEvent.click(screen.getByTestId('default-agent-runtime-claude-interactive'));
      fireEvent.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => expect(configUpdate).toHaveBeenCalledTimes(1));
      expect(configUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultLaunchModel: 'haiku',
          defaultAgentRuntime: 'claude-interactive',
        }),
      );
    });

    /**
     * The two halves are ONE setting: a model from the other provider's family
     * cannot launch on the chosen runtime, and this rung feeds every launch with
     * no per-run-type override. The per-run-type editor already refuses the pair;
     * these pin that the global rung refuses it in BOTH edit orders, at the
     * `API.config.update` payload — component state agreeing is not enough, since
     * the payload is what a launch actually reads back.
     */
    describe('cross-family pairs are unsavable', () => {
      it('runtime last: a Claude model picked first moves onto the Codex family', async () => {
        render(<Settings isOpen onClose={vi.fn()} initialTab="ai" />);
        await screen.findByTestId('settings-session-settings');

        fireEvent.click(screen.getByTestId('default-launch-model-haiku'));
        fireEvent.click(screen.getByTestId('default-agent-runtime-codex-pty'));
        fireEvent.click(screen.getByRole('button', { name: /save/i }));

        await waitFor(() => expect(configUpdate).toHaveBeenCalledTimes(1));
        expect(configUpdate).toHaveBeenCalledWith(
          expect.objectContaining({ defaultLaunchModel: 'auto', defaultAgentRuntime: 'codex-pty' }),
        );
      });

      it('model last: with the runtime on Codex, no Claude alias is even offered', async () => {
        render(<Settings isOpen onClose={vi.fn()} initialTab="ai" />);
        await screen.findByTestId('settings-session-settings');

        fireEvent.click(screen.getByTestId('default-agent-runtime-codex-sdk'));
        // The reverse order cannot reassemble the pair: the picker now offers the
        // Codex catalog only.
        expect(screen.queryByTestId('default-launch-model-opus')).not.toBeInTheDocument();
        fireEvent.click(screen.getByTestId('default-launch-model-gpt-5-codex'));
        fireEvent.click(screen.getByRole('button', { name: /save/i }));

        await waitFor(() => expect(configUpdate).toHaveBeenCalledTimes(1));
        expect(configUpdate).toHaveBeenCalledWith(
          expect.objectContaining({
            defaultLaunchModel: 'gpt-5-codex',
            defaultAgentRuntime: 'codex-sdk',
          }),
        );
      });

      it('a stored Codex model is cleared when the runtime moves back to Claude', async () => {
        configGet.mockResolvedValue({
          success: true,
          data: baseConfig({ defaultLaunchModel: 'gpt-5-codex', defaultAgentRuntime: 'codex-sdk' }),
        });
        render(<Settings isOpen onClose={vi.fn()} initialTab="ai" />);
        await screen.findByTestId('settings-session-settings');

        fireEvent.click(screen.getByTestId('default-agent-runtime-claude-sdk'));
        fireEvent.click(screen.getByRole('button', { name: /save/i }));

        await waitFor(() => expect(configUpdate).toHaveBeenCalledTimes(1));
        const payload = configUpdate.mock.calls[0][0] as Record<string, unknown>;
        // Cleared, not rewritten to an invented Claude alias — the per-kind floor
        // applies at launch.
        expect(payload).toHaveProperty('defaultLaunchModel', undefined);
        expect(payload).toHaveProperty('defaultAgentRuntime', 'claude-sdk');
      });

      // "Built-in default" survives the coercion: an unset model with a Codex
      // runtime stays unset rather than being pinned to a concrete value.
      it('keeps an unset model unset under a Codex runtime', async () => {
        render(<Settings isOpen onClose={vi.fn()} initialTab="ai" />);
        await screen.findByTestId('settings-session-settings');

        fireEvent.click(screen.getByTestId('default-agent-runtime-codex-sdk'));
        expect(screen.getByTestId('default-launch-model-unset')).toHaveAttribute(
          'aria-pressed',
          'true',
        );
        fireEvent.click(screen.getByRole('button', { name: /save/i }));

        await waitFor(() => expect(configUpdate).toHaveBeenCalledTimes(1));
        const payload = configUpdate.mock.calls[0][0] as Record<string, unknown>;
        expect(payload).toHaveProperty('defaultLaunchModel', undefined);
        expect(payload).toHaveProperty('defaultAgentRuntime', 'codex-sdk');
      });

      // …and the same when the model was explicitly cleared under a Codex runtime.
      it('keeps an explicit "Built-in default" click unset under a Codex runtime', async () => {
        configGet.mockResolvedValue({
          success: true,
          data: baseConfig({ defaultLaunchModel: 'gpt-5-codex', defaultAgentRuntime: 'codex-sdk' }),
        });
        render(<Settings isOpen onClose={vi.fn()} initialTab="ai" />);
        await screen.findByTestId('settings-session-settings');

        fireEvent.click(screen.getByTestId('default-launch-model-unset'));
        fireEvent.click(screen.getByRole('button', { name: /save/i }));

        await waitFor(() => expect(configUpdate).toHaveBeenCalledTimes(1));
        const payload = configUpdate.mock.calls[0][0] as Record<string, unknown>;
        expect(payload).toHaveProperty('defaultLaunchModel', undefined);
        expect(payload).toHaveProperty('defaultAgentRuntime', 'codex-sdk');
      });
    });

    it('clears both back to undefined — never null, never ""', async () => {
      configGet.mockResolvedValue({
        success: true,
        data: baseConfig({ defaultLaunchModel: 'opus', defaultAgentRuntime: 'codex-sdk' }),
      });
      render(<Settings isOpen onClose={vi.fn()} initialTab="ai" />);
      await screen.findByTestId('settings-session-settings');

      fireEvent.click(screen.getByTestId('default-launch-model-unset'));
      fireEvent.click(screen.getByTestId('default-agent-runtime-unset'));
      fireEvent.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => expect(configUpdate).toHaveBeenCalledTimes(1));
      const payload = configUpdate.mock.calls[0][0] as Record<string, unknown>;
      expect(payload).toHaveProperty('defaultLaunchModel', undefined);
      expect(payload).toHaveProperty('defaultAgentRuntime', undefined);
    });

    // The setting is one global field coerced per surface: a quick-only runtime
    // never reaches a flow run, and the control has to say so rather than look
    // effective everywhere.
    it('surfaces the workflow-inapplicable note for a stored quick-only runtime', async () => {
      configGet.mockResolvedValue({
        success: true,
        data: baseConfig({ defaultAgentRuntime: 'codex-pty' }),
      });
      render(<Settings isOpen onClose={vi.fn()} initialTab="ai" />);

      expect(await screen.findByTestId('default-agent-runtime-workflow-note')).toHaveTextContent(
        /quick sessions only/i,
      );
    });

    it('hides a runtime whose provider is switched off', async () => {
      configGet.mockResolvedValue({
        success: true,
        data: baseConfig({ agentProviderAccess: { claude: true, codex: false } }),
      });
      render(<Settings isOpen onClose={vi.fn()} initialTab="ai" />);
      await screen.findByTestId('default-agent-runtime-claude-sdk');

      expect(screen.queryByTestId('default-agent-runtime-codex-sdk')).not.toBeInTheDocument();
      expect(screen.queryByTestId('default-agent-runtime-codex-pty')).not.toBeInTheDocument();
    });

    it('hides an Aria-gated provider\'s runtime even when its access key is stored on', async () => {
      // This picker took the RAW config field, so a stored `pi: true` made
      // pi-sdk a selectable default on an install whose Integrations tab renders
      // no Pi card at all — the user could pick a provider they cannot see or
      // switch off. Access and the Aria gate are separate filters and BOTH have
      // to apply here.
      configGet.mockResolvedValue({
        success: true,
        data: baseConfig({ agentProviderAccess: { claude: true, codex: true, pi: true } }),
      });
      render(<Settings isOpen onClose={vi.fn()} initialTab="ai" />);
      await screen.findByTestId('default-agent-runtime-claude-sdk');

      expect(screen.queryByTestId('default-agent-runtime-pi-sdk')).not.toBeInTheDocument();
      expect(screen.queryByTestId('default-agent-runtime-pi-pty')).not.toBeInTheDocument();
      // Its non-gated siblings are unaffected.
      expect(screen.getByTestId('default-agent-runtime-codex-sdk')).toBeInTheDocument();
    });

    it('offers the Aria-gated runtime once Aria mode is on and it is switched on', async () => {
      configGet.mockResolvedValue({
        success: true,
        data: baseConfig({ ariaMode: true, agentProviderAccess: { claude: true, codex: true, pi: true } }),
      });
      render(<Settings isOpen onClose={vi.fn()} initialTab="ai" />);

      expect(await screen.findByTestId('default-agent-runtime-pi-sdk')).toBeInTheDocument();
    });
  });

  it('carries edits from BOTH groups into the same save', async () => {
    render(<Settings isOpen onClose={vi.fn()} initialTab="ai" />);

    // Feature controls edit …
    fireEvent.click(await screen.findByTestId('computed-run-cost-on'));
    // … and a Session settings edit, in one form.
    fireEvent.click(screen.getByRole('button', { name: /Orchestrated/ }));

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(configUpdate).toHaveBeenCalledTimes(1));
    expect(configUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        computeCostFromRates: true,
        defaultExecutionModel: 'orchestrated',
      }),
    );
  });
});
