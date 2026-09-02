# Code Patterns

Reusable conventions and shared utilities in this codebase. Each entry points
to a canonical example — read those for the actual implementation.

## File / Directory Conventions

- **Naming:** Components: `PascalCase.tsx`. Services/utils/stores: `camelCase.ts`.
  IPC handlers: `camelCase.ts` per domain (e.g. `session.ts`, `git.ts`).
- **Test colocation:** Unit tests live in `__tests__/` subdirectories next to the file
  under test (e.g. `main/src/services/__tests__/gitStatusManager.test.ts`). E2E tests
  are top-level in `tests/`.
- **Shared test fixtures:** Live in sibling `__test_fixtures__/` directories (NOT under
  `__tests__/__fixtures__/`). See `main/src/orchestrator/__test_fixtures__/` for canonical
  examples (`dbAdapter.ts`, `loggerLikeSpy.ts`, and `rawEvents.ts`).
- **Barrels:** No barrel `index.ts` re-exports as a rule; import paths are explicit. Known
  exceptions: `main/src/services/panels/codex/appServer/index.ts` (a pure `export *` barrel),
  plus the named-re-export barrels `shared/streamParser/index.ts` and
  `main/src/orchestrator/dynamicWorkflows/index.ts` — not license to add more.
- **Formatting:** No Prettier config. ESLint with TypeScript rules in each workspace
  (`frontend/eslint.config.js`, `main/eslint.config.js`). Run via `pnpm lint`. The `any` type is
  forbidden repo-wide — `@typescript-eslint/no-explicit-any` is `'error'` in both configs and CI
  enforces it. Use `unknown` (with type guards) or a narrowed generic instead.

## Shared Utilities

### `frontend/src/utils/cn`

- **Path:** `frontend/src/utils/cn.ts`
- **Use it for:** Merging Tailwind class names conditionally. Wraps `clsx` + `tailwind-merge`.
- **Canonical example:** Any component in `frontend/src/components/ui/`

### `main/src/utils/mutex`

- **Path:** `main/src/utils/mutex.ts`
- **Use it for:** Per-resource async locking to prevent races in the orchestrator.
  Call `mutex.acquire(resourceName)` — returns a release function.
- **Canonical example:** `main/src/services/sessionManager.ts`

### `main/src/services/simpleTaskQueue`

- **Path:** `main/src/services/simpleTaskQueue.ts`
- **Use it for:** In-process job queue with concurrency limits. No Redis.
  Construct with `new SimpleQueue(name, concurrency)`, call `.process(n, handler)`, then `.add(data)`.
- **Canonical example:** `main/src/services/cliManagerFactory.ts`

### `main/src/utils/logger`

- **Path:** `main/src/utils/logger.ts`
- **Use it for:** Structured file logging in the main process. Rolling 10 MB logs, max 5 files.
  Captures original `console.*` methods before any override to avoid recursion.
- **Canonical example:** `main/src/services/sessionManager.ts`

### `main/src/orchestrator/loggerAdapter`

- **Path:** `main/src/orchestrator/loggerAdapter.ts`
- **Use it for:** Bridging a `Logger` instance to any boundary typed as `LoggerLike`
  (the structural interface in `main/src/orchestrator/types.ts`). Call
  `makeLoggerLike(logger)` — also handles the `logger === undefined` case by returning
  a console-based shim, so callers never need a null check. Companion `makeDatabaseLike`
  builds the matching `DatabaseLike` adapter.
- **Why single-source:** Hand-rolled inline adapters (`{ info: m => logger.info(m), ... }`)
  silently drift when `Logger` or `LoggerLike` gain methods — this utility exists to kill
  that drift surface, and inline copies have crept back in before. Do NOT inline.
- **Canonical example:** `main/src/services/panels/claude/claudeCodeManager.ts:503`;
  `main/src/index.ts:559` and `:717`.

### `frontend/src/utils/api`

- **Path:** `frontend/src/utils/api.ts`
- **Use it for:** All IPC calls from renderer to main. Do not call `window.electron` directly
  from components — go through this module.
- **Canonical example:** Any store in `frontend/src/stores/`
- **Exception — `frontend/src/utils/cyboflowApi.ts`:** temporary parallel surface for the
  cyboflow workflow domain, pending the in-progress tRPC migration. Do NOT add new channels
  here, do NOT copy this module pattern into other domains, and do NOT deepen its surface —
  extend `api.ts` (`API.cyboflow.*`) or use the tRPC routers, which will eventually replace
  this module.

### `frontend/src/trpc/client`

- **Path:** `frontend/src/trpc/client.ts`
- **Use it for:** All tRPC calls from the renderer. Import as `import { trpc } from '<relative>/trpc/client'`.
- **Why single-source:** tRPC v11 subscriptions register IPC listeners per `createTRPCProxyClient` instance — a second instance causes duplicate event delivery.
- **Canonical example:** `frontend/src/stores/reviewQueueStore.ts`

### `frontend/src/utils/migrateLocalStorageKey`

- **Path:** `frontend/src/utils/migrateLocalStorageKey.ts`
- **Use it for:** One-shot localStorage key rename (e.g. crystal-→cyboflow-). Reads legacy key,
  copies value to new key, deletes legacy key, returns value. Idempotent.
- **Call contract:** Invoke inside `useEffect(..., [])` or a `useState(() => ...)` initializer —
  never inside a closure that runs on every render or log call.
- **Canonical example:** `frontend/src/App.tsx:60` (mount-time call).
- **Anti-pattern:** `frontend/src/utils/console.ts:9–12` calls it inside `isVerboseEnabled()`,
  which fires on every `devLog.*` invocation — redundant localStorage reads per log line.

### `main/src/utils/commitFooter`

- **Path:** `main/src/utils/commitFooter.ts`
- **Use it for:** The canonical Cyboflow commit-footer string. Single source of truth — never inline the footer literal elsewhere.
- **Key export:** `buildCommitFooter(enabled: boolean): string` (empty string when disabled).
- **Canonical example:** `main/src/utils/shellEscape.ts` (`buildGitCommitCommand`); byte-level contract pinned in `main/src/utils/commitFooter.test.ts`.

### `main/src/utils/devDebugLog`

- **Path:** `main/src/utils/devDebugLog.ts`
- **Use it for:** Writing structured lines to `cyboflow-{frontend,backend}-debug.log` in dev mode. Centralizes the filename literals and line format — do NOT hardcode either elsewhere.
- **Key exports:** `getDevDebugLogPath(stream)`, `appendDevDebugLog(stream, level, source, message, originalConsole?)`. Pass the pre-override `originalConsole.error` from inside `console.*` overrides to avoid recursion.
- **Canonical example:** `main/src/index.ts` console-wrapper overrides and frontend webContents listener.

### `main/src/orchestrator/__test_fixtures__/dbAdapter`

- **Path:** `main/src/orchestrator/__test_fixtures__/dbAdapter.ts`
- **Use it for:** Wrapping a `better-sqlite3` `Database` into the `DatabaseLike` (`{ prepare, transaction }`) shape required by orchestrator and tRPC handler tests. Do NOT clone locally — the `: DatabaseLike` return-type annotation is the build-time tripwire that catches future widening of `DatabaseLike`.
- **Canonical example:** `main/src/orchestrator/__tests__/workflowRegistry.test.ts`.

### `main/src/orchestrator/__test_fixtures__/loggerLikeSpy`

