---
sprints: [SPRINT-023]
span_label: SPRINT-023
created: "2026-05-19T00:00:00.000Z"
counters_start:
  ideas: 19
summary:
  cleanups: 5
  backlog_tasks: 4
  claude_md: 1
  soloflow_improvements: 0
---

# Compound Proposal — SPRINT-023

## A. Clean-up items (execute now)

### A1. Remove stale eslint-disable-next-line in useStuckNotifications.ts
- **Summary:** A now-unnecessary `// eslint-disable-next-line react-hooks/exhaustive-deps` comment on line 101 of `useStuckNotifications.ts` can be deleted — the rule no longer flags that `useEffect` block after TASK-623's refactor.
- **Source-Sprint:** SPRINT-023
- **Rationale:** The disable directive was introduced to suppress a lint warning that no longer exists after the hook was refactored. Leaving it in place is misleading (implies the hook still has a deps issue) and is flagged by ESLint as an unused-disable warning.
- **Blast radius:** Single line deletion in one file. Risk: trivial.
- **Source:** FIND-SPRINT-023-5 (surfaced by verifier on TASK-623)
- **Proposed change:**
  ```diff
  // frontend/src/hooks/useStuckNotifications.ts  (line 101)
  -  // eslint-disable-next-line react-hooks/exhaustive-deps
  ```

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** high
- **Reasoning:** The directive at `frontend/src/hooks/useStuckNotifications.ts:101` is currently `// eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: runs once on mount only` — it is the standard mount-only suppression for the `useEffect(..., [])` on lines 90-102 that calls `API.config.get()` and `requestPermission()` without listing them as deps, so the rule WILL fire if removed.
- **Counterfactual:** If running `pnpm lint` after deletion shows zero warnings on this hook (proving the deps array is actually exhaustive), then implement.

### A2. Delete dead useMcpHealth hook and its test file
- **Summary:** `frontend/src/hooks/useMcpHealth.ts` and its test file have zero production callers after TASK-626 removed the Sidebar MCP indicator — the entire hook file is dead code.
- **Source-Sprint:** SPRINT-023
- **Rationale:** TASK-626 removed the sole production consumer (Sidebar MCP indicator) and the hook's JSDoc acknowledges it is preserved "as a thin adapter for any remaining 4-value consumers" — but grep confirms there are none. The adapter also implements a lossy round-trip (`restartAttempts` hardcoded to `0`) that would silently corrupt data if anyone did call it. Keeping dead code that can corrupt data is strictly worse than deleting it.
- **Blast radius:** Delete `frontend/src/hooks/useMcpHealth.ts` and `frontend/src/hooks/__tests__/useMcpHealth.test.tsx`. No production importers exist. Risk: low (verify with `grep -rn 'useMcpHealth' frontend/src` returns zero non-test hits before deleting).
- **Source:** FIND-SPRINT-023-10 (surfaced by sprint-code-reviewer on TASK-626)
- **Proposed change:**
  ```
  Delete: frontend/src/hooks/useMcpHealth.ts
  Delete: frontend/src/hooks/__tests__/useMcpHealth.test.tsx
  Pre-flight: grep -rn 'useMcpHealth' frontend/src   # must return only hits inside these two files
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** `grep -rn 'useMcpHealth' frontend/src` returns only `useMcpHealthStore` callsites (the store, not the hook) plus self-references inside `frontend/src/hooks/useMcpHealth.ts` and its own test file — zero production importers of the `useMcpHealth` function, confirming dead code with a lossy `restartAttempts: 0` round-trip waiting to corrupt any future caller.

### A3. Delete orphaned base PendingApprovalCard and migrate its unique tests
- **Summary:** The original `frontend/src/components/PendingApprovalCard.tsx` (184 lines) has no production importers after TASK-622 swapped ReviewQueueView to use the stuck-aware `ReviewQueue/PendingApprovalCard` variant — delete it along with its test file and fold any unique test cases into the canonical test file.
- **Source-Sprint:** SPRINT-023
- **Rationale:** TASK-622 moved the canonical import path; TASK-625 even patched the orphaned file to keep its tests passing. No production path executes the base variant. `docs/CODE-PATTERNS.md §Extract-shared-utility refactors: prove completeness` explicitly requires retiring the old path after the new one takes over. The test file (`frontend/src/components/__tests__/PendingApprovalCard.test.tsx`, 449 lines) is the sole importer. The `ReviewQueue/PendingApprovalCard` already covers the full stuck-aware superset of behavior.
- **Blast radius:** Delete `frontend/src/components/PendingApprovalCard.tsx`, `frontend/src/components/__tests__/PendingApprovalCard.test.tsx`. Update the mock-path comment in `OnboardingCard.test.tsx` that still references the deleted path. Risk: low (verify with `grep -rn 'components/PendingApprovalCard' frontend/src` targets only these files).
- **Source:** FIND-SPRINT-023-8 (surfaced by sprint-code-reviewer; TASK-622 swap, TASK-625 orphan-patch cited as evidence)
- **Proposed change:**
  ```
  Delete: frontend/src/components/PendingApprovalCard.tsx
  Delete: frontend/src/components/__tests__/PendingApprovalCard.test.tsx
  Update: frontend/src/components/OnboardingCard.test.tsx — remove stale mock-path comment referencing the deleted base component
  Pre-flight: grep -rn "'.*components/PendingApprovalCard'" frontend/src
              grep -rn '".*components/PendingApprovalCard"' frontend/src
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** `grep -rn "components/PendingApprovalCard"` shows zero non-test production importers of the base file — `ReviewQueueView.tsx:3` imports from `./ReviewQueue/PendingApprovalCard` (stuck-aware variant) and the only importer of the orphan is its own `__tests__/PendingApprovalCard.test.tsx`, matching the `docs/CODE-PATTERNS.md §Extract-shared-utility refactors: prove completeness` retirement requirement.

