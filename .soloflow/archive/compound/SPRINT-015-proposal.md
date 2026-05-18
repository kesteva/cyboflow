---
sprints: [SPRINT-015]
span_label: SPRINT-015
created: "2026-05-18T00:00:00.000Z"
counters_start:
  ideas: 16
summary:
  cleanups: 5
  backlog_tasks: 9
  claude_md: 6
  soloflow_improvements: 0
---

# Compound Proposal — SPRINT-015

## A. Clean-up items (execute now)

### A1. Fix `main/package.json` test script to use `vitest run` (one-shot)
- **Summary:** `main/package.json` uses bare `vitest` for its `test` script, which defaults to watch mode in a TTY and hangs the `test:unit` chain added by TASK-564.
- **Source-Sprint:** SPRINT-015
- **Rationale:** TASK-564 added `test:unit` as `pnpm --filter main test && pnpm --filter frontend test && pnpm run test:build`. The `main` workspace `test` script is `"vitest"` (no `run`), so running `test:unit` interactively hangs at the first tier. The frontend workspace already uses the canonical `"vitest run"` form. CI avoids the hang only because stdout is not a TTY there — any developer running `pnpm run test:unit` locally will see it freeze. FIND-SPRINT-015-5 from TASK-564 code-reviewer.
- **Blast radius:** `main/package.json` only — one-line change. Risk: trivial.
- **Source:** FIND-SPRINT-015-5 (TASK-564 code-reviewer)
- **Proposed change:**
  ```diff
  --- a/main/package.json
  +++ b/main/package.json
    "scripts": {
  -   "test": "vitest",
  +   "test": "vitest run",
  +   "test:watch": "vitest",
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** `main/package.json:13` confirms `"test": "vitest"` (bare, no `run` flag) while frontend uses `vitest run` — concrete TTY-hang risk for any local `pnpm run test:unit` invocation, one-line change with effectively zero blast radius.

### A2. Fix stale `seed()` docstring in workflowRegistry.ts
- **Summary:** The `seed()` docstring claims idempotency via a `(project_id, name)` UNIQUE constraint that TASK-598 dropped; the actual idempotency mechanism is now the deterministic PK.
- **Source-Sprint:** SPRINT-015
- **Rationale:** The UNIQUE constraint was removed from both `schema.sql` and migration 006 by TASK-598; the new idempotence story is `INSERT OR IGNORE` colliding on the deterministic PK `wf-<projectId>-<name>`. The docstring is the only stale artifact. FIND-SPRINT-015-8 from TASK-598.
- **Blast radius:** `main/src/orchestrator/workflowRegistry.ts` — docstring edit only. Risk: trivial.
- **Source:** FIND-SPRINT-015-8 (TASK-598 code-reviewer)
- **Proposed change:**
  ```diff
  --- a/main/src/orchestrator/workflowRegistry.ts
  +++ b/main/src/orchestrator/workflowRegistry.ts
  @@ -102,7 +102,7 @@
  -  * Uses INSERT OR IGNORE on the `(project_id, name)` unique constraint so
  -  * re-seeding the same project is idempotent.
  +  * Uses INSERT OR IGNORE on the deterministic primary key `wf-<projectId>-<name>`
  +  * so re-seeding the same project is idempotent — existing rows are not updated.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** `workflowRegistry.ts:105` still references the dropped `(project_id, name)` UNIQUE constraint while `seed()` at line 131 actually uses deterministic PK `wf-<projectId>-<name>` — docstring-only edit, zero risk.

### A3. Fix latent cast-without-null-guard in DraggableProjectTreeView.tsx
- **Summary:** `handleAddProject` in `DraggableProjectTreeView.tsx` casts `response.data as Project` after only checking `response.success`, leaving `response.data` potentially undefined — the exact silent-bypass pattern TASK-630 aimed to eliminate.
- **Source-Sprint:** SPRINT-015
- **Rationale:** With `IPCResponse<T = unknown>` now enforced, `response.data` is `Project | undefined` even when `success === true`. The main IPC handler does return `data` today so no runtime crash exists yet, but TASK-630's audit pass missed correcting this site. FIND-SPRINT-015-14 from TASK-630 code-reviewer.
- **Blast radius:** `frontend/src/components/DraggableProjectTreeView.tsx` — one guard addition + drop one cast. Risk: low.
- **Source:** FIND-SPRINT-015-14 (TASK-630 code-reviewer)
- **Proposed change:**
  ```diff
  --- a/frontend/src/components/DraggableProjectTreeView.tsx
  +++ b/frontend/src/components/DraggableProjectTreeView.tsx
  @@ -1199 @@
  -  if (!response.success) return;
  -  const project = response.data as Project;
  +  if (!response.success || !response.data) return;
  +  const project = response.data;
  ```
  (After this change `response.data` narrows to `Project` under TypeScript control-flow — no cast needed. Verify with `pnpm --filter frontend typecheck`.)

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** `DraggableProjectTreeView.tsx:1199` confirms `...(response.data as Project)` after a `response.success`-only guard at line 1183 — the cast bypasses the `data?: T` optionality, exactly the silent-bypass class TASK-630 stabilised against; minimal-blast-radius edit.