- **Path:** `main/src/orchestrator/__test_fixtures__/loggerLikeSpy.ts`
- **Use it for:** A `vi.fn()`-based `LoggerLike` spy for orchestrator, IPC, and pipeline tests. `makeSpyLogger()` returns `LoggerLike & { calls: LogCall[] }` — each method is a Vitest spy and pushes structured entries onto `calls` for log assertions. `makeProdLoggerSpy()` returns a `Pick<Logger, 'warn' | 'info' | 'verbose'>`-shaped spy for service-layer call sites that pass the spy to code expecting the production `Logger` (cast via `as unknown as Logger` at the seam).
- **Why single-source:** consolidated from 6+ local `makeLogger()` helpers, and new local factories have regressed back in before. Do NOT clone locally. If a call site needs a different shape, extend this file with a new factory — do not fork.
- **Canonical example:** `main/src/orchestrator/__tests__/runLauncher.test.ts` (LoggerLike); `main/src/services/panels/claude/__tests__/claudeCodeManagerWiring.test.ts` (production Logger).

### `main/src/orchestrator/__test_fixtures__/rawEvents`

- **Path:** `main/src/orchestrator/__test_fixtures__/rawEvents.ts`
- **Use it for:** Any test that needs a `raw_events` table — persistence (`bridgeEvents`, `RawEventsSink`), consumption (`runExecutor`), or schema reconciliation. Exports `RAW_EVENTS_DDL`, `makeRawEventsDb()` (in-memory `better-sqlite3` with the table created and FKs off), and `countRawEvents(db, runId)`. Do NOT inline `CREATE TABLE ... raw_events` locally — a migration 006 schema change must propagate via this single source.
- **Why single-source:** extracted to kill repeated inline DDL copies — the kind a schema-migration sweep misses. New `raw_events` test sites import here.
- **Canonical example:** `main/src/orchestrator/__tests__/runEventBridge.test.ts`; `main/src/orchestrator/__tests__/runExecutor.test.ts`.

### Database seed helpers

Shared helpers live in `main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts`:

- `createTestDb()` — in-memory `better-sqlite3` with the full cyboflow schema
  applied via `GATE_SCHEMA` (column-parity-pinned to `006_cyboflow_schema.sql`
  by `__tests__/orchestratorTestDb.test.ts`).
- `seedRun(db, overrides?)` — inserts a `workflows` + `workflow_runs` pair;
  `overrides` accepts any column subset (e.g. `{ id, status, workflowName }`).
- `seedApproval(db, overrides)` — inserts one `approvals` row; `overrides.runId`
  is required (no phantom FK rows); all other fields are optional with defaults:
  `toolName='bash'`, `toolInputJson='{}'`, `toolUseId={id}`, `status='pending'`,
  `createdAt=now`. Call sites that need SDK-canonical casing pass `toolName:'Bash'`
  explicitly — self-documenting at the call site.

Do NOT inline `INSERT INTO workflow_runs` in new test files — use `seedRun`.
Do NOT inline `INSERT INTO approvals` in new test files — use `seedApproval`.
The caller must have already seeded the parent run via `seedRun` before calling
`seedApproval` — a missing parent row will fail the FK constraint and surface
the bug immediately.

**Canonical examples:** `main/src/orchestrator/__tests__/runRecovery.test.ts`,
`main/src/orchestrator/__tests__/stuckDetector.test.ts`,
`main/src/orchestrator/trpc/routers/__tests__/approvals.test.ts`.

## Recurring Patterns

### Shared types as the cross-package contract

Types in `shared/types/` are imported by both `main/` and `frontend/`. When adding a new
domain concept that spans both, define its type in `shared/types/` first. Never duplicate
type definitions across packages.

- `shared/types/models.ts` — database-layer model types
- `shared/types/panels.ts` — panel configuration and state types
- `shared/types/cliPanels.ts` — CLI-specific panel types

**Stuck-event types** live in `shared/types/stuckDetection.ts` — `StuckDetectedEvent` and
`StuckReason`. `reviewQueueSlice`'s `subscribeToStuckEvents()` action
(called from an App-level `useEffect`) subscribes directly on the typed
tRPC proxy (`trpc.cyboflow.events.onStuckDetected.subscribe(...)`, `onData: (event:
StuckDetectedEvent) => …`) — the earlier `StuckEventsClient` cast-through-`unknown` shim is no
longer used anywhere in `frontend/src`. Rules:

- Import stuck-event types from `shared/types/stuckDetection.ts`. Do NOT re-declare
  `StuckDetectedEvent` or `StuckReason` locally — independent re-declarations have
  produced a verbatim duplicate interface and a doubled IPC subscription before.
- Exactly one App-level mount (`reviewQueueSlice`'s `subscribeToStuckEvents()`) should open
  the `onStuckDetected` subscription. Other consumers read from the Zustand `reviewQueueSlice`
  (`runStatusMap`) instead of opening their own tRPC subscription.
- Audit: `grep -rn 'StuckDetectedEvent\|StuckReason' frontend/src` should show only imports,
  never a local `interface`/`type` re-declaration.

**Label maps for shared-type discriminants** belong next to the type (same file
or a companion `*Labels.ts` in `shared/types/`), keyed by `Record<Union['kind'], string>`
so adding a new variant breaks the map at compile time. Never duplicate the map in a
component and a hook — see `frontend/src/components/ReviewQueue/StuckInspectorModal.tsx`
and `frontend/src/hooks/useStuckNotifications.ts` for the anti-pattern.

**Claude stream block types** live in `shared/types/claudeStream.ts` — the single source of
truth for `TextBlock`, `ToolUseBlock`, `ToolResultBlock`, `ThinkingBlock`, and the
`ClaudeStreamEvent` discriminated union. Rules:

- Import block types directly from `shared/types/claudeStream.ts`. Do NOT re-declare local
  `interface ToolResult`/`TextBlock`/`ToolUseBlock` shadow types — a shadow that pins
  `ToolResultBlock.content` back to `string` hides the array branch from TypeScript at every
  downstream callsite.
- `ToolResultBlock.content` is `string | Array<{type: 'text'; text: string}>`. Always guard:
  `typeof content === 'string' ? content : content.map(b => b.text).join('')`. Never call
  `JSON.parse`, `.includes(...)`, or template-string interpolation on raw `content`.
- The `@deprecated` re-exports in `{frontend,main}/src/types/session.ts` (`TextContent`,
  `ToolUseContent`, `ToolResultContent`) are a temporary migration bridge — do not add new
  consumers.
- TS↔Zod drift bridge: `shared/streamParser/schemas.ts` `_typeCheck` catches
  required-field drift. Optional-field drift is a known gap.

**StreamEvent discriminated-union narrowing:** `StreamEvent.type` (`frontend/src/utils/cyboflowApi.ts`)
and `StreamEvent.payload` MUST be narrowed in the same pass. Leaving `payload: unknown`
while `type` is a union forces `as ClaudeStreamEvent`-style casts at every consumer and
defeats the discriminated-union design. If a non-SDK synthetic event exists (e.g. a
bootstrap `run_started` row with no SDK payload), model it as its own union member
(`{ type: 'run_started'; payload?: undefined }`) so `switch (event.type)` stays
exhaustively auto-narrowed. A bare `payload: unknown` on a typed envelope is the
tripwire — grep for it before merging.
Canonical example: `RunView.tsx`'s per-type row components (`SystemEventRow`,
`AssistantEventRow`, `UserEventRow`, …) each take
`Extract<StreamEvent, { type: '<discriminant>' }>` instead of casting.

**`StreamEvent` is a derived alias, not a re-declaration.** `frontend/src/utils/cyboflowApi.ts`
declares `export type StreamEvent = StreamEnvelope;` — never re-declare the
`StreamEnvelopePayload` arms locally. A parallel union forces synchronised
edits across `StreamEventType`, `StreamEnvelopePayload`, and the renderer
type; omission silently routes new variants to `UnknownEventRow` instead of
failing typecheck. The envelope carries no top-level `runId` field — the run is
already discriminated by the `cyboflow:stream:<runId>` IPC channel — so do not
add one back.

### Zustand store structure (renderer)

