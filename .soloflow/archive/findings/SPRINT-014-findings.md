---
sprint: SPRINT-014
pending_count: 15
last_updated: "2026-05-17T23:35:55.299Z"
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
- **status:** resolved
- **location:** main/src/utils/logger.ts:30
- **description:** Stale inline comment `// Use the centralized Crystal directory` still references the old Crystal name after the rename to `getCyboflowSubdirectory`. The plan (step 2) explicitly called out renaming `Crystal` references in inline comments to `Cyboflow`, but logger.ts retained this one.
- **suggested_action:** Rename the comment to `// Use the centralized Cyboflow directory` on logger.ts:30.
- **resolved_by:** verifier — status-sync: TASK-576 (logger.ts:30 now reads `// Use the centralized Cyboflow directory` per commit 74350a9 step 16)

## FIND-SPRINT-014-5
- **type:** anti-pattern
- **source:** TASK-565 (code-reviewer)
- **severity:** low
- **status:** resolved
- **location:** main/src/utils/commitFooter.ts:5 vs main/src/utils/shellEscape.ts:24,27,29 / main/src/ipc/file.ts:239,242,275,277 / main/src/services/worktreeManager.ts:651,654
- **description:** Naming-cliff between the new helper and its callers. `commitFooter.ts` exports `buildCommitFooter(enableCyboflowFooter: boolean)` (matches AC #2 — future-state name per TASK-561), but every caller still uses `enableCrystalFooter` because TASK-561 hasn't landed yet in the parallel SPRINT-014 run (TASK-561 status: pending; TASK-565 ran off the base SHA where the config field is still `enableCrystalFooter`). The boolean is positional so functionally fine, but reading the code with no TASK-561 context, the helper-boundary name swap looks like a typo / inconsistency. Will auto-resolve when TASK-561 lands and renames `enableCrystalFooter` → `enableCyboflowFooter` at the config field and propagates through all call sites.
- **suggested_action:** After TASK-561 lands, verify the naming-cliff resolved (grep `enableCrystalFooter` in `main/src/utils/shellEscape.ts main/src/ipc/file.ts main/src/services/worktreeManager.ts main/src/services/commitManager.ts` should return 0). If TASK-561 misses any of the call sites this task touched (e.g., the new local `footer`/`retryFooter` variable assignments in `ipc/file.ts:242,277`), fix them in TASK-561's scope.
- **resolved_by:** TASK-561

## FIND-SPRINT-014-6
- **type:** cleanup
- **source:** TASK-565 (code-reviewer)
- **severity:** low
- **status:** open
- **location:** main/src/ipc/file.ts:237-243 and main/src/ipc/file.ts:273-278
- **description:** The plan's step 4 (and "Hardest Decision" section) recommended extracting a local `buildMessageFromRequest(msg, enabled)` helper inside the IPC handler scope to dedupe the 3-line message-construction pattern that now exists in both the initial-commit branch and the retry branch. The executor satisfied the footer-literal AC (acceptable per the plan's note that the local helper was "optional, recommended") but left the 3-line construction duplicated across the two branches. Net effect: the task removed 4 hardcoded literals but introduced 2 near-identical message-construction blocks in their place. Small but defeats some of the dedup intent.
- **suggested_action:** Add a local arrow function inside the `git:commit` handler scope: `const buildMessage = (msg: string, enabled: boolean) => { const f = buildCommitFooter(enabled); return f ? \`${msg}\n\n${f}\` : msg; };` and call it from both branches. Net diff: -6 lines, +5 lines.
- **resolved_by:** 

## FIND-SPRINT-014-7
- **type:** scope_deviation
- **source:** TASK-576 (executor)
- **severity:** low
- **status:** resolved
- **location:** main/src/ipc/git.ts:314
- **description:** Claimed outside files_owned to meet AC: bare-word Crystal in prose comment. Not owned by TASK-561 (which only targets enableCrystalFooter/disableCrystalFooter symbols). Claim granted by claim-file.js.
- **resolved_by:** verifier — AC-prescribed: AC3 ("Backend code comments and JSDoc no longer use the bare word 'Crystal' outside the explicit allowlist") sweeps all `main/src/` files; git.ts:314 was a bare-word Crystal prose comment outside every allowlist category and had to be rewritten to satisfy AC3.

