---
sprints: [SPRINT-014]
span_label: SPRINT-014
created: 2026-05-17T23:50:00.000Z
counters_start:
  ideas: 16
summary:
  cleanups: 4
  backlog_tasks: 7
  claude_md: 3
  soloflow_improvements: 0
---

# Compound Proposal — SPRINT-014

SPRINT-014 was the `crystal-cuts-and-rebrand` epic (TASK-560/561/562/565/566/576/577/579).
Eight tasks completed, all code-reviewer CLEAN, all verifiers APPROVED (TASK-577 with one
deferred ABI check already in the human-review-queue). The sprint-code-reviewer surfaced one
high-severity bug and five medium-severity improvement opportunities across the post-merge
view; those dominate the B bucket.

---

## A. Clean-up items (execute now)

### A1. Fix `sessions:git-commit` IPC handler to honor `enableCyboflowFooter` toggle
- **Summary:** `buildGitCommitCommand(message)` in `git.ts:315` omits the `enableCyboflowFooter` argument, so every commit via the session-terminal pathway appends the Cyboflow footer regardless of the user's Settings checkbox.
- **Source-Sprint:** SPRINT-014
- **Rationale:** This is an active user-visible bug — flipping "Include Cyboflow footer in commits" in Settings suppresses the footer for the `git:commit` path (`file.ts:237`) but not for the `sessions:git-commit` path (`git.ts:315`). Two live commit IPC handlers now disagree on the same user preference. TASK-561 swept all `enableCrystalFooter` → `enableCyboflowFooter` renaming sites and TASK-565 extracted `buildCommitFooter`, but neither caught that `buildGitCommitCommand`'s second parameter has a `= true` default that silently absorbs the omission. The sprint-code-reviewer flagged this as high severity (FIND-SPRINT-014-17).
- **Blast radius:** `main/src/ipc/git.ts` (one function call site changed, one import added), optional: `main/src/utils/shellEscape.ts` signature hardening. Risk: low — mirrors the pattern already used in `file.ts:237-243`.
- **Source:** FIND-SPRINT-014-17 (sprint-code-reviewer); TASK-565-done.md (introduced `buildCommitFooter` but left `buildGitCommitCommand` default untouched); TASK-561-done.md (swept callers but missed `git.ts`).
- **Proposed change:**
  ```diff
  // main/src/ipc/git.ts  (near top of file — add import alongside existing configManager import)
  + import { configManager } from "../services/configManager";

  // main/src/ipc/git.ts:315  (inside the sessions:git-commit handler, before the command is built)
  - const command = buildGitCommitCommand(message);
  + const config = configManager.getConfig();
  + const enableCyboflowFooter = config?.enableCyboflowFooter !== false;
  + const command = buildGitCommitCommand(message, enableCyboflowFooter);
  ```
  Belt-and-braces (strongly recommended): change the `buildGitCommitCommand` second parameter
  default from `= true` to required so typecheck catches any future caller that omits it:
  ```diff
  // main/src/utils/shellEscape.ts
  - export function buildGitCommitCommand(message: string, enableCyboflowFooter: boolean = true): string {
  + export function buildGitCommitCommand(message: string, enableCyboflowFooter: boolean): string {
  ```
  Add a unit test in `main/src/utils/__tests__/shellEscape.test.ts` (or alongside `git.ts`) that
  constructs the handler with `enableCyboflowFooter: false` in the config and asserts the built
  command contains no footer text.

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `git.ts:315` calls `buildGitCommitCommand(message)` without the footer flag while `file.ts:238-243` correctly reads `enableCyboflowFooter` from configManager — this is an active user-visible Settings-toggle bug that two IPC handlers disagree on, fix is a 3-line localized change matching the existing file.ts pattern.