One store file per domain in `frontend/src/stores/`. Each store uses Zustand's `create` with
a typed slice. Components subscribe to specific slices to avoid unnecessary re-renders.
Stores never write to the database or call Node APIs — those go through `utils/api.ts`.

- **Canonical example:** `frontend/src/stores/sessionStore.ts`

### IPC handler structure (main process)

Each domain has its own IPC file in `main/src/ipc/` that registers `ipcMain.handle` calls.
All handlers are registered in `main/src/ipc/index.ts`. Keep business logic in `services/`,
not in IPC handlers — handlers should be thin: validate input, delegate to service, return result.

**This surface is frozen.** New renderer→main calls are tRPC procedures under
`main/src/orchestrator/trpc/routers/` (zod-validated input, end-to-end types), not new
`ipcMain.handle` registrations — `main/src/ipc/__tests__/noNewIpcHandlers.test.ts` pins the
per-file handler counts and fails on any growth; migrating a handler to tRPC means lowering
its frozen entry there.

- **Canonical example:** `main/src/ipc/session.ts`

**Runtime input validation:** every handler that reads from `args` MUST validate them —
see "IPC handler input validation" below for the contract and canonical usage.

### Per-run workflow definitions resolve the FROZEN spec (never live `workflows.spec_json`)

A run stamps `spec_hash` at `createRun` from its EFFECTIVE spec — the variant's frozen
`spec_json` for a variant run (migration 048), else the live workflow spec — and
`recordRevision`s it in the same transaction, so `(workflow_id, spec_hash)` always resolves
to the exact spec the run executes. **Any code that resolves a workflow definition FOR A
RUN must call `resolveRunFrozenSpec(db, runId)`** (`main/src/orchestrator/runFrozenSpec.ts`;
live-spec fallback keeps legacy/baseline runs byte-identical) — never
`JOIN workflows … read spec_json` keyed by the run. A live read makes a structural-variant
run walk the wrong graph and re-opens the historical bug where editing a workflow mid-run
changed the running definition. Every existing per-run reader routes through it; a new
per-run reader that reads `workflows.spec_json` directly is a review-blocking defect. Reading the live spec is correct ONLY for definition-authoring
surfaces (the editor, `resolveWorkflowDefinition` at variant-creation time) that are about
the workflow, not a run.

- **Canonical example:** `main/src/orchestrator/stepTransitionBridge.ts` (reader) +
  `main/src/orchestrator/__tests__/stepTransitionBridge.frozenSpec.test.ts` (accepts a
  variant-only step id, rejects a live-only one).

## IPC handler input validation

All `ipcMain.handle` handlers in `main/src/ipc/*.ts` MUST validate args via
`validateInput` from `main/src/ipc/validateInput.ts`. A bare
`const { projectId } = args as { projectId: number }` cast is insufficient — if the
renderer passes `undefined`, better-sqlite3 throws or returns wrong rows silently.
Hand-rolled type guards are forbidden — they fork the error-shape and make the
in-progress tRPC ipcLink migration harder.

Canonical usage:

```ts
const v = validateInput(z.object({ projectId: z.number().finite() }), args, 'cyboflow:approveRun');
if (!v.ok) return { success: false, error: v.error };
const { projectId } = v.value;
```

See `main/src/ipc/cyboflow.ts` for the canonical caller.

### IPC / type-parity rules (silent-drop class)

These rules all guard the same failure mode: a type declaration that drifts from the runtime
shape on the other side of an IPC/tRPC boundary, so a field is silently dropped instead of
caught by the compiler. The agent guide (`docs/AGENT-GUIDE.md`) points here before any IPC
touch; the rules, case studies, and audit greps live here.

- **`IPCResponse<T>` callers must pass an explicit `T`** — never rely on the default. The
  wrapper in `frontend/src/types/electron.d.ts` / `frontend/src/utils/api.ts` defaults
  `T = unknown`, which forces narrowing of `result.data` and catches field renames. Audit
  untyped sites: `grep -rnE "IPCResponse[^<A-Za-z]" frontend/src`.

- **Never declare a local `IPCResponse<T>` or inline `{ success; data?; error? }` shape** in
  frontend code — import from `frontend/src/utils/api.ts`. Audit: `grep -rn "interface
  IPCResponse" frontend/src` should return zero hits outside `utils/api.ts` and
  `types/electron.d.ts`. `main/src/preload.ts` currently keeps its own `IPCResponse`
  declaration plus many bare `Promise<IPCResponse>` sites — include `grep -n
  "Promise<IPCResponse>" main/src/preload.ts` in any audit pass until `shared/types/ipc.ts`
  lands.

- **IPC handler ↔ declared `T` parity:** the `T` in `IPCResponse<T>` declared in
  `frontend/src/types/electron.d.ts` and `frontend/src/utils/api.ts` MUST match the shape the
  matching `main/src/ipc/*` handler actually returns at runtime — not a legacy or aspirational
  type. A mismatched `T` forces `as unknown as X` double-casts in every consumer and hides
  handler shape changes from TypeScript (case study: `getJsonMessages` declared
  `ClaudeJsonMessage[]` while the handler returned `UnifiedMessage[]`, silently dropping
  all output). When changing an IPC handler's return shape, grep the channel name
  across `frontend/src/types/electron.d.ts`, `frontend/src/utils/api.ts`, and the handler file
  in the same pass.

- **IPC request-shape parity (the request-direction mirror):** request interfaces sent
  frontend → main (e.g. `CreateSessionRequest`, currently dual-declared in
  `main/src/types/session.ts` and `frontend/src/types/session.ts`) MUST be kept in sync. A field
  the server reads but the client can never send silently falls back to defaults — the
  request-direction twin of the return-shape rule above (case study: `branchName` added to
  the main-side interface only; `quickSession` dead on both sides). On any IPC touch, grep
  the request interface name
  across both `*/src/types/` and verify field parity. Prefer promoting to `shared/types/ipc.ts`
  over maintaining a dual declaration.

- **Optional `logger?` on observability classes must be passed, not omitted.** Constructors that
  accept `logger?: Pick<ILogger, ...>` (e.g. `TypedEventNarrowing`, `RawEventsSink`,
  `MessageProjection`) gate every diagnostic on `this.logger?.…` — omitting the argument silently
  turns the whole class into a no-op for observability (the same silent-drop class).
  Pass a logger from the enclosing scope; if the
  surrounding type uses a different logger surface (e.g. orchestrator `LoggerLike` has no
  `verbose`), adapt at the call site (e.g. `{ verbose: (m) => logger.debug(m) }`). Audit on
  touch (production code only — tests intentionally exercise the no-logger path): `grep -rn "new
  TypedEventNarrowing()" main/src --exclude-dir=__tests__` must return 0 matches.

- **tRPC subscription `onData` payload type must come from `AppRouter` inference** — never a
  local mirror or `(evt: unknown)` + runtime shape guard. Write `onData: (event) => …` and let
  the tRPC client infer the payload from the router. A locally-declared interface (e.g. a
  `WorkflowStepTransitionEvent` copy in the renderer) or an `unknown`-typed arg with a
  hand-rolled `'runId' in evt` guard defeats inference and silently accepts stale shapes after
  the router output changes. Audit: `grep -rnE "onData:
  \(evt: unknown\)|onData: \(event:" frontend/src` — each production hit is a candidate for
  inference (test files intentionally fake the shape and are exempt).

### `cyboflow_*` MCP tools are declared ONCE, in the tool registry

The same silent-drop class as the IPC rules above, on the orchestrator socket. A tool used to
live in three hand-maintained places — a JSON Schema literal in `cyboflowMcpServer.ts`'s
ListTools reply, a `case 'cyboflow_…'` arm that re-typechecked the same fields and hand-built
the camelCase envelope, and the `McpQueryMessage` union member `mcpQueryHandler.ts` reads. The
envelope crosses the socket as JSON and is re-typed by a blind
`parsed as McpQueryMessage` cast (`orchSocketServer.ts`), so a mis-renamed key compiled,
shipped, and arrived at the handler as `undefined`.

