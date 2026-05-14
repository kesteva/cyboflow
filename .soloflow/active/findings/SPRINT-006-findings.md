---
sprint: SPRINT-006
pending_count: 18
last_updated: "2026-05-14T16:24:31.773Z"
---
# Findings Queue

## FIND-SPRINT-006-12
- **source:** TASK-301 (code-reviewer)
- **type:** bug
- **severity:** low
- **status:** open
- **location:** package.json:102-108 (`build.asarUnpack`)
- **description:** The `asarUnpack` entries `main/dist/services/cyboflowPermissionBridge.js`, `main/dist/services/cyboflowPermissionBridgeStandalone.js`, and the wildcard `main/dist/services/**/*.js` all point at the path `main/dist/services/...`, but the TypeScript build emits to `main/dist/main/src/services/...` (verified by `find main/dist -name 'cyboflowPermissionBridge*'`). This means the asarUnpack rules currently match zero compiled files — the bridge scripts remain packed inside the asar. The pre-existing pre-rename paths (`main/dist/services/mcpPermissionBridge.js`) had the same defect, so TASK-301 only preserved the bug while renaming. Runtime impact is minimized because `claudeCodeManager.ts:698` detects an `.asar` path and extracts the script to a temp directory before exec — but that fallback is "wrong on purpose" cover for a misconfigured unpack list. If the asarUnpack path were correct, the slower extract-to-temp path would no longer be needed in normal operation.
- **suggested_action:** Change `main/dist/services/cyboflowPermissionBridge.js` → `main/dist/main/src/services/cyboflowPermissionBridge.js`, the standalone entry to `main/dist/main/src/services/cyboflowPermissionBridgeStandalone.js`, and the wildcard to `main/dist/main/src/services/**/*.js`. Validate that a packaged build still resolves `__dirname` to `app.asar.unpacked/main/dist/main/src/services/` for the bridge script before merging.
- **resolved_by:** 

## FIND-SPRINT-006-9
- **source:** TASK-255 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/index.ts:698
- **description:** When `mainWindow` is null at the orchestrator-wiring block, `attachOrchestratorTrpc` is silently skipped: `if (mainWindow) { attachOrchestratorTrpc(...) }`. This is a quiet failure mode — the orchestrator starts but the renderer's tRPC bridge is never installed, so every `trpc.*` call from the renderer will fail with the trpc-electron "Could not find `electronTRPC` global" error or similar. In practice, `createWindow()` is awaited immediately above this block so `mainWindow` should never be null here, but the guard hides a logically-impossible state without surfacing it. Either drop the guard (and assert with `mainWindow!` or `if (!mainWindow) throw ...`) or log a warning when the guard kicks in.
- **suggested_action:** Replace `if (mainWindow) { attachOrchestratorTrpc(...) }` with `if (!mainWindow) throw new Error('mainWindow is null after createWindow — cannot attach orchestrator tRPC'); attachOrchestratorTrpc(...)`. The throw fails loudly at startup rather than producing a half-wired app where the renderer's typed surface silently breaks.
- **resolved_by:** 

## FIND-SPRINT-006-6
- **source:** TASK-254 (code-reviewer)
- **type:** bug
- **severity:** medium
- **status:** resolved
- **location:** frontend/tsconfig.json (include) vs shared/types/trpc.ts
- **description:** TASK-254's AC #9 says the AppRouter is re-exported from `shared/types/trpc.ts` "so the frontend can import it without crossing the main/ boundary directly." However, `frontend/tsconfig.json` currently sets `"include": ["src"]` — it does NOT include `../shared`, while `main/tsconfig.json` does (`"include": ["src/**/*", "../shared/**/*"]`). When the next task in this epic wires the renderer-side tRPC client and tries `import type { AppRouter } from 'shared/types/trpc'` (or whatever the alias resolves to), tsc will not find the file under the frontend project. The re-export file itself compiles fine under main's tsconfig (which is why standalone-typecheck passes), but the consumer side will fail.
- **suggested_action:** In the renderer-wiring follow-up (TASK-255 or equivalent), either (a) add `"../shared/**/*"` to `frontend/tsconfig.json` `include`, (b) add a path alias and `references`, or (c) build shared as its own project with `composite: true` and reference it from both `main` and `frontend`. Option (c) is cleanest if shared starts to grow.
- **resolved_by:** TASK-255

