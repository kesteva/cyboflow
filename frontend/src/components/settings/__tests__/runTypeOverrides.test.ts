/**
 * runTypeOverrides — the pure rules behind the session-type override list.
 *
 * These pin the two things the rendered list depends on and that no snapshot
 * would catch: the per-key BASELINES (which must match what the launch surfaces
 * resolve, or the list invents overrides that do not exist) and the merge patch
 * shape (which must send explicit nulls so ConfigManager can merge a key to
 * empty and delete it).
 */
import { describe, it, expect } from 'vitest';
import {
  QUICK_RUN_TYPE_KEY,
  RUN_TYPE_FIELD_ORDER,
  agentRuntimeOptions,
  agentRuntimePickerOptions,
  runtimeUnavailableReason,
  baselineValueFor,
  buildRunTypeGroups,
  coerceDraftForModel,
  coerceDraftForRuntime,
  coerceDraftForSubstrate,
  coerceGlobalLaunchModel,
  draftFromStored,
  draftRuntimeProvider,
  effectiveRuntimeForDraft,
  globalRuntimeProvider,
  isQuickRunTypeKey,
  patchFromDraft,
  resolveRunTypeBaseline,
  runTypeOverrideChips,
  runTypeStatusLabel,
  runTypeValueLabel,
  workflowRunTypeKey,
  type RunTypeDraft,
  type RunTypeWorkflowSource,
} from '../runTypeOverrides';
import {
  SESSION_AGENT_RUNTIMES,
  claudeRuntimeFromSubstrate,
  substrateForRuntime,
  type AgentRuntime,
} from '../../../../../shared/types/agentRuntime';
import {
  isCodexModelFamily,
  isCodexModelSelection,
  isOmpModelFamily,
} from '../../../../../shared/types/agentModels';
import {
  resolveRunTypeLaunchDefaults,
  type RunTypeDefaults,
} from '../../../../../shared/types/sessionDefaults';
import type { CliSubstrate } from '../../../../../shared/types/substrate';
import type { AppConfig } from '../../../types/config';
import type { WorkflowRow } from '../../../../../shared/types/workflows';

function wf(id: string, name: string, projectName = '', projectId: number | null = null): RunTypeWorkflowSource {
  const row: WorkflowRow = {
    id,
    project_id: projectId,
    name,
    workflow_path: null,
    permission_mode: 'default',
    spec_json: '{}',
    created_at: '2026-01-01T00:00:00Z',
    archived_at: null,
  };
  return { row, projectName };
}

const NO_CONFIG: AppConfig = { gitRepoPath: '/repo' };