**Add or change a tool in exactly one place:** an entry in
`main/src/orchestrator/mcpServer/toolRegistry/` — `runScopeTools.ts`,
`globalAgentTools.ts`, or `designTools.ts`, keyed by (scope, name). One `defineTool({ name,
description, input, envelope, toEnvelope })` carries a zod schema; the advertised JSON Schema,
the argument validation, and the `invalid_arguments` `expected` string are all DERIVED from it,
and `toEnvelope`'s return type is checked against `EnvelopeParams<T>` — the union member for the
envelope the entry names — so a wrong camelCase key is now a build error rather than a runtime
`undefined`.

- **Never add a `case 'cyboflow_…'` arm or an `inputSchema:` literal to `cyboflowMcpServer.ts`.**
  It dispatches generically (`findTool` → `tool.prepare` → `executeMcpQuery`) and holds no
  per-tool code. `toolRegistryRatchet.test.ts` fails CI on either.
- **Scope is part of the key, not a filter.** `cyboflow_report_artifact` and
  `cyboflow_create_task` are advertised in more than one scope with a different schema and a
  different mapping (the design session narrows both), so they are separate entries.
- **Preserve deliberate looseness.** A field the arm forwarded unvalidated because the handler
  re-narrows it (`buildFindingExtras`, `parseFindingLocations`, `parseFindingImpact`,
  `parseViewports`, `parseVerificationTaskV1`) stays permissive, declared via
  `declareAs(z.unknown(), {…})` so the advertised shape stays rich. Tightening one into a strict
  `z.enum`/`z.object` turns an agent typo into a rejected write, which is what those narrowers
  exist to prevent.
- **The registry is bundled into the standalone MCP subprocess** (`scripts/bundle-mcp-server.mjs`),
  so it may import only `zod` and its siblings. Its `McpQueryMessage` import is `import type`
  on purpose: a value import would drag electron, better-sqlite3, and the services layer into
  the subprocess bundle.

### Per-session mutation serialization

Any state mutation for a workflow run passes through a per-run `SimpleQueue({concurrency: 1})`.
This serializes concurrent events (Claude stream events arriving while user approves a tool call).
Do not skip the queue for "quick" mutations — the queue is the correctness guarantee.

### tRPC seed-query + subscription race policy

For a tRPC pair where a query returns initial state and a subscription delivers
delta events (e.g. `getPhaseState` + `onStepTransition`), the consumer MUST open
the subscription BEFORE awaiting the query — not in a separate concurrent
`useEffect` — so events that arrive during the query window are not overwritten
when the seed resolves. Use a `cancelled` flag so the seed `.then()` skips
applying stale state after teardown.

**Canonical example:** `frontend/src/hooks/useWorkflowPhaseState.ts` (subscribe before the `getPhaseState.query` `.then(...)`; both guarded by a `cancelled` flag).
**Anti-pattern:** pre-retrofit `WorkflowProgressTimeline.tsx` ran two sibling effects;
the query's `setStepStates` overwrote subscription deltas.

### Entity-aware write chokepoint (`TaskChangeRouter.applyChange`)

Every write to the 3-table entity model (`ideas` / `epics` / `tasks`) MUST route through
`TaskChangeRouter.applyChange` (`main/src/orchestrator/taskChangeRouter.ts`). Nothing — not a
tRPC handler, not the orchestrator lifecycle, not an MCP agent tool — UPDATEs those tables
directly. Each `applyChange`:

1. Serializes on a per-PROJECT `p-queue({concurrency: 1})` (entity refs + `version` bumps are
   project-scoped — mirror `approvalRouter.ts`'s per-run queue keyed per project instead).
2. In ONE transaction: mutates the correct entity table AND appends a per-field delta row to
   `entity_events`, minting the per-`(entity_type, entity_id)` UNIQUE `seq` **inside** that same
   transaction (never pre-read the max and write outside — the read/write must be atomic).
   `entity_events` is polymorphic across `(entity_type, entity_id)` — it replaced the earlier
   task-scoped `task_events` table, dropped in the same migration 015 rebuild.
3. Emits a `TaskChangedEvent` on `taskChangeEvents` AFTER commit.

It is **entity-aware**: table identity is the type discriminator (no `type` column). The change
carries an `entityType`; boundary callers (tRPC / MCP) SHOULD pass it, but on the update path it
is optional and resolved by id lookup across the three tables. Lineage edits (`parent_epic_id`
task→epic, `originating_idea_id` epic/task→idea) are FK-enforced AND validated + cycle-checked
in the router. The single `ENTITY_TABLES` descriptor map is the ONLY place that knows table
identity, id prefix, and which lineage/`scope`/`entry_stage_id`/`decomposed_at`/`approved_at`
columns each table carries — add a new per-type column there, not via scattered
`if (type === 'idea')` branches.

**Off-board buckets (migration 042).** Decomposing an idea stamps `ideas.decomposed_at` (the idea
leaves the 5-stage board, reachable only via children) with NO cascade — retirement is
exclusively gate-driven (the approve-plan gate retires the planner's root idea). The CREATE seam
is the visibility gate: a plan-gated run's epics/tasks are created PENDING
(`approved_at IS NULL` = backend-invisible + sprint-ineligible) and stay so until the approve-plan
gate stamps `workflow_runs.plan_approved_at` and REVEALS them; every non-plan-gated create is
visible immediately. The REVEAL routes through the chokepoint per entity (the orchestrator-only
`approved` toggle on `TaskChange` — mirrors `decomposed`) so each flip mints an entity_event +
version bump + `TaskChangedEvent`; a mounted board sees the drafts appear on approval. Draft
DELETION is reject-only at the gate (`isRejectAnswer` — a Revise / cap-trim / free-text answer
keeps the drafts for in-place adjustment) and triple-gated on teardown
(`deleteRunCreatedEntities`: run plan-gated + `plan_approved_at IS NULL` + per-entity
`approved_at IS NULL` — a compound/quick/custom run's visible creates are NEVER swept).
`SprintLaneStore.createForRun` re-applies the `approved_at IS NOT NULL` eligibility filter as the
single sprint-materialization chokepoint (drop-with-log for the agent path; the user-facing
`runs.start` pre-check is STRICT and rejects a mixed selection by naming the ineligible ids).

**Emit-path stamp parity.** `buildBacklogTaskItem` (the chokepoint's broadcast projection) MUST
carry `decomposed_at` + `approved_at` explicitly — the frontend selectors compare `!== null`, so
an omitted (undefined) stamp silently flips board visibility on live events. Both fields are
REQUIRED on `BacklogTaskItem` so an omitting constructor fails the build (silent-drop class).

- **Canonical example:** `main/src/orchestrator/taskChangeRouter.ts`;
  `main/src/orchestrator/__tests__/taskChangeRouter.test.ts`.

### Derived-stage recompute follow-ons (`recomputeTaskExecutionStage` + `recomputeEpicStage`)

Stages 7/8 (In-development / Ready-to-merge) collapsed away in migration 042; migration 066
later re-introduced ONLY position 7 ('In development') as a derived execution stage — position 8
('Ready-to-merge') stayed collapsed. The board's one derived stage plus the epic rollup are
computed by recompute follow-ons that re-enter the chokepoint as `actor='orchestrator'` UPDATEs
(never raw table writes). BOTH are idempotent (a target equal to the current stage is a no-op)
and best-effort at the follow-on seam:

- **`recomputeTaskExecutionStage(taskId)`** — the AGGREGATE over a task's runs (supports
  parallel runs, both direct `workflow_runs.task_id` and sprint-batch lane runs). Four arms,
  first match wins: (1) any run merged (or batch lane integrated) → Done (9); (2) any run not
  yet terminal → In development (7); (3) runs exist but neither of the above → revert to
  `entry_stage_id` (fallback Ready for development, 6); (4) no runs → no-op. A terminal-stage
  guard on arms 2/3 never moves a task currently at Done or Won't-do. Driven from the
  run-lifecycle follow-on seams (`runExecutor`, `runLauncher`, the `runs.*` tRPC router, and the
  `git.ts` merge close-out, which mirrors the `outcome='merged'` arm inline for sprint lanes).
- **`recomputeEpicStage(epicId)`** — the ROLLUP over an epic's COUNTABLE child tasks (epics
  carry no runs). A child counts only when non-archived, not parked at Won't-do (position 10 —
  an explicit retirement neither blocks Done nor demotes), and not a PENDING draft
  (`approved_at IS NULL` is board-invisible and must not move a visible epic). `all countable
  children at Done (9) → Done (9)`; `any countable child not yet Done → Ready for development
  (6)`; `no countable children → no-op`. NEVER rewrites an epic the human parked at Won't-do.
  Wired as a POST-COMMIT follow-on INSIDE `applyChange` (child create, stage-move, archive
  toggle, approved reveal) AND after `applyDelete` settles (recompute deferred OUTSIDE the
  per-project queue task — re-entering the queue from inside `runDelete` would deadlock). The
  rollup write is an EPIC UPDATE (never a task create/stage-move), so it cannot recurse back
  through the same hooks.

- **Canonical example:** `main/src/orchestrator/taskChangeRouter.ts`
  (`recomputeTaskExecutionStage`, `recomputeEpicStage`, and the post-commit follow-on block in
  `applyChange`).

### review_items write pattern (`ReviewItemRouter.applyReviewItem`)

Normal `review_items` writes route through `ReviewItemRouter.applyReviewItem`
(`main/src/orchestrator/reviewItemRouter.ts`) — the second single-table chokepoint, structurally
a twin of `TaskChangeRouter` (per-project queue, atomic mutate + `entity_events` delta with
`entity_type='review_item'`, post-commit `ReviewItemChangedEvent`). The sanctioned exception is
the folded run-pause co-write helpers in `reviewItemListing.ts`: approval/question/human-gate
paths write synchronously inside their own transaction so the legacy gate row and review item
commit or roll back together. Those helpers must still append the same `entity_events` deltas and
emit after commit via `emitReviewItemChangedById`. Rules:

- The entity link is a **SOFT polymorphic** `(entity_type, entity_id)` pair — both nullable,
  `entity_type` is CHECK-constrained to `(idea|epic|task)`, and the pairing is validated in the
  router (NO per-type FK split, NO hard FK on `entity_id` — the referenced row may be deleted and
  the review item survives for the audit trail). Do NOT add a hard FK or split this into
  per-type columns.
- `blocking` is per-item. A run stays `awaiting_review` until ALL its blocking `review_items`
  resolve (aggregate-unblock). Findings are non-blocking; permissions/decisions default blocking.
- `promote-to-task` is NOT a router op — it is a TWO-chokepoint triage operation (resolve the
  item via `ReviewItemRouter` AND mint a real task via `TaskChangeRouter`), orchestrated in the
  `reviewItems` tRPC router so each router stays single-table. Do NOT collapse the two chokepoints.

- **Canonical example:** `main/src/orchestrator/reviewItemRouter.ts`;
  `main/src/orchestrator/trpc/routers/reviewItems.ts` (the two-chokepoint `promoteToTask`).

### Run-scoped artifact write chokepoint (`ArtifactRouter.apply`)

Every write to the run-scoped `artifacts` table (migration 035) routes through `ArtifactRouter.apply`
(`main/src/orchestrator/artifactRouter.ts`) — the third single-table chokepoint, structurally a
twin of `TaskChangeRouter`/`ReviewItemRouter`: a per-project `PQueue({concurrency: 1})`
serializes writes, and each op atomically mutates `artifacts`, appends an `entity_events` delta
under `entity_type='artifact'`, and emits an `ArtifactChangedEvent` after commit. `apply`
dispatches on `op` (`create` | `update` | `commit`); `create` UPSERTs by `(runId, atype)` so
re-deriving a templated artifact (auto-mint) is idempotent — one artifact per `(run_id, atype)`
in v1. Two further ops ride the same per-project queue outside `apply` proper: `acceptAsBaseline`
(the Accept-as-baseline git action, delegating the fs-copy + commit to an injected
`BaselineAcceptor` so the router itself imports no `fs`/git — standalone-typecheck invariant) and
`mergeScreenshots` (an atomic read-merge-UPSERT for concurrent screenshot deliveries). The tRPC
sub-router, the `cyboflow_report_artifact` MCP tool family, and the orchestrator's auto-mint path
are the only callers.

- **Canonical example:** `main/src/orchestrator/artifactRouter.ts`.

### `idea_components` write chokepoint (`IdeaComponentRouter.applyChange`)

Every write to the `idea_components` ledger (migration 101 — each idea's idea-spec / prototype /
architecture / epics / stories progress) routes through `IdeaComponentRouter.applyChange`
(`main/src/orchestrator/ideaComponents/ideaComponentRouter.ts`) — the fourth single-table
chokepoint, a miniature of `ReviewItemRouter`'s per-project `PQueue` + emit-after-commit
architecture, scaled down for a table with no `entity_events` audit trail of its own. The merged
read model (`resolveIdeaComponents`) is recomputed AFTER each commit and broadcast via
`ideaComponentChangeEvents`, so a subscriber never sees a raw row or a partial component list. A
ledger row, once written, is authoritative over derivation — `state='skipped'` is NEVER derived,
only ever set explicitly via `setComponentState`. `TaskChangeRouter.applyChange` calls
`IdeaComponentRouter.getInstance().applyChange(...)` directly as a POST-COMMIT follow-on
(staleness stamping on idea edits) — the one chokepoint here that re-enters another from inside
its own post-commit block.

- **Canonical example:** `main/src/orchestrator/ideaComponents/ideaComponentRouter.ts`.

### In-repo workflow prompt bodies (self-containment)

Six built-in flows — `planner` / `sprint` / `compound` / `ship` / `verify-setup` / `launch` —
and their prompt BODIES live in app source at `main/src/orchestrator/workflows/` (one `.md` per
flow name, plus `design.md` and `idea-session.md` for the non-flow design-mode / idea-session
spawns, and `builtInWorkflows.ts`). Five are user-facing; `verify-setup` configures a project
(the visual-verification runbook) rather than doing project work, and launches from its own
surface (the Verify Queue's health panel) instead of the general flow picker. There is NO
runtime read from `~/.claude/plugins/cache/soloflow/...`.
Rules when touching workflows:

- The flow-name set is `CYBOFLOW_WORKFLOW_NAMES`, its type `CyboflowWorkflowName`, and the type
  guard `isCyboflowWorkflowName` — all exported from `shared/types/workflows.ts` (grep there for
  the current tuple rather than trusting a copy here; it is an app-wide exhaustive discriminant
  and has grown before). `buildBuiltInWorkflows()` maps over the name array, so adding/removing a
  flow there is a compile-time tripwire on the descriptor map and on `WORKFLOW_DEFINITIONS`
  (`Readonly<Record<CyboflowWorkflowName, …>>`). `launch` must stay LAST in the tuple (its
  bundled agents dedupe first-wins against the planner/sprint agents it borrows from). Use the
  `Cyboflow*` names — NOT the historical `SoloFlow*` misnomers (removed: `SoloFlowWorkflowName` /
  `SOLOFLOW_WORKFLOW_NAMES` / `isSoloFlowWorkflowName` / `resolveSoloFlowPluginRoot` /
  `buildDefaultSoloFlowWorkflows`). `compound` was rebuilt natively from its preserved
  prose and `ship` was built natively from scratch.
- `workflow_path` resolves relative to the compiled bundle (`join(__dirname, '<name>.md')`).
  Any new prompt `.md` MUST be copied to `dist/...` by `copy:assets` (in `main/package.json`) —
  the glob already covers `src/orchestrator/workflows/*.md` and `src/database/migrations/*.sql`;
  extend it before adding a prompt/migration under a new directory.
- Prompt bodies are SELF-CONTAINED: agents write the DB via `cyboflow_*` MCP tools, never
  `.soloflow/IDEA-NNN.md` / `TASK-NNN.md` files. `builtInWorkflows.test.ts` asserts the bodies
  contain no `.soloflow` / `IDEA-NNN.md` / `TASK-NNN.md` reference — keep that green.
- Dropped flow prose for `prune` is preserved under `docs/workflows-future/` for a future
  cyboflow-native rebuild — do NOT re-add it to `WORKFLOW_DEFINITIONS`.

- **Canonical example:** `main/src/orchestrator/workflows/builtInWorkflows.ts`;
  `main/src/orchestrator/workflows/__tests__/builtInWorkflows.test.ts`.

### Database access

`main/src/database/database.ts` (`DatabaseService`) is the singleton owning schema DDL, the
migrations runner, and `seedDefaultBoard`. `main/src/services/database.ts` is a thin bootstrap
shim (~10 lines) that constructs that `DatabaseService` instance from the boot path and calls
`.initialize()` — nothing else lives there. All mutations go through the main process — the
renderer never accesses SQLite directly. SQL is hand-written (no ORM); use parameterized
queries. Migrations are plain `.sql` files in `main/src/database/migrations/`, named to sort
in application order.

ENTITY writes are the exception that proves the rule: they do not go through ad-hoc
`DatabaseService` methods but through the write chokepoints above. `DatabaseService` still owns
`seedDefaultBoard(projectId)`, which MUST stay field-for-field in sync with the post-066
5-stage board seed (cross-check test pins this).

### Schema reconciliation

When modifying DDL for a table, run TWO greps and cover every match (or note why a
match is intentionally excluded):

1. Inline-DDL consumers: `grep -rn 'CREATE TABLE.*<table>' main/src/ frontend/src/`
2. Migration-file loaders: `grep -rn 'readFileSync.*<NNN>\|join.*migrations.*<NNN>' main/src/`

Verify the column block with full `diff`, never `grep -A N` (the count is fragile and
silently truncates). `schema.sql` (fresh install) and the highest-numbered migration
(upgrade path) must be bidirectionally equivalent — every migration `CREATE TABLE IF NOT
EXISTS` must be a no-op after `schema.sql` runs. When adding a column to a shipped
migration, also search every test file's INSERT/SELECT for the old column list — missing
columns surface as runtime `undefined`, not typecheck errors.

### SQLite migrations: idempotence is per STATEMENT, and a real error stops the boot

`runFileBasedMigrations()` splits each `.sql` file into statements
(`splitSqlStatements.ts` — literal- and comment-aware, so a semicolon in a header
comment or a string does not cut a statement in half) and runs them one at a time
inside ONE transaction, stamping the ledger inside that same transaction.

Exactly two failures are tolerated, and only on the statement that raised them —
`ALTER TABLE … ADD COLUMN` → `duplicate column name:`, and
`CREATE TABLE|INDEX|VIEW|TRIGGER` → `… already exists`. That statement is skipped
and the REST OF THE FILE still runs. Everything else rolls the file back, stamps
nothing, and throws `MigrationFailedError` out of `initialize()`; `index.ts` turns
that into a blocking dialog and quits. Booting on a half-migrated schema surfaces
later as scattered `no such column` errors that trace back to nothing.

This runner used to be file-level: it caught `duplicate column name` around the
whole `.exec(file)` and stamped the ledger from the catch — but the transaction
had ALREADY rolled back, so every other statement in that file was discarded
while the ledger claimed success. Any migration header still describing that
"rolls back and ledger-marks the WHOLE file" behaviour is describing the bug.

**Consequence for migration authors:** every statement must be safe to re-run,
because the ledger tracks by FILENAME and renumbering a file re-applies it, as
does a ledger-wiped replay. Prefer
`CREATE … IF NOT EXISTS` and `WHERE col IS NULL`-style guarded backfills. An
unconditional backfill needs an explicit gate on whether the columns it fills
are actually new — `094_tracker_direction_modes.sql` shows the pattern: probe
`pragma_table_info` into a TEMP table BEFORE the `ALTER`s, then gate the `UPDATE`
on it. Never rely on an early abort to protect the statements below it.

**Numbering:** a new migration takes the next FREE three-digit prefix — after a
rebase, re-check, because main may have taken your number. Duplicate prefixes
are blocked by `migrationPrefixes.test.ts` (five legacy prefixes, 059–063, are
frozen exemptions); the runner tie-breaks same-prefix files by name so the
legacy pairs order deterministically.

### SQLite migrations: `PRAGMA foreign_keys` must toggle OUTSIDE `db.transaction()`

SQLite silently no-ops `PRAGMA foreign_keys` issued inside a transaction
(https://sqlite.org/pragma.html#pragma_foreign_keys). When a migration needs to
disable FK enforcement to DROP+RENAME a table that has FK children, the pragma
toggle MUST be outside the `db.transaction(...)` wrapper, and the restore MUST
run in a `finally`:

```typescript
// CORRECT — pragma outside the transaction:
db.pragma('foreign_keys = OFF');
try {
  db.transaction(() => {
    db.exec('DROP TABLE workflow_runs');
    db.exec('ALTER TABLE workflow_runs_new RENAME TO workflow_runs');
  })();
} finally {
  db.pragma('foreign_keys = ON');
}

// WRONG — pragma inside the transaction is silently ignored; DROP TABLE then
// CASCADE-deletes every row in every FK child table:
db.transaction(() => {
  db.exec('PRAGMA foreign_keys=OFF; DROP TABLE workflow_runs');
})();
```

Canonical implementation: `main/src/database/database.ts` `runFileBasedMigrations`
(detects `PRAGMA foreign_keys=OFF` in the migration text and hoists the toggle
above its own `this.transaction()` wrapper). Regression test:
`main/src/database/__tests__/fileMigrationRunner.test.ts` `'FK-toggle path: …'`.

### Extract-shared-utility refactors: prove completeness

Any change that extracts a shared fixture, helper, type, or constant MUST grep the
PRE-refactor pattern across the entire codebase (`main/src/ frontend/src/`) — not just
the files already in view. Migrate every match that is a direct substitute for the new
utility; give each intentional exclusion (different shape, deferred work, manual
lifecycle) a one-sentence note in the change description. Covering some but not all
matches leaves the codebase half-migrated — the recurring root cause behind inline-copy
regressions (DDL, `dbAdapter`, `mkdtempSync` cleanups have all shipped incomplete this way).

### `@cyboflow-hidden` annotation

Mark intentionally-unreachable code at the top of the file (whole-component case) or
immediately above the first function of the disconnected group (partial-file case).
Always include a one-sentence re-enable hint pointing at the call site (or upstream
caller / epic for forward-looking placeholders) to restore.

Two valid categories:
1. **Crystal-preserved** — code kept from the `stravu/crystal` baseline, disabled in v1.
2. **Forward-looking placeholder** — fresh cyboflow code unwired until a later
   integration change lands.

```
// @cyboflow-hidden: <what is unreachable> in cyboflow v1.
// Re-enable by <restoring specific call site or JSX usage>.
```

- **Canonical example (whole-file case):** `main/src/services/visualVerify/baselineStore.ts`
  (the golden-baseline feature, retired entirely — not merely behind a kill switch)
- **Canonical example (forward-looking placeholder):**
  `main/src/services/panels/claude/claudeCodeManager.ts` — `tryTransitionToAwaitingReview`
  (an ApprovalRouter integration point)
- **Audit tool:** `grep -rn '@cyboflow-hidden' main/src frontend/src` lists all
  inactive surfaces (both categories).

### IPC preference-backed component visibility

When a component's visibility depends on an async IPC preference (`preferences:get`),
track the read result as `boolean | null` in the parent and render nothing while it is
`null`. Do NOT initialise the child's own state to "hidden by default" and rely on an
async effect to flip it — that produces the correct steady state but a one-frame flash
on every page reload for returning users. Canonical example: the first-run onboarding
tour's `OnboardingGate` (`frontend/src/components/onboarding/`) reads the persisted
snapshot under `ONBOARDING_PREF_KEY` (`frontend/src/utils/onboarding.ts`) via
`preferences:get`/`preferences:set` and only calls `useOnboardingStore.hydrate` once
that read resolves — the store's `hydrated` flag is the no-flash gate consumers (e.g.
Sidebar's "Resume setup" button) key off of, instead of a naive default-hidden boolean.
The SAME `hydrated` flag also gates the app shell itself: `App.tsx` keeps Sidebar,
the center surface, AgentRail, and StatusBar unmounted for `isOnboardingShellHidden`
(`frontend/src/utils/onboarding.ts`) — `!hydrated || status === 'active'` — so a
pristine boot never flashes the shell before the same snapshot read resolves, and the
tour (modal steps or the guided full-window screens) owns the whole window while
active. Other consumers: `DiscordPopup`, `AnalyticsConsentDialog` (audit via
`grep -rln 'preferences:get' frontend/src`).

### Telemetry: scrub chokepoint + environment gating

All outbound telemetry is anonymized and gated in `main/src/services/telemetry/`:

- **Errors never carry user content.** Every Sentry event/breadcrumb passes through `scrub.ts`
  (`scrubSentryEvent` / `scrubBreadcrumb`) — the single chokepoint that basenames paths, redacts
  home dirs, drops `extra`/`user`/`server_name`, and drops console breadcrumbs. Do NOT add Sentry
  capture that bypasses `Sentry.init`'s `beforeSend` / `beforeBreadcrumb`.
- **Usage events are a closed union.** Renderer code calls `trackEvent(event, props)`
  (`frontend/src/utils/telemetry.ts`) where `TelemetryEvent` is a fixed union and `props` are
  scalar/enum only — never repo names, prompts, file paths, or free text. New events extend the
  union. Routed over the `telemetry:track` fire-and-forget IPC channel → `trackUsage`.
- **Environment gating** (`environment.ts`): every packaged build is stamped by
  `inject-build-info.js` — `CYBOFLOW_BUILD_ENV` (`stable`/`dev`/`local`) wins when set, otherwise
  the build variant (`build:mac*` → `stable`, `build:mac:dev*` → `dev`) — so hand-built tester
  `.dmg`s report a filterable environment. `local` = pnpm dev, an explicit local stamp, or a
  pre-fix artifact. Keep the telemetry `environment` token distinct from the updater/About
  `variant` token.
- **Telemetry must NEVER throw into app code** — every entry point is try/caught and is a no-op
  when the SDK or its credential is absent. Creds resolve from the runtime env var
  (`SENTRY_DSN` / `APTABASE_APP_KEY`, for `pnpm dev`) OR, when absent, from the keys baked into
  `buildInfo.json` at build time — a DISTRIBUTED packaged app has none of the build shell's env
  vars at runtime, so without the baked fallback both SDKs silently no-op (the "zero usage from
  installed apps" class of bug).
- **Canonical example:** `main/src/services/telemetry/{index,scrub,environment}.ts`.

## Build & Packaging

### macOS signing posture (`scripts/configure-build.js`)

`scripts/configure-build.js` runs as a `prebuild:mac*` / `prerelease:mac` step and is the
**single canonical writer** of `build.mac.notarize`, `hardenedRuntime`, and `gatekeeperAssess`.
Do not edit these keys directly in `package.json` — `configure-build.js` overwrites them on
every build. Decision is driven by env vars (`CSC_LINK`, `APPLE_ID`, `APPLE_TEAM_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `CSC_KEY_PASSWORD`, `CSC_DISABLE`).

- **Canonical example:** `scripts/configure-build.js`, `scripts/configure-build.test.js`
- **Env-var contract:** see `docs/signing/APPLE_DEVELOPER_SETUP.md`.

## Frontend Test Conventions

### `afterEach(cleanup)` is mandatory in vitest setup

`frontend/src/test/setup.ts` explicitly registers `afterEach(() => cleanup())`. The
vitest `globals: true` + `@testing-library/react@^16` combo does NOT auto-register
cleanup — without it, `renderHook` calls that attach `window`/`document` listeners
accumulate across tests (test N fires N handlers per key press). Do NOT remove that
line. Hooks with global listeners should include a multi-render regression test —
see `frontend/src/hooks/__tests__/useReviewQueueKeyboard.test.ts`.

### Mock tRPC at the canonical import path

`vi.mock(...)` must target the canonical client (e.g. `'../../trpc/client'`). The global
setup in `frontend/src/test/setup.ts` pre-stubs it; individual specs override with
their own `vi.mock('../…/trpc/client', …)` calls when they need specific behaviour.
Canonical example: `frontend/src/stores/__tests__/reviewQueueStore.test.ts:27`.

### `pnpm test:e2e` MUST keep its sh-wrapper

`package.json`'s `"test:e2e"` script is:

```json
"test:e2e": "sh -c 'while [ \"$1\" = \"--\" ]; do shift; done; playwright test \"$@\"' --"
```

Do NOT simplify to `"test:e2e": "playwright test"`. pnpm injects a literal
`--` separator between the script body and the user's args (so
`pnpm test:e2e -- tests/smoke.spec.ts --list` becomes
`playwright test -- tests/smoke.spec.ts --list`). After `--`, Playwright
treats every remaining argument as a file glob — `--list` becomes a bogus
glob, the runner executes the matching tests, and the verifier's "list
without executing" assertion fails. The wrapper strips leading `--`
separators so Playwright's flag parser sees them as flags.

Same idiom should be used for any future `pnpm` script that wraps a CLI
with its own flag parser (e.g. `vitest`, `cypress`).

### vitest config must wire `setupFiles` and `globals: true`

Both workspace `vitest.config.ts` files set `globals: true` + `setupFiles:
['./src/test/setup.ts']`. Do not flip to `globals: false` — `frontend/src/test/setup.ts`
calls `expect.extend(...)` from `@testing-library/jest-dom` at module load, which throws
`ReferenceError: expect is not defined` under `globals: false` and breaks every spec in
the workspace. When adding a new `vitest.config.ts` in either workspace, mirror the
existing files; before planning a test-wiring task, grep both `@testing-library/jest-dom`
and `test/setup.ts` — do not rely on a `.test.*` glob.

### Workspace `test` scripts must stay one-shot (`vitest run`, never bare `vitest`)

Any workspace `"test"` script that participates in a root multi-tier chain (e.g. `pnpm run
test:unit`, which chains `pnpm --filter main test && pnpm --filter frontend test && …`) MUST
invoke `vitest run`, never bare `vitest`. Bare `vitest` defaults to watch mode in a TTY and
hangs the chain locally — CI only escapes this because its stdout is not a TTY. Put watch mode
on a separate `"test:watch"` key instead of overloading `"test"`.

- **Canonical example:** `main/package.json` and `frontend/package.json`, both
  `"test": "vitest run"`.

## Database Schema

### Canonical DDL Source

The cyboflow-era run-substrate tables (`workflow_runs`, `workflows`, `approvals`, `raw_events`,
`messages`) live in TWO files that MUST stay in sync:

- `main/src/database/schema.sql` — fresh-install fast path. Run once on a new DB.
- `main/src/database/migrations/006_cyboflow_schema.sql` — upgrade path. Applied via `runFileBasedMigrations()` for existing DBs.

**canonical DDL source for those tables: migration 006.** Treat it as the authoritative
declaration; mirror any column add/drop into `schema.sql` in the same commit. Migrations from 007
onward extend the schema additively (the entity model rebuild in 015 being the one destructive,
forward-only, no-prod-data exception) — the migrations directory
(`main/src/database/migrations/`) is the source of truth for how far that goes.

**The 3-table entity model + the review inbox have their own row-shape source of truth.** Each
of `ideas` / `epics` / `tasks` carries its own typed columns plus a single shared markdown
`body` column — the sole long-form markdown field on the row (`title` and `summary` are short
text columns) — introduced by the 015 entity-model
rebuild migration. `ideas` / `epics` / `tasks` / `entity_events` (migration 015) and `review_items` (migration 016)
are pinned field-for-field against the TypeScript row interfaces in `main/src/database/models.ts`
(`IdeaRow` / `EpicRow` / `TaskRow` / `EntityEventRow` / `ReviewItemRow`) and the shared types in
`shared/types/tasks.ts` + `shared/types/reviews.ts` by
`main/src/database/__tests__/entitySchemaParity.test.ts`. When you add or change a column on any
of these tables, update the migration, `schema.sql`, the `*Row` interface, and the shared type in
the same commit — `entitySchemaParity` is the tripwire.

**The 5-stage board seed is dual-sourced.** Migration `042_collapse_board` narrowed the board to
FOUR `asserted` stages (1 Idea / 6 Ready for development / 9 Done / 10 Won't do, hidden) at their
original positions; migration `066_in_development_stage` later re-introduced position 7 ('In
development') as a fifth, `derived` stage — position 8 ('Ready-to-merge') stayed collapsed and
was never brought back. `database.ts` (`main/src/database/database.ts`) `seedDefaultBoard` seeds
the same five for NEW projects. Both MUST be field-for-field identical; the cross-check test
asserts `seedDefaultBoard` === the migrated 5-stage seed. The derived execution/rollup stages are
computed by the `recomputeTaskExecutionStage` / `recomputeEpicStage` follow-ons (see the
chokepoint pattern above). The off-board buckets (`ideas.decomposed_at`, `epics`+
`tasks.approved_at`, `workflow_runs.plan_approved_at`) carry the dropped intermediate stages as
nullable stamps.

A CI guard (`pnpm run verify:schema`, wired into `pnpm run test:unit`) opens an in-memory SQLite,
applies the schema.sql + migrations path side-by-side with the migrations-only path, and asserts
the resulting column sets and FKs match. The script lives at `scripts/verify-schema-parity.js`;
it does NOT compare test fixtures like `registrySchema.ts` — those are documented subsets and any
drift is caught by the test suites that import them.

## permissionMode contract

**Source of truth:** `shared/types/permissionMode.ts` exports both the type alias and the default constant — the LEGACY 2-mode contract for quick/legacy sessions:

```typescript
export type PermissionMode = 'approve' | 'ignore';
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'approve';
```

This is DISTINCT from the newer 4-mode contract governing workflow runs and the current Settings
UI — `'default' | 'acceptEdits' | 'auto' | 'dontAsk'`, ALSO named `PermissionMode` but exported
from `shared/types/workflows.ts`. `interactiveSettingsWriter.ts` treats `'ignore'`/`'dontAsk'` as
parallel opt-outs; do not collapse the two types or import one where the other is meant.

**Rules — grep-enforced:**

1. **No UI surface may expose `'ignore'` as selectable.** The `BaseCliPanel.tsx` Permission Mode
   dropdown must offer only `value="approve"`. (Settings.tsx no longer has a 2-mode picker at
   all — it now exposes the separate 4-mode `defaultAgentPermissionMode` picker,
   `SessionSettings.tsx`'s `PERMISSION_MODE_OPTIONS`, which has no `'ignore'` value to begin
   with.) Verification: `grep -rnE 'value="ignore"' frontend/src/ tests/` must return 0 matches.

2. **No default or fallback may resolve to `'ignore'`.** Use `DEFAULT_PERMISSION_MODE` (imported from `shared/types/permissionMode`) wherever a missing value must be filled in. Verification: `grep -rnE "\|\| 'ignore'" main/src/ frontend/src/ shared/` must return 0 matches.

3. **`'ignore'` remains a valid typed value.** Each CLI manager owns its own
   `resolveSessionAgentPermissionMode` method (`claudeCodeManager.ts`,
   `interactiveClaudeManager.ts`, `codexPtyManager.ts`, `ompPtyManager.ts`,
   `piPtyManager.ts`; `piSdkManager.ts` names its equivalent `resolveGateMode`) that reads it: the Claude pair short-circuits to
   `undefined` (preserving the legacy branch instead of resolving the 4-mode
   `agentPermissionMode`), the non-Claude managers fold it into the equivalent `'dontAsk'`. On
   the Claude interactive/PTY substrate specifically, `resolveInlineGatingHooks`
   (`interactiveSettingsWriter.ts`) also still branches on it directly — `'ignore'`, like the
   newer `'dontAsk'`/`'auto'`, omits the wildcard PreToolUse gating hook from the inline
   `--settings` fragment. Plus test fixtures. Do NOT remove `'ignore'` from the `PermissionMode`
   union or the DB CHECK constraint — legacy rows and these consumers depend on it.

4. **DB CHECK constraint is `IN ('approve', 'ignore')`** — both values are persisted. Migration 008 (`main/src/database/migrations/008_permission_mode_approve_default.sql`) backfills NULL rows to `'approve'` on legacy installs. The DEFAULT clause on new columns uses `'approve'`.

5. **Import discipline:** Import `DEFAULT_PERMISSION_MODE` and `PermissionMode` from `shared/types/permissionMode.ts`. Do NOT re-declare the type inline or hardcode the string `'approve'` as a standalone fallback literal (`|| 'approve'`). The constant import is the compile-time tripwire that catches regressions — a string literal is invisible to grep-gate sweeps once the surrounding context shifts. Verification: `grep -rnE "\|\| 'approve'" main/src/ frontend/src/ shared/ --include='*.ts' --include='*.tsx'` must return 0 matches in non-comment lines.

6. **The Claude SDK substrate installs its `PreToolUse` hook UNCONDITIONALLY.**
   `composeHookOptions` (`claudeCodeManager.ts` — the SDK-manager half of the dual-substrate
   seam) ALWAYS installs exactly one dynamic `PreToolUse` hook: no per-mode fork, no
   `'ignore'`/`dontAsk` early return. The hook live-reads the owning session's 4-mode
   `agentPermissionMode` (`shared/types/workflows.ts`) on every call, so a mode change takes
   effect on the very next tool call with no re-spawn. `'auto'` (when the model is capable) is
   the only mode where the hook itself defers to the native classifier — and even then
   `canUseTool` is installed unconditionally, so the classifier's terminal 'ask' verdict still
   becomes a blocking `ApprovalRouter` prompt. This replaced an earlier conditional-registration
   mechanism in the permission-mode redesign. `settingSources` in `buildSdkOptions` staying
   `['user', 'project']` — needed to pick up user-level MCP servers, custom instructions, and
   other per-user configuration from `~/.claude/settings.json` — is safe under this design for
   the same reason: nothing on the tool-call path skips the hook based on user-level settings.
   Do NOT revert `settingSources` to `['project']`-only without also removing the user-settings
   UX features that depend on it.
