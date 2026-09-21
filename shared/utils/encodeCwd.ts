/**
 * encodeCwd — map a worktree absolute path to the `~/.claude/projects/<key>/`
 * directory name Claude Code uses to store that session's transcript JSONL.
 *
 * Algorithm (verified empirically against the live `~/.claude/projects/` layout,
 * Probe B — IDEA-013-probe-findings.md):
 *   Replace EVERY character that is not `[A-Za-z0-9]` — including `/`, `\`, `.`,
 *   `_`, and any non-ASCII codepoint — with a single `-`.
 *
 *   Underscore used to survive (that Probe B layout was written by an older
 *   CLI), but Claude Code 2.1.278 maps it to `-` too: on 2026-09-21 a session
 *   in `~/.cyboflow_smoke295/proj/worktrees/x` wrote its JSONL under
 *   `-Users-…--cyboflow-smoke295-proj-worktrees-x` while cyboflow watched
 *   `…--cyboflow_smoke295-…` and transcript discovery gave up after 165s — the
 *   session ran with no structured pipeline (0 tokens, no claude_session_id).
 *   `ls ~/.claude/projects | grep _` returned nothing on that machine.
 *
 * Consequences confirmed on disk:
 *   - A leading separator yields a LEADING `-`
 *       `/Users/x/Developer/my-app` -> `-Users-x-Developer-my-app`
 *   - Adjacent separators each map to their own `-`, so `/` immediately followed
 *     by `.` collapses to `--`:
 *       `…T/cyboflow-day3-19dmtv/.cyboflow-worktrees/prune-f1c214bb`
 *         -> `…T-cyboflow-day3-19dmtv--cyboflow-worktrees-prune-f1c214bb`
 *     (zero directory names on disk retain a literal dot — `.` always collapses).
 *   - Each non-ASCII char maps to one `-`.
 *
 * Pure function, no imports, no `any`.
 *
 * #19972 COLLISION CAVEAT
 * -----------------------
 * This encoding is LOSSY: distinct absolute paths can collide onto the same key
 * (e.g. `/a/b-c` and `/a/b/c` both encode to `-a-b-c`). See GitHub claude-code
 * issue #19972. This module does NOT attempt to disambiguate — the mitigation
 * lives in `transcriptTailSource.ts`, whose cwd-binding fallback binds a session
 * only after the first transcript line bearing a TOP-LEVEL `cwd` equals the
 * target worktree absolute path (NOT mtime, NOT `system/init.cwd`). So when two
 * dirs collide on one key, the tail source still binds to the correct session.
 */
export function encodeCwd(absPath: string): string {
  return absPath.replace(/[^A-Za-z0-9]/g, '-');
}
