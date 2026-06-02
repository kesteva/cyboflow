/**
 * stepIdParity.test.ts — step_id derivation / round-trip invariant.
 *
 * ── Dynamic step-id model (post main-merge) ──────────────────────────────────
 * Step ids are NOT a static constant. Every `workflows` row carries a
 * `spec_json`, and `resolveWorkflowDefinition(name, spec_json)` (in
 * shared/types/workflows.ts) is the RUNTIME source of truth — a full override
 * of `WORKFLOW_DEFINITIONS`, which is now only the seed/fallback. Step ids are
 * arbitrary, user-editable, per-row data for custom flows. A STATIC parity test
 * ("every prompt-referenced id ∈ WORKFLOW_DEFINITIONS[name]") is therefore
 * INVALID, and the prompt `.md` assets no longer enumerate ids.
 *
 * This file locks the DERIVATION / ROUND-TRIP invariant against
 * `buildStepReportingAppend` (TASK-803's now-def-driven generator):
 *
 *   For a given RESOLVED WorkflowDefinition, the id set emitted by
 *   buildStepReportingAppend(def) EQUALS
 *   def.phases.flatMap(p => p.steps).map(s => s.id), IN ORDER.
 *
 * The "emitted id set" is recovered by parsing the single backtick-quoted,
 * comma-joined id line the generator produces — it is NOT a re-typed copy of
 * any sequence and NOT a scan of the `.md` bodies (which no longer carry ids),
 * so a generator-vs-definition drift fails CI.
 *
 * Three fixtures (per the post-merge revision):
 *   (a) a resolved BUILT-IN  (`resolveWorkflowDefinition('planner','{}')`)
 *   (b) an EDITED-built-in `spec_json` (renamed + added + removed step) — the
 *       prompt references the edited ids and NONE of the removed originals
 *   (c) a CUSTOM-flow def (arbitrary kebab ids, no built-in backstop)
 * Plus fail-soft: a null/broken-spec resolution yields '' (no throw), and a
 * negative-control bogus id is absent from the emitted set.
 *
 * No DB / IPC / Electron imports — the generator and resolver are pure.
 */
