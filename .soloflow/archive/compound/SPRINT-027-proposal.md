---
sprints: [SPRINT-027]
span_label: SPRINT-027
created: 2026-05-20T00:00:00.000Z
counters_start:
  ideas: 22
summary:
  cleanups: 3
  backlog_tasks: 3
  claude_md: 1
  soloflow_improvements: 0
---

# Compound Proposal — SPRINT-027

## Reconciled Findings (informational)

FIND-SPRINT-027-1 — claimed resolved by TASK-675 in `.soloflow/archive/done/testing-infrastructure/TASK-675-done.md` (status in findings file was already `resolved`; included here for completeness of the safety-net pass).

---

## A. Clean-up items (execute now)

### A1. Add 6 missing TODO(TASK-680) breadcrumb markers to multi-line execSync git sites in git.ts
- **Summary:** Six multi-line `execSync(\`git diff ...\`)` calls in `main/src/ipc/git.ts` were missed by TASK-679's TODO-trail pass because the template literal starts on a new line after `execSync(`; adding the 6 comment markers completes the breadcrumb so TASK-680's executor finds every unmigrated site.
- **Source-Sprint:** SPRINT-027
- **Rationale:** TASK-679 added `// TODO(TASK-680): migrate to runGit(cwd, args[]) — see main/src/utils/runGit.ts` above every remaining `execSync(\`git ...\`)` site it could find, but a single-line grep pattern silently skipped six multi-line forms. Without the markers, the TASK-680 executor will miss these sites and the runGit migration will be incomplete. Adding comments is zero-risk — no logic changes.
- **Blast radius:** `main/src/ipc/git.ts` lines 415, 425, 505, 515, 547, 557 only. Risk: trivial.
- **Source:** FIND-SPRINT-027-6 (TASK-679 code-reviewer); TASK-679 done report confirms the advisory.
- **Proposed change:**

  Add `// TODO(TASK-680): migrate to runGit(cwd, args[]) — see main/src/utils/runGit.ts` immediately above each of the following six `execSync(` calls. The surrounding code is unchanged.

  Line 415 — `const diff = execSync(`:
  ```diff
  +         // TODO(TASK-680): migrate to runGit(cwd, args[]) — see main/src/utils/runGit.ts
            const diff = execSync(
              `git diff ${fromCommit.hash}`,
  ```

  Line 425 — `const changedFiles = execSync(`:
  ```diff
  +           // TODO(TASK-680): migrate to runGit(cwd, args[]) — see main/src/utils/runGit.ts
              const changedFiles = execSync(
                `git diff --name-only ${fromCommit.hash}`,
  ```

  Line 505 — `const diff = execSync(` (single-commit branch):
  ```diff
  +         // TODO(TASK-680): migrate to runGit(cwd, args[]) — see main/src/utils/runGit.ts
            const diff = execSync(
              `git diff ${fromCommitHash}`,
  ```

  Line 515 — `const changedFiles = execSync(` (single-commit branch):
  ```diff
  +         // TODO(TASK-680): migrate to runGit(cwd, args[]) — see main/src/utils/runGit.ts
            const changedFiles = execSync(
              `git diff --name-only ${fromCommitHash}`,
  ```

  Line 547 — `const diff = execSync(` (multi-commit branch):
  ```diff
  +       // TODO(TASK-680): migrate to runGit(cwd, args[]) — see main/src/utils/runGit.ts
          const diff = execSync(
            `git diff ${fromCommitHash}`,
  ```

  Line 557 — `const changedFiles = execSync(` (multi-commit branch):
  ```diff
  +       // TODO(TASK-680): migrate to runGit(cwd, args[]) — see main/src/utils/runGit.ts
          const changedFiles = execSync(
            `git diff --name-only ${fromCommitHash}`,
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Read of main/src/ipc/git.ts confirms all 6 cited multi-line execSync sites (lines 415, 425, 505, 515, 547, 557) exist without TODO markers while the surrounding single-line forms (e.g. line 421/460/494/536/553) do carry them — adding 6 comment lines to complete the breadcrumb pattern is zero-risk and proportional.
- **Counterfactual:** If TASK-680's runGit follow-up has been formally re-numbered (TASK-680 was reused for the useAddTerminalPanel hook), the breadcrumb string should be updated globally in a separate sweep, not blocked here.

---

### A2. Replace inline hasCwdString ternary in terminalPanelManager.restoreTerminalState with the shared guard
- **Summary:** `terminalPanelManager.ts:287-288` reimplements the `hasCwdString` guard inline with an explanatory comment admitting the duplication; replacing the ternary with a direct call to `hasCwdString(state)` removes the only remaining inline copy in this file.
- **Source-Sprint:** SPRINT-027
- **Rationale:** TASK-677 promoted `hasCwdString` to `shared/types/panels.ts` and migrated four cwd-narrowing sites in this file, but the `restoreTerminalState` site was intentionally left because `state` is typed as `TerminalPanelState` rather than raw `customState`. The done report and FIND-SPRINT-027-7 both confirm this was a deliberate deferral, not an oversight — but `TerminalPanelState` structurally satisfies `hasCwdString`'s `{ cwd?: string }` parameter shape, so the call is valid and the inline comment explains it clearly. Removing the duplication means a future change to the empty-string logic propagates from one place.
- **Blast radius:** `main/src/services/terminalPanelManager.ts` lines 285-288 only (comment + ternary → guard call). Risk: trivial.
- **Source:** FIND-SPRINT-027-7 (SPRINT-027 sprint-code-reviewer); TASK-677 done report.
- **Proposed change:**
  ```diff
  -   // Mirrors hasCwdString's non-empty-string check (shared/types/panels.ts) — state.cwd is already
  -   // typed as string|undefined so the guard is structural here, but the empty-string handling matches.
  -   const restoreCwd =
  -     typeof state.cwd === 'string' && state.cwd.length > 0 ? state.cwd : process.cwd();
  +   const restoreCwd = hasCwdString(state) ? state.cwd : process.cwd();
  ```
  Ensure `hasCwdString` is already imported (it is — TASK-677 added the import for the other sites in the same file).

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed at main/src/services/terminalPanelManager.ts:285-288 — `hasCwdString` is already imported (line 2) and used at line 249, and `TerminalPanelState` is part of the `ToolPanelState['customState']` union (shared/types/panels.ts:16) so the guard's parameter accepts `state` structurally; the 3-line replacement removes a deliberately-acknowledged duplication.

---

### A3. Update CODE-PATTERNS.md rawEvents fixture section to reflect TASK-676's completed move
- **Summary:** `docs/CODE-PATTERNS.md` still documents the old `__tests__/__fixtures__/rawEvents.ts` path and carries a "(will move to `__test_fixtures__/rawEvents.ts` via TASK-676)" note; TASK-676 is done, so the section header, path, and pending note must be updated to the canonical `__test_fixtures__/rawEvents.ts` location.
- **Source-Sprint:** SPRINT-027
- **Rationale:** TASK-676 moved the fixture to `main/src/orchestrator/__test_fixtures__/rawEvents.ts` and updated all import sites. The CODE-PATTERNS.md entry still points at the deleted path, meaning the next agent looking up `rawEvents` gets the wrong import path and a confusing "(will move... via TASK-676)" annotation on a completed task.
- **Blast radius:** `docs/CODE-PATTERNS.md` section heading + 1 path line + 1 parenthetical. Risk: trivial.
- **Source:** TASK-676 done report (confirmed the move landed); FIND-SPRINT-027-4 (TASK-676 verifier observed the post-move state).
- **Proposed change:**
  ```diff
  -### `main/src/orchestrator/__tests__/__fixtures__/rawEvents`
  +### `main/src/orchestrator/__test_fixtures__/rawEvents`

  -- **Path:** `main/src/orchestrator/__tests__/__fixtures__/rawEvents.ts` (will move to `__test_fixtures__/rawEvents.ts` via TASK-676)
  +- **Path:** `main/src/orchestrator/__test_fixtures__/rawEvents.ts`
  ```
  Leave the rest of the section body unchanged.

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Verified: rawEvents.ts now lives at main/src/orchestrator/__test_fixtures__/rawEvents.ts and the old `__tests__/__fixtures__/` directory no longer exists, so the CODE-PATTERNS.md path at line 123/125 is concretely stale and misleading for the next agent.
- **Counterfactual:** Lines 13-15 of CODE-PATTERNS.md also still describe rawEvents.ts as "pending… via TASK-676" — the executor should fix that line too, not only the headings at 123/125.

---

## B. Backlog tasks (refine into execution-ready plans)

### B1. Consolidate raw_events DDL: import RAW_EVENTS_DDL into registrySchema.ts or add cross-reference comments
- **Summary:** `main/src/database/__test_fixtures__/registrySchema.ts` inlines its own copy of the `raw_events` CREATE TABLE DDL as part of `GATE_SCHEMA`, creating a second divergence point from the canonical `rawEvents.ts` fixture; a future `raw_events` column change requires updating both files.
- **Source-Sprint:** SPRINT-027
- **Source:** FIND-SPRINT-027-4 (TASK-676 verifier).
- **Problem:** After TASK-676 consolidated the orchestrator-side `raw_events` DDL into `main/src/orchestrator/__test_fixtures__/rawEvents.ts`, the registry-side `registrySchema.ts:76-84` still inlines its own verbatim copy as part of `GATE_SCHEMA`. The two copies are currently equivalent, but they live in different test-fixture trees and there is no automated check that keeps them in sync. A developer adding a new column to `raw_events` must remember to update `rawEvents.ts` (canonical), `registrySchema.ts` (inline copy), and the production migration — three sites, no compile-time tripwire. The `scripts/verify-schema-parity.js` CI guard explicitly excludes test fixtures: "The script does NOT compare test fixtures like `registrySchema.ts` — those are documented subsets."
- **Proposed direction:** Option (a) — re-export `RAW_EVENTS_DDL` from `main/src/orchestrator/__test_fixtures__/rawEvents.ts` and update `registrySchema.ts` to concatenate it into `GATE_SCHEMA` via a template literal: `` `${WORKFLOW_SCHEMA}${RAW_EVENTS_DDL}${APPROVALS_SCHEMA}` `` (or however the GATE_SCHEMA parts are composed). This makes `registrySchema.ts` a single-source consumer rather than a duplicator. Option (b) — add an inline comment in both fixtures pointing at each other (`// Keep in sync with main/src/orchestrator/__test_fixtures__/rawEvents.ts`) as a low-effort fallback. The plan should include a `grep -rn 'CREATE TABLE.*raw_events' main/src/` completeness check per the "prove completeness" CODE-PATTERNS.md convention.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** medium
- **Reasoning:** The two DDLs are not actually equivalent — orchestrator's RAW_EVENTS_DDL (rawEvents.ts:16-24) intentionally omits the FOREIGN KEY and the idx_raw_events_run_id index because FK enforcement is OFF in that test scope, while registrySchema.ts:76-84 includes both; option (a) would silently change the gate harness's semantics, and registrySchema.ts:9-10 already carries an explicit `MUST be mirrored here too` comment that fulfills option (b) — so this is a speculative single-sprint observation against a guard that already exists.
- **Counterfactual:** If a future change to raw_events columns actually causes a divergence bug (not hypothetical), revisit with option (b) only — option (a) is structurally wrong.

