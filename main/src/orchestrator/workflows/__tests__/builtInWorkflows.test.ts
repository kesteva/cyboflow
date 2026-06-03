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
});
