---
id: TASK-582
idea: SPRINT-006-compound
status: blocked
blocked_reason: "Fixes IPC server init ordering relative to ApprovalRouter. Under the SDK substrate, the IPC server is wired but inactive (per EPIC portability note for IDEA-013), so init-ordering bugs have no observable effect. Defer until IDEA-013 lands. Unblock when IDEA-013 starts planning."
source_sprint: SPRINT-006
created: 2026-05-14T00:00:00Z
files_owned:
  - main/src/index.ts
files_readonly:
  - main/src/services/cyboflowPermissionIpcServer.ts
  - main/src/orchestrator/approvalRouter.ts
  - main/src/orchestrator/RunQueueRegistry.ts
  - main/src/orchestrator/Orchestrator.ts
  - main/src/orchestrator/types.ts
  - .soloflow/active/findings/SPRINT-006-findings.md
  - .soloflow/active/compound/SPRINT-006-proposal.md
  - .soloflow/active/plans/approval-router-and-permission-fix/EPIC-approval-router-and-permission-fix.md
acceptance_criteria:
  - criterion: "RunQueueRegistry instantiation and ApprovalRouter.initialize() are both called inside `initializeServices()` (before `cyboflowPermissionIpcServer.start()`), not inside the `app.whenReady().then(...)` block after `createWindow()`"
    verification: "grep -nE 'new RunQueueRegistry\\(\\)' main/src/index.ts shows a match at a line BELOW the `async function initializeServices()` declaration AND ABOVE the line that calls `cyboflowPermissionIpcServer.start()`; grep -nE 'ApprovalRouter\\.initialize\\(' main/src/index.ts shows a match in the same range; both matches must be < the line number of `await cyboflowPermissionIpcServer.start()`"
  - criterion: "`new EventEmitter()` for the orchestrator deps and `orchestrator = new Orchestrator({...})` still happen after `createWindow()` (lifecycle for the BrowserWindow-dependent tRPC attach remains unchanged)"
    verification: "grep -nE 'orchestrator = new Orchestrator' main/src/index.ts shows the match remains inside the `app.whenReady().then(...)` block — line number > the line of `await createWindow()`"
  - criterion: "The orchestrator wiring block continues to pass the SAME RunQueueRegistry instance (and SAME db adapter) to `Orchestrator` constructor that was used in `ApprovalRouter.initialize()`. No duplicate `new RunQueueRegistry()` exists in the wiring block."
    verification: "grep -cE 'new RunQueueRegistry\\(\\)' main/src/index.ts returns exactly 1"
  - criterion: "Permission IPC server's `client.on('data', ...)` handler can resolve `ApprovalRouter.getInstance()` without throwing the uninitialized-singleton error. Verified by a startup-ordering integration test: spawn the main process or simulate `initializeServices()` end-to-end and confirm a stale-fd-on-boot connection does not throw."
    verification: "Either a new vitest case in main/src/__tests__/startupOrdering.test.ts asserts ApprovalRouter.initialize() returns before CyboflowPermissionIpcServer.start() resolves (using a sequence-tracking spy on each), OR a documented manual smoke in the done report: (i) leave a stale `.sock` file at `~/.cyboflow/sockets/cyboflow-permissions-<pid>.sock` from a previous run; (ii) write a Node script that opens a connection to that path immediately when the file appears; (iii) launch `pnpm dev`; (iv) confirm no `ApprovalRouter has not been initialized` error in logs."
  - criterion: "Main process typecheck passes"
    verification: "pnpm --filter main typecheck exits 0"
  - criterion: "Main process lint passes"
    verification: "pnpm --filter main lint exits 0"
  - criterion: "Main process unit tests pass"
    verification: "pnpm --filter main test exits 0"
