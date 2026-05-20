---
sprints: [SPRINT-026]
span_label: SPRINT-026
created: "2026-05-20T00:00:00.000Z"
counters_start:
  ideas: 20
summary:
  cleanups: 6
  backlog_tasks: 5
  claude_md: 3
  soloflow_improvements: 0
---

# Compound Proposal — SPRINT-026

## A. Clean-up items (execute now)

### A1. Run pnpm electron:rebuild to fix better-sqlite3 ABI mismatch
- **Summary:** `better-sqlite3` was compiled for NODE_MODULE_VERSION 136 but the current Node requires 127, causing 8 tests in `rawEventsSink.test.ts` to fail with a native-module error on every CI run.
- **Source-Sprint:** SPRINT-026
- **Rationale:** This pre-existing mismatch has silently suppressed `rawEventsSink.test.ts` (8 tests) across multiple sprints (also blocking `pnpm --filter main test` globally). It is a one-command fix and costs nothing to remediate; leaving it open obscures real failures from legitimate regressions.
- **Blast radius:** No source files changed — only native module recompilation. Risk: trivial.
- **Source:** FIND-SPRINT-026-4 (TASK-681 executor); same mismatch appeared in the Overridden bucket of `human-review-queue.md` for TASK-652/TASK-577/TASK-588 across prior sprints.
- **Proposed change:**
  ```
  Run from repo root:
    pnpm electron:rebuild
  Then confirm:
    pnpm --filter main exec vitest run src/services/streamParser/__tests__/rawEventsSink.test.ts
  Expected: 8/8 pass (was failing with NODE_MODULE_VERSION 136 vs 127).
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** `human-review-queue.md` shows the same NODE_MODULE_VERSION mismatch deferred across TASK-577, TASK-588, TASK-593, TASK-652, TASK-663/664, and now SPRINT-026 (lines 459, 466, 474, 481, 527-540) — recurrence is concrete and the fix is a single command with zero source-file blast radius.

### A2. Rewrite stale AC#6 in the sdk-migration verification report
- **Summary:** `docs/sdk-migration-smoke-results.md` AC#6 references `main/src/services/permissionManager.ts`, which no longer exists — the grep passes vacuously and misleads future readers.
- **Source-Sprint:** SPRINT-026
- **Rationale:** AC#6 as written (`grep -rnE 'cyboflowPermissionBridge|...' main/src/services/permissionManager.ts ...`) is a vacuous pass by deletion, not by design — the file was consolidated into `ClaudeCodeManager` / `approvalRouter` in a prior epic. A future reader auditing the epic gate will incorrectly conclude the bridge isolation was verified when it was not. Three real surviving references (`mcpConfigWriter.ts:25`, `mcpConfigWriter.ts:41`, `runLauncher.ts:37`) are docstring/path-resolver strings, not runtime wiring. The AC should acknowledge this.
- **Blast radius:** `docs/sdk-migration-smoke-results.md` only. Risk: trivial.
- **Source:** FIND-SPRINT-026-13 (TASK-683 verifier).
- **Proposed change:**
  ```diff
  # In docs/sdk-migration-smoke-results.md, locate the AC#6 entry under
  # "## Verification — 2026-05-20 (TASK-683)" and replace the current prose with:

  - **AC#6 (permissionManager isolation):** PASS — `main/src/services/permissionManager.ts`
    no longer exists; its responsibilities were consolidated into `ClaudeCodeManager` and
    `approvalRouter` in a prior epic. Three surviving references to `cyboflowPermissionBridge`
    in `main/src/orchestrator/mcpConfigWriter.ts` (lines 25, 41) and `runLauncher.ts` (line 37)
    are file-path strings used by the MCP config writer to locate the bridge script — they are
    NOT active runtime wiring. This AC passes by architectural consolidation rather than by
    file-present grep; the intent (bridge no longer routes through a standalone permission
    manager) is satisfied.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `main/src/services/permissionManager.ts` does not exist while three live `cyboflowPermissionBridge` references survive at `mcpConfigWriter.ts:25,41` and `runLauncher.ts:37` — the AC#6 grep at `docs/sdk-migration-smoke-results.md:628-638` currently passes vacuously and would mislead a future epic auditor.