### A4. Normalize inline IPCResponse shapes in cyboflowApi.ts to use the canonical type
- **Summary:** `frontend/src/utils/cyboflowApi.ts` casts three IPC call results to ad-hoc inline `{ success: boolean; data?: T; error?: string }` shapes instead of importing and using `IPCResponse<T>` from the canonical location.
- **Source-Sprint:** SPRINT-015
- **Rationale:** TASK-630 stabilized the canonical `IPCResponse<T>` export from `frontend/src/utils/api.ts`, but `cyboflowApi.ts` (in the same `utils/` directory) was excluded from `files_owned` and still uses inline shapes at three call sites (`listWorkflows`, `startRun`, `approveRun`). These inline shapes diverge from the canonical type on any future structural change (e.g., adding `requestId`). FIND-SPRINT-015-19 from sprint-code-reviewer.
- **Blast radius:** `frontend/src/utils/cyboflowApi.ts` — three cast expressions changed. Risk: low.
- **Source:** FIND-SPRINT-015-19 (sprint-code-reviewer)
- **Proposed change:**
  ```diff
  --- a/frontend/src/utils/cyboflowApi.ts
  +++ b/frontend/src/utils/cyboflowApi.ts
  +import type { IPCResponse } from './api';
  
  -  ) as { success: boolean; data?: WorkflowRow[]; error?: string }
  +  ) as IPCResponse<WorkflowRow[]>
  
  -  ) as { success: boolean; data?: StartRunResult; error?: string }
  +  ) as IPCResponse<StartRunResult>
  
  -  ) as { success: boolean; error?: string }
  +  ) as IPCResponse<unknown>
  ```
  Verify with `pnpm --filter frontend typecheck` exit 0.

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** `cyboflowApi.ts` lines 55-59, 76-80, 146-149 confirm three inline `{ success; data?; error? }` shapes that drift from the canonical `IPCResponse<T>` in `frontend/src/utils/api.ts:10`; three local cast-site edits in one file, zero behavioural change.

