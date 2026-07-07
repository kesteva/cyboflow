/**
 * Parity test for Ship's copied subagents.
 *
 * Ship = Planner's plan/refine set ⊕ Sprint's execute/verify set, shipped as
 * VERBATIM copies under `ship/agents/` (the bundle resolver is path-based, so
 * ship cannot reference the planner/sprint files directly). Copies drift: the
 * sprint dependency-analyzer once gained a stale-state-file hardening paragraph
 * that ship's copy silently missed. This test locks every ship agent to its
 * planner/sprint source file so any future edit to one side fails the suite
 * until the copy is re-synced (or the divergence is declared intentional below).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import * as path from 'path';

const workflowsDir = path.join(__dirname, '..');
const shipAgentsDir = path.join(workflowsDir, 'ship', 'agents');
const sourceDirs = ['planner', 'sprint'].map((flow) => path.join(workflowsDir, flow, 'agents'));

/**
 * Ship agents allowed to diverge from their planner/sprint source. Empty today —
 * add a filename here ONLY for a deliberate, reviewed divergence, with a comment
 * saying why ship needs different prose.
 */
const INTENTIONAL_DIVERGENCE: ReadonlySet<string> = new Set();

describe('ship agent parity', () => {
  const shipAgents = readdirSync(shipAgentsDir).filter((f) => f.endsWith('.md'));

  it('ships only agents that exist in planner or sprint', () => {
    for (const file of shipAgents) {
      const source = sourceDirs.find((dir) => {
        try {
          readFileSync(path.join(dir, file));
          return true;
        } catch {
          return false;
        }
      });
      expect(source, `${file} has no planner/sprint source`).toBeDefined();
    }
  });

  for (const file of readdirSync(shipAgentsDir).filter((f) => f.endsWith('.md'))) {
    if (INTENTIONAL_DIVERGENCE.has(file)) continue;
    it(`${file} matches its planner/sprint source verbatim`, () => {
      const sourceDir = sourceDirs.find((dir) => {
        try {
          readFileSync(path.join(dir, file));
          return true;
        } catch {
          return false;
        }
      });
      if (!sourceDir) return; // covered by the existence test above
      const source = readFileSync(path.join(sourceDir, file), 'utf8');
      const copy = readFileSync(path.join(shipAgentsDir, file), 'utf8');
      expect(copy, `${file} drifted from ${path.basename(sourceDir)} source`).toBe(source);
    });
  }
});
