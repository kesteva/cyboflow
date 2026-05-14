---
id: TASK-577
idea: SPRINT-006-compound
status: ready
created: 2026-05-14T00:00:00Z
files_owned:
  - main/src/services/terminalPanelManager.ts
files_readonly:
  - main/src/index.ts
  - .soloflow/active/plans/crystal-cuts-and-rebrand/EPIC-crystal-cuts-and-rebrand.md
  - .soloflow/active/plans/crystal-cuts-and-rebrand/TASK-576-plan.md
acceptance_criteria:
  - criterion: "Terminal PTY env block sets both CYBOFLOW_SESSION_ID and CYBOFLOW_PANEL_ID to the same values previously assigned to the CRYSTAL_* names"
    verification: "grep -nE 'CYBOFLOW_SESSION_ID:\\s*panel\\.sessionId' main/src/services/terminalPanelManager.ts returns 1 match AND grep -nE 'CYBOFLOW_PANEL_ID:\\s*panel\\.id' main/src/services/terminalPanelManager.ts returns 1 match"
  - criterion: "Legacy CRYSTAL_SESSION_ID and CRYSTAL_PANEL_ID env vars are still set (dual-set for backward compatibility with user scripts)"
    verification: "grep -nE 'CRYSTAL_SESSION_ID:\\s*panel\\.sessionId' main/src/services/terminalPanelManager.ts returns 1 match AND grep -nE 'CRYSTAL_PANEL_ID:\\s*panel\\.id' main/src/services/terminalPanelManager.ts returns 1 match"
  - criterion: "A deprecation comment above the CRYSTAL_* pair documents the intent to remove and points at the canonical CYBOFLOW_* names"
    verification: "grep -nE '@deprecated|deprecated|TODO.*remove' main/src/services/terminalPanelManager.ts returns at least 1 match within 5 lines of the CRYSTAL_SESSION_ID line"
  - criterion: "Main typecheck and unit tests pass"
    verification: "pnpm --filter main typecheck exits with status 0 AND pnpm --filter main test exits with status 0"
depends_on: []
estimated_complexity: low
epic: crystal-cuts-and-rebrand
test_strategy:
  needed: false
  justification: "Single-file edit adding two literal key-value entries to an env object and a deprecation comment. No existing test covers terminalPanelManager's env emission (find main/src/services/__tests__ -name 'terminal*' returns zero matches), and the env vars are consumed by user-authored shell scripts inside the spawned PTY — out of unit-test reach. The verification surface is the grep AC + a manual smoke (open a terminal panel, `echo $CYBOFLOW_SESSION_ID` returns the panel's session ID, `echo $CRYSTAL_SESSION_ID` returns the same value). Adding a unit test would require mocking `node-pty` and asserting on the env arg of `pty.spawn` — disproportionate scaffolding for a 4-line edit."
prerequisites: []
---

# Dual-set CYBOFLOW_SESSION_ID / CYBOFLOW_PANEL_ID env vars with CRYSTAL_* deprecation window

## Objective

`main/src/services/terminalPanelManager.ts:54-55` exposes two environment variables to every PTY spawned inside a Cyboflow terminal panel: `CRYSTAL_SESSION_ID` and `CRYSTAL_PANEL_ID`. These are a **runtime contract** — any user-authored shell script, alias, or prompt customization reading them would break on a flat rename. TASK-576 (backend Crystal-reference sweep) explicitly excluded these because they need a deprecation strategy, not a substitution. This task adds the canonical `CYBOFLOW_SESSION_ID` / `CYBOFLOW_PANEL_ID` env vars *alongside* the legacy ones (dual-set), flags the legacy pair with a deprecation comment, and leaves the actual removal of `CRYSTAL_*` to a future task once the deprecation window has passed.

The pattern mirrors the `--crystal-dir` / `--cyboflow-dir` CLI alias in `main/src/index.ts:122-136` — both names accepted, legacy emits a deprecation warning, removal is deferred.

## Implementation Steps

1. **Read `main/src/services/terminalPanelManager.ts:42-57`** to confirm the current env-object shape:
   ```typescript
   env: {
     ...process.env,
     PATH: enhancedPath,
     TERM: 'xterm-256color',
     COLORTERM: 'truecolor',
     LANG: process.env.LANG || 'en_US.UTF-8',
     WORKTREE_PATH: cwd,
     CRYSTAL_SESSION_ID: panel.sessionId,
     CRYSTAL_PANEL_ID: panel.id
   }
   ```

