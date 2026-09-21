/**
 * Unit tests for encodeCwd.
 *
 * Cases verified against the live `~/.claude/projects/` layout (Probe B —
 * docs/probes/IDEA-013-probe-findings.md): slash path, dot-segment `--` collapse
 * matching the on-disk entry, and non-ASCII -> hyphen. Plain vitest, no fs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { encodeCwd } from '../encodeCwd';

describe('encodeCwd', () => {
  it('maps every slash in a plain absolute path to a hyphen with a leading hyphen', () => {
    expect(encodeCwd('/Users/x/Developer/my-app')).toBe('-Users-x-Developer-my-app');
  });

  it('collapses a leading "/" + dot-segment to "--" (matching the live entry)', () => {
    // Live on-disk: `…T/cyboflow-day3-19dmtv/.cyboflow-worktrees/prune-f1c214bb`
    // -> `…-T-cyboflow-day3-19dmtv--cyboflow-worktrees-prune-f1c214bb`.
    expect(encodeCwd('/a/.cyboflow-worktrees/p')).toBe('-a--cyboflow-worktrees-p');
    expect(
      encodeCwd('/T/cyboflow-day3-19dmtv/.cyboflow-worktrees/prune-f1c214bb'),
    ).toBe('-T-cyboflow-day3-19dmtv--cyboflow-worktrees-prune-f1c214bb');
  });

  it('maps each non-ASCII character to a single hyphen', () => {
    // `é` / `ï` are single NFC codepoints -> one hyphen each.
    expect(encodeCwd('/Users/café/naïve')).toBe('-Users-caf--na-ve');
    expect(encodeCwd('/tmp/项目')).toBe('-tmp---');
  });

  it('preserves ASCII letters and digits only — an underscore maps to a hyphen like any other separator', () => {
    expect(encodeCwd('/a_b/C9')).toBe('-a-b-C9');
    // Live on-disk (Claude Code 2.1.278, 2026-09-21): a `_` data dir encodes dashed.
    expect(encodeCwd('/Users/x/.cyboflow_smoke295/proj/worktrees/grand-hill-20260921')).toBe(
      '-Users-x--cyboflow-smoke295-proj-worktrees-grand-hill-20260921',
    );
  });

  it('documents the #19972 collision caveat in a comment block', () => {
    const src = readFileSync(join(__dirname, '..', 'encodeCwd.ts'), 'utf8');
    expect(/19972|collision/i.test(src)).toBe(true);
  });
});
