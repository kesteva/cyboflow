---
id: TASK-806
idea: IDEA-013
status: ready
created: 2026-05-29T00:00:00Z
source: IDEA-013
epic: dual-substrate-claude
files_owned:
  - main/src/database/migrations/013_workflow_run_substrate.sql
  - shared/types/substrate.ts
  - shared/types/workflows.ts
  - main/src/orchestrator/substrateResolver.ts
  - main/src/orchestrator/workflowRegistry.ts
  - main/src/services/configManager.ts
  - main/src/types/config.ts
  - main/src/services/cliManagerFactory.ts
  - main/src/services/cliToolRegistry.ts
  - main/src/services/panels/claude/interactiveClaudeManager.ts
  - main/src/orchestrator/__tests__/substrateResolver.test.ts
  - main/src/database/__tests__/migration013.test.ts
  - main/src/orchestrator/__tests__/workflowRegistry.test.ts
files_readonly:
  - main/src/services/panels/claude/claudeCodeManager.ts
  - main/src/services/panels/cli/AbstractCliManager.ts
  - main/src/database/migrations/011_workflow_step_tracking.sql
  - main/src/database/__tests__/migration011.test.ts
  - main/src/database/database.ts
  - main/src/orchestrator/types.ts
acceptance_criteria:
  - criterion: "Migration 013_workflow_run_substrate.sql adds workflow_runs.substrate TEXT NOT NULL DEFAULT 'sdk' with a CHECK (substrate IN ('sdk','interactive')); pre-existing rows read back 'sdk'."
    verification: "grep -nE \"ADD COLUMN substrate TEXT NOT NULL DEFAULT 'sdk'\" main/src/database/migrations/013_workflow_run_substrate.sql && grep -n \"CHECK\\s*(\\s*substrate IN ('sdk','interactive')\" main/src/database/migrations/013_workflow_run_substrate.sql; migration013.test.ts inserts a workflow_runs row WITHOUT a substrate value and asserts the read-back column === 'sdk'."
  - criterion: "The schema-parity / migration unit test in pnpm test:unit passes: applying 006→011→013 yields a workflow_runs.substrate column whose type+default+CHECK match WorkflowRunRow.substrate, and an out-of-domain value (e.g. 'gemini') is rejected by the CHECK constraint."
    verification: "main/src/database/__tests__/migration013.test.ts mirrors migration011.test.ts: PRAGMA table_info(workflow_runs) shows substrate TEXT notnull=1 dflt_value=''sdk''; a round-trip insert of 'interactive' succeeds; inserting substrate='gemini' throws a CHECK-constraint SqliteError; re-running 013 throws /duplicate column name: substrate/i. Runs under pnpm --filter main test."
  - criterion: "shared/types/substrate.ts exports the CliSubstrate union ('sdk' | 'interactive') and DEFAULT_SUBSTRATE = 'sdk' (typed as CliSubstrate), with no Node built-in imports so it is renderer-safe."
    verification: "grep -nE \"export type CliSubstrate = 'sdk' \\| 'interactive'\" shared/types/substrate.ts && grep -nE \"export const DEFAULT_SUBSTRATE: CliSubstrate = 'sdk'\" shared/types/substrate.ts"
  - criterion: "WorkflowRunRow in shared/types/workflows.ts gains substrate?: CliSubstrate (imported from ./substrate), and WorkflowRunListRow gains substrate too (the list row is surfaced to the renderer)."
    verification: "grep -n \"substrate\" shared/types/workflows.ts shows substrate on both WorkflowRunRow and WorkflowRunListRow; grep -n \"from './substrate'\" shared/types/workflows.ts shows the CliSubstrate import."
  - criterion: "substrateResolver.ts exports resolveSubstrate(...) implementing the override ladder in precedence order: workflow frontmatter > project config > ConfigManager.defaultSubstrate global > CYBOFLOW_SUBSTRATE env > 'sdk' floor; an unrecognized value at any level is ignored (does not break the ladder) and resolution falls through to the next level."
    verification: "main/src/orchestrator/__tests__/substrateResolver.test.ts has one case per ladder level proving that level wins when set and lower levels are present, a precedence case (frontmatter beats config beats global beats env), the 'sdk' floor case (nothing set), and an invalid-value-ignored case. Runs under pnpm test:unit."
  - criterion: "WorkflowRegistry.createRun STAMPS the resolved substrate onto the workflow_runs row at launch and the value is immutable for the run lifetime; getRunById SELECTs substrate so the read-back equals what was stamped."
    verification: "workflowRegistry.test.ts: createRun stamps the default ('sdk') when nothing overrides, and stamps an explicit override (e.g. 'interactive') when the resolver yields it; getRunById round-trips the stamped value; a second read after the run progresses returns the same value (no in-flight mutation path exists). grep -n 'substrate' main/src/orchestrator/workflowRegistry.ts shows substrate in BOTH the createRun INSERT column list and the getRunById SELECT column list."
  - criterion: "ConfigManager gains defaultSubstrate?: CliSubstrate on AppConfig (main/src/types/config.ts) and a getDefaultSubstrate(): CliSubstrate accessor mirroring getDefaultModel(); the dual UpdateConfigRequest shape stays in parity."
    verification: "grep -n 'defaultSubstrate' main/src/types/config.ts returns >=2 matches (AppConfig + UpdateConfigRequest); grep -n 'getDefaultSubstrate' main/src/services/configManager.ts shows the accessor returning this.config.defaultSubstrate ?? DEFAULT_SUBSTRATE."
  - criterion: "CliManagerFactory.registerBuiltInTools registers a SECOND built-in tool id 'claude-interactive' backed by InteractiveClaudeManager, mirroring registerClaudeTool's db-guard (same TypeError when additionalOptions.db is missing/non-Database)."
    verification: "grep -n \"'claude-interactive'\" main/src/services/cliManagerFactory.ts && grep -n 'registerInteractiveClaudeTool\\|InteractiveClaudeManager' main/src/services/cliManagerFactory.ts; the new factory reuses the same dbCandidate guard pattern as registerClaudeTool (lines ~178-190)."
  - criterion: "CliManagerFactory.createManager('claude-interactive', cfg) returns an InteractiveClaudeManager; createManager('claude', cfg) still returns ClaudeCodeManager (existing path unchanged)."
    verification: "A unit test (in cliManagerFactory's existing test, or a new factory dispatch test) constructs the factory and asserts the two toolIds resolve to the two distinct manager classes; the 'claude' path remains byte-identical (instanceof ClaudeCodeManager)."
  - criterion: "InteractiveClaudeManager is a STUB extending AbstractCliManager whose abstract-method bodies throw a clear 'not implemented' error (the real body lands in TASK-808/S3) — its only purpose this slice is to make the factory branch constructible and testable."
    verification: "grep -n 'class InteractiveClaudeManager extends AbstractCliManager' main/src/services/panels/claude/interactiveClaudeManager.ts && grep -n 'not implemented' main/src/services/panels/claude/interactiveClaudeManager.ts; the factory-dispatch test asserts createManager('claude-interactive',...) returns an instance without invoking any throwing method."
  - criterion: "Pure seam — ZERO runtime behavior change: with no config/frontmatter/env overrides every existing run resolves substrate='sdk' and the SDK path is byte-identical; existing runExecutor + claudeCodeManager + workflowRegistry tests stay green."
    verification: "Existing main suites green under pnpm test:unit; substrateResolver.test.ts 'sdk' floor case + workflowRegistry.test.ts default-stamp case assert the no-override path resolves 'sdk'. No edit to claudeCodeManager.ts (read-only): git diff --stat main/src/services/panels/claude/claudeCodeManager.ts shows 0 changed lines."
  - criterion: "No use of the `any` type in any file this task creates/edits."
    verification: "grep -nE ':\\s*any(\\b|\\[)|<any>|as any' main/src/orchestrator/substrateResolver.ts shared/types/substrate.ts shared/types/workflows.ts main/src/orchestrator/workflowRegistry.ts main/src/services/configManager.ts main/src/types/config.ts main/src/services/cliManagerFactory.ts main/src/services/cliToolRegistry.ts main/src/services/panels/claude/interactiveClaudeManager.ts main/src/orchestrator/__tests__/substrateResolver.test.ts main/src/orchestrator/__tests__/workflowRegistry.test.ts main/src/database/__tests__/migration013.test.ts returns 0 matches."
  - criterion: "All unit tests pass on the verifier gate (NOT test:e2e)."
    verification: "pnpm test:unit exits 0 with migration013.test.ts and substrateResolver.test.ts included. (If a better-sqlite3 NODE_MODULE_VERSION error appears, run pnpm rebuild better-sqlite3 first per CLAUDE.md.)"
  - criterion: "The new code type-checks and lints clean."
    verification: "pnpm typecheck && pnpm lint exit 0."