### A2. Delete zero-consumer `crystalDirectory.ts` backward-compat shim
- **Summary:** `main/src/utils/crystalDirectory.ts` is a `@deprecated` re-export shim with zero in-tree consumers; it can be deleted safely.
- **Source-Sprint:** SPRINT-014
- **Rationale:** TASK-562 created the shim defensively, but in the same task it also rewrote the last in-tree consumer (`scriptPath.ts`, FIND-SPRINT-014-1) to import from `cyboflowDirectory`. Confirmed via `grep -rn "from .*crystalDirectory"` and `grep -rn "getCrystalDirectory|getCrystalSubdirectory|setCrystalDirectory"` — both return only the shim file itself. Cyboflow is pre-1.0 with no external API surface, so there is no external consumer to protect. The `--crystal-dir` CLI alias in `main/src/index.ts:120-137` is independent of the module shim and should stay. (FIND-SPRINT-014-20.)
- **Blast radius:** `main/src/utils/crystalDirectory.ts` (delete one file, 16 lines). Risk: trivial — shim has zero import sites.
- **Source:** FIND-SPRINT-014-20 (sprint-code-reviewer); TASK-562-done.md outcome section.
- **Proposed change:**
  ```
  Delete: main/src/utils/crystalDirectory.ts
  Verify: grep -rn "from.*crystalDirectory" main/src frontend/src returns zero results
  Keep:   main/src/index.ts:120-137 (--crystal-dir CLI alias, unrelated to the module shim)
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** `grep -rn "from.*crystalDirectory"` across `main/src` and `frontend/src` returns zero results (only matches are the shim's own export-declaration lines), confirming zero consumers — deleting one file with 16 lines and no callers is risk-trivial.

### A3. Remove dead import of `buildGitCommitCommand` in `executionTracker.ts`
- **Summary:** `main/src/services/executionTracker.ts:7` imports `buildGitCommitCommand` from `shellEscape` but never calls it; delete the unused import.
- **Source-Sprint:** SPRINT-014
- **Rationale:** Verified by `grep -c buildGitCommitCommand main/src/services/executionTracker.ts` → 1 (import line only). TASK-561 swept all `buildGitCommitCommand` callers but did not scan for orphaned imports. Leaving it is a footgun: someone copy-pasting from this file gets the function without the safe-call pattern. (FIND-SPRINT-014-23.)
- **Blast radius:** `main/src/services/executionTracker.ts` (delete one import line). Risk: trivial.
- **Source:** FIND-SPRINT-014-23 (sprint-code-reviewer); TASK-561-done.md (swept callers but missed the orphan).
- **Proposed change:**
  ```diff
  // main/src/services/executionTracker.ts:7
  - import { buildGitCommitCommand } from "../utils/shellEscape";
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** `grep -c buildGitCommitCommand main/src/services/executionTracker.ts` confirms exactly 1 occurrence (the import line, no calls); deleting one orphan import line is the smallest possible fix and lint would otherwise flag it on touch.

### A4. Fix `UpdateConfigRequest` polarity mismatch: `disableCyboflowFooter` → `enableCyboflowFooter`
- **Summary:** `UpdateConfigRequest` in `main/src/types/config.ts` declares `disableCyboflowFooter?: boolean` (inverted name) while every actual call site sends `enableCyboflowFooter`; the slot `disableCyboflowFooter` is dead and the mismatch is invisible to typecheck.
- **Source-Sprint:** SPRINT-014
- **Rationale:** `Settings.tsx:140` submits `{ enableCyboflowFooter }` via `API.config.update`, which is typed as `UpdateConfigRequest`. The IPC config handler spreads the payload onto `AppConfig`, so the correct key lands by accident (object spread picks up `enableCyboflowFooter` directly). The `disableCyboflowFooter` slot on `UpdateConfigRequest` is dead code that pre-dates the Crystal fork; TASK-561 renamed the symbol but preserved the polarity inversion. Fixing it makes the IPC contract self-consistent and typecheck-enforceable. (FIND-SPRINT-014-15.)
- **Blast radius:** `main/src/types/config.ts` (one field rename in `UpdateConfigRequest`), `main/src/ipc/config.ts:15` (verify spread still works — it should, field names now match). Risk: low — functionally no-op (spread behavior unchanged), but typecheck will now catch mismatches.
- **Source:** FIND-SPRINT-014-15 (TASK-561 code-reviewer); TASK-561-done.md findings section.
- **Proposed change:**
  ```diff
  // main/src/types/config.ts — UpdateConfigRequest interface
  - disableCyboflowFooter?: boolean;
  + enableCyboflowFooter?: boolean;
  ```
  After applying, run `pnpm typecheck` — if any call site was sending `disableCyboflowFooter`
  (unlikely given the grep evidence), typecheck will surface it immediately.

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `disableCyboflowFooter` at config.ts:101 has zero consumers across `main/src` and `frontend/src` while Settings.tsx:140 sends `enableCyboflowFooter` — fix is a one-line rename that makes the IPC contract typecheck-enforceable for free.