describe('resolveRunTypeBaseline', () => {
  it('floors a flow key to the workflow launch defaults (Opus / SDK / claude-sdk / default)', () => {
    expect(resolveRunTypeBaseline('workflow:wf-1', NO_CONFIG)).toEqual({
      model: 'opus',
      substrate: 'sdk',
      agentRuntime: 'claude-sdk',
      permissionMode: 'default',
    });
  });

  // THE unanimous defect (COR-8). This used to assert `agentRuntime:
  // 'claude-sdk'` NEXT TO `substrate: 'interactive'` — a pair no launch can
  // honour, on a DEFAULT INSTALL, seeded straight into the detail screen's draft
  // by `toggleCard`. The baseline now delegates to the shared resolver, and the
  // runtime is projected from the resolved substrate, so the two agree.
  it('floors the quick key to the quick-session launch defaults (Opus / interactive)', () => {
    expect(resolveRunTypeBaseline(QUICK_RUN_TYPE_KEY, NO_CONFIG)).toEqual({
      model: 'opus',
      substrate: 'interactive',
      agentRuntime: 'claude-interactive',
      permissionMode: 'default',
    });
  });

  it('honors the global config knobs the launch surfaces read', () => {
    const config: AppConfig = {
      gitRepoPath: '/repo',
      defaultAgentPermissionMode: 'dontAsk',
      quickSessionDefaultSubstrate: 'sdk',
    };
    expect(resolveRunTypeBaseline(QUICK_RUN_TYPE_KEY, config).substrate).toBe('sdk');
    expect(resolveRunTypeBaseline(QUICK_RUN_TYPE_KEY, config).permissionMode).toBe('dontAsk');
    // The runtime moves WITH the substrate — a configured SDK quick preference
    // makes 'claude-sdk' the baseline runtime, not just the baseline transport.
    expect(resolveRunTypeBaseline(QUICK_RUN_TYPE_KEY, config).agentRuntime).toBe('claude-sdk');
    // quickSessionDefaultSubstrate governs QUICK only — a flow key keeps 'sdk'
    // via DEFAULT_SUBSTRATE, and the permission knob is shared by both.
    expect(resolveRunTypeBaseline('workflow:wf-1', config).substrate).toBe('sdk');
    expect(resolveRunTypeBaseline('workflow:wf-1', config).permissionMode).toBe('dontAsk');
  });

  it('tolerates a null config (the modal renders before the first fetch resolves)', () => {
    expect(resolveRunTypeBaseline(QUICK_RUN_TYPE_KEY, null).permissionMode).toBe('default');
  });

  // AC 1 — the whole point of delegating: there is no config, stored or global,
  // that can make the baseline describe an unlaunchable pair.
  it('never returns a runtime/substrate pair that disagree, for any key or config', () => {
    const keys = [QUICK_RUN_TYPE_KEY, 'workflow:wf-1', 'workflow:wf-archived-77'];
    const configs: (AppConfig | null)[] = [
      null,
      NO_CONFIG,
      { gitRepoPath: '/repo', quickSessionDefaultSubstrate: 'sdk' },
      { gitRepoPath: '/repo', quickSessionDefaultSubstrate: 'interactive' },
      { gitRepoPath: '/repo', defaultAgentPermissionMode: 'dontAsk' },
    ];
    for (const key of keys) {
      for (const config of configs) {
        const baseline = resolveRunTypeBaseline(key, config);
        expect(substrateForRuntime(baseline.agentRuntime)).toBe(baseline.substrate);
      }
    }
  });

  /**
   * The SAME invariant one rung down, on the composition every launch seam now
   * uses: `resolveRunTypeLaunchDefaults` with the per-surface default routed
   * through the SUBSTRATE rung, then inverted back to a runtime with
   * `claudeRuntimeFromSubstrate` when nothing is stored. Routing that default
   * through the `agentRuntime` rung instead is what produced a contradictory
   * pair from either side:
   *   - a stored substrate with no runtime kept the SYNTHETIC global runtime
   *     (`{ substrate: 'interactive' }` ⇒ `agentRuntime: 'claude-sdk'`), because
   *     `substrate` has a stored rung above the implied one and `agentRuntime`
   *     does not;
   *   - and a stored runtime with no substrate is the mirror case the resolver's
   *     `impliedSubstrate` rung already covered.
   * Extends the baseline matrix above rather than duplicating it: same rule,
   * exercised over STORED rows (which a baseline deliberately ignores).
   */
  it('holds for the launch-seam composition too, over stored rows on both key kinds', () => {
    const storedRows: (RunTypeDefaults | undefined)[] = [
      undefined,
      {},
      { substrate: 'interactive' },
      { substrate: 'sdk' },
      { agentRuntime: 'claude-interactive' },
      { agentRuntime: 'claude-sdk' },
      { agentRuntime: 'claude-interactive', substrate: 'interactive' },
      { model: 'sonnet', permissionMode: 'dontAsk' },
    ];
    // The substrate each surface routes its own default through.
    const globalSubstrates: CliSubstrate[] = ['sdk', 'interactive'];

    for (const key of [QUICK_RUN_TYPE_KEY, 'workflow:wf-1']) {
      for (const stored of storedRows) {
        for (const substrate of globalSubstrates) {
          const resolved = resolveRunTypeLaunchDefaults(key, { [key]: stored ?? {} }, { substrate });
          const launchRuntime =
            resolved.agentRuntime ?? claudeRuntimeFromSubstrate(resolved.substrate);
          // Claude-family only: a Codex runtime implies no substrate at all, and
          // every seam sends `undefined` for it rather than a Claude transport.
          expect(substrateForRuntime(launchRuntime)).toBe(resolved.substrate);
        }
      }
    }
  });

  // The baseline is the GLOBAL rung only. If it consumed `runTypeDefaults` too,
  // every stored value would equal its own baseline and every diff chip would
  // vanish — the "restated config" failure the module doc names.
  it('ignores the stored entry for the key (a baseline is what a launch resolves with NOTHING stored)', () => {
    const config: AppConfig = {
      gitRepoPath: '/repo',
      runTypeDefaults: {
        [QUICK_RUN_TYPE_KEY]: { model: 'haiku', substrate: 'sdk', agentRuntime: 'codex-sdk' },
      },
    };
    expect(resolveRunTypeBaseline(QUICK_RUN_TYPE_KEY, config)).toEqual({
      model: 'opus',
      substrate: 'interactive',
      agentRuntime: 'claude-interactive',
      permissionMode: 'default',
    });
    // …and therefore the stored values still render as overrides.
    expect(
      runTypeOverrideChips(
        { model: 'haiku', substrate: 'sdk', agentRuntime: 'codex-sdk' },
        resolveRunTypeBaseline(QUICK_RUN_TYPE_KEY, config),
      ).map((c) => c.field),
    ).toEqual(['model', 'substrate', 'agentRuntime']);
  });

  // -------------------------------------------------------------------------
  // The GLOBAL launch defaults (`defaultLaunchModel` / `defaultAgentRuntime`).
  // The baseline has to move with them or the chips describe a launch nobody
  // performs: a run type that merely RESTATES the global would chip, and a run
  // type that genuinely overrides it would not.
  // -------------------------------------------------------------------------

  it('takes the model from the global defaultLaunchModel, on both key kinds', () => {
    const config: AppConfig = { gitRepoPath: '/repo', defaultLaunchModel: 'sonnet' };
    expect(resolveRunTypeBaseline(QUICK_RUN_TYPE_KEY, config).model).toBe('sonnet');
    expect(resolveRunTypeBaseline('workflow:wf-1', config).model).toBe('sonnet');
  });

  it('treats a blank defaultLaunchModel as unset (parity with configManager.getGlobalLaunchModel)', () => {
    const config: AppConfig = { gitRepoPath: '/repo', defaultLaunchModel: '  ' };
    expect(resolveRunTypeBaseline('workflow:wf-1', config).model).toBe('opus');
  });

  it('takes the runtime from the global defaultAgentRuntime, moving the substrate WITH it', () => {
    const config: AppConfig = {
      gitRepoPath: '/repo',
      defaultAgentRuntime: 'claude-interactive',
    };
    expect(resolveRunTypeBaseline('workflow:wf-1', config)).toEqual({
      model: 'opus',
      substrate: 'interactive',
      agentRuntime: 'claude-interactive',
      permissionMode: 'default',
    });
  });

  // The workflow coercion, restated as a baseline: a flow key's LAUNCH drops a
  // global codex-pty and lands on the workflow floor, so the baseline must say
  // 'claude-sdk' — otherwise every flow row would show a phantom runtime chip
  // against a runtime no flow run can use.
  it('drops a global runtime the key cannot launch on (codex-pty on a flow key)', () => {
    const config: AppConfig = { gitRepoPath: '/repo', defaultAgentRuntime: 'codex-pty' };
    expect(resolveRunTypeBaseline('workflow:wf-1', config).agentRuntime).toBe('claude-sdk');
    expect(resolveRunTypeBaseline('workflow:wf-1', config).substrate).toBe('sdk');
    // …while the quick key, which CAN launch it, adopts it.
    expect(resolveRunTypeBaseline(QUICK_RUN_TYPE_KEY, config).agentRuntime).toBe('codex-pty');
  });

  it('drops a global runtime no key offers (codex-exec)', () => {
    const config: AppConfig = { gitRepoPath: '/repo', defaultAgentRuntime: 'codex-exec' };
    expect(resolveRunTypeBaseline(QUICK_RUN_TYPE_KEY, config).agentRuntime).toBe('claude-interactive');
    expect(resolveRunTypeBaseline('workflow:wf-1', config).agentRuntime).toBe('claude-sdk');
  });

  // AC6 — the chips, which is what this baseline exists for.
  it('shows NO chips for a run type that merely restates the globals, and chips one that overrides them', () => {
    const config: AppConfig = {
      gitRepoPath: '/repo',
      defaultLaunchModel: 'sonnet',
      defaultAgentRuntime: 'claude-interactive',
    };
    const baseline = resolveRunTypeBaseline('workflow:wf-1', config);
    // Follows the globals — every stored value equals what a launch resolves.
    expect(
      runTypeOverrideChips(
        { model: 'sonnet', agentRuntime: 'claude-interactive', substrate: 'interactive' },
        baseline,
      ),
    ).toEqual([]);
    // Overrides them — both fields differ from the resolved global baseline.
    expect(
      runTypeOverrideChips({ model: 'haiku', agentRuntime: 'claude-sdk' }, baseline).map((c) => ({
        field: c.field,
        baseline: c.baseline,
      })),
    ).toEqual([
      { field: 'model', baseline: 'Sonnet 5 · 1M' },
      { field: 'agentRuntime', baseline: 'Claude Interactive (CLI)' },
    ]);
  });

  // AC5 for this seam: with neither global set the baseline is unchanged.
  it('REGRESSION: with NEITHER global set the baselines are exactly the pre-feature ones', () => {
    const config: AppConfig = {
      gitRepoPath: '/repo',
      defaultLaunchModel: undefined,
      defaultAgentRuntime: undefined,
    };
    expect(resolveRunTypeBaseline(QUICK_RUN_TYPE_KEY, config)).toEqual(
      resolveRunTypeBaseline(QUICK_RUN_TYPE_KEY, NO_CONFIG),
    );
    expect(resolveRunTypeBaseline('workflow:wf-1', config)).toEqual({
      model: 'opus',
      substrate: 'sdk',
      agentRuntime: 'claude-sdk',
      permissionMode: 'default',
    });
  });
});