depends_on: [TASK-805]
estimated_complexity: medium
test_strategy:
  needed: true
  justification: "Pure plumbing with a hard zero-behavior-change invariant: the migration, the resolver ladder, and the createRun stamp are each independently unit-testable against an in-memory DB and injected config/env, mirroring migration011.test.ts and workflowRegistry.test.ts. The factory dispatch is testable before any PTY/manager body exists because InteractiveClaudeManager is a stub. The seam is the load-bearing contract — drift here silently flips substrate resolution for every run — so it must be pinned by tests."
  targets:
    - behavior: "Migration 013 adds workflow_runs.substrate TEXT NOT NULL DEFAULT 'sdk' with the CHECK domain; existing rows read 'sdk'; out-of-domain values are rejected; re-run is idempotent (duplicate column)."
      test_file: "main/src/database/__tests__/migration013.test.ts"
      type: integration
    - behavior: "resolveSubstrate honors the override ladder in precedence order and floors to 'sdk'; invalid values are ignored and fall through."
      test_file: "main/src/orchestrator/__tests__/substrateResolver.test.ts"
      type: unit
    - behavior: "WorkflowRegistry.createRun stamps the resolved substrate (default + explicit override) and getRunById round-trips it; the value is immutable for the run."
      test_file: "main/src/orchestrator/__tests__/workflowRegistry.test.ts"
      type: integration
    - behavior: "CliManagerFactory.createManager dispatches 'claude-interactive' → InteractiveClaudeManager and 'claude' → ClaudeCodeManager; the interactive factory db-guard throws when db is missing."
      test_file: "main/src/orchestrator/__tests__/substrateResolver.test.ts"
      type: unit
