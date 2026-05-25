---
sprints: [SPRINT-036]
span_label: SPRINT-036
created: 2026-05-24T00:00:00.000Z
counters_start:
  ideas: 25
summary:
  cleanups: 4
  backlog_tasks: 1
  claude_md: 1
  soloflow_improvements: 0
---

# Compound Proposal — SPRINT-036

## A. Clean-up items (execute now)

### A1. Delete orphan `prompts:get-by-id` IPC chain (4-file sweep)
- **Summary:** Four files still define the `prompts:get-by-id` IPC channel and its call stack even though the only consumer — the `navigateToPrompt` dispatch block in `PromptHistoryModal.tsx` — was deleted in TASK-735.
- **Source-Sprint:** SPRINT-036
- **Rationale:** Dead infrastructure in the IPC layer is a maintenance hazard: it inflates `preload.ts` surface, keeps an untyped `Promise<IPCResponse>` site alive in `electron.d.ts`, and can mislead future agents into thinking prompt-by-id lookup is a live feature. No prompt-navigation roadmap item exists in active ideas.
- **Blast radius:** 4 files (`main/src/ipc/prompt.ts`, `main/src/preload.ts`, `frontend/src/utils/api.ts`, `frontend/src/types/electron.d.ts`); trivial risk — deletion of dead code with zero callers confirmed by grep.
- **Source:** FIND-SPRINT-036-1 (TASK-735 code-reviewer)
- **Proposed change:**
  ```diff
  // main/src/ipc/prompt.ts — delete the ipcMain.handle block (lines 26-34):
  -  ipcMain.handle('prompts:get-by-id', async (_event, promptId: string) => {
  -    try {
  -      const promptMarker = sessionManager.getPromptById(promptId);
  -      return { success: true, data: promptMarker };
  -    } catch (error) {
  -      console.error('Failed to get prompt by id:', error);
  -      return { success: false, error: 'Failed to get prompt by id' };
  -    }
  -  });

  // main/src/preload.ts — delete the getByPromptId binding (line 323):
  -    getByPromptId: (promptId: string): Promise<IPCResponse> => ipcRenderer.invoke('prompts:get-by-id', promptId),

  // frontend/src/utils/api.ts — delete the getByPromptId wrapper (lines 399-402):
  -    async getByPromptId(promptId: string) {
  -      if (!isElectron()) throw new Error('Electron API not available');
  -      return window.electronAPI.prompts.getByPromptId(promptId);
  -    },

  // frontend/src/types/electron.d.ts — delete the type declaration (line 207):
  -    getByPromptId: (promptId: string) => Promise<IPCResponse<unknown>>;
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** grep across `main/src` and `frontend/src` shows the only remaining references to `prompts:get-by-id` / `getByPromptId` are the four cited files plus the now-unused `sessionManager.getPromptById` method — no live consumer remains after TASK-735.

### A2. Remove stale `afterEach` block and outdated comment in `runs.test.ts`
- **Summary:** An empty `afterEach(() => { ... })` in `runs.test.ts` (lines 231-242) still references a FORBIDDEN test deleted by TASK-739; the block does nothing and its multi-line comment explains a test that no longer exists.
- **Source-Sprint:** SPRINT-036
- **Rationale:** Dead `afterEach` code with a misleading comment (references the deleted `(c) Non-'local' userId` test) makes the test suite harder to read and can confuse the next maintainer into thinking there is state-isolation logic at play when there is none.
- **Blast radius:** 1 file (`main/src/orchestrator/trpc/routers/__tests__/runs.test.ts`); trivial — removes dead code only.
- **Source:** FIND-SPRINT-036-2 (TASK-739 code-reviewer)
- **Proposed change:**
  ```diff
  // main/src/orchestrator/trpc/routers/__tests__/runs.test.ts — delete lines 231-242:
  -  afterEach(() => {
  -    // Reset module-level startRunDeps between tests so guards are back to
  -    // their unwired state. We do this by wiring a sentinel that throws, then
  -    // the next test sets its own deps in beforeEach as needed. Alternatively
  -    // we could patch the module variable directly, but going through the
  -    // public API is cleaner and mirrors how index.ts uses it.
  -    //
  -    // For the METHOD_NOT_SUPPORTED test we simply don't call setStartRunDeps
  -    // at all (never wired) — afterEach from a preceding test must have reset
  -    // it. We use a separate describe level so the afterEach only runs after
  -    // tests that did wire deps.
  -  });
  ```
  Also remove `afterEach` from the `import { describe, it, expect, beforeEach, afterEach, vi }` import (line 32) since it becomes an unused import.

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** `grep -c "afterEach("` confirms exactly one call site in `runs.test.ts` (the empty block on lines 231-242), so removing both the block and the import is safe with zero blast radius beyond this single test file.

### A3. Downgrade `import Database` to `import type Database` in `composeMcpServers.test.ts`
- **Summary:** `claudeCodeManager.composeMcpServers.test.ts:24` still uses a runtime import for `better-sqlite3` after TASK-740 removed the only `new Database()` call; the sibling file `runs.test.ts` was correctly downgraded to `import type` in the same sweep.
- **Source-Sprint:** SPRINT-036
- **Rationale:** Consistency with the sibling sweep in TASK-740; a runtime import of a native Node module in a test file that only needs the type is unnecessary coupling.
- **Blast radius:** 1 file (`main/src/services/panels/claude/__tests__/claudeCodeManager.composeMcpServers.test.ts`); trivial.
- **Source:** FIND-SPRINT-036-3 (TASK-740 code-reviewer)
- **Proposed change:**
  ```diff
  // main/src/services/panels/claude/__tests__/claudeCodeManager.composeMcpServers.test.ts:24
  -import Database from 'better-sqlite3';
  +import type Database from 'better-sqlite3';
  ```
  Pre-change verification: `grep -n "new Database\|Database\.prepare\|Database\.exec" main/src/services/panels/claude/__tests__/claudeCodeManager.composeMcpServers.test.ts` must return 0 hits (confirming type-only usage).

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** verified the only `Database` usage in `claudeCodeManager.composeMcpServers.test.ts` is `let db: Database.Database;` on line 139 (a type position) — no runtime constructor or method calls, matching the sibling sweep TASK-740 already applied to `runs.test.ts`.

### A4. Prune stale `(see TASK-742)` forward-reference in `CLAUDE.md`
- **Summary:** `CLAUDE.md` line 41 ends with `(see TASK-742)`, referring readers to a now-completed task; the parenthetical is stale noise since the work is done and the task ID is not searchable by future agents.
- **Source-Sprint:** SPRINT-036
- **Rationale:** TASK-742 is archived; the parenthetical adds no durable information and slightly undermines the authority of the surrounding sentence by implying it is provisional.
- **Blast radius:** 1 file (`CLAUDE.md`); trivial.
- **Source:** TASK-742-done.md (sprint close; done report notes CLAUDE.md was updated during the task)
- **Proposed change:**
  ```diff
  // CLAUDE.md line 41 — remove the trailing parenthetical:
  -Verifiers MUST use `pnpm test:unit` (or per-workspace `pnpm --filter main test` + `pnpm --filter frontend test`) as the code-change AC gate; treat `pnpm test:e2e` failures as environmental until the Playwright config is reworked (see TASK-742).
  +Verifiers MUST use `pnpm test:unit` (or per-workspace `pnpm --filter main test` + `pnpm --filter frontend test`) as the code-change AC gate; treat `pnpm test:e2e` failures as environmental until the Playwright config is reworked.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** confirmed CLAUDE.md line 41 ends with `(see TASK-742)` and `.soloflow/archive/done/testing-infrastructure/TASK-742-done.md` shows the task is closed — the parenthetical is purely historical noise after a one-line edit.