---

## B. Backlog tasks (refine into execution-ready plans)

### B1. Consolidate commit-footer config-lookup boilerplate into `commitFooter.ts`
- **Summary:** The two-line `configManager?.getConfig() / enableCyboflowFooter !== false` lookup pattern is duplicated 5 times across 3 files; extract a single `isCommitFooterEnabled(configManager)` helper to `commitFooter.ts`.
- **Source-Sprint:** SPRINT-014
- **Source:** FIND-SPRINT-014-18 (sprint-code-reviewer); TASK-565-done.md (introduced `buildCommitFooter` but left the lookup pattern unreduced); TASK-561-done.md (renamed field, did not consolidate).
- **Problem:** The pattern:
  ```typescript
  const config = (this.)configManager?.getConfig();
  const enableCyboflowFooter = config?.enableCyboflowFooter !== false;
  ```
  appears at `main/src/services/commitManager.ts:101-102,210-211`, `main/src/ipc/file.ts:238-239,274-275`, and `main/src/services/worktreeManager.ts:650-651`. TASK-565 centralized the footer *string* in `commitFooter.ts`, but the *enabled-decision boilerplate* (including the `!== false` default-true policy) is still repeated at every call site. The default-true policy is currently documented nowhere; if it changes, 5 sites need updating.
- **Proposed direction:** Add `isCommitFooterEnabled(configManager: ConfigManager | null | undefined): boolean` to `main/src/utils/commitFooter.ts`. The function reads `configManager?.getConfig()?.enableCyboflowFooter !== false` and returns the result. Replace all 5 duplicated lookup pairs with a single call. Update `commitFooter.test.ts` with a case for the helper. Consider making the parameter accept the resolved config object instead of the manager (avoids the double-optional chain and makes testing simpler). Estimated net diff: -10 lines, +5 lines across 4 files.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed the `configManager?.getConfig() / enableCyboflowFooter !== false` pair appears verbatim at commitManager.ts:101-102, 210-211; file.ts:238-239, 274-275; worktreeManager.ts:650-651 — 5 sites of an identical 2-line policy decision, which centralizes the default-true contract for an existing helper file without adding new abstractions.
- **Counterfactual:** Would flip to DONT_IMPLEMENT if the 5 sites were diverging (different default policies) — but they are identical, which is exactly the consolidation case.

### B2. Extract `appendCommitFooter` helper to eliminate 4 footer-composition duplicates
- **Summary:** The `buildCommitFooter(enabled)` + ternary composition pattern is duplicated 4 times across 3 files; add `appendCommitFooter(message, enabled)` to `commitFooter.ts` and replace all call sites.
- **Source-Sprint:** SPRINT-014
- **Source:** FIND-SPRINT-014-19 (sprint-code-reviewer, supersedes FIND-SPRINT-014-6); TASK-565-done.md (extracted `buildCommitFooter` but left the compose step repeated).
- **Problem:** The two-line pattern:
  ```typescript
  const footer = buildCommitFooter(enableCyboflowFooter);
  const fullMessage = footer ? `${message}\n\n${footer}` : message;
  ```
  is duplicated at `main/src/utils/shellEscape.ts:29-30`, `main/src/ipc/file.ts:242-243`, `main/src/ipc/file.ts:277-278`, and `main/src/services/worktreeManager.ts:654-655`. TASK-565 extracted the footer string but left the "append with blank line if non-empty" composition repeated at every caller.
