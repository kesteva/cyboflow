---
sprint: SPRINT-014
pending_count: 6
last_updated: "2026-05-17T21:15:00.000Z"
---
# Findings Queue

TASK-578 gated: failing blocking prereq (TASK-562 must land first).

## FIND-SPRINT-014-1
- **type:** scope_deviation
- **source:** TASK-562 (executor)
- **severity:** low
- **status:** resolved
- **location:** main/src/orchestrator/mcpServer/scriptPath.ts
- **description:** File not in original files_owned but imports getCrystalSubdirectory from crystalDirectory. Claimed and updated to use getCyboflowSubdirectory from cyboflowDirectory to satisfy AC3 (no crystalDirectory imports outside the shim). Claim was granted with no conflict.
- **resolved_by:** verifier — AC-prescribed: AC3 ("All in-tree call sites import from the new module path") requires zero `crystalDirectory` imports anywhere under `main/src/` outside the shim — scriptPath.ts was a real consumer the planner missed in files_owned, and rewriting it was required to satisfy AC3.

## FIND-SPRINT-014-2
- **type:** anti-pattern
- **source:** TASK-562 (verifier)
- **severity:** medium
- **status:** open
- **location:** frontend/src/types/electron.d.ts:22
- **description:** `interface IPCResponse<T = any>` defaults the IPC payload type parameter to `any`, which is why the AboutDialog `result.data.crystalDirectory` → `result.data.cyboflowDirectory` field-rename mismatch (introduced by TASK-562) did not surface in typecheck. The repo-wide rule "no explicit any" (CLAUDE.md TypeScript Rules) is bypassed by this default. Future IPC field renames will keep silently breaking frontend consumers until this default is removed (e.g., require explicit shape per call, or default to `unknown`).
- **suggested_action:** Change `IPCResponse<T = any>` to `IPCResponse<T = unknown>` and annotate every consumer with the explicit response shape, OR replace `IPCResponse` with a per-endpoint typed wrapper (e.g., generated from main's IPC handlers).

## FIND-SPRINT-014-3
- **type:** scope_deviation
- **source:** TASK-562 (executor)
- **severity:** low
- **status:** open
- **location:** frontend/src/components/AboutDialog.tsx
- **description:** The planner missed this file in TASK-562 files_owned. It is a direct consumer of the renamed IPC field (crystalDirectory → cyboflowDirectory in ipc/updater.ts). TASK-578 was planned to fix this but was blocked (no active worktree). Claim denied due to TASK-578 plan-level ownership, but file has no active conflicting edits. Proceeding to fix the 5 reference sites per verifier instruction to avoid runtime breakage (Data Directory row would vanish because result.data.crystalDirectory is now undefined).

## FIND-SPRINT-014-4
- **type:** cleanup
- **source:** TASK-562 (code-reviewer)
- **severity:** low
- **status:** open
- **location:** main/src/utils/logger.ts:30
- **description:** Stale inline comment `// Use the centralized Crystal directory` still references the old Crystal name after the rename to `getCyboflowSubdirectory`. The plan (step 2) explicitly called out renaming `Crystal` references in inline comments to `Cyboflow`, but logger.ts retained this one.
- **suggested_action:** Rename the comment to `// Use the centralized Cyboflow directory` on logger.ts:30.
- **resolved_by:**

## FIND-SPRINT-014-5
- **type:** anti-pattern
- **source:** TASK-565 (code-reviewer)
- **severity:** low
- **status:** open
- **location:** main/src/utils/commitFooter.ts:5 vs main/src/utils/shellEscape.ts:24,27,29 / main/src/ipc/file.ts:239,242,275,277 / main/src/services/worktreeManager.ts:651,654
- **description:** Naming-cliff between the new helper and its callers. `commitFooter.ts` exports `buildCommitFooter(enableCyboflowFooter: boolean)` (matches AC #2 — future-state name per TASK-561), but every caller still uses `enableCrystalFooter` because TASK-561 hasn't landed yet in the parallel SPRINT-014 run (TASK-561 status: pending; TASK-565 ran off the base SHA where the config field is still `enableCrystalFooter`). The boolean is positional so functionally fine, but reading the code with no TASK-561 context, the helper-boundary name swap looks like a typo / inconsistency. Will auto-resolve when TASK-561 lands and renames `enableCrystalFooter` → `enableCyboflowFooter` at the config field and propagates through all call sites.
- **suggested_action:** After TASK-561 lands, verify the naming-cliff resolved (grep `enableCrystalFooter` in `main/src/utils/shellEscape.ts main/src/ipc/file.ts main/src/services/worktreeManager.ts main/src/services/commitManager.ts` should return 0). If TASK-561 misses any of the call sites this task touched (e.g., the new local `footer`/`retryFooter` variable assignments in `ipc/file.ts:242,277`), fix them in TASK-561's scope.
- **resolved_by:**

## FIND-SPRINT-014-6
- **type:** cleanup
- **source:** TASK-565 (code-reviewer)
- **severity:** low
- **status:** open
- **location:** main/src/ipc/file.ts:237-243 and main/src/ipc/file.ts:273-278
- **description:** The plan's step 4 (and "Hardest Decision" section) recommended extracting a local `buildMessageFromRequest(msg, enabled)` helper inside the IPC handler scope to dedupe the 3-line message-construction pattern that now exists in both the initial-commit branch and the retry branch. The executor satisfied the footer-literal AC (acceptable per the plan's note that the local helper was "optional, recommended") but left the 3-line construction duplicated across the two branches. Net effect: the task removed 4 hardcoded literals but introduced 2 near-identical message-construction blocks in their place. Small but defeats some of the dedup intent.
- **suggested_action:** Add a local arrow function inside the `git:commit` handler scope: `const buildMessage = (msg: string, enabled: boolean) => { const f = buildCommitFooter(enabled); return f ? \`${msg}\n\n${f}\` : msg; };` and call it from both branches. Net diff: -6 lines, +5 lines.
- **resolved_by:**