## FIND-SPRINT-014-8
- **type:** scope_deviation
- **source:** TASK-576 (executor)
- **severity:** low
- **status:** resolved
- **location:** main/src/services/__tests__/dockBadgeService.test.ts:35
- **description:** Claimed outside files_owned to meet AC: getName() mock returning Crystal. Claim granted by claim-file.js.
- **resolved_by:** verifier — AC-prescribed: AC3's broad sweep of `main/src/` catches the bare-word Crystal in this mock string, mirroring the AC1 setup.ts getName() flip. The dockBadgeService test mock holds the same kind of stale product-name assertion AC1 targets.

## FIND-SPRINT-014-9
- **type:** scope_deviation
- **source:** TASK-576 (executor)
- **severity:** low
- **status:** resolved
- **location:** main/src/orchestrator/mcpServer/scriptPath.ts:8
- **description:** Claimed outside files_owned to meet AC: Crystal name in JSDoc comment. Claim granted by claim-file.js.
- **resolved_by:** verifier — AC-prescribed: AC3 sweeps all `main/src/` files for bare-word Crystal; scriptPath.ts:8 contained a JSDoc Crystal reference outside every allowlist category and had to be rewritten to satisfy AC3.

## FIND-SPRINT-014-10
- **type:** bug
- **source:** TASK-576 (executor)
- **severity:** medium
- **status:** resolved
- **location:** main/src/types/config.ts:52, main/src/ipc/file.ts:237,273, main/src/services/commitManager.ts:100,104, main/src/services/worktreeManager.ts:649
- **description:** These files contain prose comments with bare-word Crystal (Crystal footer, Crystal commit footer setting) that are caught by the TASK-576 AC grep but cannot be fixed because claim-file.js denies them as owned by TASK-561. TASK-561 only renames enableCrystalFooter/disableCrystalFooter symbols and will not fix these prose comments. The TASK-576 AC (zero Crystal refs outside allowlist) will fail on these lines until TASK-561 or a follow-up task addresses them.
- **suggested_action:** TASK-561 executor should also sweep Crystal footer prose comments in the 4 files it owns, or a post-merge follow-up task should clean them.
- **resolved_by:** verifier — status-sync: TASK-561 (executor swept Crystal→Cyboflow prose in all four files: config.ts:52, ipc/file.ts:237/240/273/276, commitManager.ts:100/103, worktreeManager.ts:649/652; grep for "Crystal footer|Crystal commit footer" across these files returns zero)

## FIND-SPRINT-014-11
- **type:** bug
- **source:** TASK-576 (executor)
- **severity:** low
- **status:** resolved
- **location:** main/src/services/permissionManager.ts:8,11
- **description:** Contains Crystal-era and Crystal- prose in JSDoc (Crystal-era equivalent, Crystal- prefix describing the interface origin). claim-file.js denies claiming this file as owned by TASK-579. TASK-579 executor should also sweep these prose comments when modifying permissionManager.ts.
- **resolved_by:** TASK-579

## FIND-SPRINT-014-12
- **type:** claude-md
- **source:** TASK-566 (verifier)
- **severity:** low
- **status:** open
- **location:** .soloflow/active/plans/crystal-cuts-and-rebrand/TASK-566-plan.md (AC6)
- **description:** AC6 is internally inconsistent with the plan body. The frontmatter requires "the file count touched by this task is exactly 2 (helper file + index.ts)", but plan Step 8 explicitly prescribes creating main/src/utils/devDebugLog.test.ts (a third file) and the frontmatter test_strategy.targets lists that test file as required. A planner who writes mandatory test files in the body should account for them in AC file counts. The executor commit (3dd37a5) correctly touched 3 files (devDebugLog.ts, devDebugLog.test.ts, index.ts) per the plan body — verifier treats AC6 as a planner defect and approves.
- **suggested_action:** Future plans with mandated test files should set the file-count AC to N+1 (helper + test + integration site), or omit the file-count assertion when test files are listed in test_strategy.targets. Consider updating the planner prompt / CODE-PATTERNS doc to enforce this consistency.