- **Proposed direction:** Add `appendCommitFooter(message: string, enabled: boolean): string` to `main/src/utils/commitFooter.ts`. Body: `const footer = buildCommitFooter(enabled); return footer ? \`${message}\n\n${footer}\` : message;`. Replace all 4 call sites. The `shellEscape.ts` site (`buildGitCommitCommand`) can fold the composition entirely inside `buildGitCommitCommand`'s body so callers just pass the message and the enabled flag. Add a test case for the helper. This task should be coordinated with or sequenced after B1 (same file, related patterns).
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed the `footer ? message\n\n${footer} : message` composition appears verbatim at shellEscape.ts:29-30, file.ts:242-243 and 277, and worktreeManager.ts:654-655 — these are formatting-contract-critical (blank-line separator) duplicates and centralizing them in the same file as `buildCommitFooter` is proportional.

### B3. Extract `formatConsoleArgs` helper to deduplicate 5 console-override formatters in `index.ts`
- **Summary:** The args-to-string formatter body is copy-pasted verbatim across the 5 `console.log/error/warn/info/debug` overrides in `main/src/index.ts`; extract it to `devDebugLog.ts` as `formatConsoleArgs(args: unknown[]): string`.
- **Source-Sprint:** SPRINT-014
- **Source:** FIND-SPRINT-014-22 (sprint-code-reviewer); TASK-566-done.md (scope was log-helper only, formatter extraction was out of scope).
- **Problem:** Each of the 5 console overrides at `main/src/index.ts:244-437` contains an identical block:
  ```typescript
  const message = args.map(arg => {
    if (typeof arg === "object" && arg !== null) {
      if (arg instanceof Error) return `Error: ${arg.message}\nStack: ${arg.stack}`;
      try { return JSON.stringify(arg, null, 2); } catch (e) { return `[Object with circular structure: ${arg.constructor?.name || "Object"}]`; }
    }
    return String(arg);
  }).join(" ");
  ```
  Approximately 60 lines of duplicated formatting code remain after TASK-566. TASK-566 had the natural opportunity to extract `formatConsoleArgs` as a sibling to `appendDevDebugLog` — the two are always called in sequence inside each override.
- **Proposed direction:** Add `formatConsoleArgs(args: unknown[]): string` to `main/src/utils/devDebugLog.ts` (or a new `main/src/utils/consoleFormat.ts` if separation of concerns is preferred). Replace the 5 mapper blocks in `main/src/index.ts`. Add a unit test covering the `object`, `Error`, `circular-ref`, and `primitive` branches. Estimated net diff: -60 lines, +10 lines. The `unknown[]` parameter type satisfies the existing `@typescript-eslint/no-explicit-any` rule without modification.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Read confirms `console.error`, `console.warn`, `console.info`, and `console.debug` in index.ts:289-422 each contain the identical 14-line args.map(arg => ...) block with Error/circular-ref handling (console.log uses a simpler form) — extracting to an existing utility file consolidates 4 verbatim copies of a formatting policy that already-existing devDebugLog.ts naturally houses.
- **Counterfactual:** Would flip to DONT_IMPLEMENT if proposal added a new file rather than extending devDebugLog.ts — the new-file option mentioned is the wrong choice.

### B4. Fix `IPCResponse<T = any>` default that silently bypasses TypeScript IPC contract enforcement
- **Summary:** `IPCResponse<T = any>` in `frontend/src/types/electron.d.ts:22` allows IPC response field renames to go undetected by typecheck; change the default to `unknown` or require explicit shapes per endpoint.
- **Source-Sprint:** SPRINT-014
- **Source:** FIND-SPRINT-014-2 (TASK-562 verifier); TASK-562-done.md (detected when `AboutDialog.tsx` `result.data.crystalDirectory` field rename was not caught by typecheck).
- **Problem:** During TASK-562, the `crystalDirectory` → `cyboflowDirectory` field rename on the IPC payload was not surfaced by `pnpm typecheck` because `IPCResponse<T = any>` defaults T to `any`, and `any` accepts any field access. The correct way to access the renamed field was discovered only through runtime observation. Future IPC field renames in any of the `ipcMain.handle` domains will have the same silent-break risk. The `no-explicit-any` ESLint rule bans explicit `any` in user code but cannot catch a `= any` generic default in a declaration file.
- **Proposed direction:** There are two valid approaches: (a) change `IPCResponse<T = any>` to `IPCResponse<T = unknown>` and update every consumer to add an explicit type parameter or a type guard before accessing `result.data` fields — this is the minimal change and makes the default at least safe-ish; (b) replace the generic wrapper with per-endpoint discriminated types generated from the IPC handler map (more thorough, larger scope). Option (a) is preferred as a first step. Audit all consumers of `IPCResponse` via `grep -rn "IPCResponse" frontend/src main/src` and `grep -rn "result\.data\." frontend/src` to enumerate the sites needing explicit type parameters.
- **Scope:** medium

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed concrete harm (TASK-562 ran into the silent rename bug) and grep shows 151 IPCResponse sites in frontend/src with 20 `result.data.` accesses — but App.tsx:34 already defines its own `IPCResponse<T = unknown>` locally, proving the safer default is a viable pattern; refining as a backlog task (not executing now) lets the planner scope the fanout properly.
- **Counterfactual:** Would flip to DONT_IMPLEMENT if execution were proposed in-line; medium-scope IPC refactor needs planner sequencing, which the backlog target provides.

