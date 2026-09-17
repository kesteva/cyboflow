import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Ratchet: the largest source files in main/ may only SHRINK.
 *
 * GitHub issue #19 — `mcpQueryHandler.ts`, `index.ts` and
 * `verificationScheduler.ts` had been growing release over release with
 * nothing in the repo to notice. There is no `max-lines` lint rule, and
 * `src/index.ts` sits in vitest's coverage `exclude` list with no unit test
 * over `initializeServices()` at all, so this file is the only signal that
 * file produces in `test:unit`. Same idiom as `toolRegistryRatchet.test.ts`
 * and `noNewIpcHandlers.test.ts`: caps are frozen at the size on the day the
 * ratchet landed; an extraction lowers a cap (and MUST record the new cap
 * here, so the map tracks reality); a change that pushes a file back over
 * its cap fails this test and belongs in a sibling module instead.
 *
 * Line counts are measured the way `wc -l` measures them (newline count), so
 * a cap can be re-derived from the shell without running vitest.
 */

/** Frozen 2026-09-15 at the sizes of local main `df1706b48` (v0.4.0 + the
 * Distractodo Tier 0+1 merge), then re-based 2026-09-17 on local main
 * `9439bd5cf` (custom views + the grouped diff rail landed in between, before
 * this ratchet existed on main). The planned extractions, in order (see the
 * plan on issue #19): the McpQueryMessage/Deps type contract out of
 * mcpQueryHandler (~950 lines), then its workflow-config and global-agent
 * families, then index.ts's verify/eval composition (all four landed 2026-09-15
 * to 09-17). Entries may decrease or disappear, never grow. */
const FROZEN_LINE_CAPS: Record<string, number> = {
  'orchestrator/mcpServer/mcpQueryHandler.ts': 5717, // steps 1-3: type contract → mcpQueryMessages.ts; workflow-config + global-agent read/propose tools → handlers/; backlog projections → backlogProjection.ts
  'index.ts': 6409, // seeded-finding reader → orchestrator/seededFindingReader.ts; onBatchMinted hook → humanPrerequisiteSink; workflow-shaped proposal deps → agentThread/proposalExecutorWorkflowDeps.ts; §5.3 drift probes → services/visualVerify/verifyDriftProbes.ts; step 4: verify + eval composition → verifyComposition.ts / evalComposition.ts (siblings)
  'orchestrator/verify/verificationScheduler.ts': 5489, // `this`-free drain-priority policy + await primitives → verify/schedulerHelpers.ts (re-exported, so no consumer import changed)
  'services/panels/claude/claudeCodeManager.ts': 4818,
  'database/database.ts': 4249,
  'ipc/session.ts': 3732,
};

function locateSrcRoot(): string {
  let dir = process.cwd();
  for (;;) {
    for (const candidate of [path.join(dir, 'src'), path.join(dir, 'main', 'src')]) {
      if (fs.existsSync(path.join(candidate, 'ipc', 'index.ts'))) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`Could not locate main/src from ${process.cwd()}`);
    dir = parent;
  }
}

/** `wc -l` semantics: the number of newline characters in the file. */
function countLines(filePath: string): number {
  const text = fs.readFileSync(filePath, 'utf8');
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

describe('file-size ratchet (issue #19)', () => {
  const root = locateSrcRoot();

  for (const [rel, cap] of Object.entries(FROZEN_LINE_CAPS)) {
    it(`${rel} stays at or under its frozen cap of ${cap} lines`, () => {
      const abs = path.join(root, rel);
      expect(fs.existsSync(abs), `${rel} no longer exists — drop its entry from FROZEN_LINE_CAPS`).toBe(
        true,
      );
      const lines = countLines(abs);
      expect(
        lines,
        `${rel} is ${lines} lines, over its frozen cap of ${cap}. ` +
          'Extract the new code into a sibling module instead of growing this file ' +
          '(issue #19). If this file was deliberately shrunk, lower the cap here so ' +
          'the ratchet keeps tracking reality.',
      ).toBeLessThanOrEqual(cap);
    });
  }

  it('caps are recorded at reality, not padded (no cap more than 2% above the file)', () => {
    // A cap that sits well above the file leaves headroom for exactly the
    // creep this ratchet exists to stop. Keep the map honest: after an
    // extraction, lower the entry to the new size.
    const slack: string[] = [];
    for (const [rel, cap] of Object.entries(FROZEN_LINE_CAPS)) {
      const lines = countLines(path.join(root, rel));
      if (cap > Math.floor(lines * 1.02)) slack.push(`${rel}: cap ${cap} vs ${lines} lines`);
    }
    expect(slack, `Lower these caps to the current size:\n${slack.join('\n')}`).toEqual([]);
  });
});