## FIND-SPRINT-006-3
- **source:** TASK-253 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/__tests__/Orchestrator.test.ts:132-136
- **description:** In the "stop drains the run queue registry" test, the task body writes `taskFinished = false; taskFinished = true;` — the first assignment is dead because the outer-scope `let taskFinished = false;` already provides that initial value. The inline `// initially false` comment is misleading, since the read at line 142 happens BEFORE the task runs (the gate is still locked), not while the task is mid-execution. The test passes, but the intent of the dead write is unclear and a future reader may "fix" it incorrectly.
- **suggested_action:** Drop the `taskFinished = false; // initially false` line so the task body is just `taskFinished = true;`. The outer initialization already guarantees the pre-state.
- **resolved_by:** 

## FIND-SPRINT-006-2
- **source:** TASK-253 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/Orchestrator.ts:72-75
- **description:** `Orchestrator.ts` re-exports `RunQueueRegistry`, `EventEmitter`, and the `OrchestratorDeps` type at the bottom of the file as a "caller convenience." No call sites currently consume these re-exports (verified by grep across `main/src/` — there are no imports from `'./orchestrator/Orchestrator'` other than direct class imports in tests). The convenience is speculative and adds two extra public surface symbols (`EventEmitter`, `RunQueueRegistry`) that callers can already import from their canonical locations. If a caller wires `OrchestratorDeps` from a single import, that's the only re-export that earns its keep.
- **suggested_action:** When TASK-254/255 wires the orchestrator from `main/src/index.ts`, either delete the unused `EventEmitter` / `RunQueueRegistry` re-exports or confirm them by use. The `OrchestratorDeps` re-export is fine — it lives next to its consumer.
- **resolved_by:** 