### B5. Mirror `CYBOFLOW_SESSION_ID`/`CYBOFLOW_PANEL_ID` env vars into `terminalSessionManager.ts`
- **Summary:** TASK-577 added dual-set CYBOFLOW_*/CRYSTAL_* env vars to `terminalPanelManager.ts` but the sibling `terminalSessionManager.ts` (used by the per-session terminal pathway) still sets neither, producing inconsistent env contracts across two live terminal modes.
- **Source-Sprint:** SPRINT-014
- **Source:** FIND-SPRINT-014-25 (sprint-code-reviewer); TASK-577-done.md (codified the env-var contract on one of two parallel managers).
- **Problem:** `terminalPanelManager.ts:47-61` (updated by TASK-577) now sets both `CRYSTAL_SESSION_ID`/`CRYSTAL_PANEL_ID` (deprecated) and `CYBOFLOW_SESSION_ID`/`CYBOFLOW_PANEL_ID` (canonical). `terminalSessionManager.ts:41-48` (untouched) sets neither. `sessionManager.ts:1556` uses `terminalSessionManager` for the legacy per-session terminal pathway, which is a live code path. User shell scripts or CI scripts that rely on `CYBOFLOW_SESSION_ID` will find it present in panel-mode terminals and absent in session-mode terminals — same product feature, inconsistent contract.
- **Proposed direction:** Either (a) mirror the dual-set block into `terminalSessionManager.ts` PTY spawn options, and extract a shared `buildCyboflowTerminalEnv(sessionId: string, panelId?: string): Record<string, string>` helper to avoid a third copy of the key set; or (b) annotate `terminalSessionManager.ts` with `@cyboflow-hidden` if the file is scheduled for deletion as part of the panel-migration epic, and add a TODO referencing the deletion task. If option (a), place the shared helper in `main/src/utils/terminalEnv.ts` and import it from both managers.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed `terminalSessionManager.ts:41-48` env block sets WORKTREE_PATH, TERM, COLORTERM, LANG but neither CYBOFLOW_SESSION_ID nor CRYSTAL_SESSION_ID, while `terminalPanelManager.ts:47-60` sets all four — and sessionManager.ts:1556 confirms terminalSessionManager is a live code path, so user shell scripts will see inconsistent env contracts across two terminal modes for the same product feature.

### B6. Settle branding decisions: UTM parameters and Discord invite URL
- **Summary:** Two TASK-560 human escalations are pending decisions that require the user's input before they can be resolved in code — the Stravu UTM parameters in Settings.tsx and the Discord invite URL in DiscordPopup.tsx.
- **Source-Sprint:** SPRINT-014
- **Source:** TASK-560-done.md escalations 1 and 2; human-review-queue.md does not list these as formal items (they were not added during sprint-close).
- **Problem:**
  1. `frontend/src/components/Settings.tsx:643` — the Stravu "Buy Pro" link uses `utm_source=Crystal&utm_campaign=Crystal`. TASK-560 preserved this intentionally. If these are flipped to `utm_source=Cyboflow&utm_campaign=Cyboflow`, Stravu's attribution dashboard will show the traffic under a new source that may not yet exist, losing historical continuity. If left as-is, the link attributes cyboflow users to Crystal.
  2. `frontend/src/components/DiscordPopup.tsx:78` — the invite URL `discord.gg/XrVa6q7DPY` points at the Stravu/Crystal Discord. The copy was updated to say "Cyboflow Community" but the destination is still the Crystal server, making the popup internally inconsistent for any user who follows it.
