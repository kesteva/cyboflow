---
sprints: [SPRINT-024]
span_label: SPRINT-024
created: 2026-05-19T00:00:00.000Z
counters_start:
  ideas: 18
summary:
  cleanups: 6
  backlog_tasks: 4
  claude_md: 1
  code_patterns: 1
  soloflow_improvements: 0
---

# Compound Proposal — SPRINT-024

## A. Clean-up items (execute now)

### A1. Collapse duplicate `path` import in workflowRegistry.test.ts
- **Summary:** `workflowRegistry.test.ts` has both a named `import { join }` and a namespace `import * as path` from `'path'` on adjacent lines — consolidate to one import.
- **Source-Sprint:** SPRINT-024
- **Rationale:** The dual-import is purely cosmetic dead weight surfaced by FIND-SPRINT-024-3. Both imports are currently used (join at 17 call sites; `path.relative`/`path.join` at lines 572, 578), so collapsing to the namespace import is a safe, bounded change with no runtime effect.
- **Blast radius:** `main/src/orchestrator/__tests__/workflowRegistry.test.ts` only. Risk: trivial.
- **Source:** FIND-SPRINT-024-3 (TASK-634 code-reviewer)
- **Proposed change:**
  ```diff
  - import { join } from 'path';
  - import * as path from 'path';
  + import * as path from 'path';
  ```
  Then rewrite the 17 `join(...)` callsites to `path.join(...)`.

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed at `main/src/orchestrator/__tests__/workflowRegistry.test.ts:20-21` — both `import { join } from 'path'` and `import * as path from 'path'` coexist, with `join` used at 17 sites and `path.relative`/`path.join` at lines 556, 562; trivial single-file consolidation with zero runtime risk.

---

