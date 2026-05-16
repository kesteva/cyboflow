---
id: TASK-401
idea: IDEA-009
status: in-flight
created: "2026-05-11T00:00:00Z"
files_owned:
  - main/src/trpc/index.ts
  - main/src/trpc/context.ts
  - main/src/trpc/routers/cyboflow.ts
  - main/src/trpc/routers/approvals.ts
  - main/src/trpc/routers/events.ts
  - frontend/src/trpc/client.ts
  - frontend/src/stores/reviewQueueStore.ts
  - shared/types/approvals.ts
  - main/src/index.ts
  - main/src/preload.ts
  - package.json
files_readonly:
  - main/src/services/permissionIpcServer.ts
  - main/src/services/database.ts
  - docs/cyboflow_system_design.md
  - frontend/src/stores/sessionStore.ts
  - frontend/src/stores/panelStore.ts
  - .soloflow/active/research/ROADMAP-001-research-risks.md
  - .soloflow/active/research/ROADMAP-001-research-architecture.md
acceptance_criteria:
  - criterion: tRPC server is mounted in main process with `cyboflow.approvals` and `cyboflow.events` routers exposed via electron-trpc IPC handler
    verification: "grep -n 'createIPCHandler\\|appRouter' main/src/index.ts returns at least one match referencing the new tRPC handler registration; `pnpm typecheck` passes"
  - criterion: "`cyboflow.approvals.listPending` query returns array of pending Approval rows (typed via shared/types/approvals.ts) and `cyboflow.events.onApprovalCreated` is a subscription"
    verification: "grep -n 'listPending\\|onApprovalCreated' main/src/trpc/routers/approvals.ts main/src/trpc/routers/events.ts returns matches in both files; types resolve at typecheck"
  - criterion: "reviewQueueStore (Zustand) exposes `queue: Approval[]`, `addApproval`, `removeApproval`, `replaceAll`, `connectionStatus`"
    verification: "grep -n 'queue\\|addApproval\\|removeApproval\\|replaceAll\\|connectionStatus' frontend/src/stores/reviewQueueStore.ts returns all five symbols"
  - criterion: "Store performs full-state resync on mount and on tRPC reconnect: invokes `listPending` and replaces the whole queue, then subscribes to `onApprovalCreated` for deltas"
    verification: "grep -n 'listPending\\|onApprovalCreated\\|replaceAll' frontend/src/stores/reviewQueueStore.ts shows both call paths present"
  - criterion: "Shared Approval type defined with id, runId, workflowName, toolName, payloadPreview, rationale, createdAt, status fields"
    verification: "grep -n 'interface Approval\\|type Approval' shared/types/approvals.ts returns a match; the fields listed are present"
  - criterion: "Pinned versions of `@trpc/server`, `@trpc/client`, `electron-trpc`, `superjson`, `zod` appear in package.json dependencies with versions that include tRPC v11 leak fix (PR #6161)"
    verification: "grep -n '@trpc/server\\|@trpc/client\\|electron-trpc\\|superjson' package.json returns four entries; `pnpm install` succeeds"
depends_on: []
estimated_complexity: high
epic: review-queue-ui
test_strategy:
  needed: true
  justification: "Store has explicit reducers (addApproval, removeApproval, replaceAll) and resync logic — verify pure-function correctness without a live tRPC connection"
  targets:
    - behavior: replaceAll wipes existing queue and inserts new approvals atomically
      test_file: frontend/src/stores/__tests__/reviewQueueStore.test.ts
      type: unit
    - behavior: addApproval is idempotent on duplicate id (subscription replay safety)
      test_file: frontend/src/stores/__tests__/reviewQueueStore.test.ts
      type: unit
    - behavior: removeApproval no-ops when id missing
      test_file: frontend/src/stores/__tests__/reviewQueueStore.test.ts
      type: unit
---
# tRPC Foundation: cyboflow.approvals Router + reviewQueueStore + Full-State Resync

## Objective