- **Proposed direction:** The user must supply: (1) whether to update the UTM parameters (and if so, what source/campaign values to use — `Cyboflow`? something else?); (2) a Cyboflow-owned Discord invite URL to replace `XrVa6q7DPY`, or a decision to remove the DiscordPopup component entirely until a Cyboflow Discord exists. Once the decisions are recorded, the code change is a small find-and-replace in two files.
- **Scope:** small (pending user decision before execution)

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed Settings.tsx:643 still carries `utm_source=Crystal&utm_campaign=Crystal` and DiscordPopup.tsx:78,81 points at `discord.gg/XrVa6q7DPY` while UI copy says "Cyboflow Community" — these are external-facing branding inconsistencies that need a human decision before code can move, which is exactly what a refined backlog task captures (vs. leaving the friction undocumented).
- **Counterfactual:** Would flip to DONT_IMPLEMENT only if user already has a documented decision elsewhere — none found in human-review-queue.

### B7. Refactor `--cyboflow-dir` / `--crystal-dir` CLI flag parser to eliminate duplication
- **Summary:** The 18-line CLI argv parser for `--cyboflow-dir`/`--crystal-dir` in `main/src/index.ts:120-137` repeats each branch (equals-form and space-form) twice with the deprecation warning duplicated; consolidate to a single normalize step.
- **Source-Sprint:** SPRINT-014
- **Source:** FIND-SPRINT-014-24 (sprint-code-reviewer); TASK-562-done.md (introduced the dual-form parser defensively for backward compat).
- **Problem:** The flag parser at `main/src/index.ts:120-137` handles `--cyboflow-dir=VALUE` and `--cyboflow-dir VALUE` as separate branches, and separately handles `--crystal-dir=VALUE` and `--crystal-dir VALUE`, with the deprecation warning written twice. Any new `--cyboflow-*` flag will require 4 more branches. Not blocking, but the surface is error-prone as more flags arrive.
- **Proposed direction:** Refactor to a two-step approach: (1) a `normalizeArg(arg, next)` step that converts both the `--flag=value` and `--flag value` forms into a `{flag, value}` pair, consuming the `next` token when needed; (2) a single `switch(flag)` that handles `--cyboflow-dir` (canonical) and `--crystal-dir` (deprecated, logs a deprecation warning and falls through to the canonical case). Net diff: -10 lines, +6 lines, one deprecation-warning site. The `--crystal-dir` deprecation warning path should be preserved verbatim.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Speculative — `grep "process\.argv\|args\["` in main/src/index.ts confirms exactly ONE CLI flag exists in the entire codebase (`--cyboflow-dir`/`--crystal-dir`), so the "any new --cyboflow-* flag will require 4 more branches" rationale guards against a problem that hasn't arrived; refactoring a 17-line block with a `-10/+6` net to preempt hypothetical flag additions is the canonical speculative-generalization anti-pattern.
- **Counterfactual:** Would flip to IMPLEMENT if a second CLI flag were added (or planned), making the parser an actual extension point rather than a one-shot.

---

## C. CLAUDE.md / CODE-PATTERNS.md improvements (apply now)

