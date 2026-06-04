/**
 * Unit tests for buildBuiltInWorkflows() — the in-repo built-in workflow
 * descriptors that severed the SoloFlow plugin-cache dependency (P0).
 *
 * Coverage:
 *  1. Maps EXACTLY the two cyboflow built-in names (planner + sprint), keyed by
 *     CYBOFLOW_WORKFLOW_NAMES.
 *  2. Each descriptor path points at an existing, readable, non-empty `.md`
 *     prompt body alongside the module.
 *  3. The prompt bodies are self-contained: no `.soloflow` / `IDEA-NNN.md` /
 *     `TASK-NNN.md` references.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { buildBuiltInWorkflows } from '../builtInWorkflows';
import { resolveWorkflowBundle } from '../workflowBundle';
import { CYBOFLOW_WORKFLOW_NAMES } from '../../../../../shared/types/workflows';

describe('buildBuiltInWorkflows', () => {
  it('maps exactly the cyboflow built-in names (planner + sprint)', () => {
    const descriptors = buildBuiltInWorkflows();
    const names = descriptors.map((d) => d.name).sort();
    expect(names).toEqual(['planner', 'sprint']);
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

  it('prompt frontmatter declares a permission_mode the registry can parse', () => {
    for (const descriptor of buildBuiltInWorkflows()) {
      const body = readFileSync(descriptor.path, 'utf-8');
      expect(body, `${descriptor.name} frontmatter`).toMatch(
        /permission_mode:\s*(default|acceptEdits|dontAsk)/,
      );
    }
  });

  it('planner surfaces human gates via AskUserQuestion and forbids silently passing a gate', () => {
    const planner = buildBuiltInWorkflows().find((d) => d.name === 'planner');
    expect(planner, 'planner descriptor present').toBeDefined();
    const body = readFileSync(planner!.path, 'utf-8');

    // The slim orchestrator names AskUserQuestion as the gate mechanism and
    // forbids silently proceeding past a gate.
    expect(body, 'planner must name AskUserQuestion').toMatch(/AskUserQuestion/);
    expect(body, 'Hard rules must forbid silently passing a gate').toMatch(
      /never silently proceed past a gate/,
    );

    // The per-phase gate detail now lives in the invokable command bundle
    // (IDEA-013 rung-(ii)): the `Approve idea` / `Approve plan` headers (≤12 char
    // wire limit) are carried by the approve-idea / approve-plan slash-commands.
    const commands = resolveWorkflowBundle(planner!.path).commands;
    const byName = new Map(commands.map((c) => [c.name, c.content]));
    expect(byName.get('approve-idea'), 'approve-idea command names AskUserQuestion').toMatch(/AskUserQuestion/);
    // \s allows the soft line-break between "header" and the backtick'd header.
    expect(byName.get('approve-idea'), 'approve-idea uses the `Approve idea` header').toMatch(
      /header\s+`Approve idea`/,
    );
    expect(byName.get('approve-plan'), 'approve-plan uses the `Approve plan` header').toMatch(
      /header\s+`Approve plan`/,
    );
  });
});