depends_on: []
estimated_complexity: low
epic: approval-router-and-permission-fix
test_strategy:
  needed: true
  justification: "Startup-ordering bugs are notoriously absent from typecheck and lint surfaces — they require an integration-style test that observes the actual call sequence. One unit-test file. The manual smoke fallback is acceptable when CI cannot reliably synthesize a stale-fd race, but the preferred deliverable is the spy-based test."
  targets:
    - behavior: "ApprovalRouter.initialize() resolves before cyboflowPermissionIpcServer.start() during `initializeServices()`"
      test_file: main/src/__tests__/startupOrdering.test.ts
      type: integration
---

# Fix ApprovalRouter initialization ordering relative to cyboflowPermissionIpcServer.start()

## Objective

`main/src/index.ts:571` (inside `initializeServices()`) calls `await cyboflowPermissionIpcServer.start()` — the Unix socket starts listening and accepting connections — but `ApprovalRouter.initialize()` happens in the `app.whenReady().then(...)` block at `main/src/index.ts:718`, *after* `createWindow()`. There is a window during boot where the socket is live and any connecting client (including a stale fd from a previous app run pointing at the same socket path on disk) can send a `permission-request` that hits `cyboflowPermissionIpcServer.ts:73`'s `ApprovalRouter.getInstance()` call — which throws `'ApprovalRouter has not been initialized.'` (`approvalRouter.ts:128-134`). The deny-on-error fallback at `cyboflowPermissionIpcServer.ts:79-90` recovers by writing a deny on the socket, so the bug is not silent, but the diagnosis trail is noisy and an unlucky window during boot can produce confusing logs.

This task moves the RunQueueRegistry instantiation and `ApprovalRouter.initialize()` *before* `cyboflowPermissionIpcServer.start()` inside `initializeServices()`. The Orchestrator construction (which needs the BrowserWindow for tRPC attach) stays where it is — only the singletons that the IPC server needs at-listen-time move.

## Implementation Steps

1. **Edit `main/src/index.ts`** — inside `initializeServices()`, between the `archiveProgressManager = new ArchiveProgressManager()` line (currently ~562) and the `console.log('[Main] Initializing Permission IPC server...')` line (currently ~565), insert:

   ```ts
   // Initialize RunQueueRegistry and ApprovalRouter BEFORE starting the permission IPC server.
   // The IPC server's data handler resolves ApprovalRouter.getInstance() synchronously when a
   // bridge client connects — any stale-fd connection during boot would otherwise throw the
   // uninitialized-singleton error.
   const runQueues = new RunQueueRegistry();
   const db: DatabaseLike = {
     prepare: (sql) => databaseService.getDb().prepare(sql),
     transaction: (fn) => databaseService.getDb().transaction(fn),
   };
   ApprovalRouter.initialize(db, runQueues.getOrCreate.bind(runQueues));
   console.log('[Main] ApprovalRouter initialized');
   ```

   Hoist the `runQueues` and `db` declarations to function scope so the later `app.whenReady().then(...)` block can reuse them. Concretely:
   - Lift `let runQueues: RunQueueRegistry | null = null;` and `let db: DatabaseLike | null = null;` to module-scope `let` declarations near the other service-instance declarations (~line 80-87 in current code).
   - Assign them inside `initializeServices()` (per the snippet above).
   - In the `app.whenReady().then(...)` block (currently ~lines 685-720), **remove** the duplicate `new RunQueueRegistry()` and the inline `db` adapter, and **remove** the `ApprovalRouter.initialize(...)` call. Use the hoisted `runQueues` and `db` when constructing the Orchestrator:
     ```ts
     orchestrator = new Orchestrator({ db: db!, logger: loggerLike, eventBus: new EventEmitter(), runQueues: runQueues! });
     ```
   - Keep the `attachOrchestratorTrpc({...})` call and the `console.log('[Main] Orchestrator started and tRPC IPC handler attached')` line in the `whenReady` block — those depend on `mainWindow`.