### C1. Add `IPCResponse<T = any>` type-safety rule to CLAUDE.md TypeScript section
- **Summary:** Document that `IPCResponse` generic defaults must not be `any`; require explicit payload types at every IPC call site so field renames surface in typecheck instead of runtime.
- **Source-Sprint:** SPRINT-014
- **Target file:** `CLAUDE.md`
- **Rationale:** FIND-SPRINT-014-2 (TASK-562 verifier) shows a real case where the `T = any` default allowed a field rename (`crystalDirectory` → `cyboflowDirectory`) to go undetected by typecheck and only surface as a missing data row at runtime. Without a codified rule, future IPC handler changes face the same silent-break risk.
- **Proposed change:**
  ```diff
  ## TypeScript Rules

  The `any` type is forbidden. ESLint rule `@typescript-eslint/no-explicit-any` is set to
  `error` and CI enforces it. Use `unknown` (with type guards) or narrow generics instead.
  +
  + **IPC response types:** `IPCResponse<T>` callers must supply an explicit type argument —
  + never rely on the `T = any` default. Prefer `IPCResponse<{ fieldName: Type }>` at the
  + call site so IPC field renames surface in `pnpm typecheck` instead of at runtime.
  + Audit: `grep -rn "IPCResponse[^<]" frontend/src` finds untyped call sites.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Concrete recent failure (TASK-562 hit silent rename), 151 IPCResponse sites still vulnerable, and App.tsx:34 already independently locally defined `IPCResponse<T = unknown>` — pattern is recurring enough that codifying it in the existing TypeScript Rules section adds 3 lines of guidance without inflating CLAUDE.md.

### C2. Register `commitFooter` and `devDebugLog` utilities in CODE-PATTERNS.md Shared Utilities
- **Summary:** Two new shared utilities introduced in SPRINT-014 (`main/src/utils/commitFooter.ts` and `main/src/utils/devDebugLog.ts`) are missing from the `docs/CODE-PATTERNS.md` Shared Utilities section; future agents will reinvent them without a registration entry.
- **Source-Sprint:** SPRINT-014
- **Target file:** `docs/CODE-PATTERNS.md`
- **Rationale:** FIND-SPRINT-014-21 (sprint-code-reviewer); TASK-565-done.md and TASK-566-done.md introduced these helpers but neither task updated the patterns doc. The Shared Utilities section is the documented home — it currently lists `cn`, `mutex`, `simpleTaskQueue`, `logger`, `api`, `trpcClient`, `migrateLocalStorageKey`.
- **Proposed change:**
  ```diff
  ### `frontend/src/utils/migrateLocalStorageKey`
  ... (existing entry, unchanged)

  + ### `main/src/utils/commitFooter`
  +
  + - **Path:** `main/src/utils/commitFooter.ts`
  + - **Use it for:** Building the canonical Cyboflow commit footer string, and deciding
  +   whether to append it based on the `enableCyboflowFooter` config flag. The footer
  +   literal lives in exactly one place — do NOT inline it elsewhere.
  + - **Key exports:** `buildCommitFooter(enabled: boolean): string` — returns the footer
  +   string or empty string; callers compose via the "append-with-blank-line" pattern
  +   (see B2 for the planned `appendCommitFooter` helper).
  + - **Canonical example:** `main/src/utils/shellEscape.ts:29` (`buildGitCommitCommand`
  +   wrapper). Byte-level contract tested in `main/src/utils/commitFooter.test.ts`.
  +
  + ### `main/src/utils/devDebugLog`
  +
  + - **Path:** `main/src/utils/devDebugLog.ts`
  + - **Use it for:** Writing structured lines to `cyboflow-frontend-debug.log` /
  +   `cyboflow-backend-debug.log` in dev mode. Centralizes both the filename literals
  +   and the log-line format — do NOT hardcode the filenames elsewhere.
  + - **Key exports:** `getDevDebugLogPath(stream: DevLogStream): string`,
  +   `appendDevDebugLog(stream, level, source, message, originalConsole?)`.
  + - **Recursion guard:** pass the pre-override `originalConsole.error` as the fifth
  +   argument inside console overrides to avoid infinite recursion.
  + - **Canonical example:** `main/src/index.ts:38,100-110,236-396` (console wrapper
  +   overrides and frontend webContents listener).
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed CODE-PATTERNS.md Shared Utilities section lists 7 helpers (cn, mutex, simpleTaskQueue, logger, api, trpcClient, migrateLocalStorageKey) but neither commitFooter nor devDebugLog despite both being singleton-policy utilities introduced in SPRINT-014 — section explicitly serves as the discovery surface so new agents don't reinvent these helpers, and the entries match existing format.