### A4. Downgrade per-invocation WARN log in cancelAndRestartHandler to debug
- **Summary:** The `logger.warn(...)` added by TASK-627 in `cancelAndRestartHandler.ts` fires unconditionally on every Cancel-and-restart click, flooding production logs with a paragraph about TASK-304 not having landed — downgrade to `logger.debug` or emit once at ApprovalRouter init.
- **Source-Sprint:** SPRINT-023
- **Rationale:** The corresponding tooltip on `PendingApprovalCard` already communicates the same caveat to the user. The `warn` level is appropriate for unexpected conditions; a known, documented no-op invoked by normal UI interaction does not warrant a multi-line warning per click. Once Cancel-and-restart is used routinely this will drown out genuine warnings in production logs.
- **Blast radius:** `main/src/orchestrator/cancelAndRestartHandler.ts:124-128` — change `logger.warn` to `logger.debug` (or restructure to emit once). Risk: trivial.
- **Source:** FIND-SPRINT-023-12 (surfaced by sprint-code-reviewer on TASK-627)
- **Proposed change:**
  ```diff
  // main/src/orchestrator/cancelAndRestartHandler.ts (~line 124)
  -  logger?.warn(
  -    `clearPendingForRun is a no-op until TASK-304 lands ...`,
  -    { runId }
  -  );
  +  logger?.debug(
  +    `clearPendingForRun is a no-op until TASK-304 lands ...`,
  +    { runId }
  +  );
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** `main/src/orchestrator/cancelAndRestartHandler.ts:127-130` confirms the unconditional `logger?.warn(...)` fires inside the per-run queue on every Cancel-and-restart click with a multi-line TASK-304 paragraph — a one-line severity downgrade trivially fixes the impending log-flood without changing behavior or call semantics.

### A5. Migrate two remaining claudeCodeManager test files to canonical dbAdapter fixture
- **Summary:** Two `claudeCodeManager` test files still carry inline `function dbAdapter` definitions identical to the canonical fixture at `__test_fixtures__/dbAdapter.ts` — complete the repo-wide consolidation that TASK-633 finished for the other four files.
- **Source-Sprint:** SPRINT-023
- **Rationale:** TASK-633 extracted the canonical fixture and migrated four orchestrator test files; the planner's pre-flight check missed these two files because they live under a different path (`services/panels/claude/__tests__/`). Leaving them inline creates the exact drift surface that CODE-PATTERNS.md §Extract-shared-utility refactors: prove completeness warns against.
- **Blast radius:** `main/src/services/panels/claude/__tests__/claudeCodeManager.killProcess.test.ts:81` and `main/src/services/panels/claude/__tests__/claudeCodeManagerWiring.test.ts:76` — replace the inline `function dbAdapter` with an import from `main/src/orchestrator/__test_fixtures__/dbAdapter`. Risk: low.
- **Source:** FIND-SPRINT-023-6 (surfaced by executor on TASK-633; explicitly noted in TASK-633-done.md as out-of-scope follow-up)
- **Proposed change:**
  ```diff
  // In each of the two test files:
  -function dbAdapter(db: Database): DatabaseLike {
  -  return { prepare: db.prepare.bind(db), transaction: db.transaction.bind(db) };
  -}
  +import { dbAdapter } from '../../../orchestrator/__test_fixtures__/dbAdapter';
  // (adjust relative path as needed per file location)
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Both cited files (`claudeCodeManager.killProcess.test.ts:81` and `claudeCodeManagerWiring.test.ts:76`) inline identical `function dbAdapter` definitions that match the canonical export at `main/src/orchestrator/__test_fixtures__/dbAdapter.ts`, and TASK-633 explicitly flagged these as out-of-scope follow-ups so completing the consolidation is the proportional `prove-completeness` finish.