2. **Create `main/src/__tests__/startupOrdering.test.ts`** — new integration test. Strategy:
   - Import `CyboflowPermissionIpcServer` and `ApprovalRouter` and a fresh `DatabaseService` (against in-memory DB).
   - Spy on `ApprovalRouter.initialize` and `CyboflowPermissionIpcServer.prototype.start` using `vi.spyOn(...)`.
   - Record the call order via a shared `calls: string[]` array; each spy implementation pushes its name then delegates to the original (`Reflect.apply(original, this, args)`).
   - Reproduce the relevant slice of `initializeServices()` body in the test (extract to a helper if too large, but the test can copy the 10–15 lines needed).
   - Assert: `calls.indexOf('ApprovalRouter.initialize') < calls.indexOf('CyboflowPermissionIpcServer.start')`.
   - Clean up via `ApprovalRouter._resetForTesting()` and `await server.stop()` in `afterEach`.

   If extracting the ordering logic for testability is too invasive, the fallback is:
   - Make `initializeServices()` accept an optional `{ approvalRouter?: typeof ApprovalRouter; permissionServer?: CyboflowPermissionIpcServer }` injection seam, and pass spied collaborators from the test.
   - Or skip the automated test and ship the manual-smoke acceptance instead (see frontmatter AC for the manual-smoke procedure).

3. **Run the verification chain**:
   ```
   pnpm --filter main typecheck
   pnpm --filter main lint
   pnpm --filter main test startupOrdering
   pnpm --filter main test
   pnpm dev   # smoke: launch app, confirm no "ApprovalRouter has not been initialized" in logs
   ```

## Acceptance Criteria

See frontmatter. Seven criteria covering the relocation, deduplication, integration test (or manual smoke fallback), and the standard build chain.

## Test Strategy

See frontmatter `test_strategy`. One integration-style test asserting call order via spies. Manual-smoke fallback documented as acceptable if injection refactoring proves too invasive — startup-ordering bugs are hard to test cleanly in Electron-coupled code.

## Hardest Decision

**Where to put RunQueueRegistry — function-local to `initializeServices()` or module-scope hoisted?** Chosen: **module-scope** with `let` and lazy assignment. Function-local would force the Orchestrator construction in `whenReady` to receive a duplicate registry, defeating the deduplication AC. Module-scope is consistent with the existing pattern for `databaseService`, `worktreeManager`, etc. (`main/src/index.ts:69-86`).

## Rejected Alternatives

- **Move only `ApprovalRouter.initialize()` and leave `RunQueueRegistry` in the whenReady block.** Rejected: `ApprovalRouter.initialize()` requires the `getQueueForRun` factory which comes from the registry. Moving one without the other would just shuffle the dependency without fixing the ordering.
- **Move the entire orchestrator wiring (`new Orchestrator(...)`, `attachOrchestratorTrpc(...)`) into `initializeServices()`.** Rejected: `attachOrchestratorTrpc` needs `mainWindow`, which is created by `createWindow()` *after* `initializeServices()`. Moving it would break the BrowserWindow dependency. We only move what is needed by the permission IPC server.
- **Defer `cyboflowPermissionIpcServer.start()` to the whenReady block.** Rejected: this is the dual of the chosen fix and is arguably valid, but the IPC server has no BrowserWindow dependency — it should start as early as possible to minimize the boot-time window during which Claude subprocesses spawned by reused PIDs cannot reach the socket. Moving the singletons up is the more conservative correction.

## Lowest Confidence Area

The integration test's mechanism for asserting call order. Electron tests are notoriously hard to set up — depending on the spy strategy, the test may need to mock `electron`'s `app.isPackaged` / `getPath`, the `Logger` constructor's filesystem access, etc. If the automated test proves >2× the implementation cost, the executor should ship the manual smoke and document why in the done report. The bug class (boot-time race) is rare enough in practice (a stale fd from a previous PID is unusual) that manual-smoke is defensible.