describe('runTypeOverrideChips', () => {
  const baseline = resolveRunTypeBaseline('workflow:wf-1', NO_CONFIG);

  it('is empty for an absent key', () => {
    expect(runTypeOverrideChips(undefined, baseline)).toEqual([]);
    expect(runTypeStatusLabel(0)).toBe('Following defaults');
  });

  it('drops fields whose stored value equals the baseline', () => {
    expect(runTypeOverrideChips({ model: 'opus', substrate: 'sdk' }, baseline)).toEqual([]);
  });

  it('keeps only the differing fields, with the baseline they differ from', () => {
    const chips = runTypeOverrideChips({ model: 'haiku', substrate: 'interactive' }, baseline);
    expect(chips.map((c) => c.field)).toEqual(['model', 'substrate']);
    expect(chips[0]).toMatchObject({ label: 'Model', baseline: 'Opus 5 · 1M' });
    expect(chips[1]).toMatchObject({ value: 'Interactive terminal', baseline: 'SDK' });
    expect(runTypeStatusLabel(chips.length)).toBe('2 overrides');
  });

  // The inverse of "stored == baseline ⇒ no chip": the SAME stored value flips
  // to a chip once the global default moves away from it. The diff is computed
  // against the RESOLVED baseline, not against the hard-coded ship default.
  it('chips a stored value that equals the ship default but differs from the configured global', () => {
    const configured = resolveRunTypeBaseline('workflow:wf-1', {
      gitRepoPath: '/repo',
      defaultAgentPermissionMode: 'dontAsk',
    });
    // 'default' is PermissionMode's ship value, yet this user's global is dontAsk.
    const chips = runTypeOverrideChips({ permissionMode: 'default' }, configured);
    expect(chips).toHaveLength(1);
    expect(chips[0]).toMatchObject({
      field: 'permissionMode',
      value: 'Ask before edits',
      baseline: "Don't ask",
    });
    // ...and against the untouched global it is not an override at all.
    expect(runTypeOverrideChips({ permissionMode: 'default' }, baseline)).toEqual([]);
  });

  it('emits chips in the display order, not the stored key order', () => {
    const chips = runTypeOverrideChips(
      { permissionMode: 'dontAsk', agentRuntime: 'codex-sdk', model: 'haiku' },
      baseline,
    );
    expect(chips.map((c) => c.field)).toEqual(['model', 'agentRuntime', 'permissionMode']);
    // The order is the module's single source, so a reordered field list moves
    // the chips with it rather than silently disagreeing with the detail screen.
    const order = RUN_TYPE_FIELD_ORDER.filter((f) => chips.some((c) => c.field === f));
    expect(chips.map((c) => c.field)).toEqual([...order]);
  });

  it('treats any stored reasoning effort as an override (there is no global baseline)', () => {
    const chips = runTypeOverrideChips(
      { reasoningEffort: 'high' },
      resolveRunTypeBaseline(QUICK_RUN_TYPE_KEY, NO_CONFIG),
    );
    expect(chips).toHaveLength(1);
    expect(chips[0]).toMatchObject({ field: 'reasoningEffort', value: 'High', baseline: null });
    expect(runTypeStatusLabel(1)).toBe('1 override');
  });
});