---

# Substrate selection seam: migration + types + resolver + factory dispatch (SDK path byte-identical)

## Objective

Establish the SINGLE resolution point and persistence for the dual-substrate choice with proven-zero impact on existing runs. This slice (IDEA-013 S1-selection-seam) adds all the dual-substrate plumbing — a new `workflow_runs.substrate` column (migration 013), the `CliSubstrate` shared type, a pure `resolveSubstrate()` override ladder, a `WorkflowRegistry.createRun` stamp + `getRunById` read-back, a `ConfigManager.defaultSubstrate` setting, and a second built-in factory tool id `'claude-interactive'` backed by a STUB `InteractiveClaudeManager` — such that with no config/frontmatter/env overrides EVERY existing run resolves `substrate='sdk'` and the SDK path is byte-identical. This unblocks the manager body (TASK-808/S3) and the dispatch/facade work (S4) by making the factory branch testable before any PTY code exists. This task does NOT spawn anything interactive: `InteractiveClaudeManager` is a throw-on-call stub whose only job is to make `createManager('claude-interactive', cfg)` constructible. All of S1's `fileTouchPoints` are new files or additive edits to non-IDEA-029-owned files, so this slice is independent of IDEA-029 and depends ONLY on TASK-805 (the prior IDEA-013 slice in the chain).

## Implementation Steps