### A5. Add `// FIXME` annotation on double-cast sites in MessagesView.tsx and RichOutputView.tsx
- **Summary:** Two files use `as unknown as LocalType[]` double-casts that paper over a legacy type-coherence gap; annotate them with a FIXME so the follow-up task (B5) has a clear breadcrumb.
- **Source-Sprint:** SPRINT-015
- **Rationale:** FIND-SPRINT-015-12 flagged these as TASK-630 "last-resort cast" sites. The casts are not bugs today, but without annotation they are invisible to the next engineer. The plan's own guidance says `as unknown as T` is allowed but must be marked. Risk is nil — comment-only change. FIND-SPRINT-015-12 from TASK-630 code-reviewer.
- **Blast radius:** `frontend/src/components/panels/ai/MessagesView.tsx`, `frontend/src/components/panels/ai/RichOutputView.tsx` — comment lines only. Risk: trivial.
- **Source:** FIND-SPRINT-015-12 (TASK-630 code-reviewer)
- **Proposed change:**
  ```diff
  // In MessagesView.tsx at the double-cast line:
  - ) as unknown as JSONMessage[];
  + ) as unknown as JSONMessage[]; // FIXME(SPRINT-015): local JSONMessage diverges from ClaudeJsonMessage — see FIND-SPRINT-015-12; resolve in follow-up task
  
  // In RichOutputView.tsx at the double-cast line:
  - ) as unknown as UserPromptMessage[];
  + ) as unknown as UserPromptMessage[]; // FIXME(SPRINT-015): see FIND-SPRINT-015-12
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Double-casts confirmed at `MessagesView.tsx:55` and `RichOutputView.tsx:219`; comment-only annotations leave a breadcrumb for B5 follow-up at effectively zero cost.


## B. Backlog tasks (refine into execution-ready plans)

### B1. Complete dbAdapter extraction to remaining 5 test files
- **Summary:** Five test files (`cancelAndRestart.test.ts`, `approvalRouter.test.ts`, `stuckDetector.test.ts`, `mcpQueryHandler.test.ts`, `inspectorQueries.test.ts`) still carry identical inline `function dbAdapter(db: Database.Database): DatabaseLike` copies that TASK-604 missed.
- **Source-Sprint:** SPRINT-015
- **Source:** FIND-SPRINT-015-15 (TASK-604 code-reviewer); TASK-604-done.md confirms the 5 files were noted as out-of-scope.
- **Problem:** The goal of TASK-604 was to ensure future widening of `DatabaseLike` fails typecheck in one place, not across silent copies. Five of the nine identical copies remain. All five files are under `main/src/orchestrator/__tests__/` or adjacent — direct drop-in import candidates. A sixth file (`trpc/__tests__/approvals.test.ts`) has a narrower bespoke shape and should be excluded intentionally.
- **Proposed direction:** Create a small task owning the five listed test files. Replace each inline `function dbAdapter(db: Database.Database): DatabaseLike { ... }` block with `import { dbAdapter } from '../__test_fixtures__/dbAdapter';` (adjust relative depth for `mcpServer/__tests__/`). Verify with `pnpm --filter main test` exit 0 and `pnpm typecheck` exit 0. Explicitly note in the plan that `trpc/__tests__/approvals.test.ts` is excluded (different shape, intentional).
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** grep confirms 5 inline `function dbAdapter(db: Database.Database): DatabaseLike` copies across `cancelAndRestart`, `stuckDetector`, `approvalRouter`, `inspectorQueries`, `mcpQueryHandler` while the canonical `__test_fixtures__/dbAdapter.ts` already exists — finishes TASK-604's stated goal of single-point widening, drop-in scope.

### B2. Migrate 2 remaining mkdtempSync leak sites to withTempDir
- **Summary:** `gitignoreWriter.test.ts` and `workflowRegistry.test.ts` define their own `mkdtempSync` temp-dir creation with no cleanup hooks — identical leaks to what TASK-605 fixed in the four in-scope files.
- **Source-Sprint:** SPRINT-015
- **Source:** FIND-SPRINT-015-16 (TASK-605 code-reviewer); TASK-605-done.md confirms both sites were noted as out-of-scope.
- **Problem:** `gitignoreWriter.test.ts:11-13` defines `makeTempDir()` calling `mkdtempSync(...,'gitignore-test-')` with no `afterEach`/`afterAll`. `workflowRegistry.test.ts:88` calls `mkdtempSync(...,'workflow-registry-test-')` in `beforeEach` with no matching cleanup. Both leave named directories in `$TMPDIR` after every test run. TASK-605's AC verification grep covered only its four prefixes, so the leaks passed silently.
- **Proposed direction:** Create a task owning the two files. For `gitignoreWriter.test.ts`: replace `makeTempDir()` calls with `await withTempDir('gitignore-test-', ...)` wrappers in each `it` body. For `workflowRegistry.test.ts`: replace the `beforeEach`/`afterAll` mkdtemp pattern with per-`it` `withTempDir` wrappers (or a top-level `withTempDir` if the test structure is flat enough). Post-migration, verify `ls $TMPDIR | grep -E 'gitignore-test-|workflow-registry-test-'` returns no rows after `pnpm --filter main test`.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** `gitignoreWriter.test.ts:12` and `workflowRegistry.test.ts:88` both call `mkdtempSync` and neither file contains `afterEach`/`afterAll`/`rmSync` — concrete tmp-dir leak per run, completing TASK-605's stated coverage with proportional drop-in to existing `withTempDir`.

### B3. Migrate 2 remaining inline DDL sites to REGISTRY_SCHEMA / GATE_SCHEMA
- **Summary:** `transitions.test.ts` and `mcpQueryHandler.test.ts` still declare divergent inline DDL for `workflows` + `workflow_runs` that TASK-603 missed — the stated goal of a single DDL source of truth is not yet met.
- **Source-Sprint:** SPRINT-015
- **Source:** FIND-SPRINT-015-10 (TASK-603 verifier); TASK-603-done.md confirms the two files were noted as out-of-scope.
- **Problem:** `main/src/services/cyboflow/__tests__/transitions.test.ts:27` declares `SCHEMA_DDL` with columns `description`, `updated_at` on `workflows` — a shape that already drifts from `schema.sql` (missing `permission_mode`, `workflow_path`, `branch_name`, `error_message` on `workflow_runs`). `main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts:32` declares `MINIMAL_SCHEMA` with yet another divergent shape. Both pass today only because their INSERT/SELECT statements avoid the missing columns, but any future column exercise will fail at these sites first.
- **Proposed direction:** Create a task owning the two test files. For `transitions.test.ts`: replace `SCHEMA_DDL` with `import { REGISTRY_SCHEMA } from '../../database/__test_fixtures__/registrySchema'` and update the `db.exec()` call. For `mcpQueryHandler.test.ts`: decide during planning whether `MINIMAL_SCHEMA` genuinely needs a subset shape (if so, export a `MINIMAL_SCHEMA` from `registrySchema.ts` that is a documented subset) or can share `REGISTRY_SCHEMA` directly. Verify with `pnpm --filter main test` exit 0 and no DDL drift between the two files' runtime table shapes.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** grep confirms `transitions.test.ts:27` (`SCHEMA_DDL`) and `mcpQueryHandler.test.ts:32` (`MINIMAL_SCHEMA`) still inline divergent DDL while `REGISTRY_SCHEMA`/`GATE_SCHEMA` already exist in `__test_fixtures__/registrySchema.ts` — completes TASK-603's stated SoT goal at proportional cost.

### B4. Extend `getRunById` SELECT and `WorkflowRunRow` type to include `started_at` / `ended_at`
- **Summary:** `workflowRegistry.ts:getRunById` omits `started_at` and `ended_at` from its SELECT projection, and `WorkflowRunRow` in `shared/types/workflows.ts` lacks both fields — the columns exist in DDL but are unreachable through the registry API.
- **Source-Sprint:** SPRINT-015
- **Source:** FIND-SPRINT-015-17 (sprint-code-reviewer); TASK-598-done.md confirmed columns were added to schema and migration 006.
- **Problem:** TASK-598 added `started_at DATETIME` and `ended_at DATETIME` to `workflow_runs` in both `schema.sql` and migration 006. However `workflowRegistry.ts:202` SELECT names 13 columns and omits both. `cancelAndRestartHandler.ts:148` already writes `ended_at`; the stuck-detector epic will need `started_at`. Without the projection, any caller using `getRunById` after writing timing data will silently read `undefined`.
- **Proposed direction:** Create a task owning `main/src/orchestrator/workflowRegistry.ts` and `shared/types/workflows.ts`. In `workflowRegistry.ts:202`, extend the SELECT list to include `started_at, ended_at`. In `WorkflowRunRow`, add `started_at?: string | null` and `ended_at?: string | null`. Add a regression test in `workflowRegistry.test.ts` mirroring the existing `reads back policy_json` test pattern — write a run with timing values, call `getRunById`, assert both fields are returned. Verify with `pnpm --filter main test` exit 0 and `pnpm typecheck` exit 0.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** `schema.sql:70-71` defines `started_at`/`ended_at` and `cancelAndRestartHandler.ts:148` already writes `ended_at`, but `workflowRegistry.ts:202` SELECT omits both and `WorkflowRunRow` in `shared/types/workflows.ts` lacks both fields — a concrete `undefined` read for any caller using `getRunById` after writing timing data.

### B5. Unify local JSONMessage / UserPromptMessage types with ClaudeJsonMessage in AI panel views
- **Summary:** `MessagesView.tsx` and `RichOutputView.tsx` use `as unknown as LocalType[]` double-casts because their local message types diverge from the IPC payload shape — legacy Crystal-era type debt surfaced by TASK-630.
- **Source-Sprint:** SPRINT-015
- **Source:** FIND-SPRINT-015-12 (TASK-630 code-reviewer)
- **Problem:** `frontend/src/components/panels/ai/MessagesView.tsx:55` declares `JSONMessage` with `data: string` (always-string) but the runtime forEach accesses `msg.data` as string-or-object (matching `ClaudeJsonMessage`). `RichOutputView.tsx:219` has a parallel divergence with `UserPromptMessage`. The double-casts `as unknown as LocalType[]` hide the incoherence from TypeScript. Any future change to either the local type or the IPC payload passes typecheck silently at the cast boundary.
- **Proposed direction:** Create a task owning the two files under `frontend/src/components/panels/ai/`. Either (a) unify the local types with `ClaudeJsonMessage` from `frontend/src/types/session.ts` and remove the casts, or (b) introduce an explicit `function parseJsonMessage(raw: ClaudeJsonMessage): JSONMessage` adapter at the boundary so the cast is replaced by a real converter. Option (b) is preferred because the forEach loops already contain runtime-type sniffing logic that can be extracted into the adapter. Verify with `pnpm --filter frontend typecheck` exit 0 and `pnpm --filter frontend test` exit 0.
- **Scope:** medium

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Two `as unknown as` double-casts confirmed (`MessagesView.tsx:55`, `RichOutputView.tsx:219`) in actively-used components (`ClaudePanel.tsx`, `RichOutputWithSidebar.tsx`) — a real type-coherence gap with concrete silent-bypass risk; medium scope is proportional to a 2-file unify-or-adapter task.
- **Counterfactual:** If planner refinement reveals the local types are also consumed by deeper transformer logic that would balloon the diff, downgrade to A5 (annotation only) and defer.

### B6. Eliminate 4 local duplicate IPCResponse interface declarations in frontend components
- **Summary:** Four files (`App.tsx`, `DiscordPopup.tsx`, `OnboardingCard.tsx`, `ReviewQueueView.tsx`) declare their own `interface IPCResponse<T = unknown>` duplicating the canonical type from `frontend/src/utils/api.ts`.
- **Source-Sprint:** SPRINT-015
- **Source:** FIND-SPRINT-015-11 (TASK-630 code-reviewer)
- **Problem:** With the canonical type now stabilized to `<T = unknown>`, any future structural change (e.g., adding `requestId`) will not propagate to the four local copies. Each local copy is verified against a stale shape, and casts like `as IPCResponse<string>` succeed against the local definition silently. Confirmed by grep: `grep -n "interface IPCResponse" frontend/src/{App.tsx,components/{DiscordPopup,OnboardingCard,ReviewQueueView}.tsx}` returns 4 hits.
- **Proposed direction:** Create a task owning the four files. Replace each local `interface IPCResponse<T = unknown> { ... }` with `import type { IPCResponse } from '../../utils/api';` (or `'../utils/api'` for `App.tsx`). The cast sites in each file already pass `<T>` explicitly and should keep working. Verify with `pnpm --filter frontend typecheck` exit 0.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** grep confirms 4 local `interface IPCResponse<T = unknown>` declarations in `App.tsx:34`, `DiscordPopup.tsx:5`, `OnboardingCard.tsx:4`, `ReviewQueueView.tsx:9` — same recurring drift class as A4, drop-in import substitution with proportional small scope.

### B7. Refactor IPCResponse to a discriminated union (or delete IPCDataResponse)
- **Summary:** `IPCDataResponse<T>` introduced by TASK-630 is type-unsound — it asserts `data: T` is always present regardless of `success`, which re-introduces the silent-bypass class of bug TASK-630 was designed to eliminate; the fix is either deletion or a proper discriminated union.
- **Source-Sprint:** SPRINT-015
- **Source:** FIND-SPRINT-015-13 (TASK-630 code-reviewer)
- **Problem:** `frontend/src/types/electron.d.ts:37` declares `type IPCDataResponse<T> = Omit<IPCResponse<T>, 'data'> & { data: T }`. This asserts `data: T` regardless of `success`. A future caller could write `result.data.foo` without checking `result.success`, pass typecheck, and dereference `undefined` at runtime. In practice all current callers still gate with `if (response.success && response.data)`, so no concrete defect has shipped — but the helper exists specifically to enable dropping that gate, which would then be unsafe. The discriminated union shape `{ success: true; data: T } | { success: false; error: string }` gives the same call-site ergonomics under TS control-flow narrowing while preserving the contract.
- **Proposed direction:** Create a task owning `frontend/src/types/electron.d.ts` and `frontend/src/utils/api.ts`. Either (a) delete `IPCDataResponse` and revert the ~14 channel signatures to `IPCResponse<T>` (callers already write the guard), or (b) refactor `IPCResponse<T>` itself to a tagged discriminated union: `{ success: true; data: T } | { success: false; error: string; details?: string; command?: string }`. Option (b) is the more durable fix. Verify with AC using the existing type-contract regression tests in `frontend/src/utils/__tests__/ipcResponseType.test.ts` (TASK-630) plus `pnpm typecheck` exit 0.
- **Scope:** medium

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** medium
- **Reasoning:** The proposal explicitly admits "no concrete defect has shipped" — `IPCDataResponse` was added one sprint ago by TASK-630 and all 36 callers currently gate with `if (response.success && response.data)`, making this a speculative refactor of a type touched in ~14 channel signatures (option a) or every IPC site (option b) for a problem nobody has hit.
- **Counterfactual:** If a future sprint produces a real bug where a caller dereferences `IPCDataResponse.data` without a success gate and ships `undefined.foo`, that concrete defect would clear the bar.

### B8. Centralize IPCResponse<T> in shared/types/ipc.ts; parameterize bare preload.ts sites
- **Summary:** `IPCResponse<T>` is declared independently in three active-code files across two processes (`electron.d.ts`, `api.ts`, `preload.ts`), and ~200 `Promise<IPCResponse>` sites in `preload.ts` are bare (no `T` arg) — the same silent-bypass risk CLAUDE.md's audit grep was designed to catch, but the grep excludes `main/src`.
- **Source-Sprint:** SPRINT-015
- **Source:** FIND-SPRINT-015-18 (sprint-code-reviewer)
- **Problem:** `main/src/preload.ts:170` declares its own `interface IPCResponse<T = unknown>`. The project has a `shared/types/` directory but no module there exports the canonical type — both `electron.d.ts` and `api.ts` also redeclare it rather than importing. With three independent declarations, any structural change must be applied three times. Additionally, `preload.ts` has ~200 `Promise<IPCResponse>` bare sites (no `T`) that the existing CLAUDE.md audit grep (`grep -rnE "IPCResponse[^<A-Za-z]" frontend/src`) does not cover because it excludes `main/src`.
- **Proposed direction:** Create a task that introduces `shared/types/ipc.ts` exporting a single canonical `IPCResponse<T>` (or the discriminated union from B7 if that lands first). Migrate `frontend/src/utils/api.ts`, `frontend/src/types/electron.d.ts`, and `main/src/preload.ts` to import from there. As a second step, audit the ~200 bare `Promise<IPCResponse>` sites in `preload.ts` and parameterize each with a concrete `T` matching the handler return shape (or confirm `<T = unknown>` is correct for genuinely dynamic channels). Update the CLAUDE.md audit grep to also cover `main/src/preload.ts`.
- **Scope:** large

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** medium
- **Reasoning:** `grep -c "Promise<IPCResponse>" main/src/preload.ts` returns 124 bare sites — the proposed second-step sweep to parameterize each against handler-return shapes is a large blast-radius touch on a process-boundary file for a category of bug (silent renaming) that the canonical default `T = unknown` already prevents at the renderer-cast level; the centralization piece (step 1) is reasonable but ships entangled with the 124-site sweep.
- **Counterfactual:** A pared-back task scoped to step 1 only (centralize the type, no preload.ts parameterization sweep) would clear the bar.

### B9. Add schema parity CI check and designate migration 006 as canonical DDL source
- **Summary:** `workflow_runs` DDL now lives in five locations (schema.sql, migration 006, registrySchema.ts fixture, plus two drifted test files flagged in B3) with no automated parity check — any column addition must be mirrored manually.
- **Source-Sprint:** SPRINT-015
- **Source:** FIND-SPRINT-015-21 (sprint-code-reviewer); FIND-SPRINT-015-3 (TASK-598 verifier)
- **Problem:** TASK-598 reconciled sites 1 and 2 (schema.sql + migration 006). TASK-603 extracted site 3 (registrySchema.ts). FIND-SPRINT-015-10 / B3 above tracks sites 4 and 5 (test files). The only enforcement is the docblock comment in `registrySchema.ts` saying "mirror column additions here too" — human-enforced, not automated. TASK-598's end-of-task verification used `grep -A 10` which truncated the DDL block and gave a false-positive AC pass on `started_at`/`ended_at`.
- **Proposed direction:** Create a task that: (a) documents in `docs/CODE-PATTERNS.md` that migration 006 is the canonical source of truth for `workflows`/`workflow_runs` DDL (schema.sql is the derived fresh-install path); (b) writes a `scripts/verify-schema-parity.js` CI script that opens an in-memory SQLite DB, runs `schema.sql`, then re-runs all migrations in numeric order, and asserts that no `CREATE TABLE` in the migration produces a new table (all tables already exist from schema.sql via `IF NOT EXISTS` — a non-no-op `CREATE TABLE` signals drift); (c) adds `pnpm run verify:schema` to the CI `pnpm run test:unit` chain. Also consider replacing the registrySchema.ts inline string with `readFileSync(join(__dirname, '..', '..', 'database', 'schema.sql'))` so the test fixture automatically tracks the canonical file.
- **Scope:** medium

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Two distinct schema-drift failures already shipped this sprint — FIND-SPRINT-015-3 (TASK-598 `grep -A 10` false-positive AC) and FIND-SPRINT-015-21 (5-site DDL sprawl tracked in B3) — and C3's documentation-only rule is easy to skip when an agent is rushed; an automated `verify:schema` parity check is the only structural backstop and is a single small script (durable, hermetic, fast).
- **Counterfactual:** If the verify-schema script ends up needing to special-case more than 2 tables, the maintenance cost climbs and a doc-only rule (C3) becomes the better fit.


## C. CLAUDE.md / CODE-PATTERNS.md improvements (apply now)

### C1. Frontend testing setupFiles contract
- **Summary:** Document that the frontend vitest config must reference `src/test/setup.ts` whenever `@testing-library/jest-dom` is in use, and that `globals: false` requires explicit vitest imports in every spec.
- **Source-Sprint:** SPRINT-015
- **Target file:** `docs/CODE-PATTERNS.md`
- **Status:** ready
- **source_item:** C1
- **Diff:**
  ```diff
  --- a/docs/CODE-PATTERNS.md
  +++ b/docs/CODE-PATTERNS.md
  @@ section: Frontend Test Conventions, append after the "Mock tRPC at the SUT's own import path" subsection
  +### vitest config must wire `setupFiles` and `globals: true`
  +
  +Both workspace `vitest.config.ts` files set `globals: true` + `setupFiles:
  +['./src/test/setup.ts']`. Do not flip to `globals: false` — `frontend/src/test/setup.ts`
  +calls `expect.extend(...)` from `@testing-library/jest-dom` at module load, which throws
  +`ReferenceError: expect is not defined` under `globals: false` and breaks every spec in
  +the workspace. When adding a new `vitest.config.ts` in either workspace, mirror the
  +existing files; before planning a test-wiring task, grep both `@testing-library/jest-dom`
  +and `test/setup.ts` — do not rely on a `.test.*` glob.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** `frontend/vitest.config.ts` confirms `globals: true` + `setupFiles: ['./src/test/setup.ts']` so the rule matches reality, and FIND-SPRINT-015-2 documents that omitting `setupFiles` broke every spec via `ReferenceError: expect is not defined` — a concrete, severe trap that the planner's sibling-scan approach failed to prevent.