describe('keys', () => {
  it('only the synthetic quick key is quick — a workflow key never is', () => {
    expect(isQuickRunTypeKey(QUICK_RUN_TYPE_KEY)).toBe(true);
    expect(workflowRunTypeKey('wf-1')).toBe('workflow:wf-1');
    expect(isQuickRunTypeKey(workflowRunTypeKey('quick'))).toBe(false);
  });
});

const LOCAL_FLAVOR = { launchable: false, ariaMode: false };
const ARIA_FLAVOR = { launchable: true, ariaMode: true };

describe('agentRuntimePickerOptions', () => {
  // The two OMP flavors are ALTERNATIVES — an install either supervises a
  // remote fleet or runs OMP locally. Offering both would let Settings store a
  // runtime the launch picker refuses to show.
  it('offers the local OMP runtimes and hides the fleet supervisor by default', () => {
    const offered = agentRuntimePickerOptions(QUICK_RUN_TYPE_KEY, LOCAL_FLAVOR);
    expect(offered).toContain('omp-sdk');
    expect(offered).toContain('omp-pty');
    expect(offered).not.toContain('omp-fleet');
  });

  it('swaps to the fleet supervisor under Aria mode', () => {
    const offered = agentRuntimePickerOptions(QUICK_RUN_TYPE_KEY, ARIA_FLAVOR);
    expect(offered).toContain('omp-fleet');
    expect(offered).not.toContain('omp-sdk');
    expect(offered).not.toContain('omp-pty');
  });

  // Aria mode ALONE offers the row. Requiring `launchable` too used to leave an
  // Aria install with no OMP row at all — the local runtimes are hidden
  // precisely because Aria is on — so the setting silently lost its whole
  // family. The caller renders it disabled with the reason instead.
  it('offers the fleet supervisor under Aria mode even when nothing is launchable', () => {
    expect(
      agentRuntimePickerOptions(QUICK_RUN_TYPE_KEY, { launchable: false, ariaMode: true }),
    ).toContain('omp-fleet');
  });

  it('names why an offered fleet row cannot be selected', () => {
    expect(runtimeUnavailableReason('omp-fleet', { launchable: false, ariaMode: true })).toBe(
      'bridge not configured',
    );
    expect(runtimeUnavailableReason('omp-fleet', { launchable: true, ariaMode: true })).toBeNull();
    // Nothing else is ever gated this way.
    expect(runtimeUnavailableReason('omp-sdk', { launchable: false, ariaMode: false })).toBeNull();
  });

  // Flipping the toggle changes what you can PICK, never what is stored: a
  // <select> whose list omits its own value renders blank and would rewrite the
  // override on the next save.
  it('keeps the currently-stored runtime offered even when the flavor hides it', () => {
    expect(agentRuntimePickerOptions(QUICK_RUN_TYPE_KEY, ARIA_FLAVOR, 'omp-sdk')).toContain('omp-sdk');
    expect(agentRuntimePickerOptions(QUICK_RUN_TYPE_KEY, LOCAL_FLAVOR, 'omp-fleet')).toContain('omp-fleet');
  });

  // The flavor filter rides ON TOP of the launch-kind narrowing; it must not
  // widen a workflow key into runtimes that key could never launch.
  it('never widens the launch-kind set it filters', () => {
    for (const flavor of [LOCAL_FLAVOR, ARIA_FLAVOR]) {
      const base = agentRuntimeOptions('workflow:wf-1');
      for (const runtime of agentRuntimePickerOptions('workflow:wf-1', flavor)) {
        expect(base).toContain(runtime);
      }
    }
  });
});

