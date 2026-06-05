/**
 * Unit tests for buildBuiltInWorkflows() — the in-repo built-in workflow
 * descriptors that severed the SoloFlow plugin-cache dependency (P0).
 *
 * Coverage:
 *  1. Maps EXACTLY the five cyboflow built-in names (the two user-facing flows
 *     planner + sprint PLUS the three internal parallel-sprint flows
 *     task / sprint-init / sprint-finalize), keyed by CYBOFLOW_WORKFLOW_NAMES.
 *  2. Each descriptor path points at an existing, readable, non-empty `.md`
 *     prompt body alongside the module.
 *  3. The prompt bodies are self-contained: no `.soloflow` / `IDEA-NNN.md` /
 *     `TASK-NNN.md` references.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { buildBuiltInWorkflows } from '../builtInWorkflows';
import { CYBOFLOW_WORKFLOW_NAMES } from '../../../../../shared/types/workflows';

describe('buildBuiltInWorkflows', () => {
  it('maps exactly the cyboflow built-in names (user-facing + internal)', () => {
    const descriptors = buildBuiltInWorkflows();
    const names = descriptors.map((d) => d.name).sort();
    expect(names).toEqual(['planner', 'sprint', 'sprint-finalize', 'sprint-init', 'task']);
    // Keyed by CYBOFLOW_WORKFLOW_NAMES — same set, no extras, no omissions.
    expect(names).toEqual([...CYBOFLOW_WORKFLOW_NAMES].sort());
  });

  it('points each descriptor at an existing, readable, non-empty prompt .md', () => {
    for (const descriptor of buildBuiltInWorkflows()) {
      expect(descriptor.path, `${descriptor.name} path`).toMatch(/\.md$/);
      const body = readFileSync(descriptor.path, 'utf-8');
      expect(body.trim().length, `${descriptor.name} prompt body non-empty`).toBeGreaterThan(0);
    }
  });

  it('prompt bodies are self-contained (no .soloflow / IDEA-NNN.md / TASK-NNN.md)', () => {
    for (const descriptor of buildBuiltInWorkflows()) {
      const body = readFileSync(descriptor.path, 'utf-8');
      expect(body, `${descriptor.name} must not reference .soloflow`).not.toMatch(/\.soloflow/);
      expect(body, `${descriptor.name} must not reference IDEA-NNN.md`).not.toMatch(/IDEA-NNN\.md/);
      expect(body, `${descriptor.name} must not reference TASK-NNN.md`).not.toMatch(/TASK-NNN\.md/);
    }
  });

  it('frontmatter permission_mode is optional; if present it is one of the four valid modes', () => {
    // Built-in flows ship WITHOUT a frontmatter permission_mode (null by
    // default); per-agent override is opt-in only. Absent values fall back to
    // the global agentPermissionMode default, not a flow-pinned mode — so an
    // ABSENT permission_mode is allowed and is the current baseline. We scan
    // ONLY the leading frontmatter fence so a prose mention can't false-trigger,
    // and IF a flow declares permission_mode we assert it is one of the four
    // valid PermissionMode values the registry can parse (incl. 'auto').
    for (const descriptor of buildBuiltInWorkflows()) {
      const body = readFileSync(descriptor.path, 'utf-8');
      const frontmatterMatch = body.match(/^---\n([\s\S]*?)\n---/);
      expect(frontmatterMatch, `${descriptor.name} has a frontmatter block`).not.toBeNull();
      const frontmatter = frontmatterMatch![1];
      const declared = frontmatter.match(/^permission_mode:\s*([A-Za-z]+)/m);
      if (declared) {
        expect(
          ['default', 'acceptEdits', 'auto', 'dontAsk'],
          `${descriptor.name} frontmatter permission_mode must be a valid PermissionMode`,
        ).toContain(declared[1]);
      }
    }
  });

  it('planner surfaces human gates inline via AskUserQuestion and forbids silently passing a gate', () => {
    const planner = buildBuiltInWorkflows().find((d) => d.name === 'planner');
    expect(planner, 'planner descriptor present').toBeDefined();
    const body = readFileSync(planner!.path, 'utf-8');

    // The orchestrator names AskUserQuestion as the gate mechanism and forbids
    // silently proceeding past a gate.
    expect(body, 'planner must name AskUserQuestion').toMatch(/AskUserQuestion/);
    expect(body, 'Hard rules must forbid silently passing a gate').toMatch(
      /never silently proceed past a gate/,
    );

    // Human gates run INLINE in the orchestrator (IDEA-013 subagent rework):
    // subagents have no AskUserQuestion, so the `Approve idea` / `Approve plan`
    // headers (≤12 char wire limit) live in the planner prose itself, not in a
    // delegated unit. \s allows the soft line-break before the backtick'd header.
    expect(body, 'planner uses the `Approve idea` gate header').toMatch(/header\s+`Approve idea`/);
    expect(body, 'planner uses the `Approve plan` gate header').toMatch(/header\s+`Approve plan`/);
  });
});