- **Counterfactual:** If the broader sprint logs show no other test-wiring tasks were ever planned in cyboflow's history, the rule could be deferred until that pattern actually recurs.

### C2. Workspace `test` scripts must be one-shot
- **Summary:** Document that any workspace `test` script that participates in a multi-tier `&&` chain must use the one-shot form (`vitest run`, not bare `vitest`), with the watch form on a separate `test:watch` key.
- **Source-Sprint:** SPRINT-015
- **Target file:** `CLAUDE.md` (project root)
- **Status:** ready
- **source_item:** C2
- **Diff:**
  ```diff
  --- a/CLAUDE.md
  +++ b/CLAUDE.md
  @@ section: Common Commands, append after the "Platform packaging ..." line
  +Workspace `"test"` scripts that participate in a root multi-tier chain (e.g.
  +`pnpm run test:unit`) MUST be one-shot — use `"vitest run"`, never bare `"vitest"`.
  +Bare `vitest` defaults to watch mode in a TTY and hangs the chain locally (CI escapes
  +only because stdout is not a TTY). Put watch mode on a separate `"test:watch"` key.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Direct corollary of A1's confirmed `main/package.json:13` bare-vitest defect — a one-sentence rule pinned to a real recurring class (chain-participating workspace scripts) that prevents the same TTY-hang trap when any future workspace (e.g. `shared/`) adds its own `test` script.

### C3. Schema reconciliation — discovery + diffing rules
- **Summary:** Document the two required grep patterns for schema reconciliation tasks, ban `grep -A N` for DDL comparison, and assert bidirectional equivalence between schema.sql and the highest-numbered migration.
- **Source-Sprint:** SPRINT-015
- **Target file:** `docs/CODE-PATTERNS.md`
- **Status:** ready
- **source_item:** C3
- **Diff:**
  ```diff
  --- a/docs/CODE-PATTERNS.md
  +++ b/docs/CODE-PATTERNS.md
  @@ section: Recurring Patterns, append after the "### Database access" subsection
  +### Schema reconciliation
  +
  +When modifying DDL for a table, run TWO greps and cover every match in `files_owned`
  +(or document exclusions in `plan_decisions`):
  +
  +1. Inline-DDL consumers: `grep -rn 'CREATE TABLE.*<table>' main/src/ frontend/src/`
  +2. Migration-file loaders: `grep -rn 'readFileSync.*<NNN>\|join.*migrations.*<NNN>' main/src/`
  +
  +Verify the column block with full `diff`, never `grep -A N` (the count is fragile and
  +silently truncates). `schema.sql` (fresh install) and the highest-numbered migration
  +(upgrade path) must be bidirectionally equivalent — every migration `CREATE TABLE IF NOT
  +EXISTS` must be a no-op after `schema.sql` runs. When adding a column to a shipped
  +migration, also search every test file's INSERT/SELECT for the old column list — missing
  +columns surface as runtime `undefined`, not typecheck errors.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** FIND-SPRINT-015-3 is a high-severity multi-symptom failure (TASK-598's `grep -A 10` falsely passed AC1, the plan missed 5 migration-file consumers, and `started_at`/`ended_at` regressed); the rule documents the specific failure modes (two grep patterns, ban `grep -A N`, bidirectional equivalence) and is the kind of trap every future schema change will face.

### C4. Extract-shared-utility refactors: prove completeness
- **Summary:** Document that extract-shared-utility refactors must run a codebase-wide structural grep for the pre-refactor pattern, and every match must appear in `files_owned` or be excluded with a reason in `plan_decisions`.
- **Source-Sprint:** SPRINT-015
- **Target file:** `docs/CODE-PATTERNS.md`
- **Status:** ready
- **source_item:** C4
- **Diff:**
  ```diff
  --- a/docs/CODE-PATTERNS.md
  +++ b/docs/CODE-PATTERNS.md
  @@ section: Recurring Patterns, append after the new "### Schema reconciliation" subsection
  +### Extract-shared-utility refactors: prove completeness
  +
  +Any task that extracts a shared fixture, helper, type, or constant MUST grep the
  +PRE-refactor pattern across the entire codebase (`main/src/ frontend/src/`) — not just
  +the files already in the planner's sample. Every match that is a direct substitute for
  +the new utility appears in `files_owned`; intentional exclusions (different shape,
  +deferred epic, manual lifecycle) get a one-sentence note in `plan_decisions`. A plan that
  +lists some but not all matches without exclusion notes leaves the codebase half-migrated.
  +Recent regressions: TASK-603 (2 inline DDL sites), TASK-604 (5 inline `dbAdapter` copies),
  +TASK-605 (2 `mkdtempSync` leaks) all shipped with the same root cause.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Three concurrent same-class regressions in this sprint (TASK-603, TASK-604, TASK-605 all left out-of-scope matches that became follow-up tasks B1/B2/B3) — the rule encodes the exact one-line grep that would have caught them all, with a documented citation of the recurrence.

### C5. No local `IPCResponse` declarations + extend audit grep to `main/src/preload.ts`
- **Summary:** Forbid local `interface IPCResponse` / inline `{ success; data?; error? }` shapes in frontend files, and extend the existing audit grep so it covers `main/src/preload.ts` (which has its own copy + many bare sites).
- **Source-Sprint:** SPRINT-015
- **Target file:** `CLAUDE.md` (project root)
- **Status:** ready
- **source_item:** C5+C6 (merged — both items extend the same paragraph)
- **Diff:**
  ```diff
  --- a/CLAUDE.md
  +++ b/CLAUDE.md
  @@ section: TypeScript Rules, append after the "**IPC response types:** ..." paragraph
  +Never declare a local `interface IPCResponse<T>` or inline `{ success; data?; error? }`
  +shape in frontend code — import from `frontend/src/utils/api.ts`. Audit:
  +`grep -rn "interface IPCResponse" frontend/src` should return zero hits outside
  +`utils/api.ts` and `types/electron.d.ts`. `main/src/preload.ts` currently keeps its own
  +`IPCResponse` declaration plus many bare `Promise<IPCResponse>` sites — include
  +`grep -n "Promise<IPCResponse>" main/src/preload.ts` in any audit pass until
  +`shared/types/ipc.ts` lands (see B8).
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** grep confirms 6 active `IPCResponse` declarations across frontend + `main/src/preload.ts:170` plus 124 bare `Promise<IPCResponse>` sites in preload — the rule extends an existing CLAUDE.md paragraph rather than creating a new section, addresses a recurring drift class already cleaned in A4/B6, and the audit grep is evergreen even if B8 never lands.

### C6. Add CLAUDE.md rule: extend audit grep for IPCResponse to cover main/src/preload.ts [dropped — merged into C5]
- **Reason:** Both C5 and C6 extend the same `**IPC response types:**` paragraph in the root CLAUDE.md; emitting two diffs against adjacent anchors would conflict at apply time. The merged C5 carries both rules.

## Suppressed — SoloFlow Defects

- **Refactor-discovery planner-skeptic checkbox** — FIND-SPRINT-015-20 notes "the planner-skeptic agent should reject plans that fail [the full-codebase grep] check" and "a soloflow-dev:planner hook that auto-greps for common refactor anti-patterns." These are SoloFlow agent / hook behaviour changes, not project conventions. The project-level discovery rule is captured in C4 above; the agent-level enforcement recommendation is suppressed here. Consider opening an issue or running `/soloflow:compound --tester` against this sprint in a SoloFlow-tester setup to surface it as a maintainer recommendation.

## Reconciled Findings (informational)

No stale-open findings were detected. The following findings were marked `status: resolved` in the findings file and were correctly skipped from triage:

- FIND-SPRINT-015-4 — marked resolved by TASK-598 in findings file.
- FIND-SPRINT-015-6 — marked resolved by TASK-598 in findings file.
- FIND-SPRINT-015-7 — marked resolved by TASK-630 in findings file.
- FIND-SPRINT-015-9 — marked resolved (verifier note) in findings file.