1. **Create `main/src/database/migrations/013_workflow_run_substrate.sql`** (new; next number after 012). Mirror the style and header comments of `011_workflow_step_tracking.sql` (no explicit `BEGIN/COMMIT` — `runFileBasedMigrations()` in `database.ts` wraps each file in a transaction). Body:
   ```sql
   ALTER TABLE workflow_runs
     ADD COLUMN substrate TEXT NOT NULL DEFAULT 'sdk'
       CHECK (substrate IN ('sdk','interactive'));
   ```
   Document in the header that this is the IDEA-013 dual-substrate seam, every legacy row reads back `'sdk'`, and the value is immutable for a run.

2. **Create `shared/types/substrate.ts`** (new). Keep it free of Node built-ins (renderer-safe, like `workflows.ts`). Export:
   - `export type CliSubstrate = 'sdk' | 'interactive';`
   - `export const DEFAULT_SUBSTRATE: CliSubstrate = 'sdk';`
   - Optionally a small `isCliSubstrate(v: unknown): v is CliSubstrate` guard (return-typed predicate, NO `any`) for the resolver to reject invalid override values. Use this rather than casts.

3. **Edit `shared/types/workflows.ts`.** Add `import type { CliSubstrate } from './substrate';` at top. Add `substrate?: CliSubstrate;` to `WorkflowRunRow` (place it near `current_step_id` ~line 40 with a one-line doc comment) and add `substrate: CliSubstrate;` to `WorkflowRunListRow` (the renderer-facing list row, ~lines 54-66) so the picker can show it in S7. Keep the column-order doc note consistent with how 011 documented mirroring.

4. **Create `main/src/orchestrator/substrateResolver.ts`** (new). MUST honor the standalone-typecheck invariant documented at the top of `orchestrator/types.ts` and `workflowRegistry.ts` (NO `electron`, NO `services/*` import). Export a pure function:
   ```ts
   export interface SubstrateResolverInputs {
     frontmatterSubstrate?: string | null;   // workflow .md frontmatter `substrate:` value
     projectConfigSubstrate?: string | null;  // per-project config override
     globalDefaultSubstrate?: string | null;   // ConfigManager.defaultSubstrate
     env?: NodeJS.ProcessEnv;                   // for CYBOFLOW_SUBSTRATE, defaults to process.env
   }
   export function resolveSubstrate(inputs: SubstrateResolverInputs): CliSubstrate;
   ```
   Walk the ladder in precedence order — frontmatter > projectConfig > globalDefault > `env.CYBOFLOW_SUBSTRATE` > `DEFAULT_SUBSTRATE` ('sdk') — using `isCliSubstrate(...)` to validate each candidate and SKIP to the next level on an unrecognized value (fail-soft, never throw; mirrors `resolveSoloFlowPluginRoot`'s graceful fall-through and `extractPermissionMode`'s default-on-unknown). Return `DEFAULT_SUBSTRATE` if nothing valid is found.

5. **Edit `main/src/orchestrator/workflowRegistry.ts`.** Import `resolveSubstrate` and `CliSubstrate`/`DEFAULT_SUBSTRATE`. In `createRun(workflowId)` (~315-336): after looking up the workflow, resolve the substrate (the simplest correct v1 wiring is to resolve from the inputs available to the registry — pass through frontmatter `substrate:` if `extractPermissionMode`-style parsing is added, the project/global config values if injected, and `process.env`; if those collaborators are not yet injected here, resolve with only env + `DEFAULT_SUBSTRATE` and leave a documented TODO seam for S4/S7 to thread project/global config — but the floor and stamp MUST be correct). Add `substrate` to the INSERT column list and bind the resolved value. Update the return type to include the stamped `substrate`. In `getRunById` (~342-348), add `substrate` to the SELECT column list so the read-back includes it. Do NOT add any in-flight UPDATE path for substrate — it is immutable for the run.