describe('agentRuntimeOptions', () => {
  // The quick key is the only one whose launch can reach the Codex TUI; a flow
  // run has no PTY seam, so offering it there would be a control that cannot
  // take effect (the same rule that keeps effort quick-only).
  it('offers the Codex CLI runtime on the quick key and never on a flow key', () => {
    expect(agentRuntimeOptions(QUICK_RUN_TYPE_KEY)).toContain('codex-pty');
    expect(agentRuntimeOptions('workflow:wf-1')).not.toContain('codex-pty');
    // Both share the three Claude/Codex-SDK runtimes.
    for (const runtime of ['claude-sdk', 'claude-interactive', 'codex-sdk']) {
      expect(agentRuntimeOptions('workflow:wf-1')).toContain(runtime);
      expect(agentRuntimeOptions(QUICK_RUN_TYPE_KEY)).toContain(runtime);
    }
  });

  // Session membership alone is not enough to be offered: a picker seeded from
  // SESSION_AGENT_RUNTIMES narrows by the picker capability, and a WORKFLOW key
  // narrows by the LAUNCHABLE set on top of it — which is what keeps the two
  // OMP lanes apart on a workflow key even though both are legal session
  // runtimes on the same enabled provider.
  it('offers both OMP lanes on the quick key but only omp-sdk on a workflow key', () => {
    expect(agentRuntimeOptions(QUICK_RUN_TYPE_KEY)).toContain('omp-sdk');
    expect(agentRuntimeOptions(QUICK_RUN_TYPE_KEY)).toContain('omp-pty');
    expect(agentRuntimeOptions('workflow:wf-1')).toContain('omp-sdk');
    expect(agentRuntimeOptions('workflow:wf-1')).not.toContain('omp-pty');
  });

  it('still labels a stored OMP value rather than falling back to the raw id', () => {
    // The label map is deliberately wider than the option list — a value that
    // reaches the detail screen must read as a name either way.
    expect(runTypeValueLabel('agentRuntime', 'omp-sdk')).toBe('OMP');
    expect(runTypeValueLabel('agentRuntime', 'omp-pty')).toBe('OMP (CLI)');
  });
});

describe('runTypeValueLabel', () => {
  it('labels every known value from the same maps the pickers use', () => {
    expect(runTypeValueLabel('model', 'sonnet')).toBe('Sonnet 5 · 1M');
    expect(runTypeValueLabel('substrate', 'interactive')).toBe('Interactive terminal');
    expect(runTypeValueLabel('agentRuntime', 'codex-pty')).toBe('Codex (CLI)');
    expect(runTypeValueLabel('permissionMode', 'dontAsk')).toBe("Don't ask");
    expect(runTypeValueLabel('reasoningEffort', 'xhigh')).toBe('Xhigh');
  });

  // A stored value can outlive the option that produced it (a retired model
  // alias, a runtime renamed in a later build). The row still has to render, so
  // every branch falls back to the RAW value rather than blank or undefined.
  it('falls back to the raw value for a value no option list still knows', () => {
    expect(runTypeValueLabel('model', 'claude-3-legacy')).toBe('claude-3-legacy');
    expect(runTypeValueLabel('substrate', 'quantum')).toBe('quantum');
    expect(runTypeValueLabel('agentRuntime', 'gemini-pty')).toBe('gemini-pty');
    expect(runTypeValueLabel('permissionMode', 'yolo')).toBe('yolo');
  });
});

describe('buildRunTypeGroups', () => {
  it('splits built-ins, the synthetic quick row, global custom flows and per-project ones', () => {
    const groups = buildRunTypeGroups(
      [
        wf('wf-3-custom-bb', 'nightly', 'Cyboflow', 3),
        wf('wf-global-custom-aa', 'triage'),
        wf('wf-global-ship', 'ship'),
        wf('wf-global-planner', 'planner'),
      ],
      [],
    );

    expect(groups.map((g) => g.title)).toEqual([
      'Built-in flows',
      'Quick sessions',
      'Custom flows',
      'Custom flows · Cyboflow',
    ]);
    // Built-ins keep the canonical planner → sprint → compound → ship order.
    expect(groups[0].rows.map((r) => r.label)).toEqual(['Planner', 'Ship']);
    expect(groups[1].rows.map((r) => r.key)).toEqual([QUICK_RUN_TYPE_KEY]);
  });

  it("lists the setup flow with the other built-ins so its stored default stays reachable", () => {
    const groups = buildRunTypeGroups([wf('wf-global-verify', 'verify-setup')], []);
    expect(groups[0].title).toBe('Built-in flows');
    expect(groups[0].rows.map((r) => r.label)).toEqual(['Verify Setup']);
  });

  it('renders a stale key as-is instead of pruning it', () => {
    const groups = buildRunTypeGroups(
      [wf('wf-global-sprint', 'sprint')],
      [QUICK_RUN_TYPE_KEY, workflowRunTypeKey('wf-global-sprint'), 'workflow:wf-archived-77'],
    );

    const staleGroup = groups.find((g) => g.id === 'stale');
    expect(staleGroup?.rows).toEqual([
      {
        key: 'workflow:wf-archived-77',
        label: 'workflow:wf-archived-77',
        sublabel: 'No matching flow in the current project list',
        stale: true,
      },
    ]);
    // The quick key and a key that DOES resolve never land in the stale bucket.
    expect(staleGroup?.rows).toHaveLength(1);
  });

  it('always offers the quick row, even with no workflows at all', () => {
    const groups = buildRunTypeGroups([], []);
    expect(groups.map((g) => g.id)).toEqual(['quick']);
  });

  it('gives every owning project its own group, ordered by project name', () => {
    const groups = buildRunTypeGroups(
      [
        wf('wf-9-zulu', 'nightly', 'Zulu', 9),
        wf('wf-2-alpha', 'triage', 'Alpha', 2),
        wf('wf-global', 'audit'),
      ],
      [],
    );

    expect(groups.map((g) => g.title)).toEqual([
      'Quick sessions',
      'Custom flows',
      'Custom flows · Alpha',
      'Custom flows · Zulu',
    ]);
    // A GLOBAL flow (project_id null ⇒ projectName '') stays ungrouped, which is
    // exactly the row workflowsStore emits once for the whole fan-out.
    expect(groups[1].rows.map((r) => r.key)).toEqual(['workflow:wf-global']);
    expect(groups[2].rows.map((r) => r.key)).toEqual(['workflow:wf-2-alpha']);
    expect(groups[3].rows.map((r) => r.key)).toEqual(['workflow:wf-9-zulu']);
  });

  it('keeps several stale keys, sorted, without ever touching the quick key', () => {
    const groups = buildRunTypeGroups(
      [wf('wf-global-sprint', 'sprint')],
      ['workflow:wf-zz-gone', QUICK_RUN_TYPE_KEY, 'workflow:wf-aa-gone'],
    );

    const stale = groups.find((g) => g.id === 'stale');
    expect(stale?.rows.map((r) => r.key)).toEqual(['workflow:wf-aa-gone', 'workflow:wf-zz-gone']);
    // Every stale row is labelled with its raw key and flagged, so the render
    // site can tell "renamed flow" apart from a live one without re-deriving it.
    expect(stale?.rows.every((r) => r.stale && r.label === r.key)).toBe(true);
    // The quick key is synthetic: it has no workflow row and must never be
    // mistaken for an unmatched one.
    expect(groups.find((g) => g.id === 'quick')?.rows[0].stale).toBe(false);
  });
});