---

### B2. Fix intermittent killProcess mid-stream test timeout in claudeCodeManager.killProcess.test.ts
- **Summary:** The `killProcess mid-stream clears pipelines, sdkRuns, and processes maps` test reliably times out at 5000ms during full-suite runs but passes in isolation; the root cause (real timer or unresolved process mock) needs investigation and a targeted fix.
- **Source-Sprint:** SPRINT-027
- **Source:** FIND-SPRINT-027-2 (TASK-673 executor) and FIND-SPRINT-027-3 (TASK-676 executor — duplicate, same pre-existing failure). The verifier on FIND-027-3 explicitly flagged these as the same defect and asked the compounder to merge them.
- **Problem:** `main/src/services/panels/claude/__tests__/claudeCodeManager.killProcess.test.ts` contains a test named "killProcess mid-stream clears pipelines, sdkRuns, and processes maps" that passes when run in isolation (`vitest run` targeting only that file) but times out at 5000ms when the full test suite runs. This is a pre-existing failure that surfaced across multiple tasks (TASK-673, TASK-676) and is unrelated to any sprint change. The timeout-only-in-full-suite pattern strongly suggests either: (a) a real `setTimeout`/`setInterval` left running by a prior test that makes this test wait for an actual process signal rather than a mocked one, or (b) a shared mock (e.g. `vi.mock('node:child_process')`) whose state bleeds from one test file into this one, preventing the mock's kill signal from resolving. The 1-failure count in the full suite has been consistent across SPRINT-027 (TASK-673: 540/542, TASK-675: 541/542, TASK-676: 541/542, TASK-677: 548/549, TASK-678: 551/552, TASK-679: 563/564).
- **Proposed direction:** Open the test file, identify how `killProcess` is triggered in the mid-stream test, and check whether the mock for the child_process / SDK stream resolves synchronously or after a real timer. If a real timer or process is used, replace it with a `vi.useFakeTimers()` scope or a mock that calls the kill callback synchronously. Also check whether any test in the same file or in files that run before it (in the full-suite order) leaves a `setTimeout` or an open IPC handle that prevents `vi` teardown. Target: test passes in both isolation and full-suite runs.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** The test file exists at the cited path and the same failure was independently surfaced by TASK-673 (FIND-027-2) and TASK-676 (FIND-027-3) — the full-suite failure recurs across 6 task done reports in SPRINT-027 (540/542 → 563/564 lineage), so this is recurring CI noise that masks future regressions, not a one-off.