### A3. Add queue-entry back-links to sdk-migration-smoke-results.md deferred checklist headings
- **Summary:** The six templated smoke checklists in `docs/sdk-migration-smoke-results.md` (AC#13-#18) have no back-link to their corresponding human-review-queue entries, creating two independent records that will drift the moment a reviewer fills in only one.
- **Source-Sprint:** SPRINT-026
- **Rationale:** `docs/sdk-migration-smoke-results.md` §"Outstanding Follow-ups" states the smokes are tracked via human-review-queue entries, but the checklist headings themselves (lines ~820-928) contain no such reference. A human walking the doc will fill in checkboxes that the `/soloflow:review-queue` flow never sees; a human walking the queue won't find the detail-rich checklists. One line per heading eliminates the drift surface.
- **Blast radius:** `docs/sdk-migration-smoke-results.md` only (docs append). Risk: trivial.
- **Source:** FIND-SPRINT-026-14 (TASK-683 code-reviewer).
- **Proposed change:**
  ```diff
  # Under each of the six ### Smoke N — … headings, add one line immediately after the heading:
  # Example for Smoke 1:

  ### Smoke 1 — Panel create + prompt + stream (AC#13)
  + > Tracked in `.soloflow/human-review-queue.md` — task: TASK-683, action: AC#13 Manual smoke 1.

  # Repeat the analogous line for Smokes 2-6 (AC#14-#18).
  # Also rephrase the "Outstanding Follow-ups" line 987 from:
  #   "tracked via the human-review-queue entries appended by TASK-683"
  # to:
  #   "tracked via the human-review-queue entries appended post-verifier by the orchestrator
  #    (FIND-SPRINT-026-12 remediation); each Smoke N heading above links to its queue entry."
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Verified queue entries for AC#13-#18 do exist at `human-review-queue.md:318-369` while the templated checklists at `docs/sdk-migration-smoke-results.md:830-928` carry no back-link — two independent records with no cross-pointer is a real drift surface, and the doc-only fix is one line per heading.

### A4. Annotate messageProjection.ts compact metadata fields as forward-compat
- **Summary:** The `compactTrigger` / `preTokens` fields on projected `UnifiedMessage.metadata` have no current renderer consumer — a one-line comment prevents future agents from hunting for a nonexistent read site.
- **Source-Sprint:** SPRINT-026
- **Rationale:** FIND-SPRINT-026-17 confirms `grep -rn "compactTrigger\|preTokens" frontend/src` returns zero matches. The only compact-related renderer consumer (`RichOutputView.tsx:842`) dispatches on `systemSubtype === "context_compacted"` but never reads the trigger or token fields. Without annotation, the next agent who refactors `messageProjection.ts` will search for consumers, find none, and treat the rename as dead code — risking a revert that breaks the camelCase convention.
- **Blast radius:** `main/src/services/streamParser/messageProjection.ts` (comment-only). Risk: trivial.
- **Source:** FIND-SPRINT-026-17 (SPRINT-026 sprint-code-reviewer).
- **Proposed change:**
  ```diff
  # main/src/services/streamParser/messageProjection.ts, around line 138-141
  # (the compact_boundary projection block that sets compactTrigger and preTokens):

    metadata: {
      systemSubtype: 'context_compacted',
  -   compactTrigger: event.compact_metadata.trigger,
  -   preTokens: event.compact_metadata.pre_tokens,
  +   // compactTrigger / preTokens: camelCase forward-compat (FIND-SPRINT-026-5).
  +   // No current renderer consumer reads these — RichOutputView.tsx:842 dispatches
  +   // on systemSubtype only. When a renderer surfaces compact details, read from here
  +   // (not the wire-layer snake_case fields on compact_metadata).
  +   compactTrigger: event.compact_metadata.trigger,
  +   preTokens: event.compact_metadata.pre_tokens,
    }
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `grep -rn "compactTrigger\|preTokens" frontend/src` returns zero matches and `RichOutputView.tsx:842` dispatches only on `systemSubtype === 'context_compacted'` — without an anchoring comment the next reader auditing `messageProjection.ts:139-140` will incorrectly treat the camelCase rename as dead code and risk reverting it.

### A5. Fix stale docstring in messageProjection.test.ts
- **Summary:** The Coverage list header in `messageProjection.test.ts` still describes test #2 as `compact_trigger+pre_tokens in metadata` (snake_case) after TASK-682 renamed the assertions to `compactTrigger` / `preTokens` (camelCase).
- **Source-Sprint:** SPRINT-026
- **Rationale:** A developer scanning the file header for the compact metadata field names will find the obsolete snake_case form and waste time greping a name that no longer exists in the assertions. One-word edit.
- **Blast radius:** `main/src/services/streamParser/__tests__/messageProjection.test.ts:10` (comment). Risk: trivial.
- **Source:** FIND-SPRINT-026-18 (SPRINT-026 sprint-code-reviewer).
- **Proposed change:**
  ```diff
  # main/src/services/streamParser/__tests__/messageProjection.test.ts, line 10

  - //   2. compact_trigger+pre_tokens in metadata
  + //   2. compactTrigger+preTokens in metadata
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `messageProjection.test.ts:10` still reads `compact_trigger+pre_tokens in metadata` while the test body at lines 221-222 asserts `compactTrigger` / `preTokens` — single-line docstring fix, zero risk.

### A6. Replace wire-key user-visible label `pre_tokens=` with a human-readable form in RunView
- **Summary:** `RunView.SystemEventRow` renders the compact_boundary row with the literal text `pre_tokens={cb.compact_metadata.pre_tokens}`, leaking a snake_case wire-field name into the visible UI.
- **Source-Sprint:** SPRINT-026
- **Rationale:** All other human-facing labels in SystemEventRow (e.g. "model:", "cwd:", "session:") use natural English keys. `pre_tokens=` is the only wire-key label exposed to the user. Cosmetic, but inconsistent and user-visible.
- **Blast radius:** `frontend/src/components/cyboflow/RunView.tsx` (single string literal change). Risk: trivial.
- **Source:** FIND-SPRINT-026-19 (SPRINT-026 sprint-code-reviewer).
- **Proposed change:**
  ```diff
  # frontend/src/components/cyboflow/RunView.tsx, around line 83
  # (inside SystemEventRow compact_boundary branch)

  - pre_tokens={cb.compact_metadata.pre_tokens}
  + pre-compaction tokens={cb.compact_metadata.pre_tokens}
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Verified `RunView.tsx:83` renders the literal wire key `pre_tokens=` to the user while every other label in `SystemEventRow` (model:/cwd:/session:) uses natural English — single string-literal change with no wire-shape impact.

---

## B. Backlog tasks (refine into execution-ready plans)

### B1. Remove or restore dead api_retry / compact renderer branches in RunView
- **Summary:** `RunView.SystemEventRow` contains two rendering branches for `subtype === "api_retry"` and `subtype === "compact"` that can never fire because TASK-681 removed those subtypes from the Zod schema.
- **Source-Sprint:** SPRINT-026
- **Source:** FIND-SPRINT-026-15 (SPRINT-026 sprint-code-reviewer); TASK-681 done report (systemUnionSchema now contains only `systemInitSchema` and `systemCompactBoundarySchema`).
- **Problem:** `RunView.tsx:58-76` renders dedicated `SystemApiRetryEvent` and `SystemCompactEvent` branches. At runtime, `TypedEventNarrowing.narrow()` rejects any system event with `subtype === "api_retry"` or `subtype === "compact"` (both removed from `main/src/services/streamParser/schemas.ts:97-100` by TASK-681). The rejected event falls through to `{kind:"__unknown__"}`, and `deriveEventType` returns `"unknown"` — routing always to `UnknownEventRow`, never to `SystemEventRow`'s api_retry/compact branches. The shared TS types `SystemApiRetryEvent` / `SystemCompactEvent` are legitimately preserved in `shared/types/claudeStream.ts` (retention rationale: T8 fixture migration), but the renderer branches are dead code.
- **Proposed direction:** A task should pick one of the two stated paths and execute it cleanly:
  - **Path A (retire):** Delete the `api_retry` and `compact` branches from `RunView.SystemEventRow` (lines 58-76); remove the now-unused `SystemApiRetryEvent` / `SystemCompactEvent` imports from `RunView.tsx`. The shared TS types in `shared/types/claudeStream.ts` are NOT deleted — they carry a documented retention rationale. Update the corresponding RunView unit tests (the TASK-682 test-writer added edge-case tests for these subtypes at lines `44b0e8` commit — those tests will also need removal or transformation to assert that api_retry/compact route to UnknownEventRow).
  - **Path B (restore):** Re-add `systemApiRetrySchema` and `systemCompactSchema` to `systemUnionSchema` in `main/src/services/streamParser/schemas.ts`, restore the matching projection branches in `messageProjection.ts`, and add test coverage. Only if the SDK-migration decision changes to preserve legacy `claude -p` compatibility.
  - Path A is strongly preferred: the SDK does not emit these event subtypes, and the renderer branches provide no user value.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Verified `schemas.ts:97-100` `systemUnionSchema` contains only `systemInitSchema` and `systemCompactBoundarySchema` while `RunView.tsx:58-76` still renders `api_retry` and `compact` branches — the branches are reachable-only by schema reintroduction, so deleting them (Path A) is the proportional fix.

### B2. Fix run_started cross-task contract: add to StreamEventType union and narrow payload
- **Summary:** The synthetic `run_started` event emitted by `runLauncher.ts` is invisible to users because it is not in `StreamEventType`, falls through `RunView.renderEvent`'s switch, and `payload: unknown` forces five redundant `as` casts into the renderer.
- **Source-Sprint:** SPRINT-026
- **Source:** FIND-SPRINT-026-16 and FIND-SPRINT-026-20 (SPRINT-026 sprint-code-reviewer); TASK-682 done report; TASK-683 done report (path B KEEP decision for the synthetic event).
- **Problem:** Two coupled issues from cross-task drift between TASK-682 and TASK-683:
  1. `cyboflowApi.ts:33-39` defines `StreamEventType` as a closed six-value union (`system | assistant | user | result | stream_event | unknown`). `runLauncher.ts:145-149` publishes a synthetic event with `type: "run_started"`. At runtime, `RunView.renderEvent` (`RunView.tsx:224-233`) switches on `event.type` — `"run_started"` matches no case, the switch falls through, React renders nothing. The 50-500ms UI-bootstrap gap that justified path B (TASK-683 AC#8) is not actually closed.
  2. `StreamEvent.payload` is typed as `unknown`, but the producer side (`runEventBridge.ts:119-123`) types it as `ClaudeStreamEvent`. Every SDK row renderer in `RunView.tsx` compensates with five `as` casts (lines 38, 98, 138, 167, 186). These `as` casts were likely preserved to avoid breaking the `run_started` synthetic event (which cannot satisfy `ClaudeStreamEvent`), but they remove the type safety the discriminated union design was meant to provide.
  - `StreamEventPublisher.publish` in `runLauncher.ts:64-66` types `event.type` as bare `string`, so TypeScript does NOT catch the union mismatch at compile time.
- **Proposed direction:** Resolve in one task picking from these paths (path A recommended):
  - **Path A (cheapest, preserves AC#8 path-B intent):** Add `"run_started"` to `StreamEventType` in `frontend/src/utils/cyboflowApi.ts:33-39`; add a `case "run_started":` branch in `RunView.renderEvent` rendering a minimal placeholder row (e.g. "Starting…"); tighten `StreamEventPublisher.publish` in `runLauncher.ts:64-66` from `type: string` to `type: StreamEventType`; then tighten `StreamEvent.payload` from `unknown` to `ClaudeStreamEvent | undefined` (run_started has no payload) and delete the five `as` casts in `RunView.tsx`.
  - **Path B (remove synthetic event):** Delete the synthetic `run_started` publish from `runLauncher.ts:145-149`; update `runLauncher.test.ts` to assert `publishSpy` NOT called; tighten `payload` to `ClaudeStreamEvent` and remove the five casts. Accept the 50-500ms blank interval until the first real SDK event.
  - **Path C (architectural):** Introduce a shared `StreamEventType | "run_started"` literal union in `shared/types/` so publisher and consumer agree at compile time; keep path A's renderer branch.
  - After the chosen path lands, smoke AC#17 (workflow run emits >=2 distinct real SDK event types beyond run_started) to confirm the fix is end-to-end.
- **Scope:** small (path A or B) / medium (path C)

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Verified `cyboflowApi.ts:33-39` declares `StreamEventType` as a closed six-value union not containing `run_started`, `runLauncher.ts:146` publishes `type: 'run_started'`, and the exhaustive switch at `RunView.tsx:225-232` has no `run_started` case — the synthetic event silently fails to render today, directly defeating the AC#8 path-B rationale.

### B3. Fix Playwright/vitest spec-file conflict for cyboflow-day3-gate.spec.ts
- **Summary:** `tests/cyboflow-day3-gate.spec.ts` imports from `vitest` but lives in the `tests/` directory that Playwright collects, causing `pnpm test` to fail with a vitest/CJS incompatibility.
- **Source-Sprint:** SPRINT-026
- **Source:** FIND-SPRINT-026-9 (TASK-683 executor); also confirmed in TASK-683 done report (AC#12 pre-existing FAIL) and human-review-queue `SPRINT-025` deferred visual entry which also noted the same file.
- **Problem:** `tests/cyboflow-day3-gate.spec.ts:17` imports from the `vitest` package. Playwright 1.54.1 treats this as a vitest ESM-only file and fails with `Vitest cannot be imported in a CommonJS module` during test collection, causing `pnpm test` (AC#12) to exit non-zero. This is a pre-existing defect that blocks the Playwright E2E suite globally. Two fix options: (1) add `testIgnore: ["**/cyboflow-day3-gate.spec.ts"]` to `playwright.config.ts`, or (2) move the file to `main/src/.../__tests__/` as a `.test.ts` vitest spec.
- **Proposed direction:** Option 2 is preferred — move `tests/cyboflow-day3-gate.spec.ts` to `main/src/orchestrator/__tests__/cyboflowDayGate.test.ts` (or a similarly appropriate `__tests__/` path), replace any Playwright-specific APIs with vitest equivalents, and confirm `pnpm test` exits 0 after exclusion. Option 1 (testIgnore) is faster but hides the file from both test runners — choose it only if the file's test logic requires the vitest API and cannot be ported.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Verified `tests/cyboflow-day3-gate.spec.ts:17` imports from `vitest` and lives under `tests/` (Playwright's collection root) — pre-existing AC#12 FAIL acknowledged in TASK-683 done report blocks `pnpm test` exit 0 in CI globally; small fix unblocks the suite.

### B4. Investigate and fix pre-existing runExecutor.test.ts failures
- **Summary:** `runExecutor.test.ts` has 4 failing test cases (lifecycle transitions, bridgeEvents source arg, panelId/runId alignment) that block `pnpm test:unit` from exiting 0 across multiple sprints.
- **Source-Sprint:** SPRINT-026
- **Source:** FIND-SPRINT-026-10 (TASK-683 executor); TASK-683 done report (AC#11 pre-existing FAIL, reproduces at HEAD~3).
- **Problem:** `main/src/orchestrator/__tests__/runExecutor.test.ts` has 4 test assertions that fail independently of any SPRINT-026 changes. The failing cases involve lifecycle transitions, a `bridgeEvents` source arg, and panelId/runId alignment — these appear to be logic regressions in the test assertions vs. the current contract rather than infrastructure failures (the fix is in test logic, not `pnpm electron:rebuild`). They have been silently suppressed across at least SPRINT-025 and SPRINT-026. Until fixed, every `pnpm test:unit` run in CI reports failure noise that masks real regressions.
- **Proposed direction:** A focused investigation task should: (1) reproduce the 4 failures locally, (2) determine whether the assertions are wrong (API changed after the tests were written) or the production code is wrong (regression in the executor), (3) update or fix accordingly, (4) confirm `pnpm test:unit` exits 0 (modulo the `better-sqlite3` ABI mismatch — see A1, which should be fixed first as a prerequisite). Key files: `main/src/orchestrator/__tests__/runExecutor.test.ts`, `main/src/orchestrator/runExecutor.ts`.
- **Scope:** small (if it's test-assertion drift) / medium (if it's a production code regression)

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** TASK-683 done report and `docs/sdk-migration-smoke-results.md:964` document 4-5 pre-existing failures in `runExecutor.test.ts` reproducing at HEAD~3 — these mask real regressions on every `pnpm test:unit` run and prerequisite A1 ensures the ABI mismatch is not the cause.

### B5. Add first-real-event latency instrumentation to enable data-driven removal of synthetic run_started
- **Summary:** The synthetic `run_started` event in `runLauncher.ts` was kept (path B) to cover a 50-500ms UI-bootstrap gap, but whether the gap actually exists at p95 is unknown — add a latency histogram so the decision can be made with data.
- **Source-Sprint:** SPRINT-026
- **Source:** FIND-SPRINT-026-11 (TASK-683 executor); TASK-683 done report (path B KEEP decision, FIND-SPRINT-026-11 logged as future improvement).
- **Problem:** `runLauncher.ts:142-150` emits a synthetic `run_started` event immediately after `RunExecutor.launch()` returns. The 50-500ms gap estimate is undocumented and unmeasured. If the p95 latency to the first real SDK event is consistently < 100ms, the synthetic event adds complexity and UX noise (especially after B2 is resolved). Without a measurement, the decision cannot be revisited.
- **Proposed direction:** Add a lightweight latency instrument in `runEventBridge.ts` or `ClaudeCodeManager.ts`: record `Date.now()` when `runLauncher.launch()` returns, then subtract when the first real SDK event arrives via `runEventBridge`. Log the delta with `logger.verbose('[RunLauncher] first-event latency: {N}ms')` per run. After a few weeks of self-hosting, query the backend log file for these entries to compute p95. If p95 < 100ms, the B2 task (above) can pick path B (remove the synthetic event); if p95 is consistently > 200ms, path A (add `run_started` as a real union member with a proper placeholder row) is correct. Dependent on B2 being resolved first — the measurement is only meaningful once `run_started` either renders correctly (path A) or is removed (path B).
- **Scope:** small

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Speculative — the synthetic event doesn't even render today (B2 finding), so instrumenting its latency before B2 ships is solving a problem that doesn't exist yet; once B2 picks Path A or B the measurement question may dissolve entirely.
- **Counterfactual:** If B2 lands as Path A (keep synthetic) and the user reports the bootstrap gap is still visible at p95, revisit this as a follow-up.

---

## C. CLAUDE.md / CODE-PATTERNS.md improvements (apply now)

### C1. Clarify Electron renderer verification posture in CLAUDE.md
- **Summary:** Add an explicit CLAUDE.md statement that `visual_web` cannot drive the Electron renderer and that `pnpm dev` + Peekaboo `visual_macos` is the correct path for UI verification.
- **Source-Sprint:** SPRINT-026
- **Status:** ready
- **source_item:** C1
- **Target file:** `CLAUDE.md`
- **Action:** insert-after the existing paragraph ending `read \`cyboflow-frontend-debug.log\` (see below).`
- **Rationale:** FIND-SPRINT-026-2 (TASK-672 verifier) and FIND-SPRINT-026-8 (TASK-682 verifier) document the same recurring failure: Playwright MCP navigates to `http://localhost:4521`, gets HTTP 200, but the JS throws `Could not find electronTRPC global` and the DOM is empty. Recurrence: `human-review-queue.md` dedup_key `visual_web_electron_unreachable` (sprints 015, 017, 020, 023, 024, 025, 026). The reviewer tightened the diff to a 2-line note pointing at the new `docs/VISUAL-VERIFICATION-SETUP.md` (C2 owns the permission detail).
- **Proposed change:**
  ```diff
  # CLAUDE.md, immediately after the existing paragraph ending
  # "read `cyboflow-frontend-debug.log` (see below)."

    Visual verification of any frontend UI change requires `pnpm dev` (full Electron). The Vite renderer at `http://localhost:4521` cannot bootstrap standalone — it depends on `preload`-injected `electronTRPC` and will error without the main process. For headless validation when capture is unavailable, read `cyboflow-frontend-debug.log` (see below).
  +
  + The `visual_web` / Playwright MCP path is NON-FUNCTIONAL here (renderer cannot bootstrap without Electron `preload`). Use `visual_macos` via Peekaboo MCP with `pnpm dev` running. Both Screen Recording AND Accessibility grants are required — see `docs/VISUAL-VERIFICATION-SETUP.md`.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Recurrence confirmed across 7 sprints (`human-review-queue.md` dedup_key `visual_web_electron_unreachable` at lines 37, 54, 71, 290 plus `visual_macos_unavailable` at line 90) — current CLAUDE.md tells agents the renderer can't bootstrap but doesn't redirect them to the correct `visual_macos`+Peekaboo path, so they keep retrying `visual_web` every UI sprint.

### C2. Document two-permission requirement for Peekaboo Accessibility in visual verification setup
- **Summary:** Create `docs/VISUAL-VERIFICATION-SETUP.md` capturing the visual_web-vs-visual_macos rationale and the two-permission (Screen Recording + Accessibility) macOS contract for Peekaboo MCP. Add a one-line entry to CLAUDE.md "Reference Docs" so the file is discoverable.
- **Source-Sprint:** SPRINT-026
- **Status:** ready
- **source_item:** C2
- **Target file:** `docs/VISUAL-VERIFICATION-SETUP.md` (new) + one-line addition to `CLAUDE.md` "Reference Docs" list
- **Action:** create-file + insert-line
- **Rationale:** FIND-SPRINT-026-3 (TASK-672 verifier): Peekaboo MCP host had Screen Recording granted but NOT Accessibility, silently blocking UI interaction. The reviewer kept C2 as a single ready item (entire content is setup/recipe — no rule half to split into CLAUDE.md beyond the discoverability pointer).
- **Proposed change:**
  ```diff
  # 1. Create new file: docs/VISUAL-VERIFICATION-SETUP.md with this content:

  + # Visual Verification Setup (cyboflow)
  +
  + This project is an Electron app. The Vite renderer at `http://localhost:4521`
  + depends on `preload`-injected `electronTRPC` and cannot bootstrap standalone, so
  + the `visual_web` / Playwright MCP path returns an empty page (HTTP 200, DOM empty).
  + Use `visual_macos` via Peekaboo MCP with `pnpm dev` running and the Electron
  + window visible.
  +
  + ## macOS Permissions Required for Peekaboo MCP
  +
  + Two separate macOS grants must be enabled for the Claude Code host process:
  +
  + 1. **Screen Recording** — enables window screenshots.
  +    System Settings > Privacy & Security > Screen Recording > Claude Code.
  + 2. **Accessibility** — enables UI events (click, type, key press, menu).
  +    System Settings > Privacy & Security > Accessibility > Claude Code.
  +
  + Screen Recording alone is NOT sufficient: capture works but interaction is
  + silently blocked. If `visual_macos` returns screenshots but clicks/keystrokes do
  + nothing, check Accessibility first. After granting either permission, quit and
  + relaunch Claude Code.
  +
  + Recurrence evidence: `human-review-queue.md` dedup_keys
  + `visual_web_electron_unreachable` and `visual_macos_unavailable` (affected
  + sprints 015, 017, 020, 023, 024, 025, 026).

  # 2. CLAUDE.md, in the "Reference Docs" bullet list, add one entry between
  #    the `signing/...` line and the closing blank line:

    - `docs/signing/APPLE_DEVELOPER_SETUP.md` — Apple signing env-var contract and provisioning steps. Load before any build, packaging, or release task.
  + - `docs/VISUAL-VERIFICATION-SETUP.md` — Electron visual-verification contract (visual_web non-functional; visual_macos via Peekaboo; two macOS permissions).
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed `docs/VISUAL-VERIFICATION-SETUP.md` does not yet exist and the two-permission (Screen Recording + Accessibility) trap is documented in `MEMORY.md` plus the recurring `visual_macos_unavailable` queue entry — Accessibility is the more commonly missed grant and the recipe-shaped content belongs in a referenced doc, not inflated into CLAUDE.md.

### C3. Document StreamEvent discriminated-union narrowing convention in CODE-PATTERNS.md
- **Summary:** Add a CODE-PATTERNS.md note that `StreamEvent.type` and `StreamEvent.payload` must be narrowed together; model synthetic non-SDK events as discriminated-union members so casts stay eliminated.
- **Source-Sprint:** SPRINT-026
- **Status:** ready
- **source_item:** C3
- **Target file:** `docs/CODE-PATTERNS.md`
- **Action:** insert-after the "Claude stream block types" entry block (under "Shared types as the cross-package contract")
- **Rationale:** FIND-SPRINT-026-20 (SPRINT-026 sprint-code-reviewer): TASK-682 narrowed `StreamEvent.type` to `StreamEventType` but left `payload: unknown`; consumers compensate with five `as` casts at `RunView.tsx:38,98,138,167,186`. The reviewer trimmed the inline TS snippet — CODE-PATTERNS.md entries reference code, they don't ship code. Pointer to the verified cast sites kept as canonical evidence.
- **Proposed change:**
  ```diff
  # docs/CODE-PATTERNS.md, immediately after the "Claude stream block types"
  # entry's final bullet "TS↔Zod drift bridge: ...", before the
  # "### Zustand store structure (renderer)" heading. Add a new bold entry
  # under the same "Shared types as the cross-package contract" section:

  + **StreamEvent discriminated-union narrowing:** `StreamEvent.type` (`frontend/src/utils/cyboflowApi.ts`)
  + and `StreamEvent.payload` MUST be narrowed in the same pass. Leaving `payload: unknown`
  + while `type` is a union forces `as ClaudeStreamEvent`-style casts at every consumer and
  + defeats the discriminated-union design. If a non-SDK synthetic event exists (e.g. a
  + bootstrap `run_started` row with no SDK payload), model it as its own union member
  + (`{ type: 'run_started'; payload?: undefined }`) so `switch (event.type)` stays
  + exhaustively auto-narrowed. A bare `payload: unknown` on a typed envelope is the
  + tripwire — grep for it before merging.
  + Canonical drift: FIND-SPRINT-026-20 — five surviving casts at `RunView.tsx:38,98,138,167,186`.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Verified all five `as`-cast sites at `RunView.tsx:38,98,138,167,186` and the unmatched `payload: unknown` declaration at `cyboflowApi.ts:44` — the rule cites a concrete drift the team just shipped, lives in CODE-PATTERNS.md (not CLAUDE.md) so it doesn't inflate the every-agent prompt budget, and gives the B2 follow-up a canonical anchor.

---

## Reconciled Findings (informational)

The following findings had `status: open` in the findings queue at sprint close but were claimed as resolved by a done report. The sprint-closer's reconciliation step should have patched these; they are listed here as a safety net.

- **FIND-SPRINT-026-6** — claimed resolved by TASK-682 in `/Users/raimundoesteva/Developer/cyboflow/.claude/worktrees/sdk-migration-decomp/.soloflow/archive/done/claude-agent-sdk-migration/TASK-682-done.md` (cross-task scope deviation, camelCase rename applied per FIND-SPRINT-026-5 recommendation).
- **FIND-SPRINT-026-12** — claimed resolved (orchestrator post-verifier action: `review-queue.js append` for 6 deferred smoke entries) by TASK-683 in `/Users/raimundoesteva/Developer/cyboflow/.claude/worktrees/sdk-migration-decomp/.soloflow/archive/done/claude-agent-sdk-migration/TASK-683-done.md`. The findings file `resolved_by` field is blank; the done report states "logged → resolved by orchestrator."

---

## Suppressed — SoloFlow Defects

The following candidates were considered for Bucket C but reclassified as SoloFlow plugin defects. Tester mode is off, so they are suppressed from the proposal rather than elevated to Bucket D. Consider opening an issue or re-running `/soloflow:compound --tester` against this sprint in a SoloFlow-tester setup to surface them as maintainer recommendations.

- **sprint-initiator omits depends_on in sprint.json** — the sprint-initiator generated a sprint.json for SPRINT-026 without `depends_on` entries on the tasks that require sequential execution, which would have allowed a parallel-mode executor to run dependent tasks before their prerequisites. This is a SoloFlow sprint-initiator agent behavior defect (it should emit depends_on chains for tasks in the same epic that share a schema/type contract), not a project convention.