## FIND-SPRINT-014-13
- **type:** scope_deviation
- **source:** TASK-576 (executor)
- **severity:** low
- **status:** resolved
- **location:** main/src/services/permissionManager.ts:8,11
- **description:** Force-claimed from TASK-579 (pending/not-started) per orchestrator directive to fix 2 prose Crystal references (L8, L11) blocking AC3. TASK-579 plans to delete this file entirely; these edits are safe to make ahead of that deletion.
- **resolved_by:** TASK-579

## FIND-SPRINT-014-14
- **type:** anti-pattern
- **source:** TASK-576 (code-reviewer)
- **severity:** low
- **status:** resolved
- **location:** main/src/services/permissionManager.ts:8-11
- **description:** Semantic degradation from the force-claim rewrite (FIND-13). The original JSDoc drew a contrast: the legacy `PermissionRequest`/`PermissionResponse` types here are *Crystal-era* (inherited, pre-Cyboflow) and diverge from the *new* canonical Cyboflow contract in `shared/types/approval.ts`. By replacing both "Crystal-era" occurrences with "Cyboflow-era", the comment now labels the legacy types with the same epoch as the canonical replacement, collapsing the distinction. Reads as: "these Cyboflow-era types diverge from the canonical contract... `sessionId` is the Cyboflow-era equivalent of `ApprovalRequest.runId`" — but `ApprovalRequest.runId` is itself the Cyboflow-substrate name, so the equivalence is now circular. Strict adherence to the bare-word sweep wins over comment precision. Acceptable trade-off because the file is dead code scheduled for deletion in TASK-579 and the comment will exist for a short time.
- **suggested_action:** When TASK-579 deletes this file, the issue self-resolves. Alternatively, a follow-up could reword to "The interfaces below are *legacy* / *inherited* types and diverge from the canonical Cyboflow substrate contract... `sessionId` is the legacy equivalent of `ApprovalRequest.runId`" to restore the contrast without reintroducing the bare word "Crystal".
- **resolved_by:** TASK-579

## FIND-SPRINT-014-15
- **type:** bug
- **source:** TASK-561 (code-reviewer)
- **severity:** low
- **status:** open
- **location:** main/src/types/config.ts:101 vs frontend/src/components/Settings.tsx:140 / main/src/ipc/config.ts:15
- **description:** Pre-existing schema mismatch faithfully preserved by TASK-561's rename. `UpdateConfigRequest` declares the footer-toggle field as `disableCyboflowFooter?: boolean` (inverted polarity from `AppConfig.enableCyboflowFooter`), but every actual call site sends the positive form: `Settings.tsx:140` submits `{ enableCyboflowFooter }` through `API.config.update`, which is typed as `UpdateConfigRequest`. The handler at `main/src/ipc/config.ts:15` accepts the typed payload and forwards it to `configManager.updateConfig(updates)`, which spreads it onto `this.config` — so the wrong-named-but-correctly-shaped field lands on `AppConfig.enableCyboflowFooter` by accident. The `disableCyboflowFooter` slot on `UpdateConfigRequest` is dead. TASK-561 renamed the symbol but did not introduce this — it has been broken since the original Crystal codebase (`disableCrystalFooter` vs `enableCrystalFooter`).
- **suggested_action:** Remove `disableCyboflowFooter?: boolean` from `UpdateConfigRequest` and add `enableCyboflowFooter?: boolean` instead, so the IPC contract matches what the renderer actually sends. This also exposes the existing call-site to typecheck enforcement (today the mismatch is invisible because the spread accepts any extra field).
- **resolved_by:** 

## FIND-SPRINT-014-16
- **type:** bug
- **source:** TASK-577 (verifier)
- **severity:** medium
- **status:** open
- **location:** .soloflow/worktrees/TASK-577/node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3/build/Release/better_sqlite3.node (worktree-local node_modules)
- **description:** `pnpm --filter main exec vitest run` in the TASK-577 worktree fails 14 test files / 116 tests with `Error: ...better_sqlite3.node was compiled against a different Node.js version using NODE_MODULE_VERSION 136. This version of Node.js requires NODE_MODULE_VERSION 127`. Identical failure pattern on the parent commit (ae78e34^) — pre-existing environmental drift, not caused by TASK-577's 5-line env-object literal edit. CLAUDE.md prescribes `pnpm electron:rebuild` as the fix. AC4 ("pnpm --filter main test exits with status 0") cannot pass until the worktree's better-sqlite3 binding is rebuilt against the Node version vitest is running under. The task's typecheck gate passes cleanly (exit 0), and the grep ACs (1–3) all pass.
- **suggested_action:** Operator runs `pnpm electron:rebuild` (or `pnpm install --force` followed by `pnpm electron:rebuild`) inside `.soloflow/worktrees/TASK-577` before the test gate is re-asserted. Alternatively: rebuild against the host Node and re-run `pnpm --filter main test`. The same environmental issue likely affects all sibling parallel worktrees on SPRINT-014 — investigate whether the parent-checkout's better-sqlite3 build is being shared into worktrees in a stale state.
- **resolved_by:** 