---

## B. Backlog tasks (refine into execution-ready plans)

### B1. Extract shared StuckEventsClient interface and eliminate doubled tRPC subscription
- **Summary:** `useStuckNotifications` and `reviewQueueSlice` each re-declare an identical `StuckEventsClient` interface and each open their own independent tRPC subscription to `cyboflow.events.onStuckDetected`, causing every stuck event to traverse the IPC bridge twice.
- **Source-Sprint:** SPRINT-023
- **Source:** FIND-SPRINT-023-9 (sprint-code-reviewer cross-task analysis of TASK-622 and TASK-623)
- **Problem:** `frontend/src/hooks/useStuckNotifications.ts:40,112` and `frontend/src/stores/reviewQueueSlice.ts:47,193` both redeclare verbatim:
  ```typescript
  interface StuckEventsClient {
    onStuckDetected: {
      subscribe(input: undefined, callbacks: { onData: ...; onError: ... }): { unsubscribe(): void };
    };
  }
  ```
  Both cast `trpc.cyboflow.events as unknown as StuckEventsClient` and subscribe at App top-level. Every stuck event triggers two independent observer chains — one writes `runStatusMap`, the other dispatches macOS notifications. Once TASK-254 ships, both sites must be updated in sync. The duplication was invisible to per-task reviewers; only the cross-sprint view reveals it.
- **Proposed direction:** Extract the shared interface to `shared/types/stuckDetection.ts` (alongside the existing `StuckDetectedEvent` and `StuckReason` types already there after TASK-623). Then consolidate the two App-level subscriptions: the preferred approach is to have `useStuckNotifications` subscribe to Zustand `reviewQueueSlice` diffs (reading `runStatusMap` changes) instead of opening its own tRPC subscription — this makes the slice the single source of truth and collapses two IPC subscriptions into one. If the Zustand-diff approach proves awkward, an alternative is a thin singleton event emitter in `frontend/src/utils/stuckEventsClient.ts` that opens exactly one tRPC subscription and fans out to both consumers. Either way, App.tsx should mount only one `subscribeToStuckEvents` call.
- **Scope:** medium

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Verbatim duplication confirmed at `useStuckNotifications.ts:40-50` and `reviewQueueSlice.ts:47-57` (both `interface StuckEventsClient` definitions plus the `trpc.cyboflow.events as unknown as StuckEventsClient` cast), and `App.tsx:80,91-95` mounts both subscriptions in parallel — fixing both sites in lockstep when TASK-254 lands is real coordination cost, and consolidating to one cast site has a natural home in the existing `shared/types/stuckDetection.ts` that both already import from.
- **Counterfactual:** If the Zustand-diff approach for `useStuckNotifications` turns out to break the "fire exactly once per app-launch per runId" semantics (e.g. because a runId can transition `stuck → stuck` and miss the diff), drop the consolidation half and keep only the shared-interface extraction.