## FIND-SPRINT-006-1
- **source:** TASK-251 (code-reviewer)
- **type:** bug
- **severity:** low
- **status:** open
- **location:** package.json:54-70 (root `dependencies`) vs main/package.json:18-35
- **description:** `electron-store@^11.0.0` is declared in `main/package.json` but not in the root `package.json`. The TASK-251 plan's own rationale (Implementation Step 3) states "The root list is what electron-builder reads when assembling `node_modules/**/*` into the asar; missing the root list means the packaged app will throw at first `require('trpc-electron')`". By that same rationale, packaged builds may also be missing `electron-store` at runtime in the main process. This pre-dates TASK-251 (not introduced by this commit) but was surfaced while reviewing the parity logic just added for trpc-electron/p-queue/superjson.
- **suggested_action:** Verify in a packaged build whether `require('electron-store')` resolves; if it does, document why (electron-builder's `npmRebuild`/`buildDependenciesFromSource` interaction may already pull workspace deps), and either remove the parity-claim from future task plans or add electron-store to root for consistency. If it doesn't resolve, add `"electron-store": "^11.0.0"` to root dependencies.
- **resolved_by:** 

## FIND-SPRINT-006-5
- **source:** TASK-254 (verifier)
- **type:** anti-pattern
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/trpc/routers/events.ts:48
- **description:** `makePlaceholderAsyncIterator<T>` is declared as `async function*` (an async generator) but its body never reaches a `yield` statement — it only `await`s the abort signal and returns. ESLint's `require-yield` rule rightly flags this and pnpm lint now reports `1 error` where the baseline (pre-TASK-254) had `0 errors, 228 warnings`. The generator is consumed via `for await (const ev of source) yield ev;` and via `throttleAsyncIterator(source, 60)`, so behaviourally it is a never-yielding iterable; the lint error is real and CI-failing. Two fixes are equivalent in semantics: (a) add a defensive `if (false) yield undefined as T;` to satisfy the rule, (b) add a `// eslint-disable-next-line require-yield` directive with a one-line rationale, or (c) replace the function with a hand-rolled object implementing `AsyncIterable<T>` (no async-generator syntax). Option (c) is cleanest because the function genuinely is not generator-shaped — it's a one-shot abort-await with a typed empty stream.
- **suggested_action:** Replace `async function* makePlaceholderAsyncIterator` with a plain async function returning an AsyncIterable: `function makePlaceholderAsyncIterator<T>(signal: AbortSignal): AsyncIterable<T> { return { async *[Symbol.asyncIterator]() { if (signal.aborted) return; await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true })); } }; }` — or apply the eslint-disable directive if you want to keep the current shape. Either way, `pnpm --filter main lint` must exit 0.
- **resolved_by:** 

## FIND-SPRINT-006-4
- **source:** TASK-254 (executor)
- **type:** bug
- **severity:** medium
- **status:** open
- **location:** main/node_modules/better-sqlite3
- **description:** better-sqlite3 native module compiled against NODE_MODULE_VERSION 136 but current Node.js requires 137. Affects 22 tests across transitions.test.ts, rawEventsSink.test.ts, fileMigrationRunner.test.ts, and cyboflowSchema.test.ts. Tests in those suites all fail with the same binding error. Unrelated to TASK-254 changes — pre-existing environment issue. Fix: run npm rebuild better-sqlite3 or pnpm rebuild --filter main.
- **suggested_action:** Run: cd main && pnpm rebuild better-sqlite3, or rebuild with the Electron version: electron-rebuild -f -w better-sqlite3
- **resolved_by:** 

## FIND-SPRINT-006-7
- **type:** scope_deviation
- **source:** TASK-255 (executor)
- **severity:** low
- **status:** resolved
- **location:** frontend/tsconfig.json
- **description:** required to meet AC: frontend tsconfig must include ../shared to resolve AppRouter type import — directly addresses FIND-SPRINT-006-6
- **resolved_by:** verifier — files_owned: plan explicitly owns frontend/tsconfig.json (line 13 of TASK-255-plan.md), this is not a scope deviation

## FIND-SPRINT-006-8
- **type:** scope_deviation
- **source:** TASK-255 (executor)
- **severity:** low
- **status:** resolved
- **location:** frontend/package.json
- **description:** required to meet AC: frontend must declare @trpc/client, trpc-electron, superjson as dependencies for trpcClient.ts to typecheck and bundle correctly
- **resolved_by:** verifier — files_owned: plan explicitly owns frontend/package.json (line 14 of TASK-255-plan.md), this is not a scope deviation

## FIND-SPRINT-006-10
- **type:** scope_deviation
- **source:** TASK-255 (executor)
- **severity:** low
- **status:** resolved
- **location:** main/src/database/database.ts
- **description:** required to meet AC: DatabaseService needs a public getDb() accessor so the inline DatabaseLike adapter in index.ts can forward prepare() and transaction() calls without a type-erasure cast. The as unknown as DatabaseLike cast in index.ts:687 was the code-review blocker for TASK-255.
- **resolved_by:** verifier — plan-prescribed: Implementation Step 3 explicitly anticipates "TASK-253's DatabaseLike shape may need a tiny adapter object; if so, define it inline rather than expanding the orchestrator's surface." The getDb() accessor is the minimum surface needed for that inline adapter to delegate without exposing the private better-sqlite3 handle as public. Also AC-prescribed: removing the as unknown as DatabaseLike cast was required to satisfy "structural typecheck without cast bypass" surfaced by code review.

## FIND-SPRINT-006-11
- **type:** scope_deviation
- **source:** TASK-301 (executor)
- **severity:** low
- **status:** resolved
- **location:** main/src/utils/crystalDirectory.ts
- **description:** required to meet AC: getCyboflowSubdirectory re-export needed in cyboflowPermissionIpcServer.ts; crystalDirectory.ts was files_readonly but the acceptance criterion explicitly requires getCyboflowSubdirectory. Filed claim and it was granted.
- **resolved_by:** verifier — plan-prescribed: Implementation Step 3 (line 72 of TASK-301-plan.md) explicitly says "add a thin re-export `export const getCyboflowSubdirectory = getCrystalSubdirectory;` at the bottom of `crystalDirectory.ts` ONLY IF the symbol does not already exist." The file also appears in `files_owned` (line 15) alongside `files_readonly` (line 17). The edit is exactly what the plan prescribed.

## FIND-SPRINT-006-13
- **type:** scope_deviation
- **source:** TASK-302 (executor)
- **severity:** low
- **status:** resolved
- **location:** main/src/services/cyboflowPermissionBridge.ts
- **description:** required to meet AC8: file imported type PermissionResponse from permissionManager.ts; replaced with equivalent ApprovalDecision from approvalRouter.ts so no production import path resolves to the deprecated permissionManager file. mcpPermissionServer.ts could not be claimed (owned by TASK-301) but that file is dead code (no callers) so the remaining grep match is not a production import path.
- **resolved_by:** verifier — files_owned: TASK-302-plan.md line 12 explicitly lists main/src/services/cyboflowPermissionBridge.ts in files_owned (the file is dual-listed in files_readonly at line 15 which is a plan inconsistency, but files_owned grants edit authority). Not a scope deviation.

## FIND-SPRINT-006-14
- **source:** SPRINT-006 (sprint-code-reviewer)
- **type:** bug
- **severity:** medium
- **status:** open
- **location:** main/src/index.ts:566-578 (initializeServices) vs main/src/index.ts:715 (ApprovalRouter.initialize)
- **description:** ApprovalRouter init runs AFTER CyboflowPermissionIpcServer.start() — race window where IPC server is listening but ApprovalRouter is uninitialized.
- **suggested_action:** Move ApprovalRouter.initialize() ahead of cyboflowPermissionIpcServer.start(), OR gate the IPC server.start() until after the orchestrator block runs. Cleanest: relocate the RunQueueRegistry / orchestrator / ApprovalRouter wiring into initializeServices() BEFORE the cyboflowPermissionIpcServer.start() call. The current ordering is salvageable only because no production bridge currently spawns until after the renderer is up; add a comment + assertion explaining the temporal contract or fix it.
- **resolved_by:** 











start-order in main/src/index.ts:
  1. app.whenReady → initializeServices() awaited (line 680)
     - inside initializeServices line 571: await cyboflowPermissionIpcServer.start() — socket is now live and accepting connections
  2. await createWindow() (line 682)
  3. orchestrator wiring block (lines 686-717)
     - line 715: ApprovalRouter.initialize(...) finally constructs the singleton

For the entire window between (1) and (3) the socket is listening. cyboflowPermissionIpcServer.ts:72 calls ApprovalRouter.getInstance() inside the client data handler; getInstance() throws on uninitialized singleton (approvalRouter.ts:129). If any bridge subprocess (or stale fd from a previous unclean shutdown) connects and writes a permission-request before step 3 completes, the client.write() inside the catch on line 81 fires with the synthesized deny but the underlying error is the singleton-not-initialized message rather than a real permission denial. Window in practice is short (createWindow + a few ms) and there is no spawner yet, but the contract — IPC server live ⇒ ApprovalRouter ready — is violated.

Suspected tasks: TASK-301, TASK-302

## FIND-SPRINT-006-15
- **source:** SPRINT-006 (sprint-code-reviewer)
- **type:** bug
- **severity:** high
- **status:** open
- **location:** main/src/services/cyboflowPermissionIpcServer.ts:49-94 and main/src/services/cyboflowPermissionBridge.ts:23-39
- **description:** Both sides of the permission unix-socket parse incoming bytes as a single JSON object per data event. Node net sockets do NOT preserve message framing — multiple writes can coalesce into one data event and a single write can be split. Server-side (cyboflowPermissionIpcServer.ts:51): `const message = JSON.parse(data.toString())`. Bridge-side (cyboflowPermissionBridge.ts:23): `const message = JSON.parse(data.toString())`. Both will throw on (a) two permission-request writes from the bridge arriving in one chunk, (b) a large input payload (large file paths, big Bash commands) split across chunks, (c) any other coalescing scenario.
- **suggested_action:** Add newline-delimited framing. On both sides, accumulate a buffer per socket and split on \n; only parse complete lines. Pattern already in main/build-cyboflow-permission-bridge.js:108 (SimpleMCPServer.processBuffer) — copy the buffer+split idiom to cyboflowPermissionBridge.ts (client) and cyboflowPermissionIpcServer.ts (server). Wrap every write with `JSON.stringify(msg) + \n`.
- **resolved_by:** 










Under the legacy PermissionManager path the failure mode was a single denied prompt — annoying but recoverable. With the new ApprovalRouter (TASK-302) a successful requestApproval opens a transaction that UPDATEs workflow_runs.status to awaiting_review; if the matching respond() never lands because the JSON parse of the response chunk fails on the bridge side, the run is wedged in awaiting_review with no socket reply, blocking Claude indefinitely. This is the same defect on both sides of the wire — it predates SPRINT-006 (the original Crystal mcpPermissionBridge.ts had it), but the impact escalated when the sprint replaced an in-memory state machine with persistent DB transactions.

Suspected tasks: TASK-301 (carried over the parsing during rename), TASK-302 (raised the impact by introducing DB transactions and run-state mutations behind the socket)

## FIND-SPRINT-006-16
- **source:** SPRINT-006 (sprint-code-reviewer)
- **type:** bug
- **severity:** medium
- **status:** open
- **location:** main/src/services/cyboflowPermissionIpcServer.ts:53-89
- **description:** No input validation on the incoming JSON message. cyboflowPermissionIpcServer.ts unpacks `const { requestId, sessionId, toolName, input } = message;` and feeds the raw values straight into ApprovalRouter.requestApproval(sessionId, toolName, input, socketReply). There are no checks that:
- **suggested_action:** Define a zod schema in cyboflowPermissionIpcServer.ts: `const PermissionRequest = z.object({ type: z.literal(permission-request), requestId: z.string().min(1), sessionId: z.string().min(1), toolName: z.string().min(1), input: z.record(z.string(), z.unknown()) });`. Parse with `.safeParse(message)`; on failure, write a deny response if requestId is recoverable, otherwise log and drop. Also constrain the input payload size (e.g. 1MB) before JSON.parse to mitigate DoS.
- **resolved_by:** 








  - sessionId is a non-empty string (typeof === string, .length > 0)
  - toolName is a non-empty string
  - input is a plain object (typeof === object && input !== null && !Array.isArray)
  - requestId exists (needed to build a coherent reply)
  - message.type is the only branch acted on (no allowlist of permitted types)

While the socket lives in ~/.cyboflow/sockets/cyboflow-permissions-<pid>.sock (per-user macOS desktop scope), the project zod is already declared as a dependency in main/package.json:32. A zod schema for the message envelope would have caught the missing-tool_use_id-mapping concern flagged in approvalRouter.ts:200 too. Untrusted bytes flow into JSON.stringify(input) → SQLite tool_input_json column.

Suspected tasks: TASK-301 (carried over the unchecked unpack), TASK-302 (made it materially worse by persisting unvalidated input into the approvals table)

## FIND-SPRINT-006-17
- **source:** SPRINT-006 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/services/permissionManager.ts and main/src/services/mcpPermissionServer.ts
- **description:** Two dead files remain in main/src/services/ after this sprint flipped the active permission path to ApprovalRouter:
- **suggested_action:** Delete main/src/services/permissionManager.ts and main/src/services/mcpPermissionServer.ts. Also delete the cyboflowPermissionBridge import of `type PermissionResponse` if there is any leftover; ApprovalDecision is now the canonical type. Run pnpm typecheck and pnpm --filter main test after deletion to confirm zero dead-import lint warnings remain.
- **resolved_by:** 








  1. permissionManager.ts — class `PermissionManager` (EventEmitter, singleton). Only readers are mcpPermissionServer.ts (also dead) and the now-removed PermissionManager import in claudeCodeManager.ts. No live importers across main/src or frontend/src.
  2. mcpPermissionServer.ts — class `MCPPermissionServer`. Zero importers (`grep -rn MCPPermissionServer\b` only finds the export itself). This file was even touched in TASK-301 to rename the internal server identifier crystal-permissions → cyboflow-permissions (line 18), making dead code look freshly maintained — exactly the cross-task smell sprint-code-review should catch.

Keeping these files masks the dependency removal. They still contribute to the lint surface (warnings counted in the verification report), still import legacy types, and any future grep for permission turns up two parallel implementations of the same concept.

Suspected tasks: TASK-301 (rebrand of the file), TASK-302 (replacement of PermissionManager with ApprovalRouter — should have deleted these)

## FIND-SPRINT-006-18
- **source:** SPRINT-006 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/types.ts:57-60 (OrchestratorDeps.eventBus) and main/src/index.ts:705
- **description:** OrchestratorDeps declares `eventBus: EventEmitter` (types.ts:59) and main/src/index.ts:705 instantiates a fresh `new EventEmitter()` for the orchestrator. But across the entire sprint, no code reads or writes this eventBus:
- **suggested_action:** Choose one: (a) Wire ApprovalRouter to emit approvalCreated on the shared eventBus AND wire the events router subscription to consume from it, completing the design intent. (b) Drop eventBus from OrchestratorDeps until a real consumer arrives, so future maintainers do not assume a wiring that does not exist. Option (a) is preferable because the stream-parser-to-main epic will need the same plumbing; document the contract in docs/ARCHITECTURE.md §Orchestrator.
- **resolved_by:** 






  - Orchestrator.ts only uses deps.logger and deps.runQueues; no this.deps.eventBus reference.
  - ApprovalRouter (TASK-302) extends EventEmitter itself and emits approvalCreated on the router instance — not on the shared eventBus.
  - The events sub-router (TASK-254) uses makePlaceholderAsyncIterator, which never touches the eventBus either.

Result: the eventBus dep is purely speculative API surface threaded through start/stop and the test harness but exercised by nothing. This is a cross-task pattern that only the sprint-level view catches: TASK-253 added the field, TASK-254 was expected to subscribe events via it, TASK-302 was expected to publish approvalCreated through it — neither happened.

Suspected tasks: TASK-253 (added the field), TASK-254 (should have wired the events router to it), TASK-302 (should have emitted approvalCreated on it)

## FIND-SPRINT-006-19
- **source:** SPRINT-006 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/services/cyboflowPermissionIpcServer.ts and main/src/orchestrator/approvalRouter.ts
- **description:** The sprint introduces three different identifier concepts that are conflated:
- **suggested_action:** Before TASK-303/304/305 lands the workflow-runs mapping, document the transitional identity in docs/ARCHITECTURE.md and add a one-line invariant note at cyboflowPermissionIpcServer.ts:58 and approvalRouter.ts:200 making the temporal contract explicit. When TASK-304 wires the real tool_use_id, gate the change with a schema migration that backfills/clears stale rows so the synthesized tool_use_id values from this sprint do not pollute production data.
- **resolved_by:** 





  1. The `sessionId` written by the bridge subprocess (cyboflowPermissionBridge.ts:18 — `process.argv[2]`, originally Crystals sessionId).
  2. The `runId` expected by ApprovalRouter.requestApproval (approvalRouter.ts:163 — workflow_runs.id).
  3. The `tool_use_id` that Claude attaches to its tool call.

cyboflowPermissionIpcServer.ts:54-58 has a TODO acknowledging the conflation and passes `sessionId` directly as the `runId`. approvalRouter.ts:200 comments “tool_use_id is NOT NULL in the schema; we use the approvalId as the canonical tool-use identifier until TASK-304” and uses the freshly-generated approvalId for BOTH the approvals.id PRIMARY KEY and the approvals.tool_use_id column. This means:
  - DB schema invariant — that approvals.tool_use_id be unique-per-real-Claude-tool-use — is silently violated since tool_use_id == id == random UUID, not the real Claude tool_use_id.
  - When TASK-304 lands and a real Claude tool_use_id flows in, every existing query that joins on tool_use_id will misbehave on rows inserted during this transitional window.
  - The runId↔sessionId conflation means any caller that already maps sessions to runs (the workflow-runs registry, which doesnt exist yet) will need to retroactively reconcile the IDs.

This is a cross-task design fragility introduced by stitching TASK-301 (bridge keeps Crystals sessionId argv) with TASK-302 (router strictly types its first param as runId).

Suspected tasks: TASK-301 (kept sessionId argv contract), TASK-302 (synthesized fake tool_use_id)

## FIND-SPRINT-006-20
- **source:** SPRINT-006 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/services/cyboflowPermissionIpcServer.ts (no chmod on socket file or its dir)
- **description:** The unix socket at ~/.cyboflow/sockets/cyboflow-permissions-<pid>.sock is created with default file permissions (typically 0o755 dir, 0o755 socket inode after umask). On a single-user macOS desktop this is acceptable, but the socket is the entry point that — via ApprovalRouter — can flip workflow_runs.status to awaiting_review and persist arbitrary tool inputs into the approvals table. Any other process owned by another local UID that can reach ~/.cyboflow/sockets/ can submit permission-request messages.
- **suggested_action:** After the server starts listening, chmod the socket file to 0o600 so only the same UID can read/write: `fs.chmodSync(this.socketPath, 0o600)` inside server.listen callback. Also chmod the parent socket directory to 0o700 when creating it. Cite this in docs/cyboflow_system_design.md as the trusted-boundary contract.
- **resolved_by:** 





No cross-task task narrowed this: TASK-301 carried over Crystals socket-creation pattern (it created its socket the same way), and TASK-302 raised the impact by making the socket a DB-write entry point. Plan TASK-302-plan.md does not call out a chmod requirement.

Suspected tasks: TASK-301 (socket creation), TASK-302 (raised stakes)

## FIND-SPRINT-006-21
- **source:** SPRINT-006 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/trpc/routers/{runs,approvals,workflows}.ts
- **description:** All three sub-routers throw `new TRPCError({ code: NOT_IMPLEMENTED, message: NOT_IMPLEMENTED_MSG })` from every procedure body, where NOT_IMPLEMENTED_MSG is a local const string. tRPC v11s built-in error codes do NOT include `NOT_IMPLEMENTED` (the valid codes are PARSE_ERROR, BAD_REQUEST, INTERNAL_SERVER_ERROR, NOT_FOUND, FORBIDDEN, UNAUTHORIZED, METHOD_NOT_SUPPORTED, TIMEOUT, CONFLICT, PRECONDITION_FAILED, PAYLOAD_TOO_LARGE, UNSUPPORTED_MEDIA_TYPE, UNPROCESSABLE_CONTENT, TOO_MANY_REQUESTS, CLIENT_CLOSED_REQUEST, INTERNAL_SERVER_ERROR). At runtime tRPC will fall back to INTERNAL_SERVER_ERROR for an unrecognized code string, but TypeScripts declared TRPC_ERROR_CODE_KEY union will be widened by an `as any` somewhere or will produce a typecheck failure under strict modes — the fact that pnpm typecheck passes today suggests tRPCs type widens to accept arbitrary strings.
- **suggested_action:** Replace `NOT_IMPLEMENTED` with the valid tRPC code `METHOD_NOT_SUPPORTED` (or `INTERNAL_SERVER_ERROR` if METHOD_NOT_SUPPORTED is too misleading), and extract a `throwNotImplemented(epic: string)` helper in main/src/orchestrator/trpc/trpc.ts so each sub-router just calls it: `query(() => throwNotImplemented(workflow-runs epic))`. Future epic-completion tasks then need to grep for `throwNotImplemented` to find every remaining stub.
- **resolved_by:** 




More importantly, the deferred-stub pattern is duplicated across three files with the same shape but different epic attribution in NOT_IMPLEMENTED_MSG. A shared helper `notImplemented(epicName: string)` in trpc.ts (or a `.use(notImplementedMiddleware)` factory) would consolidate the boilerplate that every subsequent epic must remember to remove.

Suspected tasks: TASK-254 (introduced all three routers with this pattern)

## FIND-SPRINT-006-22
- **source:** SPRINT-006 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/utils/crystalDirectory.ts:81-87
- **description:** TASK-301 added `export const getCyboflowSubdirectory = getCrystalSubdirectory;` with docstring claiming “The data-directory flip (~/.crystal → ~/.cyboflow) is handled by the crystal-cuts-and-rebrand epic; this re-export lets Cyboflow-branded modules import a consistently-named symbol today.” But getCrystalDirectory() (lines 41-72) ALREADY uses `.cyboflow` everywhere — the flip has already happened in this file. The docstring is stale and misleads readers into thinking the rebrand of the directory path is still pending.
- **suggested_action:** Either (a) finish the rename: rename `getCrystalDirectory` → `getCyboflowDirectory` and `getCrystalSubdirectory` → `getCyboflowSubdirectory` at the function-declaration sites and update all callers (the file is currently aliased only — about 30 import sites need updating), or (b) update the alias docstring to read accurately: “Alias matching Cyboflow naming. The underlying getCrystalSubdirectory already returns ~/.cyboflow paths — the legacy function name is preserved for git-history clarity and will be renamed when the crystal-cuts-and-rebrand epic closes.” Option (a) is preferred and likely belongs in the crystal-cuts-and-rebrand epic.
- **resolved_by:** 



The legacy `getCrystalDirectory()` / `getCrystalSubdirectory()` names are themselves now misnomers — they return cyboflow paths. The alias is a half-measure that adds a parallel symbol without removing the misnamed originals.

Suspected tasks: TASK-301

## FIND-SPRINT-006-23
- **source:** SPRINT-006 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/build-cyboflow-permission-bridge.js (the entire file)
- **description:** This new build script is a 275-line, near-verbatim copy of the pre-rename main/build-mcp-bridge.js with two changes: identifier renames (sessionId / cyboflow-permissions / output filename) and the embedded SimpleMCPServer class. It writes a TypeScript-source-equivalent JavaScript file that DUPLICATES the logic in main/src/services/cyboflowPermissionBridge.ts — but only the standalone version uses SimpleMCPServer (a hand-rolled minimal JSON-RPC implementation) while cyboflowPermissionBridge.ts uses the real @modelcontextprotocol/sdk Server. The two implementations can drift:
- **suggested_action:** Either (a) bundle the TS source into the standalone JS via esbuild/rollup at build time so the two implementations stay in sync mechanically (eliminates the hand-rolled SimpleMCPServer), or (b) document the protocol-equivalence contract in a comment at the top of build-cyboflow-permission-bridge.js and add a unit test that exercises both bridge paths against the same fixture of incoming JSON-RPC frames. Option (a) is preferred to eliminate the manual-sync hazard.
- **resolved_by:** 

  - SimpleMCPServer.handleMessage handles protocolVersion negotiation manually; the SDK version negotiates via `Server.connect(transport)`.
  - The standalone versions message buffer-and-split parser (line 108 processBuffer) is correctly implemented; the TS source versions JSON.parse-per-data-event is broken (see FIND-SPRINT-006-15). They will not behave identically under load.

The sprint kept these two implementations in sync only for the name rebrand. No task validates that the standalone JS and the TS source produce equivalent JSON-RPC behavior — TASK-301 only checked that filenames and identifiers were consistent.

Suspected tasks: TASK-301

## FIND-SPRINT-006-24
- **source:** SPRINT-006 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/services/cyboflowPermissionBridge.ts:31 and main/src/services/cyboflowPermissionIpcServer.ts:45
- **description:** Both files generate request/client identifiers via `${Date.now()}-${Math.random()}`. Collision probability is astronomically low but the pattern is wrong on principle — Math.random() is not a UUID source and the project already imports `randomUUID` from node:crypto elsewhere (main/src/orchestrator/approvalRouter.ts:30). The two ID-allocation sites were touched in different tasks (TASK-301 for the bridge, TASK-302 for the IPC server) and neither adopted the canonical UUID utility used by the same sprints ApprovalRouter.

This is a textbook cross-task pattern-drift the per-task reviewer cannot see: each task touches one side of the pair, copies Crystals legacy idiom, and neither reviewer notices the inconsistency.

Suspected tasks: TASK-301, TASK-302
- **suggested_action:** Replace both `${Date.now()}-${Math.random()}` constructions with `randomUUID()` from node:crypto. Add a single shared helper if more call sites are expected — but for now an inline rename is enough.
- **resolved_by:** 