### A2. Fix assertion style in claudeCodeManagerWiring.test.ts warn check
- **Summary:** Replace the manual `MockInstance` cast + `mock.calls[0][0]` indexing in `claudeCodeManagerWiring.test.ts` with the idiomatic `toHaveBeenCalledWith(expect.stringContaining(...))` form already used in the sibling test.
- **Source-Sprint:** SPRINT-024
- **Rationale:** FIND-SPRINT-024-9 identified that lines 313–319 cast `logger.warn` to `import('vitest').MockInstance` and inspect `mock.calls[0][0]` manually — the rawEventsSink sibling test at `main/src/services/streamParser/__tests__/rawEventsSink.test.ts:225–231` asserts the same code path with `expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('[rawEventsSink] insert failed for runId='))`, no cast needed. The current form is fragile (positional argument indexing) and imports a type inline.
- **Blast radius:** `main/src/services/panels/claude/__tests__/claudeCodeManagerWiring.test.ts` lines 313–319 only. Risk: trivial.
- **Source:** FIND-SPRINT-024-9 (TASK-649 code-reviewer)
- **Proposed change:**
  ```diff
  - expect(logger.warn).toHaveBeenCalled();
  - const warn = logger.warn as unknown as import('vitest').MockInstance;
  - expect(warn.mock.calls[0][0]).toContain('[rawEventsSink]');
  + expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('[rawEventsSink]'));
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Sibling test at `main/src/services/streamParser/__tests__/rawEventsSink.test.ts:225-231` already uses `toHaveBeenCalledWith(expect.stringContaining(...))` for the identical fail-soft path — the wiring test pattern at lines 313-319 is strictly weaker (positional indexing + inline `import('vitest').MockInstance` cast) and the fix is a 3-line in-place swap.

---

### A3. Replace local `makeLoggerSpy` with shared `makeSpyLogger` in claudeCodeManagerWiring.test.ts
- **Summary:** The local `makeLoggerSpy()` factory in `claudeCodeManagerWiring.test.ts` duplicates the canonical `makeSpyLogger()` fixture from `loggerLikeSpy.ts` added in the same sprint by TASK-646.
- **Source-Sprint:** SPRINT-024
- **Rationale:** FIND-SPRINT-024-10 (sprint-code-reviewer) identified that TASK-646 created the shared `main/src/orchestrator/__test_fixtures__/loggerLikeSpy.ts` fixture, and one commit later TASK-649 added a separate local `makeLoggerSpy()` (lines 30–43) instead of importing it. The shapes differ (`LoggerLike` vs `Pick<Logger, warn|info|verbose>`) but the wiring test only asserts on `.warn`, and the file already applies `logger as unknown as Logger` casts. Removing the local factory eliminates an N+1 spy pattern that TASK-646 was specifically designed to prevent.

  Note: the TASK-649 done report says the local factory "is justified" because `LoggerLike` is incompatible with `Logger`. Verify at implementation time whether `logger as unknown as Logger` makes this a non-issue — if the `verbose` property causes a compile error, option (b) from the finding (add a `makeProdLoggerSpy()` to `loggerLikeSpy.ts`) is the cleaner fix rather than keeping two separate files.
- **Blast radius:** `main/src/services/panels/claude/__tests__/claudeCodeManagerWiring.test.ts` lines 30–43. Risk: low (tests must still pass after the swap).
- **Source:** FIND-SPRINT-024-10 (SPRINT-024 sprint-code-reviewer)
- **Proposed change:**
  ```diff
  - function makeLoggerSpy() {
  -   return {
  -     warn: vi.fn<[string], void>(),
  -     info: vi.fn<[string], void>(),
  -     verbose: vi.fn<[string], void>(),
  -   };
  - }
  + import { makeSpyLogger } from '../../../../orchestrator/__test_fixtures__/loggerLikeSpy';
  ```
  Replace `makeLoggerSpy()` callsites with `makeSpyLogger()`. If `verbose` is required by the production Logger type at the call site, extend `loggerLikeSpy.ts` with a `makeProdLoggerSpy()` variant instead of keeping a local factory.

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** `LoggerLike` in `main/src/orchestrator/types.ts:41-46` has info/warn/error/debug but no `verbose`, while `ClaudeCodeManager` calls `logger?.verbose(...)` at lines 685, 690, 714, 719 — so a straight `makeSpyLogger()` swap is shape-incompatible, but the file already does `logger as unknown as Logger` at 5 sites (lines 162-294), so the cast covers the gap and the local factory remains an N+1 spy fixture the shared loggerLikeSpy.ts was designed to retire.
- **Counterfactual:** If implementation finds that the `as unknown as Logger` cast triggers a structural-type error against the renamed call site, then option (b) — adding `makeProdLoggerSpy()` to `loggerLikeSpy.ts` — is the right answer; verdict stays IMPLEMENT either way.

---

### A4. Add top-level `import type Database` to cliManagerFactory.ts
- **Summary:** Replace the inline `import("better-sqlite3").Database` type cast in `cliManagerFactory.ts:177` with a top-of-file `import type Database from "better-sqlite3"` matching the pattern already used in `claudeCodeManager.ts`.
- **Source-Sprint:** SPRINT-024
- **Rationale:** FIND-SPRINT-024-11 (sprint-code-reviewer). The inline `import(...)` type in a function body is harder to read and harder to grep than a top-of-file type import. Runtime behavior is identical; this is a pure readability/consistency fix. `claudeCodeManager.ts:9` already uses `import type Database from "better-sqlite3"` as the canonical form.
- **Blast radius:** `main/src/services/cliManagerFactory.ts` lines 9 (new import) and 177 (cast rewrite). Risk: trivial.
- **Source:** FIND-SPRINT-024-11 (SPRINT-024 sprint-code-reviewer, suspected TASK-647)
- **Proposed change:**
  ```diff
  + import type Database from 'better-sqlite3';
  
  // ... later in the file:
  - const db = options?.db as import("better-sqlite3").Database | undefined;
  + const db = options?.db as Database | undefined;
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed at `main/src/services/cliManagerFactory.ts:177` (inline `import("better-sqlite3").Database` cast) — the file already imports concrete classes from `./panels/claude/claudeCodeManager` (which uses the canonical top-of-file `import type Database from "better-sqlite3"` at line 9), so this is a 2-line cosmetic alignment with zero runtime impact.

---