6. **Edit `main/src/types/config.ts`.** Add `defaultSubstrate?: CliSubstrate;` to `AppConfig` (near `defaultModel`, line ~13) AND to `UpdateConfigRequest` (near line ~69) to keep the dual request/response shape in parity (CLAUDE.md IPC request-shape parity rule). Import `CliSubstrate` from `../../../shared/types/substrate` (verify relative depth).

7. **Edit `main/src/services/configManager.ts`.** Add a `getDefaultSubstrate(): CliSubstrate` accessor mirroring `getDefaultModel()` (~line 174): `return this.config.defaultSubstrate ?? DEFAULT_SUBSTRATE;`. Import `CliSubstrate`/`DEFAULT_SUBSTRATE` from the shared substrate types. Do NOT add `defaultSubstrate` to the constructor defaults object (leaving it undefined means the accessor floors to 'sdk' and no config file rewrite is forced on existing users — preserving byte-identical behavior).

8. **Create `main/src/services/panels/claude/interactiveClaudeManager.ts`** (new STUB). `export class InteractiveClaudeManager extends AbstractCliManager`. Implement every abstract method declared on `AbstractCliManager` (getCliToolName, testCliAvailability, buildCommandArgs, getCliExecutablePath, parseCliOutput, initializeCliEnvironment, cleanupCliResources, getCliEnvironment, startPanel/continuePanel/stopPanel/restartPanelWithHistory) as a body that throws `new Error('InteractiveClaudeManager not implemented — see TASK-808')`. Give `getCliToolName()` a real return ('Claude Code (Interactive)') if the abstract contract requires it to be callable during registration; otherwise keep it throwing. The constructor must match the shape the factory will call (same arg order as `ClaudeCodeManager`: sessionManager, logger?, configManager?, db). Add a file-level comment that the real body lands in TASK-808/S3 and that this stub exists solely to make the factory branch constructible/testable. No `any`.

9. **Edit `main/src/services/cliManagerFactory.ts`.** In `registerBuiltInTools()` (~155-165) add a call to a new `private registerInteractiveClaudeTool()` alongside `registerClaudeTool()`. Implement `registerInteractiveClaudeTool()` mirroring `registerClaudeTool()` (lines 170-243): same `db` guard (the exact `TypeError` when `additionalOptions.db` is missing or lacks `.prepare`), but `id: 'claude-interactive'`, `name: 'Claude Code (Interactive)'`, and `managerFactory` returning `new InteractiveClaudeManager(...)`. Register with a LOWER priority than the `claude` tool's 100 (so `getDefaultTool()` still prefers SDK). Import `InteractiveClaudeManager`. (`cliToolRegistry.ts` is listed as owned only in case a metadata tweak is needed — prefer NOT editing it; the registry already supports arbitrary tool ids via `registerTool`, so the factory edit alone should suffice. Touch `cliToolRegistry.ts` only if `CliToolDefinition` needs a field.)

10. **Create `main/src/database/__tests__/migration013.test.ts`** modeled on `migration011.test.ts`: helper applies 006 → 011 → 013 to a `:memory:` DB; assert `PRAGMA table_info(workflow_runs)` shows `substrate` TEXT `notnull=1` `dflt_value` ='sdk'; assert an insert WITHOUT substrate reads back `'sdk'`; assert inserting `'interactive'` round-trips; assert inserting `'gemini'` throws a CHECK-constraint error; assert re-running 013 throws `/duplicate column name: substrate/i`.