---

### B3. Narrow or remove the dead `encoding: 'buffer'` option from RunGitOptions in runGit.ts
- **Summary:** `RunGitOptions.encoding` accepts `'utf8' | 'buffer'` but both `runGit` and `runGitAsync` always return `string`; the `'buffer'` branch coerces to `string` anyway, making the option misleading and the return-type annotation incorrect for callers expecting a Buffer.
- **Source-Sprint:** SPRINT-027
- **Source:** TASK-679 done report advisory ("encoding: 'buffer' option in RunGitOptions is dead — both functions always return string. Documented in JSDoc. Consider type-narrowing in a follow-up.").
- **Problem:** `main/src/utils/runGit.ts:19` declares `encoding?: 'utf8' | 'buffer'` in `RunGitOptions`, but lines 33-35 and 44-45 always coerce the result to `string` via `(result as Buffer).toString('utf8')`. A caller who passes `encoding: 'buffer'` gets a `string`, not a `Buffer`, contradicting their expectation. The dead option adds surface area to the interface with no benefit and the JSDoc note is the only warning.
- **Proposed direction:** Two options: (a) remove the `'buffer'` variant from the type (`encoding?: 'utf8'`) and remove the dead `Buffer` coercion branches — cleaner, but a technically breaking change if any caller already passes `'buffer'` (unlikely given the helper was just introduced in TASK-679); (b) keep the interface but use TypeScript function overloads to make the return type `Buffer` when `encoding: 'buffer'` is passed and `string` otherwise — correct but more complex. Option (a) is strongly preferred given there are currently zero callers of the `'buffer'` variant. Run `grep -rn "encoding.*buffer" main/src/` to confirm zero callers before deleting.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Grep across main/src/ confirms zero callers pass `encoding: 'buffer'` — the only matches are the type declaration (runGit.ts:19) and the dead coercion comment (line 32), so option (a) is a safe one-file narrow now that has near-zero attention cost; left in place, the next runGit caller hits a misleading `string`-return-when-buffer-requested trap.