### A5. Dedup verify-schema-parity invocation in the `test:unit` chain
- **Summary:** The `test:unit` script in `package.json` hard-codes `node scripts/verify-schema-parity.js` when it should reuse the already-declared `pnpm run verify:schema` script to keep the path in one place.
- **Source-Sprint:** SPRINT-024
- **Rationale:** FIND-SPRINT-024-12 (sprint-code-reviewer). If `verify-schema-parity.js` ever moves or is renamed, the duplicate hard-coded path in `test:unit` silently breaks while `verify:schema` would be the only updated site. Single source of truth is trivially achievable with a one-token change.
- **Blast radius:** `package.json` line 55–56 only. Risk: trivial (pnpm script delegation is equivalent).
- **Source:** FIND-SPRINT-024-12 (SPRINT-024 sprint-code-reviewer, suspected TASK-639)
- **Proposed change:**
  ```diff
  - "test:unit": "pnpm --filter main test && pnpm --filter frontend test && node scripts/verify-schema-parity.js && node scripts/__tests__/verify-schema-parity.test.js && pnpm run test:build"
  + "test:unit": "pnpm --filter main test && pnpm --filter frontend test && pnpm run verify:schema && node scripts/__tests__/verify-schema-parity.test.js && pnpm run test:build"
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed at `package.json:55-56` — `verify:schema` declares the script path once but `test:unit` redundantly inlines `node scripts/verify-schema-parity.js`, creating a two-site rename hazard fixable with a single-token swap.

---

### A6. Delete dead `parseJsonMessage` / `parseJsonMessages` runtime functions and their test file
- **Summary:** Delete the two dead runtime exports from `parseJsonMessage.ts` and their standalone test file — the functions have zero production callers after TASK-637's Option A fix, yet they gate merges with a passing test suite for unreachable code.
- **Source-Sprint:** SPRINT-024
- **Rationale:** FIND-SPRINT-024-14 (sprint-code-reviewer). TASK-637 introduced `parseJsonMessage()` and `parseJsonMessages()` in `frontend/src/components/panels/ai/parseJsonMessage.ts`, then the follow-up fix commit `bb926cd` bypassed both functions in every consumer (MessagesView.tsx, RichOutputView.tsx). The runtime functions are imported by nothing in production. The type exports (`JSONMessage`, `UserPromptMessage`, `SessionInfo`) are still used — keep those. The `parseJsonMessage.test.ts` file currently tests the dead functions and would be deleted along with them.

  Verification: `grep -rn parseJsonMessage frontend/src` should return zero matches in `.tsx` files outside the module itself after deletion.
- **Blast radius:** Delete `frontend/src/components/panels/ai/parseJsonMessage.test.ts`; remove the two function exports from `frontend/src/components/panels/ai/parseJsonMessage.ts` (keep the interface/type exports). Risk: low (no production callers confirmed by grep).
- **Source:** FIND-SPRINT-024-14 (SPRINT-024 sprint-code-reviewer, TASK-637)
- **Proposed change:**
  ```diff
  // frontend/src/components/panels/ai/parseJsonMessage.ts — KEEP type exports, DELETE functions:
  - export function parseJsonMessage(msg: ClaudeJsonMessage): JSONMessage | null { ... }
  - export function parseJsonMessages(msgs: ClaudeJsonMessage[]): JSONMessage[] { ... }
  
  // DELETE entirely:
  // frontend/src/components/panels/ai/__tests__/parseJsonMessage.test.ts
  ```
  Before deleting, run `grep -rn 'parseJsonMessage\b' frontend/src` to confirm zero `.tsx`/`.ts` call sites remain outside the module and its test.

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** `grep -rn parseJsonMessage frontend/src` confirms only the test file imports the runtime functions; `MessagesView.tsx:5` and `RichOutputView.tsx:13` import only the `JSONMessage`, `UserPromptMessage`, `SessionInfo` type exports — and `RichOutputView.tsx:209` carries an inline comment explicitly noting the adapter is shape-mismatched and bypassed, so the runtime functions and their 41-line test gate merges on unreachable code.

---

## B. Backlog tasks (refine into execution-ready plans)

### B1. Fix pre-existing spy state bleed in runExecutor.test.ts
- **Summary:** Four tests in `runExecutor.test.ts` fail due to spy state leaking between tests — lifecycle-transition spy called-once assertions get 2 calls and a bridgeEvents not-called assertion fails.
- **Source-Sprint:** SPRINT-024
- **Source:** FIND-SPRINT-024-1 (TASK-634 verifier); pre-existing on HEAD~1 of TASK-634, confirmed by TASK-646 verifier (492 pass, 5 pre-existing failures).
- **Problem:** `main/src/orchestrator/__tests__/runExecutor.test.ts` lines 635, 816, 871, and 1310 have spy assertions that fail because spy call counts accumulate from a previous test. The `beforeEach` in the relevant describe blocks is not calling `vi.clearAllMocks()` or resetting the specific spy, so state bleeds between consecutive tests. The TASK-634 verifier confirmed these failures are present on the parent commit, not introduced by the sprint.
- **Proposed direction:** Audit the `beforeEach`/`afterEach` setup in `runExecutor.test.ts`. Add `vi.clearAllMocks()` (or targeted spy resets via `mockSpy.mockReset()`) in the relevant `beforeEach` block. Confirm the spy objects are fresh per test and not shared across describe blocks that run sequentially. The `makeSpyLogger` migration from TASK-646 already landed; this is purely about clearing spy state between test runs. Run `cd main && pnpm exec vitest run src/orchestrator/__tests__/runExecutor.test.ts` to verify the 4 failures clear.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Re-ran `pnpm --filter main exec vitest run src/orchestrator/__tests__/runExecutor.test.ts` and confirmed 4 failing tests at lines 626, 807, 862, 1301 — the `expect(running).toHaveBeenCalledOnce()` and `.not.toHaveBeenCalled()` assertions still fail because spy state accumulates across tests, blocking the green-suite signal future executors rely on.

---

### B2. Fix pre-existing `stuck_detected_at` column retained after schema rebuild in cyboflowSchema.test.ts
- **Summary:** `cyboflowSchema.test.ts:680` fails because the schema reconciler's rebuild path does not drop the `stuck_detected_at` orphan column, contradicting the post-rebuild assertion.
- **Source-Sprint:** SPRINT-024
- **Source:** FIND-SPRINT-024-2 (TASK-634 verifier); confirmed pre-existing.
- **Problem:** `main/src/database/__tests__/cyboflowSchema.test.ts:680` asserts `expect(cols.some((c) => c.name === 'stuck_detected_at')).toBe(false)` after a schema rebuild is triggered (when `worktree_path` is NOT NULL or `stuck_detected_at` orphan column exists). The assertion fails — the column is still present after rebuild. The schema reconciler/migration path that runs the rebuild is not removing `stuck_detected_at`. The relevant code is likely in `main/src/database/database.ts` or the migration helpers that handle the reconciler rebuild branch.
- **Proposed direction:** Locate the reconciler rebuild branch in the database service (search for the `stuck_detected_at` reference and the `worktree_path NOT NULL` trigger). The rebuild logic likely copies the table to a temp table and recreates it — verify the `CREATE TABLE ... AS SELECT` or manual column listing omits `stuck_detected_at`. If the rebuild uses `CREATE TABLE AS SELECT *`, replace with an explicit column list that excludes the orphan column. Update the test to confirm 0 matches for `stuck_detected_at` after rebuild.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** high
- **Reasoning:** The proposed direction is contradicted by commit `d3142db` ("fix: stop reconciliation from dropping stuck_detected_at column") — `main/src/database/database.ts:1354-1363` explicitly idempotently re-adds the column, and the rebuild at lines 1394, 1405, 1410 explicitly includes `stuck_detected_at` in the new schema and copy because StuckDetector.prepare() throws SqliteError on boot without it, cascading into ApprovalRouter never initializing; the test at cyboflowSchema.test.ts:680 is the stale party and needs to assert `toBe(true)`, not the production code.
- **Counterfactual:** A backlog task to UPDATE the test assertion to match the now-canonical "preserve stuck_detected_at" behavior would clear the bar; the current proposed direction (re-drop the column) would re-introduce the d3142db boot regression.

---

### B3. Fix stale IPC type declarations and rework MessagesView session_info detection
- **Summary:** `electron.d.ts` declares `getJsonMessages` as returning `ClaudeJsonMessage[]` but the main-process handler returns `UnifiedMessage[]` — a type lie that forces double-casts and left the parseJsonMessage adapter shape-mismatched; MessagesView's session_info detection is also dead against the current shape.
- **Source-Sprint:** SPRINT-024
- **Source:** FIND-SPRINT-024-4 (high, TASK-637 code-reviewer); FIND-SPRINT-024-5 (medium, TASK-637 verifier)
- **Problem:** Two locations in `frontend/src/types/electron.d.ts` (lines 86 and 317) and `frontend/src/utils/api.ts` (lines 90 and 520) declare `getJsonMessages: (panelId: string) => Promise<IPCResponse<ClaudeJsonMessage[]>>`. At runtime, `main/src/ipc/session.ts:937` via `projectStoredOutputs` → `MessageProjection` returns `UnifiedMessage[]`. The type mismatch is what originally forced the `as unknown as JSONMessage[]` double-casts cleaned up by TASK-637, and it caused TASK-637's adapter to drop all output messages in RichOutputView (TASK-637 code review round 1 finding). The legacy `sessions:get-json-messages` handler was deleted by TASK-648, so only `panels:get-json-messages` remains and its declared type is the only one to fix. Additionally, `MessagesView.tsx` lines 67–119 still check `parsedData.type === 'session_info'` — a Crystal-era shape check that is dead against `UnifiedMessage` (which uses `role`/`metadata.systemSubtype`, not `type`). The Session Information card likely never renders post-UnifiedMessage migration.
- **Proposed direction:** (1) Change `getJsonMessages` in `electron.d.ts:317` and `api.ts:520` from `IPCResponse<ClaudeJsonMessage[]>` to `IPCResponse<UnifiedMessage[]>` (import `UnifiedMessage` from `shared/types/unifiedMessage`). (2) In `MessagesView.tsx`, replace the `parsedData.type === 'session_info'` realtime check (lines 67–119) with `parsedData.role === 'system' && parsedData.metadata?.systemSubtype === 'init'` to drive the session info card from the actual `UnifiedMessage` init message — mirroring how `RichOutputView.tsx:764` handles it. (3) The initial-load `setSessionInfo(null)` hard-code in `MessagesView.tsx:39–49` (added by TASK-637 bb926cd as a TODO) should be replaced with a search of the loaded messages for the `systemSubtype === 'init'` entry. (4) After the type fix, delete or redesign `parseJsonMessage.ts` as per A6 (the type exports may still be needed).

  Prerequisite: A6 (dead function deletion) is a safe independent clean-up, but the type export reshaping should be coordinated with this task.
- **Scope:** medium

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed the type lie at `frontend/src/types/electron.d.ts:316` (declares `ClaudeJsonMessage[]`) vs `main/src/ipc/session.ts:953-956` (returns `UnifiedMessage[]` via `projectStoredOutputs`), and the existing inline cast at `MessagesView.tsx:41` (`rawMsg as unknown as UnifiedMessage`) is exactly the symptom the proposed C2 rule warns about; step (1) of the proposed direction (the type-declaration fix) is small and high-value, but steps (2)–(3) (reworking MessagesView session_info) invest in components IDEA-017 slates for retirement alongside the legacy Crystal view — flag at refinement time so the plan scopes the type fix narrowly and defers the session-info card rework.
- **Counterfactual:** If IDEA-017's "retire MessagesView/RichOutputView" slice gets sequenced before this task lands, drop steps (2)-(3) entirely and ship only the IPC type-declaration fix.

---

### B4. Tighten type safety for `additionalOptions` in the claude `ManagerFactoryFunction`
- **Summary:** The `claudeManagerFactory` in `cliManagerFactory.ts` accepts `additionalOptions: unknown` and casts its `db` property without structural validation — a wrong-type caller would silently pass the truthy check and only fail at the first `db.prepare()` call inside `RawEventsSink`.
- **Source-Sprint:** SPRINT-024
- **Source:** FIND-SPRINT-024-13 (medium, SPRINT-024 sprint-code-reviewer, TASK-647)
- **Problem:** `main/src/services/cliManagerFactory.ts:170–187` uses `additionalOptions as Record<string, unknown> | undefined` and `options?.db as Database | undefined`. The only runtime guard is a truthy check (`if (!db) throw TypeError`). A caller passing `{ db: "not-a-db" }` would bypass the TypeError and surface as a cryptic `db.prepare is not a function` error at the first sink write. The systemic cause is the `ManagerFactoryFunction` signature in `cliToolRegistry.ts:115` using `unknown` for tool-specific options — a design choice made to accommodate different tool factories with different option shapes.
- **Proposed direction:** Option (a) — minimal: add a structural duck-type guard before the cast: `if (!db || typeof (db as { prepare?: unknown }).prepare !== 'function') { throw new TypeError('[CliManagerFactory] options.db must be a better-sqlite3 Database instance'); }`. This fails fast with a meaningful error on a wrong-type argument. Option (b) — larger refactor: tighten `ManagerFactoryFunction` in `cliToolRegistry.ts` to accept a discriminated union of per-tool option types (`claude: { db: Database }; codex: {}; ...`) so the factory dispatch site is type-checked end-to-end. Option (a) is the minimal safe fix for now; option (b) is worth a separate task when the registry grows beyond one active factory.
- **Scope:** small (option a) / medium (option b)

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed two callers — `main/src/index.ts:482-484` passes `additionalOptions: { db }` correctly, but `main/src/ipc/session.ts:104-106` passes `additionalOptions: {}` (no db) and would silently TypeError if the fallback path at session.ts:110 ever stops catching; option (a)'s 2-line duck-type guard is proportional to the risk while option (b) is correctly deferred until the registry hosts a second tool factory.
- **Counterfactual:** If the plan refines toward option (b) directly, push back — the discriminated-union refactor pre-bakes a type shape for hypothetical codex/other factories that don't exist and would have to be undone or extended on first real second-factory contact.

---

## C. CLAUDE.md / CODE-PATTERNS.md improvements (apply now)

### C1. Document `makeSpyLogger` shared fixture in CODE-PATTERNS.md
- **Summary:** Add a `makeSpyLogger` entry under Shared Utilities in CODE-PATTERNS.md so future agents writing orchestrator/IPC tests reach for the shared fixture rather than creating a new local spy factory.
- **Source-Sprint:** SPRINT-024
- **Target file:** `docs/CODE-PATTERNS.md`
- **Action:** insert-after `### Database seed helpers (pending — see compounded FIND-SPRINT-018-12)` anchor's preceding entry (i.e. immediately after the closing line of `### main/src/orchestrator/__test_fixtures__/dbAdapter`, before `### Database seed helpers`)
- **Status:** ready
- **source_item:** C1
- **Diff:**
  ```diff
  --- a/docs/CODE-PATTERNS.md
  +++ b/docs/CODE-PATTERNS.md
  @@
   - **Canonical example:** `main/src/orchestrator/__tests__/workflowRegistry.test.ts`; recurring drift fixed in FIND-SPRINT-017-11.
   
  +### `main/src/orchestrator/__test_fixtures__/loggerLikeSpy`
  +
  +- **Path:** `main/src/orchestrator/__test_fixtures__/loggerLikeSpy.ts`
  +- **Use it for:** A `vi.fn()`-based `LoggerLike` spy for orchestrator, IPC, and pipeline tests. `makeSpyLogger()` returns `LoggerLike & { calls: LogCall[] }` — each method is a Vitest spy and pushes structured entries onto `calls` for log assertions.
  +- **Why single-source:** TASK-646 consolidated 6+ local `makeLogger()` helpers; a second local factory regressed in the same sprint (FIND-SPRINT-024-10). Do NOT clone locally. If a call site requires the full `Logger` (not `LoggerLike`), cast via `logger as unknown as Logger` or extend this file with a `makeProdLoggerSpy()` — do not fork.
  +- **Canonical example:** `main/src/orchestrator/__tests__/runLauncher.test.ts`
  +
   ### Database seed helpers (pending — see compounded FIND-SPRINT-018-12)
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Sibling entry pattern already exists at `docs/CODE-PATTERNS.md:107-111` for `dbAdapter` with the same single-source justification, and the in-sprint regression (TASK-646 consolidated 8 sites; TASK-649 reintroduced a local factory one commit later as FIND-SPRINT-024-10) is concrete evidence the recurring trap warrants codification next to its peer fixture.

---

### C2. Add IPC handler return-type sync rule to CLAUDE.md
- **Summary:** Add a rule to CLAUDE.md's TypeScript section: the declared return type in `electron.d.ts` for each IPC channel must be the actual runtime type returned by the main-process handler — not the type the frontend hopes to receive.
- **Source-Sprint:** SPRINT-024
- **Target file:** `CLAUDE.md`
- **Action:** insert-after the `main/src/preload.ts currently keeps its own IPCResponse declaration ...` paragraph, before `## localStorage Key Migrations`
- **Status:** ready
- **source_item:** C2
- **Diff:**
  ```diff
  --- a/CLAUDE.md
  +++ b/CLAUDE.md
  @@
   Never declare a local `interface IPCResponse<T>` or inline `{ success; data?; error? }` shape in frontend code — import from `frontend/src/utils/api.ts`. Audit: `grep -rn "interface IPCResponse" frontend/src` should return zero hits outside `utils/api.ts` and `types/electron.d.ts`. `main/src/preload.ts` currently keeps its own `IPCResponse` declaration plus many bare `Promise<IPCResponse>` sites — include `grep -n "Promise<IPCResponse>" main/src/preload.ts` in any audit pass until `shared/types/ipc.ts` lands.
   
  +**IPC handler ↔ declared `T` parity:** the `T` in `IPCResponse<T>` declared in `frontend/src/types/electron.d.ts` and `frontend/src/utils/api.ts` MUST match the shape the matching `main/src/ipc/*` handler actually returns at runtime — not a legacy or aspirational type. A mismatched `T` forces `as unknown as X` double-casts in every consumer and hides handler shape changes from TypeScript (FIND-SPRINT-024-4: `getJsonMessages` declared `ClaudeJsonMessage[]` while the handler returned `UnifiedMessage[]`, causing TASK-637 to silently drop all output). When changing an IPC handler's return shape, grep the channel name across `frontend/src/types/electron.d.ts`, `frontend/src/utils/api.ts`, and the handler file in the same pass.
   
   ## localStorage Key Migrations
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** The cited harm is concrete — `frontend/src/components/panels/ai/MessagesView.tsx:41` and `RichOutputView.tsx:209` carry inline `as unknown as UnifiedMessage` casts plus a TODO comment pointing at the same type lie, and TASK-637 needed a fix commit + reviewer round to recover from the silent output drop; the rule slots into the existing IPC-typing block at CLAUDE.md:48-50 and tightens an attack surface that already cost a sprint, though frequency = 1 keeps confidence at medium rather than high.
- **Counterfactual:** If `shared/types/ipc.ts` lands and replaces the hand-rolled `electron.d.ts` declarations with handler-derived types, this rule becomes redundant and should be retired.

---

## Reconciled Findings (informational)

The following findings had `status: open` in the findings file but were claimed resolved by a done report. No triage items were emitted for these — they are listed here as a cross-check audit trail.

- FIND-SPRINT-024-6 — marked `status: resolved` in findings file; verifier resolution cited in TASK-646-done.md.
- FIND-SPRINT-024-7 — marked `status: resolved` in findings file; verifier resolution cited in TASK-646-done.md.
- FIND-SPRINT-024-8 — marked `status: resolved` in findings file; claimed resolved by TASK-647 in TASK-647-done.md.