---

## B. Backlog tasks (refine into execution-ready plans)

### B1. Delete the `frontend/src/utils/trpcClient.ts` backwards-compatibility shim and migrate remaining production importers
- **Summary:** The shim at `frontend/src/utils/trpcClient.ts` was intentionally preserved by TASK-741 pending a production-side follow-up; the 10 test files have been swept but production callers still import via the shim path rather than the canonical `frontend/src/trpc/client.ts`.
- **Source-Sprint:** SPRINT-036
- **Source:** TASK-741-done.md ("The shim at `frontend/src/utils/trpcClient.ts` is intentionally left intact for a separate production-side follow-up task."); CODE-PATTERNS.md tRPC client entry ("Why single-source: tRPC v11 subscriptions register IPC listeners per `createTRPCProxyClient` instance — a second instance (or re-export shim) causes duplicate event delivery.")
- **Problem:** `frontend/src/utils/trpcClient.ts` is documented in CODE-PATTERNS.md as the canonical import path for tRPC (`import { trpc } from '<relative>/utils/trpcClient'`), but the file is now just a backward-compat shim re-exporting from `../trpc/client`. The mismatch between the documented canonical path and the real canonical path creates confusion for future agents. The shim is safe (it is a pure re-export), but it is unnecessary indirection once all callers are updated.
- **Proposed direction:** Grep for all production (non-test) importers of `utils/trpcClient` across `frontend/src/` (excluding `__tests__/` and test setup files). Update each to import from the canonical `frontend/src/trpc/client` path. Update CODE-PATTERNS.md to point the tRPC client entry at `frontend/src/trpc/client.ts` as the canonical path. Finally, delete `frontend/src/utils/trpcClient.ts`. Verify with `pnpm --filter frontend test` and `pnpm typecheck`. The shim must NOT be replaced by a new one — the whole point is to converge on a single module.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** grep confirms 8 production files in `frontend/src/` (stores, components, hooks) still route through the shim while `docs/CODE-PATTERNS.md:78-81` documents the shim path as canonical — a real doc-vs-reality split that TASK-741-done.md explicitly flagged for follow-up.