## FIND-SPRINT-014-17
- **source:** SPRINT-014 (sprint-code-reviewer)
- **type:** bug
- **severity:** high
- **status:** open
- **location:** main/src/ipc/git.ts:315
- **description:** `sessions:git-commit` IPC handler ignores user `enableCyboflowFooter` setting — `buildGitCommitCommand(message)` is called without the flag, so it always falls back to the default `enableCyboflowFooter: boolean = true` and appends the Cyboflow commit footer regardless of user preference.
- **suggested_action:** In `main/src/ipc/git.ts` `sessions:git-commit` handler: import configManager, read `config?.enableCyboflowFooter !== false`, and pass that as the second arg to `buildGitCommitCommand(message, enableCyboflowFooter)`. Add a unit test that flips the config to false and asserts the constructed command contains no footer text. Optional belt-and-braces: change the default in `buildGitCommitCommand` signature from `= true` to required, forcing every caller to make the choice explicit (caught at typecheck).
- **resolved_by:** 









The sibling commit IPC handler in `main/src/ipc/file.ts:237-243` correctly reads the config and threads `enableCyboflowFooter` through. Two live commit IPC handlers now disagree on whether to honor the toggle — flipping the Settings checkbox suppresses the footer for `git:commit` (file.ts) but not for `sessions:git-commit` (git.ts).

Suspected tasks: TASK-561 (rename of enableCrystalFooter → enableCyboflowFooter swept config/file.ts/commitManager.ts/worktreeManager.ts but missed the git.ts caller), TASK-565 (introduced buildCommitFooter helper but the duplicate code path through buildGitCommitCommand kept its `= true` default).

## FIND-SPRINT-014-18
- **source:** SPRINT-014 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/services/commitManager.ts:101-102,210-211; main/src/ipc/file.ts:238-239,274-275; main/src/services/worktreeManager.ts:650-651
- **description:** The `enableCyboflowFooter` config lookup is duplicated 5 times across 3 files with the identical 2-line pattern:
- **suggested_action:** Add `isCommitFooterEnabled(configManager): boolean` (or `getCommitFooter(configManager): string`) helper to `main/src/utils/commitFooter.ts`. Replace the 5 duplicated lookups. Co-locates the default-true policy with the footer string so the implicit `!== false` (defaults to true when unset) is documented once. Net diff: -10 lines, +5 lines.
- **resolved_by:** 







```
const config = (this.)configManager?.getConfig();
const enableCyboflowFooter = config?.enableCyboflowFooter !== false;
```

TASK-565 extracted `buildCommitFooter(enabled)` to one site but left every caller still doing the config lookup. TASK-561 renamed the field but did not consolidate the lookup. Net effect across the sprint: the *footer string* is now centralized, but the *enabled-decision boilerplate* is just as duplicated as before.

Suspected tasks: TASK-561 (rename), TASK-565 (extract buildCommitFooter).

## FIND-SPRINT-014-19
- **source:** SPRINT-014 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/utils/shellEscape.ts:29-30; main/src/ipc/file.ts:242-243,277-278; main/src/services/worktreeManager.ts:654-655
- **description:** The compose-footer-with-message pattern is duplicated 4 times across 3 files:
- **suggested_action:** Add `appendCommitFooter(message: string, enabled: boolean): string` to `main/src/utils/commitFooter.ts` that wraps the bare `buildCommitFooter` + ternary composition. Either replace all 4 sites with this helper, or fold the entire concern into the existing `buildGitCommitCommand` for the shellEscape.ts site. Supersedes/subsumes FIND-SPRINT-014-6.
- **resolved_by:** 