describe('draft ⇄ patch', () => {
  it('round-trips a stored override into a draft', () => {
    expect(draftFromStored({ model: 'sonnet', reasoningEffort: 'high' })).toEqual({
      model: 'sonnet',
      reasoningEffort: 'high',
      substrate: null,
      agentRuntime: null,
      permissionMode: null,
    });
  });

  it('sends EVERY member so a cleared field is deleted and an emptied key is dropped', () => {
    expect(patchFromDraft(draftFromStored(undefined))).toEqual({
      model: null,
      reasoningEffort: null,
      substrate: null,
      agentRuntime: null,
      permissionMode: null,
    });
  });

  it('sends a fully populated draft by value, with no member omitted', () => {
    const stored = {
      model: 'haiku',
      reasoningEffort: 'max',
      substrate: 'interactive',
      agentRuntime: 'codex-pty',
      permissionMode: 'dontAsk',
    } as const;
    const patch = patchFromDraft(draftFromStored(stored));
    expect(patch).toEqual(stored);
    // Every editable field is a patch member on EVERY save — an omitted member
    // is indistinguishable from "leave it alone" to ConfigManager's merge, so a
    // field dropped here would become unclearable.
    expect(Object.keys(patch).sort()).toEqual([...RUN_TYPE_FIELD_ORDER].sort());
  });

  it('clears exactly the fields the user cleared, keeping the rest', () => {
    const draft = draftFromStored({ model: 'sonnet', substrate: 'interactive' });
    expect(patchFromDraft({ ...draft, substrate: null })).toEqual({
      model: 'sonnet',
      reasoningEffort: null,
      substrate: null,
      agentRuntime: null,
      permissionMode: null,
    });
  });
});

/**
 * The invariant: a draft can never SAVE a combination no launch can honour — a
 * Claude model under a Codex runtime (or the reverse), or a substrate the
 * chosen runtime contradicts. It used to be enforced on the `agentRuntime` pick
 * ONLY, which held for one edit order and collapsed in every other: picking the
 * runtime first and the model second reassembled the exact pair the runtime
 * pick had just removed. These pin all three entry points.
 */