Establish the typed tRPC contract between main and renderer for the review queue. This task creates: (1) the `cyboflow.approvals` and `cyboflow.events` tRPC routers in the main process, (2) the renderer tRPC client wired via `electron-trpc/ipcLink`, (3) the `reviewQueueStore` Zustand slice that owns the queue state, and (4) the resync-on-mount + resync-on-reconnect logic that prevents queue desync (the failure mode named in IDEA slice 9 and risks research §12). Until this exists, no other queue UI task can connect to live data. The actual `ApprovalRouter` orchestrator service that *creates* approvals is a separate concern owned by epic `approval-router` (IDEA-008's downstream); this task wires the read/subscribe contract only and accepts mocked/stubbed `listPending` returning `[]` if the orchestrator side isn't ready yet.

## Implementation Steps

1. Add tRPC v11 dependencies to `package.json`: `@trpc/server`, `@trpc/client`, `electron-trpc`, `superjson` (transformer), `zod` (boundary validation only). Pin versions that include the v11 subscription leak fix (PR #6161 — verify `@trpc/server` ≥ 11.0.0-rc.470 or stable v11 release). Run `pnpm install`.
2. Create `shared/types/approvals.ts` exporting `Approval` interface with fields: `id: string`, `runId: string`, `workflowName: string`, `toolName: string`, `payloadPreview: string`, `rationale: string | null`, `createdAt: string` (ISO), `status: 'pending' | 'approved' | 'rejected' | 'expired'`. Also export `ApprovalCreatedEvent` and `ApprovalDecidedEvent` types for the subscription discriminated union.
3. Create `main/src/trpc/context.ts` exporting `createContext` that returns `{ principal: { userId: 'local' }, db: DatabaseService }`. The principal pattern is required per system design §5.8 so the team-tier extraction is a swap not a refactor.
4. Create `main/src/trpc/index.ts` with `initTRPC.context<Context>().create({ transformer: superjson })` and export `t`, `router`, `publicProcedure`. This is the only place tRPC primitives are constructed.
5. Create `main/src/trpc/routers/approvals.ts` with:
   - `listPending`: query, no input, returns `Approval[]` by reading from `approvals` table where `status = 'pending'` ordered by `created_at ASC`. If the table does not yet exist (depends on IDEA-008), return `[]` and log a warn; do not throw.
   - `approve`: mutation, input `z.object({ approvalId: z.string() })`, returns `{ success: true }`. Stub implementation: log + return success. Full implementation is the ApprovalRouter service (out of scope for this task).
   - `reject`: mutation, same shape, same stub behavior.
6. Create `main/src/trpc/routers/events.ts` with:
   - `onApprovalCreated`: subscription returning `observable<ApprovalCreatedEvent>`. Backed by a main-process `EventEmitter` (export `approvalEvents` from this module so the future ApprovalRouter can emit on it). For now, the emitter is constructed but no producer wires into it — empty subscription is acceptable.
   - `onApprovalDecided`: subscription returning `observable<ApprovalDecidedEvent>`. Same pattern.
7. Create `main/src/trpc/routers/cyboflow.ts` composing the sub-routers: `router({ approvals: approvalsRouter, events: eventsRouter })`. Export `appRouter = router({ cyboflow: cyboflowRouter })` and `type AppRouter = typeof appRouter`.
8. In `main/src/index.ts`, after BrowserWindow creation, call `createIPCHandler({ router: appRouter, windows: [mainWindow], createContext })` from `electron-trpc/main`. Add the import. This must happen before the renderer subscribes — verify by adding a console.log on registration.
9. In `main/src/preload.ts`, add `exposeElectronTRPC()` call from `electron-trpc/preload` so the renderer can reach the IPC bridge. This goes alongside existing `contextBridge.exposeInMainWorld` calls — do not remove them.
10. Create `frontend/src/trpc/client.ts` exporting a typed client: `createTRPCClient<AppRouter>({ links: [ipcLink()], transformer: superjson })`. Import `AppRouter` from `../../../main/src/trpc/routers/cyboflow` (type-only import). Export `trpc` for use in the store.
11. Create `frontend/src/stores/reviewQueueStore.ts` with Zustand `create<ReviewQueueState>()`:
    - State: `queue: Approval[]`, `connectionStatus: 'idle' | 'connecting' | 'connected' | 'disconnected'`
    - Reducers: `addApproval(a)` (idempotent — return early if `queue.find(x => x.id === a.id)`), `removeApproval(id)`, `replaceAll(items)`, `setConnectionStatus(s)`
    - Action `init()`: sets `connecting`, calls `trpc.cyboflow.approvals.listPending.query()`, calls `replaceAll(result)`, sets `connected`, then subscribes via `trpc.cyboflow.events.onApprovalCreated.subscribe(undefined, { onData: (evt) => addApproval(evt.approval), onError: () => { setConnectionStatus('disconnected'); /* trigger reconnect */ } })`. On reconnect (subscription re-established or component remount after disconnect), call `init()` again — the `replaceAll` makes this safe.
12. Write unit tests in `frontend/src/stores/__tests__/reviewQueueStore.test.ts` exercising the reducers in isolation (mock the trpc client by injecting a fake or just testing the pure reducer functions exported separately).

## Acceptance Criteria

- tRPC handler registered in main with cyboflow routers reachable from the renderer.
- `listPending`, `approve`, `reject`, `onApprovalCreated`, `onApprovalDecided` all exist with correct types.
- `reviewQueueStore` exists with reducers and resync logic; `init()` performs full-state load on mount AND on reconnect, never trusting deltas to be sufficient.
- Pinned dependency versions in `package.json` include tRPC v11 leak fix.
- Unit tests cover the three pure reducers.

## Test Strategy

Three unit tests in `frontend/src/stores/__tests__/reviewQueueStore.test.ts`:
1. `replaceAll` replaces the queue atomically — start with 2 items, call `replaceAll([])`, expect length 0; call `replaceAll([a, b, c])`, expect exactly those three.
2. `addApproval` is idempotent — call twice with same `id`, expect length 1.
3. `removeApproval` no-ops on missing id — call on empty queue, expect no throw and length 0.

The tRPC integration itself is tested end-to-end by downstream UI tasks (manual smoke via the dev console). No need to mock the tRPC link here.

## Hardest Decision

**tRPC v11 vs. continuing to use raw Electron IPC for the queue.** System design §4 and §5.8 mandate tRPC for new cyboflow code. The risks research §9 flags a v11 subscription memory leak. The decision is to use v11 with a pinned version that includes the fix (PR #6161) rather than fall back to IPC, because: (a) the leak fix is merged and shipping in current v11 stable, (b) the team-tier extraction story breaks without typed RPC, (c) the subscription mechanism is exactly the right shape for the approval-event stream. The mitigation is the pin + a manual heap-check during the 1-day self-host.

## Rejected Alternatives

- **Raw Electron IPC with manual typing.** Rejected because backend extraction in v2 requires rewriting every call site. tRPC's `ipcLink → httpLink` swap is the whole reason for the architectural commitment.
- **Defer the resync logic to "v1.1".** Rejected because the renderer-reload scenario is the v1 self-host failure mode (risks research §12). A queue that shows stale data after one HMR is a worse demo than no queue at all.
- **Single store managing both queue and connection state separately.** The connection status is intrinsic to the queue's trustworthiness — splitting it makes the UI consumer juggle two stores. Keep them co-located.

What would change my mind: if `electron-trpc` v11 support is not stable in the target package versions, fall back to a hand-rolled typed IPC wrapper with the same router/subscription shape — slower to write but unblocks the rest of the epic.

## Lowest Confidence Area

The exact version pin for the tRPC v11 leak fix. The research report references issue #6156 and PR #6161 but the executor must verify the fix is in the version they install. If the latest stable v11 release does NOT include the fix, the executor should pin to a specific RC version that does, or use `mat-sz/trpc-electron` as a fallback. Adding a one-line comment in `package.json` next to the pin explaining the constraint is encouraged.