2. **Edit the env block** to add the canonical CYBOFLOW_* pair *before* the legacy pair, and add a deprecation comment above the legacy pair. The final shape:
   ```typescript
   env: {
     ...process.env,
     PATH: enhancedPath,
     TERM: 'xterm-256color',
     COLORTERM: 'truecolor',
     LANG: process.env.LANG || 'en_US.UTF-8',
     WORKTREE_PATH: cwd,
     // Canonical Cyboflow env vars exposed to PTY subprocesses.
     CYBOFLOW_SESSION_ID: panel.sessionId,
     CYBOFLOW_PANEL_ID: panel.id,
     // @deprecated Legacy Crystal-era names kept for backward compat with user
     // shell scripts. TODO(post-v1): remove after deprecation window.
     CRYSTAL_SESSION_ID: panel.sessionId,
     CRYSTAL_PANEL_ID: panel.id
   }
   ```
   Ordering rationale: canonical first so a reader of the env block sees the supported names at the top; legacy second under an explicit deprecation marker.

3. **Run `pnpm --filter main typecheck`.** Expected: exit 0. (The env object accepts arbitrary string keys, so adding two new entries is type-safe.)

4. **Run `pnpm --filter main test`.** Expected: exit 0. No existing test exercises this file, so there is no risk of test regression — this is a sanity gate.

5. **Manual smoke (recommended, not gated on):** start a dev build (`pnpm dev`), open a terminal panel, run `echo "$CYBOFLOW_SESSION_ID $CYBOFLOW_PANEL_ID $CRYSTAL_SESSION_ID $CRYSTAL_PANEL_ID"`. All four should print non-empty strings; the first pair should equal the second pair (same panel/session). Not part of the AC because it requires the dev environment to be running.

## Acceptance Criteria

See frontmatter. Compound rule: both env-var pairs are set to the same values, the canonical pair is named with the `CYBOFLOW_` prefix, and a deprecation comment is present.

## Test Strategy

No new tests. The behavior surface is "are these strings present in the PTY env at spawn time" — fully captured by the AC greps. A unit test mocking `pty.spawn` to inspect the env arg would be ~30 lines of scaffolding to assert what `grep` already proves in 1 line. Sibling-test scan: `find main/src/services -name 'terminal*.test.ts' -o -name 'terminalPanelManager*.spec.ts'` returns zero matches; no co-located coverage to keep green.

## Hardest Decision

Whether to set the canonical CYBOFLOW_* names *only* (flat rename) or dual-set with CRYSTAL_* preserved. **Decision: dual-set.** The env vars are a documented surface that user-authored shell scripts inside the terminal panel may already read. A flat rename would silently break those scripts on the next Cyboflow release. The cost of dual-set is two extra entries in an env object (4 bytes of memory per PTY) and a future cleanup task; the cost of a flat rename is unannounced breakage of user workflows. The same trade-off was taken for `--crystal-dir` (CLI flag with deprecation warning) and for `getCrystalDirectory` (re-export shim in TASK-562) — this maintains the project's consistent backward-compat-then-deprecate posture.

A weaker alternative would be "only set CRYSTAL_* unless an env var like `CYBOFLOW_USE_NEW_NAMES=1` is set." Rejected: opt-in deprecation requires user education and a release-notes line for a v0.x project — too much ceremony for a string-rename. Just dual-set both.

## Rejected Alternatives

- **Set CYBOFLOW_* only (flat rename).** Rejected: silently breaks user scripts. See Hardest Decision.
- **Add a runtime deprecation warning emitted when a user shell reads CRYSTAL_*.** Rejected: there is no portable way to detect that a child process read an env var (no hook in `node-pty`); the warning would have to be a heuristic on shell output, which is fragile. Comment-level documentation is the correct level of formality at this scope.
- **Move the env-var setup into a shared helper at `main/src/utils/cyboflowEnv.ts` and call it from both `terminalPanelManager.ts` and any future PTY-spawning site.** Rejected: there is currently exactly one PTY-spawning call site for these vars. Premature abstraction; revisit if a second consumer appears.

## Lowest Confidence Area

**The deprecation timeline.** The comment says `TODO(post-v1): remove after deprecation window` but does not name a concrete date or version. v1 is the target shipping line per `docs/cyboflow_system_design.md`. The right cleanup trigger is probably "two minor versions after the first user-facing release notes line announces the rename" — not a calendar date. This is intentionally vague because the project has not yet shipped v1 and a precise schedule would be speculative. The cleanup task itself (remove `CRYSTAL_*` from the env block) is one line of work; the open question is *when*, not *how*. Recommend filing the cleanup task in the backlog with `blocked` status and a precondition like "first stable v1 release has been out for ≥ 1 minor version."

Secondary concern: whether `WORKTREE_PATH` (an existing env var on line 53) should similarly be aliased to `CYBOFLOW_WORKTREE_PATH`. **No** — `WORKTREE_PATH` is a generic, non-branded name; it is not a `CRYSTAL_*` legacy. It stays as-is and does not need a CYBOFLOW_* alias.