---

## C. CLAUDE.md / CODE-PATTERNS.md improvements (apply now)

### C1. Add Electron-renderer resolution paths to VISUAL-VERIFICATION-SETUP.md for visual_web=true configs
- **Summary:** `docs/VISUAL-VERIFICATION-SETUP.md` documents the Electron preload constraint but does not tell a verifier what to do when the SoloFlow config has `verification.visual_web=true` with `playwright_target.kind=electron` — add a short section naming the three resolution paths so the verifier stops re-deriving them every sprint.
- **Source-Sprint:** SPRINT-027
- **Target file:** `docs/VISUAL-VERIFICATION-SETUP.md`
- **Action:** insert-after "Use `visual_macos` via Peekaboo MCP with `pnpm dev` running and the Electron window visible."
- **Status:** ready
- **source_item:** C1
- **Rationale:** FIND-SPRINT-027-5 observed `visual_web=true` + `playwright_target.kind=electron` leads to `skipped_unable` with no doc-side guidance on what to do. The `human-review-queue.md` `visual_web_electron_unreachable` dedup_key has fired for SPRINT-015, 017, 020, 023, 024, 025, 026, and 027 — eight sprints of the verifier re-typing the same three resolution paths into the queue. Documenting them once in the supporting doc (loaded by reference from root CLAUDE.md) lets the next verifier cite the doc instead. CLAUDE.md itself already points at this doc and stays short by design, so the content belongs here, not in CLAUDE.md.
- **Reviewer notes:** Dropped the original closing sentence ("Option 1 is the lowest-friction fix…") — `.soloflow/config.json` shows `visual_web: true` is the user's deliberate override (per MEMORY.md), so recommending option 1 as the default fix contradicts the user's choice. Reframed the trailing line to neutrally point at `visual_macos` as the supported fallback when `skipped_unable` is acceptable. Also trimmed the speculative "See the Playwright Electron guide" pointer in option 2 since no concrete in-repo path exists yet; left the CDP-attach option as a named direction.
- **Diff:**
  ```diff
  +## When `verification.visual_web=true` is set (Electron project)
  +
  +`visual_web=true` combined with `playwright_target.kind=electron` always
  +produces `skipped_unable` verdicts — Playwright MCP drives a standalone
  +Chromium browser and cannot attach to the Electron renderer, which requires
  +the `electronTRPC` preload global. Three resolution paths exist:
  +
  +1. **Set `verification.visual_web=false`** in `.soloflow/config.json` — visual
  +   verification then uses `visual_macos` (Peekaboo) only.
  +2. **Add a CDP-attach launcher** — expose the Electron renderer over Chrome
  +   DevTools Protocol so Playwright can `page.goto(cdpUrl)` against it; no
  +   such launcher exists in this repo yet.
  +3. **Run Playwright E2E manually** — `pnpm dev` in one shell, `pnpm test` in
  +   another. The `tests/*.spec.ts` suite drives the full Electron app and is
  +   not subject to the preload constraint.
  +
  +If `visual_web=true` is being kept deliberately (it currently is — see
  +`.soloflow/config.json`), `skipped_unable` is the expected verdict for the
  +Playwright MCP path; `visual_macos` via Peekaboo with `pnpm dev` running is
  +the supported capture path in the meantime.
  +
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** dedup_key `visual_web_electron_unreachable` appears in human-review-queue.md at 4 distinct entries (and the existing VISUAL-VERIFICATION-SETUP.md recurrence block already lists sprints 015/017/020/023/024/025/026), so the verifier re-derivation cost is recurring; adding resolution paths to the existing supporting doc (not CLAUDE.md) is proportional, and the reviewer-noted reframing avoids contradicting the user's deliberate `visual_web=true` override.
- **Counterfactual:** The proposal claims `playwright_target.kind=electron` but `.soloflow/config.json` does not currently declare that key — the diff still reads sensibly without the kind subfield because the constraint applies to any Electron renderer target.

---

## Suppressed — SoloFlow Defects

The following findings describe SoloFlow plugin behavior rather than project-specific conventions. They are suppressed from Bucket C because the fix belongs in the SoloFlow plugin, not in this project's CLAUDE.md. Consider opening an issue or running `/soloflow:compound --tester` against this sprint in a SoloFlow-tester setup to surface these as maintainer recommendations.

- **Duplicate plan IDs (TASK-684/685 in `crystal-cuts-and-rebrand`, TASK-686/687 across `cyboflow-shell-architecture` and `testing-infrastructure`)** — sprint findings preamble notes that two pairs of task IDs were assigned to overlapping epics, requiring manual exclusion from the sprint to prevent state corruption. The planner or sprint-initiator should detect and reject duplicate IDs before writing plan files.

- **Compounder produced duplicate tasks across sprint boundaries (TASK-671 from SPRINT-024 compound, TASK-674 from SPRINT-025 compounder — both targeting the same 4 assertions in `runExecutor.test.ts`)** — TASK-674 done report and the findings file preamble both confirm the duplication. The compound's task-extraction step should cross-check proposed backlog items against open plan files for the same file/symbol targets before emitting a new task.