### C3. Add terminal env-var dual-set policy to CODE-PATTERNS.md
- **Summary:** Document the canonical pattern for exposing session/panel context to child processes in terminal managers, covering both the CYBOFLOW_* canonical vars and the CRYSTAL_* deprecated aliases, so future terminal-related tasks implement it consistently in all spawn sites.
- **Source-Sprint:** SPRINT-014
- **Target file:** `docs/CODE-PATTERNS.md`
- **Rationale:** TASK-577 codified the dual-set as policy in `terminalPanelManager.ts` but the sibling `terminalSessionManager.ts` was left divergent (FIND-SPRINT-014-25, sprint-code-reviewer). Without a documented pattern, the next task touching either manager or adding a new terminal pathway will again need to rediscover the dual-set contract from the implementation. This is a project-code convention (codebase-specific env-var contract for child PTY processes), not a SoloFlow behavior note.
- **Proposed change:** Append to the `Recurring Patterns` section in `docs/CODE-PATTERNS.md`:
  ```diff
  + ### Terminal manager PTY env vars
  +
  + When spawning a child PTY process from a terminal manager, always dual-set both the
  + canonical `CYBOFLOW_*` vars and the deprecated `CRYSTAL_*` aliases so user shell scripts
  + written against either name continue to work until the legacy pair is removed post-v1.
  +
  + ```typescript
  + env: {
  +   ...process.env,
  +   // Canonical (v1+)
  +   CYBOFLOW_SESSION_ID: sessionId,
  +   CYBOFLOW_PANEL_ID: panelId,
  +   // @deprecated TODO(post-v1): remove once all user scripts migrate
  +   CRYSTAL_SESSION_ID: sessionId,   // kept for backward compat
  +   CRYSTAL_PANEL_ID: panelId,       // kept for backward compat
  + }
  + ```
  +
  + Apply this to every PTY spawn site: `terminalPanelManager.ts` and
  + `terminalSessionManager.ts`. If adding a new terminal pathway, add it there too.
  + Extract a shared `buildCyboflowTerminalEnv(sessionId, panelId?)` helper (see B5)
  + once both sites are aligned so the key set is defined exactly once.
  ```

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Rule drift risk — terminalSessionManager.ts:41-48 currently does NOT follow the proposed dual-set policy (B5 is what would fix it), so codifying the pattern before B5 lands means the doc contradicts 1 of 2 cited sites; additionally, the CRYSTAL_* dual-set is explicitly a temporary v1-era backward-compat measure with a planned post-v1 removal, which is a thin foundation for a durable CODE-PATTERNS.md rule when only 2 PTY spawn sites exist.
- **Counterfactual:** Would flip to IMPLEMENT if sequenced after B5 ships AND a third terminal pathway is on the roadmap, making the rule both consistent with code and load-bearing for future authors.

---

## Reconciled Findings (informational)

The following findings had `status: open` in the findings file but were claimed as resolved by a done report. Treated as resolved — not triaged into buckets above.

- FIND-SPRINT-014-3 — claimed resolved by TASK-562 in `.soloflow/archive/done/crystal-cuts-and-rebrand/TASK-562-done.md` (outcome: "IPC field rename propagated to `frontend/src/components/AboutDialog.tsx` (5 sites) after verifier round"; findings section: "FIND-SPRINT-014-3: scope deviation AboutDialog.tsx (resolved by verifier direction)"). The findings file's `status` field was not updated to `resolved` during sprint close.

---

## Suppressed — SoloFlow Defects

The following item passed initial triage as a C-candidate but was reclassified as a SoloFlow planner defect and suppressed (tester mode is off for this compound run).

- **Planner AC file-count assertion should account for mandated test files (FIND-SPRINT-014-12)** — The plan for TASK-566 set AC6 to "file count is exactly 2 (helper + index.ts)" but simultaneously listed a mandatory test file in `test_strategy.targets` (a third file). The rule "file-count AC must equal N + number of test files listed in `test_strategy.targets`" is a constraint on how the SoloFlow planner writes AC assertions, not on how this codebase's code is structured. It would evaporate if the user switched workflows. Consider opening an issue or running `/soloflow:compound --tester` against this sprint in a SoloFlow-tester setup to surface it as a maintainer recommendation.