describe('runtime-family coercion — every edit order', () => {
  const flow = resolveRunTypeBaseline('workflow:wf-1', NO_CONFIG);

  function draft(over: Partial<RunTypeDraft> = {}): RunTypeDraft {
    return { ...draftFromStored(undefined), ...over };
  }

  describe('effective runtime', () => {
    it('falls through to the baseline while the runtime card is off', () => {
      expect(effectiveRuntimeForDraft(draft(), flow)).toBe('claude-sdk');
      expect(draftRuntimeProvider(draft(), flow)).toBe('claude');
      expect(effectiveRuntimeForDraft(draft({ agentRuntime: 'codex-pty' }), flow)).toBe('codex-pty');
      expect(draftRuntimeProvider(draft({ agentRuntime: 'codex-sdk' }), flow)).toBe('codex');
      expect(draftRuntimeProvider(draft({ agentRuntime: 'omp-sdk' }), flow)).toBe('omp');
    });
  });

  // AC 1 — runtime last. This order already held; it is pinned so the fix for
  // the others cannot regress it.
  describe('runtime last', () => {
    it('coerces a Claude model chosen first once a Codex runtime is picked', () => {
      const next = coerceDraftForRuntime(draft({ model: 'sonnet' }), 'codex-sdk', flow);
      expect(patchFromDraft(next)).toMatchObject({ model: 'auto', agentRuntime: 'codex-sdk' });
    });

    it('coerces the model even when the model card was never switched on', () => {
      // An omitted member resolves to the always-Claude floor at launch, so
      // "leave it null" would be the cross-family pair, just implicitly.
      expect(coerceDraftForRuntime(draft(), 'codex-sdk', flow).model).toBe('auto');
    });

    it('coerces a stale Codex model back to the baseline on a Claude runtime', () => {
      const next = coerceDraftForRuntime(draft({ model: 'gpt-5-codex' }), 'claude-sdk', flow);
      expect(next.model).toBe('opus');
    });

    it('leaves "follow defaults" alone on a Claude runtime', () => {
      expect(coerceDraftForRuntime(draft(), 'claude-interactive', flow).model).toBeNull();
    });
  });

  // AC 2 — model last. THE defect: the model path applied no coercion at all.
  describe('model last', () => {
    it('refuses a Claude alias once the runtime is Codex', () => {
      const codex = coerceDraftForRuntime(draft({ model: 'sonnet' }), 'codex-sdk', flow);
      const next = coerceDraftForModel(codex, 'opus', flow);
      expect(next.model).toBe('auto');
      // The patch that would actually be saved carries no cross-family pair.
      expect(patchFromDraft(next)).toMatchObject({ model: 'auto', agentRuntime: 'codex-sdk' });
    });

    it('keeps a genuine Codex model under a Codex runtime', () => {
      const next = coerceDraftForModel(draft({ agentRuntime: 'codex-sdk' }), 'gpt-5-codex', flow);
      expect(next.model).toBe('gpt-5-codex');
    });

    it('has no "follow defaults" under a Codex runtime — that IS the Claude floor', () => {
      expect(coerceDraftForModel(draft({ agentRuntime: 'codex-pty' }), null, flow).model).toBe('auto');
    });

    it('judges the model against the EFFECTIVE runtime, not just an explicit one', () => {
      // Runtime card off ⇒ the baseline (Claude) runtime owns the launch, so a
      // Codex model restored from a stale row cannot survive the edit path.
      expect(coerceDraftForModel(draft(), 'gpt-5-codex', flow).model).toBe('opus');
      expect(coerceDraftForModel(draft(), 'sonnet', flow).model).toBe('sonnet');
      expect(coerceDraftForModel(draft({ model: 'sonnet' }), null, flow).model).toBeNull();
    });
  });

  // AC 3 — substrate last. A stored substrate BEATS the runtime's implied one in
  // `resolveRunTypeLaunchDefaults`, so a disagreeing pair is savable dead state.
  describe('substrate last', () => {
    it('moves the Claude runtime to the one that owns the picked transport', () => {
      const next = coerceDraftForSubstrate(draft({ agentRuntime: 'claude-sdk' }), 'interactive');
      expect(patchFromDraft(next)).toMatchObject({
        substrate: 'interactive',
        agentRuntime: 'claude-interactive',
      });
    });

    it('keeps an agreeing pick as-is', () => {
      const next = coerceDraftForSubstrate(draft({ agentRuntime: 'claude-interactive' }), 'interactive');
      expect(next.agentRuntime).toBe('claude-interactive');
      expect(next.substrate).toBe('interactive');
    });

    it('drops the pick entirely under a Codex runtime — there is nothing to agree with', () => {
      for (const substrate of ['sdk', 'interactive'] as const) {
        const next = coerceDraftForSubstrate(draft({ agentRuntime: 'codex-sdk' }), substrate);
        expect(next.substrate).toBeNull();
        expect(next.agentRuntime).toBe('codex-sdk');
      }
    });

    it('leaves a free-standing substrate override alone when no runtime is chosen', () => {
      // Nothing to contradict: the key has picked no runtime of its own.
      const next = coerceDraftForSubstrate(draft(), 'interactive');
      expect(next).toMatchObject({ substrate: 'interactive', agentRuntime: null });
    });

    it('clears to "follow defaults" without touching the runtime', () => {
      const next = coerceDraftForSubstrate(draft({ agentRuntime: 'claude-interactive', substrate: 'interactive' }), null);
      expect(next).toMatchObject({ substrate: null, agentRuntime: 'claude-interactive' });
    });
  });

  // AC 3 — `RunTypeOverrideDetail`'s `toggleCard` seeds each field of a card
  // from `baselineValueFor` "so the control starts at the value the launch would
  // have used". With the old contradictory quick baseline that seeded
  // `{ substrate: 'interactive' }` and then `{ agentRuntime: 'claude-sdk' }`,
  // whose coercion silently threw the substrate away. This replays that exact
  // loop for the Runtime card on a DEFAULT install.
  describe('Runtime-card seeding on a default install', () => {
    function seedRuntimeCard(key: string): RunTypeDraft {
      const baseline = resolveRunTypeBaseline(key, NO_CONFIG);
      let next = draftFromStored(undefined);
      // The card's field order, from knobCardsFor('runtime').
      for (const field of ['substrate', 'agentRuntime'] as const) {
        const value = baselineValueFor(field, baseline);
        next =
          field === 'substrate'
            ? coerceDraftForSubstrate(next, value as CliSubstrate | null)
            : coerceDraftForRuntime(next, value as AgentRuntime, baseline);
      }
      return next;
    }

    it('seeds the quick key to a self-consistent interactive pair', () => {
      const draft = seedRuntimeCard(QUICK_RUN_TYPE_KEY);
      expect(draft).toMatchObject({
        substrate: 'interactive',
        agentRuntime: 'claude-interactive',
      });
      // The seeded pair is exactly the baseline it claims to start from — the
      // substrate is no longer discarded by the runtime's coercion.
      expect(substrateForRuntime(draft.agentRuntime as AgentRuntime)).toBe(draft.substrate);
    });

    it('seeds a flow key to a self-consistent SDK pair', () => {
      expect(seedRuntimeCard('workflow:wf-1')).toMatchObject({
        substrate: 'sdk',
        agentRuntime: 'claude-sdk',
      });
    });
  });

  // AC 5 — the substrate a runtime implies has ONE definition (shared/types),
  // and this module reads it rather than keeping a private copy that can drift.
  it('agrees with shared substrateForRuntime for every runtime, not a local copy', () => {
    for (const runtime of SESSION_AGENT_RUNTIMES) {
      const implied = substrateForRuntime(runtime);
      for (const substrate of ['sdk', 'interactive'] as const) {
        const next = coerceDraftForRuntime(draft({ substrate }), runtime, flow);
        // Kept only when it IS the implied transport; cleared otherwise.
        expect(next.substrate).toBe(implied === substrate ? substrate : null);
      }
    }
  });
});