import { describe, it, expect } from 'vitest';
import {
  buildStepReportingAppend,
  flattenStepIds,
} from '../prompts/step-reporting-instructions';
import {
  resolveWorkflowDefinition,
  WORKFLOW_DEFINITIONS,
  type WorkflowDefinition,
} from '../../../../shared/types/workflows';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recover the ordered id list the generator actually emitted into the prompt.
 *
 * `buildStepReportingAppend` writes the ids as a single dedicated LINE of
 * comma-separated backtick-quoted tokens (e.g. "`context`, `research`,
 * `approve-idea`"), distinct from the prose lines which embed single backtick
 * tokens like `cyboflow_report_step` / `mcpServers` inside sentences. We locate
 * the one line whose comma-separated members are EVERY-ONE backtick-wrapped (the
 * id list) and extract its tokens, in declaration order. This parses the
 * generator's real output rather than re-deriving from the def, so a drift
 * between the generator and the definition fails the assertion. Returns [] when
 * no such line exists (the fail-soft empty-string append).
 */
function emittedStepIds(append: string): string[] {
  for (const line of append.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const parts = trimmed.split(',').map((p) => p.trim());
    // The id list line: every comma-separated member is exactly `…`-wrapped.
    if (parts.every((p) => /^`[^`]+`$/.test(p))) {
      return parts.map((p) => p.slice(1, -1));
    }
  }
  return [];
}

/** Authoritative ordered id list for a resolved definition. */
function definitionStepIds(def: WorkflowDefinition): string[] {
  return def.phases.flatMap((p) => p.steps).map((s) => s.id);
}

const BOGUS_ID = 'definitely-not-a-step';

// ---------------------------------------------------------------------------
// (a) Resolved built-in
// ---------------------------------------------------------------------------

describe('stepIdParity — resolved built-in (planner fallback)', () => {
  const def = resolveWorkflowDefinition('planner', '{}');

  it('resolves the built-in planner definition (non-null)', () => {
    expect(def).not.toBeNull();
    expect(def).toEqual(WORKFLOW_DEFINITIONS.planner);
  });

  it('emitted id set EQUALS the resolved definition ids, in order', () => {
    expect(def).not.toBeNull();
    const append = buildStepReportingAppend(def);
    const expectedIds = definitionStepIds(def as WorkflowDefinition);

    // Round-trip: generator output parsed back to ids === definition ids.
    expect(emittedStepIds(append)).toEqual(expectedIds);
    // The generator-internal flatten helper agrees with the definition too.
    expect(flattenStepIds(def)).toEqual(expectedIds);
  });

  it('negative control: a bogus id is absent from the emitted set', () => {
    const append = buildStepReportingAppend(def);
    expect(emittedStepIds(append)).not.toContain(BOGUS_ID);
    expect(definitionStepIds(def as WorkflowDefinition)).not.toContain(BOGUS_ID);
  });
});

// ---------------------------------------------------------------------------
// (b) Edited-built-in spec_json (renamed + added + removed step)
// ---------------------------------------------------------------------------

describe('stepIdParity — edited built-in (renamed / added / removed steps)', () => {
  // A user edit of the built-in `planner`: in the Plan phase the original
  // `research` step is RENAMED to `deep-research`, a NEW `kickoff` step is
  // ADDED before it, and the original `approve-idea` step is REMOVED. The
  // Refine phase is left intact. Persisted as the row's `spec_json`.
  const EDITED_PLANNER: WorkflowDefinition = {
    id: 'planner',
    phases: [
      {
        id: 'plan',
        label: 'Plan',
        color: '#3b6dd6',
        steps: [
          { id: 'context', name: 'Get context', agent: 'idea-extractor', mcps: ['filesystem'], retries: 0 },
          { id: 'kickoff', name: 'Kickoff sync', agent: 'human', mcps: [], retries: 0, human: true },
          { id: 'deep-research', name: 'Deep research', agent: 'researcher', mcps: ['web-search'], retries: 1, optional: true },
        ],
      },
      {
        id: 'refine',
        label: 'Refine',
        color: '#5a4ad6',
        steps: [
          { id: 'epics', name: 'Create epics', agent: 'task-refiner', mcps: ['filesystem'], retries: 0 },
          { id: 'tasks', name: 'Fill out task details', agent: 'task-refiner', mcps: ['filesystem'], retries: 0 },
        ],
      },
    ],
  };

  const def = resolveWorkflowDefinition('planner', JSON.stringify(EDITED_PLANNER));

  it('spec_json override wins over the built-in seed', () => {
    expect(def).not.toBeNull();
    expect(def).toEqual(EDITED_PLANNER);
    expect(def).not.toEqual(WORKFLOW_DEFINITIONS.planner);
  });

  it('emitted id set EQUALS the EDITED definition ids, in order', () => {
    const append = buildStepReportingAppend(def);
    expect(emittedStepIds(append)).toEqual(definitionStepIds(def as WorkflowDefinition));
  });

  it('emitted set contains the edited (renamed + added) ids', () => {
    const ids = emittedStepIds(buildStepReportingAppend(def));
    expect(ids).toContain('deep-research'); // renamed
    expect(ids).toContain('kickoff'); // added
  });

  it('emitted set OMITS the removed original ids', () => {
    const ids = emittedStepIds(buildStepReportingAppend(def));
    // `research` was renamed away and `approve-idea` was removed entirely;
    // both built-in originals must be absent from the edited run's prompt.
    expect(ids).not.toContain('research');
    expect(ids).not.toContain('approve-idea');
    // Sanity: the removed originals DO exist in the built-in seed, proving the
    // omission is a real edit and not a typo.
    const builtinIds = definitionStepIds(WORKFLOW_DEFINITIONS.planner);
    expect(builtinIds).toContain('research');
    expect(builtinIds).toContain('approve-idea');
  });

  it('negative control: a bogus id is absent from the emitted set', () => {
    expect(emittedStepIds(buildStepReportingAppend(def))).not.toContain(BOGUS_ID);
  });
});

// ---------------------------------------------------------------------------
// (c) Custom-flow def (arbitrary kebab ids, no built-in backstop)
// ---------------------------------------------------------------------------

describe('stepIdParity — custom flow (no built-in backstop)', () => {
  const CUSTOM_FLOW: WorkflowDefinition = {
    id: 'my-bespoke-flow',
    phases: [
      {
        id: 'intake',
        label: 'Intake',
        color: '#3b6dd6',
        steps: [
          { id: 'triage-request', name: 'Triage request', agent: 'executor', mcps: ['filesystem'], retries: 0 },
          { id: 'gather-evidence', name: 'Gather evidence', agent: 'researcher', mcps: ['web-search'], retries: 1 },
        ],
      },
      {
        id: 'resolution',
        label: 'Resolution',
        color: '#c96442',
        steps: [
          { id: 'draft-fix', name: 'Draft a fix', agent: 'executor', mcps: ['filesystem', 'git'], retries: 2 },
          { id: 'final-signoff', name: 'Final sign-off', agent: 'human', mcps: [], retries: 0, human: true },
        ],
      },
    ],
  };

  // A custom flow name is NOT a built-in, so a missing/empty spec resolves to
  // null — the spec_json IS the only source of the definition here.
  const def = resolveWorkflowDefinition('my-bespoke-flow', JSON.stringify(CUSTOM_FLOW));

  it('resolves a custom flow from its spec_json (no built-in fallback)', () => {
    expect(def).not.toBeNull();
    expect(def).toEqual(CUSTOM_FLOW);
    // A custom name with no usable spec has nothing to fall back to.
    expect(resolveWorkflowDefinition('my-bespoke-flow', '{}')).toBeNull();
  });

  it('emitted id set EQUALS the custom definition ids, in order', () => {
    const append = buildStepReportingAppend(def);
    expect(emittedStepIds(append)).toEqual([
      'triage-request',
      'gather-evidence',
      'draft-fix',
      'final-signoff',
    ]);
    expect(emittedStepIds(append)).toEqual(definitionStepIds(def as WorkflowDefinition));
  });

  it('negative control: a bogus id is absent from the emitted set', () => {
    expect(emittedStepIds(buildStepReportingAppend(def))).not.toContain(BOGUS_ID);
  });
});

// ---------------------------------------------------------------------------
// Fail-soft: null / broken resolution yields '' (no throw)
// ---------------------------------------------------------------------------

describe('stepIdParity — fail-soft null / broken resolution', () => {
  it('a null definition yields the empty string (no throw)', () => {
    expect(buildStepReportingAppend(null)).toBe('');
    expect(flattenStepIds(null)).toEqual([]);
    expect(emittedStepIds('')).toEqual([]);
  });

  it('a broken custom spec (non-built-in name + invalid JSON) resolves to null → ""', () => {
    const def = resolveWorkflowDefinition('not-a-builtin', 'not valid json');
    expect(def).toBeNull();
    expect(buildStepReportingAppend(def)).toBe('');
  });

  it('an empty-spec custom name resolves to null → "" (no built-in backstop)', () => {
    const def = resolveWorkflowDefinition('not-a-builtin', '{}');
    expect(def).toBeNull();
    expect(buildStepReportingAppend(def)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Cross-built-in coverage: every seed definition round-trips
// ---------------------------------------------------------------------------

describe('stepIdParity — all built-in seeds round-trip', () => {
  for (const name of Object.keys(WORKFLOW_DEFINITIONS)) {
    it(`built-in '${name}': emitted ids EQUAL the resolved definition ids`, () => {
      const def = resolveWorkflowDefinition(name, '{}');
      expect(def).not.toBeNull();
      const append = buildStepReportingAppend(def);
      expect(emittedStepIds(append)).toEqual(definitionStepIds(def as WorkflowDefinition));
    });
  }
});