### B2. Extend setRunStatus terminal-eviction to also evict runReasonMap and runDetectedAtMap
- **Summary:** `reviewQueueSlice` evicts `runStatusMap` entries on terminal transitions (completed/canceled/failed) but leaves the matching `runReasonMap` and `runDetectedAtMap` entries alive indefinitely, causing unbounded map growth over a long session.
- **Source-Sprint:** SPRINT-023
- **Source:** FIND-SPRINT-023-13 (sprint-code-reviewer on TASK-624; JSDoc at line 80 of `reviewQueueSlice.ts` explicitly documents the gap)
- **Problem:** `frontend/src/stores/reviewQueueSlice.ts:168-182`: `setRunStatus` deletes `runStatusMap[runId]` on terminal status but leaves `runReasonMap[runId]` and `runDetectedAtMap[runId]` in place. The JSDoc notes: "Entries are written alongside runStatusMap but are NOT evicted on terminal status." Over many stuck-then-canceled runs the two maps accumulate dead entries. The JSDoc claims the reason "stays available for diagnostic display even after cancel" but this should be verified — if no consumer reads `runReasonMap` or `runDetectedAtMap` after a run's terminal transition, the comment is wrong and eviction is safe.
- **Proposed direction:** Audit all consumers of `useRunStuckDetails(runId)` in the frontend to confirm whether any read stuck details for a run after its terminal transition. If no consumer does, extend the `setRunStatus` terminal-eviction branch in `reviewQueueSlice.ts:168-182` to also `delete state.runReasonMap[runId]` and `delete state.runDetectedAtMap[runId]`. Update the JSDoc at line 80. Add a test asserting that terminal-status transitions evict all three maps. If a consumer genuinely needs post-terminal reason data, gate writes on `runStatusMap` membership instead (skip writes for already-terminal runs) and document the rationale.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** `reviewQueueSlice.ts:168-182` confirms only `runStatusMap` is evicted on terminal status while `runReasonMap`/`runDetectedAtMap` grow unbounded, and `ReviewQueue/PendingApprovalCard.tsx:102` already gates `useRunStuckDetails(isStuck ? runId : undefined)` so consumers ignore the maps post-terminal — the JSDoc's "stays available for diagnostic display" claim is unsupported by any current callsite, making three-map eviction safe and proportional.