```
const footer = buildCommitFooter(enableCyboflowFooter);
const fullMessage = footer ? `${message}\n\n${footer}` : message;
```

TASK-565 extracted `buildCommitFooter` but left the "append-with-blank-line if non-empty" composition repeated at every caller. FIND-6 (already in the queue) flagged this for the two IPC handlers in file.ts only — the sprint view shows the pattern is broader (shellEscape.ts and worktreeManager.ts have it too).

Suspected tasks: TASK-565 (introduced helper but did not include the compose step).

## FIND-SPRINT-014-20
- **source:** SPRINT-014 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/utils/crystalDirectory.ts
- **description:** The `crystalDirectory.ts` backward-compat shim created by TASK-562 has zero in-tree consumers. Verified via `grep -rn "from .*crystalDirectory" --include="*.ts" --include="*.tsx"` and `grep -rn "getCrystalDirectory|getCrystalSubdirectory|setCrystalDirectory"` — both return only the shim file itself.
- **suggested_action:** Delete `main/src/utils/crystalDirectory.ts`. The `--crystal-dir` CLI flag aliasing in `main/src/index.ts:120-137` is independent of the module shim and should stay (that handles end-user invocation, not in-tree imports). Add a one-line note to docs/CODE-PATTERNS.md or the migration changelog if user-facing deprecation tracking is desired.
- **resolved_by:** 






The shim is annotated @deprecated and re-exports three symbols (`getCrystalDirectory`, `getCrystalSubdirectory`, `setCrystalDirectory`) that nothing imports. TASK-562 also rewrote `scriptPath.ts` (FIND-1) to import from the new module, eliminating the last potential caller. Since cyboflow is pre-1.0 with no external API, there is no external consumer either.

Suspected tasks: TASK-562 (introduced the shim defensively but the rename was complete in the same task).

## FIND-SPRINT-014-21
- **source:** SPRINT-014 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** docs/CODE-PATTERNS.md (Shared Utilities section)
- **description:** Two new shared utilities introduced in SPRINT-014 are not registered in `docs/CODE-PATTERNS.md`:
- **suggested_action:** Append two entries to `docs/CODE-PATTERNS.md` `Shared Utilities` section in the existing format (Path/Use it for/Canonical example), one per new helper. devDebugLog canonical example: `main/src/index.ts:38,100-110,236-396` (console wrapper). commitFooter canonical example: `main/src/utils/shellEscape.ts:29` (the buildGitCommitCommand wrapper).
- **resolved_by:** 





1. `main/src/utils/devDebugLog.ts` (TASK-566) — exports `getDevDebugLogPath(stream)` and `appendDevDebugLog(stream, level, source, message, originalConsole?)`. Centralizes the cyboflow-{frontend,backend}-debug.log filename literals; future rebrand or relocation touches one file.
2. `main/src/utils/commitFooter.ts` (TASK-565) — exports `buildCommitFooter(enabled)`. Holds the canonical Cyboflow footer string; per the test file (`commitFooter.test.ts`) the byte-level equality check is the contract.

CODE-PATTERNS.md `Shared Utilities` section is the documented home for these — it currently lists `cn`, `mutex`, `simpleTaskQueue`, `logger`, `api`, `trpcClient`, `migrateLocalStorageKey`. Future agents reading the patterns doc will reinvent these helpers.

Suspected tasks: TASK-565, TASK-566.

## FIND-SPRINT-014-22
- **source:** SPRINT-014 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/index.ts:244-437 (console.log/error/warn/info/debug overrides)
- **description:** TASK-566 extracted the dev-debug-log filename/path literals but left the surrounding 5 console-override bodies still ~95% duplicated. Each of `console.log`, `console.error`, `console.warn`, `console.info`, `console.debug` (lines ~244-437) hand-builds the same args-to-string formatter:
- **suggested_action:** Add `formatConsoleArgs(args: unknown[]): string` to `main/src/utils/devDebugLog.ts` (or a new `consoleFormat.ts` if you prefer separation of concerns). Replace the 5 console-override formatter blocks. Net diff: ~ -60 lines, +10 lines. Reuses the same single point of truth for object/Error/circular-ref formatting that the renderer-forwarding code, the logger, and the devDebugLog already share.
- **resolved_by:** 