11. **Create `main/src/orchestrator/__tests__/substrateResolver.test.ts`**: one case per ladder level winning, a full-precedence case, the 'sdk' floor, and an invalid-value-ignored case. Also add the factory-dispatch assertions here (or in cliManagerFactory's existing test): build the factory and assert `createManager('claude-interactive', cfg)` returns an `InteractiveClaudeManager` and `createManager('claude', cfg)` returns a `ClaudeCodeManager`, and that the interactive factory's db-guard throws when `db` is absent — WITHOUT invoking any throwing stub method.

12. **Extend `main/src/orchestrator/__tests__/workflowRegistry.test.ts`** (existing `createRun` ~328 and `getRunById` ~396 describe blocks): add cases asserting createRun stamps `'sdk'` with no override, stamps `'interactive'` when the resolver yields it (inject an env or a config value through whatever collaborator the registry uses), and that `getRunById` round-trips the stamped value.

13. Run `pnpm test:unit` (exit 0) — if a `better-sqlite3` NODE_MODULE_VERSION error appears, run `pnpm rebuild better-sqlite3` first per CLAUDE.md, then re-run. Then run `pnpm typecheck && pnpm lint` and confirm clean. Run the no-`any` grep across all owned files.

## Acceptance Criteria notes

- **Migration idempotency signal**: `runFileBasedMigrations()` treats `duplicate column name: substrate` as the "already applied" signal, so the migration MUST be a bare `ALTER TABLE ADD COLUMN` (no `IF NOT EXISTS` — SQLite ALTER does not support it and the duplicate-column throw is the intended idempotency mechanism, exactly as 011 relies on).
- **CHECK constraint domain**: keep the domain literally `('sdk','interactive')` to match `CliSubstrate`. If a future substrate is added, the migration domain and the union must be widened together — note this in the SQL header.
- **Immutability**: substrate is stamped once in `createRun` and only ever read via `getRunById`. Do NOT introduce an UPDATE path. The "immutable for the run lifetime" AC is satisfied by the absence of any mutator plus a test reading it twice.
- **Resolver fail-soft**: an unrecognized override (e.g. a typo `interactiv`) at any ladder level is ignored and resolution falls through to the next level, never throwing — mirroring `extractPermissionMode` defaulting on unknown and `resolveSoloFlowPluginRoot` falling through. This prevents a bad config value from breaking run creation.
- **No forced config rewrite**: `defaultSubstrate` is intentionally NOT added to the ConfigManager constructor defaults; the `getDefaultSubstrate()` accessor floors to `DEFAULT_SUBSTRATE`. This keeps existing `config.json` files byte-identical (no migration write on launch) — part of the zero-behavior-change invariant.
- **Stub safety**: the factory-dispatch test asserts `createManager('claude-interactive', ...)` RETURNS an instance; it must NOT call a throwing stub method. `getCliToolName` may need a real return if the registry/availability path calls it during registration — verify against `cliToolRegistry.checkToolAvailability` (line ~380 constructs a temp manager and calls `getCachedAvailability`); register the interactive tool with `validateOnRegister: false` and `skipValidation` at create time so availability is not probed in this slice.
- **Factory priority**: register `claude-interactive` with priority < 100 so `getDefaultTool()` continues to return the SDK `claude` tool — preserving the existing default-manager boot path.

## Out of Scope

- The real `InteractiveClaudeManager` body (PTY spawn, transcript tail, completion) — that is TASK-808/S3; this slice ships only a throw-on-call stub.
- Substrate-aware spawner dispatch at the `index.ts` boot seam and the FACADE EventEmitter source — that is S4, which is depends-on-MERGE of IDEA-029 TASK-799 (which OWNS `index.ts`). This task does NOT edit `index.ts` and adds NO duplicate of any IDEA-029 code.
- Threading per-project and per-workflow-frontmatter substrate overrides end-to-end into `WorkflowRegistry.createRun` if the registry does not yet receive those collaborators — the resolver supports them, but full wiring of project/global config into createRun may be completed in S4/S7; this slice guarantees the env + global default + floor are correct and leaves a documented seam.
- Any renderer/picker UI for substrate selection — that is S7 (`RunRightRail`/`CyboflowRoot`, AppRouter-inferred tRPC types).
- Editing `claudeCodeManager.ts` (read-only here; TASK-800/IDEA-029 owns it) — the SDK path is unchanged and must stay byte-identical.
- The transcript normalizer / `TranscriptSource` (S2 / prior TASK), shell-hook gating (S5), and step tracking (S6) — none are touched by the seam.
- Widening `streamParser/schemas.ts` or any frontend type — the seam is backend types + migration + factory only.