### B3. Migrate git:execute-project shell arg escaping to escapeShellArg / buildSafeCommand
- **Summary:** The `git:execute-project` IPC handler in `main/src/ipc/file.ts:795-821` still inlines its own shell arg escaper (double-quote wrapping with backslash-escape) instead of using `escapeShellArg` from `shellEscape.ts`, which TASK-628's shared-utility refactor was meant to canonicalize.
- **Source-Sprint:** SPRINT-023
- **Source:** FIND-SPRINT-023-11 (sprint-code-reviewer on TASK-628; cites `docs/CODE-PATTERNS.md §Extract-shared-utility refactors: prove completeness`)
- **Problem:** `main/src/ipc/file.ts:811-816` wraps args in double quotes and only escapes the inner double-quote with a backslash. This is strictly weaker than `escapeShellArg` (single-quote wrapping from `shellEscape.ts`) — it does not protect against backticks, `$(...)` command substitution, or other shell metacharacters in arg values. TASK-628 consolidated five commit-footer sites but the pre-flight grep pattern for inline shell escapers did not cover this handler. Any arg value containing shell metacharacters (e.g. a branch name with `$` or a commit message with backticks) will produce incorrect shell commands.
- **Proposed direction:** In `main/src/ipc/file.ts:795-821`, replace the inline arg-mapper at lines 811-816 with `buildSafeCommand('git', ...request.args)` from `main/src/utils/shellEscape.ts`. Run `grep -rn 'replace(/"/g' main/src` and `grep -rn "replace(/'/" main/src` to confirm there are no other inline shell escapers TASK-628's refactor missed. Add a unit test asserting that `git:execute-project` correctly escapes an arg containing a single quote, a backtick, and a `$(command)` substitution sequence.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** `main/src/ipc/file.ts:811-816` confirms the inline `"${arg.replace(/"/g, '\\"')}"` pattern that is strictly weaker than `escapeShellArg` (single-quote wrapping at `main/src/utils/shellEscape.ts:18`), and a broader audit shows two more inline sites (`worktreeManager.ts:653` and `runCommandManager.ts:78`) the proposal's grep would catch — this is a real shell-injection surface, not cosmetic, and `buildSafeCommand` is the in-repo canonical fix that TASK-628 explicitly meant to be the migration target.

### B4. Extract cyboflowSessionEnv shared helper to consolidate dual-set PTY env pattern
- **Summary:** The `CYBOFLOW_SESSION_ID` + `CRYSTAL_SESSION_ID` dual-set pattern is inlined identically in two PTY managers (`terminalSessionManager.ts` and `terminalPanelManager.ts`) — extracting it to a shared helper reduces the two-site update needed when the CRYSTAL_SESSION_ID deprecation lifts.
- **Source-Sprint:** SPRINT-023
- **Source:** FIND-SPRINT-023-14 (sprint-code-reviewer on TASK-631)
- **Problem:** `main/src/services/terminalSessionManager.ts:48-52` (added by TASK-631) and `main/src/services/terminalPanelManager.ts:55-59` (pre-existing TASK-577 pattern) both inline the same:
  ```typescript
  CYBOFLOW_SESSION_ID: sessionId,
  CRYSTAL_SESSION_ID: sessionId, // @deprecated — TODO(post-v1): remove
  ```
  When the deprecation lifts, both sites must be updated. A future grep for `CRYSTAL_SESSION_ID` will surface them, but a shared helper makes removal a one-line change and eliminates any risk of one site drifting (e.g. spelling the variable differently, or a third manager being added without the dual-set).
- **Proposed direction:** Create `main/src/utils/cyboflowSessionEnv.ts` exporting:
  ```typescript
  export function cyboflowSessionEnvVars(sessionId: string): Record<string, string> {
    return {
      CYBOFLOW_SESSION_ID: sessionId,
      CRYSTAL_SESSION_ID: sessionId, // @deprecated — TODO(post-v1): remove
    };
  }
  ```
  Spread `cyboflowSessionEnvVars(sessionId)` into the env block of both PTY managers, replacing the inlined properties. Run `grep -rn 'CRYSTAL_SESSION_ID' main/src` to confirm no other inline sites were missed. Add a unit test asserting the returned object has both keys set to the same value. Update the `docs/CODE-PATTERNS.md §Shared Utilities` section to register the new helper.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** medium
- **Reasoning:** The two PTY managers do NOT share a verbatim pattern — `terminalPanelManager.ts:54-60` sets four keys (`CYBOFLOW_SESSION_ID`, `CYBOFLOW_PANEL_ID`, `CRYSTAL_SESSION_ID`, `CRYSTAL_PANEL_ID`) while `terminalSessionManager.ts:48-52` sets only two — extracting a shared helper would either force the panel manager to lose its panel-id pair or require a parameterized helper for a two-site, two-line deletion that a `grep CRYSTAL_SESSION_ID` already cleanly surfaces at deprecation time.
- **Counterfactual:** If a third PTY manager is added in a future sprint, or if the panel/session helpers naturally converge (e.g. a unified `pty.ts` factory lands), the consolidation becomes proportional.

---

## C. CLAUDE.md / CODE-PATTERNS.md improvements (apply now)

### C1. Document `shared/types/stuckDetection.ts` as the canonical home for stuck-event types and subscription interface
- **Summary:** No existing CODE-PATTERNS.md entry tells agents that the `StuckEventsClient` cast pattern and stuck-event types belong in `shared/types/stuckDetection.ts` — two tasks independently re-declared both in SPRINT-023.
- **Source-Sprint:** SPRINT-023
- **Target file:** `/Users/raimundoesteva/Developer/cyboflow/docs/CODE-PATTERNS.md`
- **Action:** insert-after `"- `shared/types/cliPanels.ts` — CLI-specific panel types"` (append a new paragraph to the "Shared types as the cross-package contract" section, immediately before the "Label maps for shared-type discriminants" paragraph)
- **Status:** ready
- **source_item:** C1
- **Diff:**
  ```diff
  --- a/docs/CODE-PATTERNS.md
  +++ b/docs/CODE-PATTERNS.md
  @@ -131,6 +131,17 @@ domain concept that spans both, define its type in `shared/types/` first. Never duplicate
   - `shared/types/panels.ts` — panel configuration and state types
   - `shared/types/cliPanels.ts` — CLI-specific panel types
   
  +**Stuck-event types** live in `shared/types/stuckDetection.ts` — `StuckDetectedEvent`,
  +`StuckReason`, and the forward-looking `StuckEventsClient` structural cast shim used
  +until TASK-254 ships a typed `trpc.cyboflow.events.onStuckDetected` subscription. Rules:
  +
  +- Import all stuck-event types from `shared/types/stuckDetection.ts`. Do NOT re-declare
  +  `StuckEventsClient` or `StuckDetectedEvent` locally — SPRINT-023 had two sites do this
  +  independently, producing a verbatim duplicate interface and a doubled IPC subscription.
  +- Exactly one App-level mount should cast `trpc.cyboflow.events as unknown as
  +  StuckEventsClient` and open the subscription. Other consumers read from the Zustand
  +  `reviewQueueSlice` (`runStatusMap`) instead of opening their own tRPC subscription.
  +- Audit: `grep -rn 'StuckEventsClient' frontend/src` must return exactly one cast site.
  +
   **Label maps for shared-type discriminants** belong next to the type (same file
   or a companion `*Labels.ts` in `shared/types/`), keyed by `Record<Union['kind'], string>`
   so adding a new variant breaks the map at compile time. Never duplicate the map in a
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** The duplication is concrete and recurring — two independent SPRINT-023 tasks (TASK-622 and TASK-623) each re-declared `interface StuckEventsClient` verbatim at `reviewQueueSlice.ts:47-57` and `useStuckNotifications.ts:40-50`, and the existing CODE-PATTERNS.md §Shared types section already lists peer files (`models.ts`, `panels.ts`, `cliPanels.ts`, `claudeStream.ts`) so registering `stuckDetection.ts` alongside them is additive and matches the file's audit-grep contract; the rule will pay off again when TASK-254 lands and removes the cast.
- **Counterfactual:** If TASK-254 lands before this rule is applied (collapsing the cast entirely), demote to a shorter one-line entry listing the file with no audit grep.

---

## Reconciled Findings (informational)

No stale-open findings were detected. All resolved findings had explicit `status: resolved` in the findings file; no done report claimed resolution of a finding still marked `open`. The sprint-closer reconciliation step appears to have run cleanly for findings 1–4 and 7.

---

## Suppressed — SoloFlow Defects

No C-candidates were reclassified as SoloFlow defects. All findings triaged into bucket C are about this project's codebase conventions (shared types, subscription patterns, IPC escaping), not about SoloFlow agent behavior.