---

## C. CLAUDE.md / CODE-PATTERNS.md improvements (apply now)

### C1. Document the pnpm `--` separator quirk and the `test:e2e` shell-wrapper rationale in `docs/CODE-PATTERNS.md`
- **Summary:** Add a note to `docs/CODE-PATTERNS.md` explaining why `pnpm test:e2e` uses a POSIX-sh wrapper instead of plain `playwright test`, so future plan-authors do not rewrite it as the simpler-looking literal form and re-break `--list` flag forwarding.
- **Source-Sprint:** SPRINT-036
- **Target file:** `docs/CODE-PATTERNS.md`
- **Rationale:** FIND-SPRINT-036-4 (TASK-742 verifier): the plan prescribed `"test:e2e": "playwright test"` but empirically that form causes `pnpm test:e2e -- tests/smoke.spec.ts --list` to fail AC5 — Playwright ignores `--list` and actually runs the tests. The executor had to adopt a sh wrapper that strips pnpm's injected `--` separator. This is non-obvious; without a note it will be silently reverted by the next agent touching `package.json` scripts.
- **Proposed change:**

  Append the following section to `docs/CODE-PATTERNS.md` under the existing `## Frontend Test Conventions` section (after the `vitest config must wire setupFiles` entry):

  ```markdown
  ### `pnpm test:e2e` — shell wrapper required for flag forwarding

  The root `test:e2e` script in `package.json` uses a POSIX-sh wrapper:

  ```sh
  sh -c 'while [ "$1" = "--" ]; do shift; done; playwright test "$@"' --
  ```

  **Do NOT simplify this to `"playwright test"`.**  pnpm injects a literal `--` separator
  before any args you pass on the command line (e.g. `pnpm test:e2e -- tests/smoke.spec.ts
  --list`). Playwright treats everything after `--` as a glob/positional and discards flag
  names, so `--list` becomes a file pattern and the tests actually run instead of being
  listed. The wrapper strips leading `--` args before forwarding, making flag pass-through
  work correctly.

  This was confirmed empirically during TASK-742 (FIND-SPRINT-036-4): the plain form failed
  AC5 (`--list` caused tests to execute); the wrapper form passed.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** the wrapper in `package.json:52` is genuinely non-obvious — a future agent normalizing scripts would almost certainly "simplify" it back to `playwright test` and silently re-break `--list` flag forwarding, and the `## Frontend Test Conventions` anchor (line 349 of CODE-PATTERNS.md) is a natural home with low attention-budget cost.
- **Counterfactual:** if another note about the same pnpm `--` quirk already existed in CODE-PATTERNS.md, this would be a duplicate and the verdict would flip.

---

## Reconciled Findings (informational)

- FIND-SPRINT-036-7 — claimed resolved by TASK-743 in `.soloflow/archive/done/quick-session/TASK-743-done.md` ("Resolved: FIND-SPRINT-036-5 … FIND-SPRINT-036-7 (direct-coverage gap addressed by 8be67d2)"), but `status` field in findings file still reads `open`. Sprint-closer's reconciliation patch appears not to have run for this entry. The finding is legitimately closed: commit `8be67d2` added a direct fixture-driven test for the duplicate-column-name idempotency branch in `fileMigrationRunner.test.ts`, which was the entire ask in the suggested_action.
