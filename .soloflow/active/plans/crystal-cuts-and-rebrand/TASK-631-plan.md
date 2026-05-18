---
id: TASK-631
idea: SPRINT-014-COMPOUND
status: ready
created: "2026-05-17T00:00:00Z"
files_owned:
  - main/src/services/terminalSessionManager.ts
files_readonly:
  - main/src/services/terminalPanelManager.ts
  - .soloflow/archive/done/crystal-cuts-and-rebrand/TASK-577-done.md
acceptance_criteria:
  - criterion: "PTY spawn env block sets CYBOFLOW_SESSION_ID to the sessionId argument"
    verification: "grep -nE 'CYBOFLOW_SESSION_ID:\\s*sessionId' main/src/services/terminalSessionManager.ts returns exactly 1 match"
  - criterion: "Legacy CRYSTAL_SESSION_ID also dual-set with deprecation comment"
    verification: "grep -nE 'CRYSTAL_SESSION_ID:\\s*sessionId' main/src/services/terminalSessionManager.ts returns exactly 1 match"
  - criterion: "Deprecation comment within 3 lines above CRYSTAL_SESSION_ID"
    verification: "grep -nE '@deprecated|TODO\\(post-v1\\)' main/src/services/terminalSessionManager.ts returns at least 1 match"
  - criterion: "No PANEL_ID variants (this manager has no panel concept)"
    verification: "grep -nE 'CYBOFLOW_PANEL_ID|CRYSTAL_PANEL_ID' main/src/services/terminalSessionManager.ts returns 0 matches"
  - criterion: "Other env vars (WORKTREE_PATH, TERM, COLORTERM, LANG, PATH) preserved unchanged"
    verification: "grep -nE 'WORKTREE_PATH:\\s*worktreePath' main/src/services/terminalSessionManager.ts returns 1 match"
  - criterion: "pnpm typecheck and pnpm lint pass"
    verification: "pnpm typecheck && pnpm lint exit 0"
depends_on: []
estimated_complexity: low
epic: crystal-cuts-and-rebrand
test_strategy:
  needed: false
  justification: "Mirrors TASK-577's pattern in a sibling file with no behavior beyond setting two env vars on PTY spawn — fully covered by typecheck + grep ACs. No sibling test exists; matches TASK-577 precedent."
---
# Mirror CYBOFLOW_*/CRYSTAL_* dual-set env vars into terminalSessionManager.ts

## Objective

TASK-577 codified the dual-set env-var policy (canonical CYBOFLOW_* + deprecated CRYSTAL_* with comment) in terminalPanelManager.ts. Sibling terminalSessionManager.ts:41-48 PTY spawn block sets WORKTREE_PATH/TERM/COLORTERM/LANG but neither session-ID env var — so user shell scripts inside session-mode terminals don't see the contract that scripts inside panel-mode terminals do. Apply the same pattern. Session-mode has no panel concept; only the session-ID pair is mirrored.

## Implementation Steps

1. **Read `main/src/services/terminalPanelManager.ts:47-61`** to confirm the canonical pattern.

2. **Edit `main/src/services/terminalSessionManager.ts:41-48`** — replace the env block:
   ```ts
   env: {
     ...process.env,
     PATH: shellPath,
     WORKTREE_PATH: worktreePath,
     TERM: 'xterm-256color',
     COLORTERM: 'truecolor',
     LANG: process.env.LANG || 'en_US.UTF-8',
     // Canonical Cyboflow env var exposed to PTY subprocesses.
     CYBOFLOW_SESSION_ID: sessionId,
     // @deprecated Legacy Crystal-era name kept for backward compat with user
     // shell scripts. TODO(post-v1): remove after deprecation window.
     CRYSTAL_SESSION_ID: sessionId,
   },
   ```

3. **Run `pnpm typecheck && pnpm lint`** — both must exit 0.

4. **Manual smoke (recommended):** start `pnpm dev`, open a session-mode terminal, run `echo "$CYBOFLOW_SESSION_ID $CRYSTAL_SESSION_ID"`. Both should print the same non-empty session ID.

## Hardest Decision

Whether to extract a shared `buildCyboflowTerminalEnv(sessionId, panelId?)` helper now. Decided against: the two sites have diverging contracts (panel-mode uses enhancedPath + panelId; session-mode uses getShellPath() + no panel). Forcing a helper now bloats its signature for no win. If a 3rd PTY spawn site appears, extract then.

## Lowest Confidence Area

Whether session-mode terminals are still a live code path in cyboflow v1 or `@cyboflow-hidden` legacy. Either way the patch is safe — verify sessionManager.ts:1556 during execution if uncertain.