```
const message = args.map(arg => {
  if (typeof arg === "object" && arg !== null) {
    if (arg instanceof Error) return `Error: ${arg.message}\nStack: ${arg.stack}`;
    try { return JSON.stringify(arg, null, 2); } catch (e) { return `[Object with circular structure: ${arg.constructor?.name || "Object"}]`; }
  }
  return String(arg);
}).join(" ");
```

Roughly 60 lines of duplicated formatting code remain across the 5 overrides. TASK-566 had a chance to also extract `formatConsoleArgs(args): string` as a sibling helper to `appendDevDebugLog` — the two are always called in sequence inside each override.

Suspected tasks: TASK-566 (scope was log-helper only, did not extend to the args formatter).

## FIND-SPRINT-014-23
- **source:** SPRINT-014 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/services/executionTracker.ts:7
- **description:** Dead import: `import { buildGitCommitCommand } from "../utils/shellEscape";` — `buildGitCommitCommand` is referenced exactly once in the file (the import) and is never called. Verified via `grep -c buildGitCommitCommand main/src/services/executionTracker.ts` → 1.
- **suggested_action:** Delete the import in `main/src/services/executionTracker.ts:7`. `pnpm lint` would catch this with the `no-unused-vars` rule — also worth confirming whether the rule is currently configured (the dead import means it is not, or is downgraded to warn).
- **resolved_by:** 



Not introduced by this sprint, but TASK-561 swept every `enableCrystalFooter` / `buildGitCommitCommand` call site and is the natural moment to notice the orphan. Importing a function that builds a git-commit shell command without using it carries a slight footgun risk (someone copy-paste reuses it without the safe-default-true argument).

Suspected tasks: TASK-561 (made a sweep over buildGitCommitCommand callers but did not include this orphaned import).

## FIND-SPRINT-014-24
- **source:** SPRINT-014 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/index.ts:120-137
- **description:** The --cyboflow-dir / --crystal-dir CLI flag parser has two near-identical branches (one for the `--flag=value` form, one for the `--flag value` form), each with its own deprecation-warning branch. Net: 18 lines of imperative parsing with the deprecation message repeated twice.
- **suggested_action:** Refactor to a single normalize step at the top of the parse loop: collect `(flagName, value)` pairs from either form, then a single switch on the canonical flag. Or use a tiny argv helper. Net diff: -10 lines, +6 lines, one deprecation-warning site instead of two. Not blocking; cosmetic but the surface will grow as more cyboflow-* flags appear.
- **resolved_by:** 


TASK-562 added this defensively for backward compat, but the dual-form duplication makes future flag changes (e.g. adding `--cyboflow-data-dir`) error-prone — any new pair would need 4 branches.

Suspected tasks: TASK-562.

## FIND-SPRINT-014-25
- **source:** SPRINT-014 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/services/terminalSessionManager.ts:41-48 vs main/src/services/terminalPanelManager.ts:47-61
- **description:** Two terminal manager classes spawn PTY subprocesses with divergent env-var contracts:

1. `terminalPanelManager.ts` (TASK-577 just updated) — sets both legacy `CRYSTAL_SESSION_ID`/`CRYSTAL_PANEL_ID` and canonical `CYBOFLOW_SESSION_ID`/`CYBOFLOW_PANEL_ID`.
2. `terminalSessionManager.ts` (untouched this sprint) — sets neither. Used live by `sessionManager.ts:1556` for the legacy per-session terminal pathway.

User shell scripts relying on these env vars will see them present in panel-mode terminals and absent in session-mode terminals — same product feature ("a cyboflow terminal"), inconsistent contract. Not a regression (terminalSessionManager has never set them), but the inconsistency is now visible because TASK-577 codified the dual-set as policy in only one of the two managers.

Suspected tasks: TASK-577 (codified the env-var contract on one of two parallel managers).
- **suggested_action:** Either (a) mirror the dual-set into `terminalSessionManager.ts` so both pathways expose the session/panel env vars consistently, or (b) annotate `terminalSessionManager.ts` with `@cyboflow-hidden` if the plan is to delete it as part of the panel-migration epic, with a TODO referencing the deletion task. If (a), also add a shared helper `buildCyboflowSessionEnv(sessionId, panelId?)` to avoid a third copy of the same key set.
- **resolved_by:** 