/**
 * The SAME invariant one rung up: `config.defaultLaunchModel` +
 * `config.defaultAgentRuntime` (Settings → Session settings → Global defaults)
 * feed every launch that has no per-run-type override, so a cross-family pair
 * stored there is the widest version of the pair the detail screen refuses.
 *
 * The global rung has no baseline above it — only the hardcoded floor — so the
 * fallback is "absent" (`''`), and ABSENT IS NEVER COERCED in either direction:
 * "Built-in default" has to stay reachable.
 */
describe('global-rung runtime-family coercion (Default Launch Model / Agent Runtime)', () => {
  describe('globalRuntimeProvider', () => {
    it('reads the provider off the runtime, and treats an unset global as Claude', () => {
      // Unset ⇒ each launch kind falls through to its own floor, and every floor
      // is a Claude runtime — so the model controls stay Claude-scoped.
      expect(globalRuntimeProvider(undefined)).toBe('claude');
      expect(globalRuntimeProvider('claude-sdk')).toBe('claude');
      expect(globalRuntimeProvider('claude-interactive')).toBe('claude');
      expect(globalRuntimeProvider('codex-sdk')).toBe('codex');
      expect(globalRuntimeProvider('codex-pty')).toBe('codex');
      expect(globalRuntimeProvider('omp-sdk')).toBe('omp');
      expect(globalRuntimeProvider('omp-pty')).toBe('omp');
    });
  });

  // Runtime edited last: the two-click order the UI actually exposes (pick a
  // model, then flip the runtime).
  describe('runtime last', () => {
    it('replaces a Claude alias with the Codex sentinel under any Codex runtime', () => {
      expect(coerceGlobalLaunchModel('opus', 'codex-sdk')).toBe('auto');
      expect(coerceGlobalLaunchModel('haiku', 'codex-pty')).toBe('auto');
    });

    it('clears a Codex model back to "Built-in default" under a Claude runtime', () => {
      // No baseline above a global: falling back to the floor is the honest
      // answer, not inventing a Claude alias the user never picked.
      expect(coerceGlobalLaunchModel('gpt-5-codex', 'claude-sdk')).toBe('');
      expect(coerceGlobalLaunchModel('gpt-5-codex', 'claude-interactive')).toBe('');
      // …and the same when the runtime is cleared: an unset global resolves to
      // the (Claude) floors, so the Codex model can no longer launch either.
      expect(coerceGlobalLaunchModel('gpt-5-codex', undefined)).toBe('');
    });
  });

  // Model edited last — the reverse order. Unreachable from the picker itself
  // (the options are runtime-scoped), so this guards a stale/restored value.
  describe('model last', () => {
    it('keeps a same-family pick verbatim', () => {
      expect(coerceGlobalLaunchModel('sonnet', 'claude-interactive')).toBe('sonnet');
      expect(coerceGlobalLaunchModel('sonnet', undefined)).toBe('sonnet');
      expect(coerceGlobalLaunchModel('gpt-5-codex', 'codex-sdk')).toBe('gpt-5-codex');
    });

    it("treats 'auto' as family-neutral — it is a valid selection on both sides", () => {
      expect(coerceGlobalLaunchModel('auto', 'codex-sdk')).toBe('auto');
      expect(coerceGlobalLaunchModel('auto', 'claude-sdk')).toBe('auto');
    });
  });

  // The "Built-in default" contract: clearing must never become a value.
  it('never turns an unset model into a concrete one, Codex runtime included', () => {
    for (const runtime of [undefined, ...SESSION_AGENT_RUNTIMES] as const) {
      expect(coerceGlobalLaunchModel('', runtime)).toBe('');
    }
  });

  // The property the two edit paths exist to guarantee: whatever is stored is
  // launchable on whatever runtime is stored beside it.
  it('leaves no cross-family pair reachable for any model × runtime combination', () => {
    const models = [
      'fable',
      'opus',
      'sonnet',
      'haiku',
      'auto',
      'gpt-5-codex',
      'gpt-5',
      'anthropic/claude-opus-4-5',
      'openrouter/qwen3-coder',
      '',
    ];
    for (const runtime of [undefined, ...SESSION_AGENT_RUNTIMES] as const) {
      for (const model of models) {
        const coerced = coerceGlobalLaunchModel(model, runtime);
        if (coerced === '') continue; // absent ⇒ the launch floor applies
        const provider = globalRuntimeProvider(runtime);
        expect(
          provider === 'codex'
            ? isCodexModelSelection(coerced)
            : provider === 'omp'
              ? isOmpModelFamily(coerced)
              : !isCodexModelFamily(coerced) && !isOmpModelFamily(coerced),
        ).toBe(true);
        // Idempotent: re-coercing a coerced value changes nothing.
        expect(coerceGlobalLaunchModel(coerced, runtime)).toBe(coerced);
      }
    }
  });
});
