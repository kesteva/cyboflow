---
id: TASK-302
idea_id: IDEA-007
status: ready
created: 2026-05-11T00:00:00Z
files_owned:
  - main/src/orchestrator/approvalRouter.ts
  - main/src/services/cyboflowPermissionIpcServer.ts
  - main/src/services/panels/claude/claudeCodeManager.ts
  - main/src/index.ts
  - main/src/orchestrator/__tests__/approvalRouter.test.ts
files_readonly:
  - main/src/services/permissionManager.ts
  - main/src/services/cyboflowPermissionBridge.ts
  - main/src/database/database.ts
  - main/src/database/migrations/006_cyboflow_schema.sql
  - .soloflow/active/ideas/IDEA-004.md
  - .soloflow/active/ideas/IDEA-006.md
  - .soloflow/active/research/ROADMAP-001-research-architecture.md
  - .soloflow/active/research/ROADMAP-001-research-risks.md
acceptance_criteria:
  - criterion: "main/src/orchestrator/approvalRouter.ts exists and exports an ApprovalRouter class with a getInstance() singleton (or an orchestrator-injected factory) plus methods requestApproval(runId, toolName, input), respond(approvalId, decision), clearPendingForRun(runId) (declared, body stubbed if TASK-304 not yet merged), and getPending()"
    verification: "test -f main/src/orchestrator/approvalRouter.ts && grep -nE 'class ApprovalRouter' main/src/orchestrator/approvalRouter.ts && grep -nE 'requestApproval|respond\\(|clearPendingForRun|getPending' main/src/orchestrator/approvalRouter.ts"
  - criterion: "ApprovalRouter.requestApproval co-writes the approvals row INSERT and workflow_runs UPDATE to status='awaiting_review' inside a single db.transaction() and uses the status guard `AND status='running'` on the UPDATE"
    verification: "grep -nE 'db\\.transaction|BEGIN IMMEDIATE' main/src/orchestrator/approvalRouter.ts && grep -nE \"AND status\\s*=\\s*'running'\" main/src/orchestrator/approvalRouter.ts"
  - criterion: "ApprovalRouter.respond uses a status guard on the awaiting_review→running UPDATE: `WHERE id=? AND status='awaiting_review'` and checks the changes count is > 0 before sending allow on the socket"
    verification: "grep -nE \"WHERE id\\s*=\\s*\\?\\s+AND status\\s*=\\s*'awaiting_review'\" main/src/orchestrator/approvalRouter.ts && grep -nE 'changes\\s*[>=]+\\s*0|info\\.changes' main/src/orchestrator/approvalRouter.ts"
  - criterion: "ApprovalRouter mutations run inside the per-run p-queue: requestApproval/respond bodies are submitted via a `queue.add(...)` call obtained from a per-run queue registry"
    verification: "grep -nE 'p-queue|PQueue|queueForRun|perRunQueue' main/src/orchestrator/approvalRouter.ts && grep -nE '\\.add\\(' main/src/orchestrator/approvalRouter.ts"
  - criterion: "cyboflowPermissionIpcServer.ts no longer imports PermissionManager; it calls ApprovalRouter for inbound permission-request messages"
    verification: "! grep -n 'PermissionManager' main/src/services/cyboflowPermissionIpcServer.ts && grep -n 'ApprovalRouter' main/src/services/cyboflowPermissionIpcServer.ts"
  - criterion: "claudeCodeManager.ts no longer imports PermissionManager; cleanup hook calls ApprovalRouter.clearPendingForRun (stub OK; full body in TASK-304)"
    verification: "! grep -n 'PermissionManager' main/src/services/panels/claude/claudeCodeManager.ts && grep -n 'clearPendingForRun' main/src/services/panels/claude/claudeCodeManager.ts"
  - criterion: "Unit test suite for approvalRouter passes: (1) requestApproval inserts an approvals row with status='pending' and transitions workflow_runs to awaiting_review under a single transaction; (2) a respond call after the run has been canceled (status set to 'canceled' between requestApproval and respond) returns changes=0 and does NOT send allow on the socket; (3) the per-run queue serializes two concurrent requestApproval calls for the same runId"
    verification: "pnpm --filter @cyboflow/main test approvalRouter exits 0; the test output lists at least the three named cases"
  - criterion: "Main process typecheck succeeds with no references to PermissionManager outside the deprecated file (which remains on disk for the parallel epic that ultimately deletes it) — i.e., no production import path resolves to permissionManager.ts"
    verification: "pnpm run typecheck exits 0; grep -rn --include='*.ts' \"from '.*permissionManager'\" main/src/ returns no matches outside main/src/services/permissionManager.ts itself"
depends_on: [TASK-301]
estimated_complexity: high
epic: approval-router-and-permission-fix
test_strategy:
  needed: true
  justification: "ApprovalRouter is the load-bearing primitive of the review queue. The status-guard race condition, the transaction atomicity, and the per-run queue serialization are exactly the invariants the design doc calls non-negotiable. Each invariant must have a dedicated test case because they cannot be eyeballed in code review."
  targets:
    - behavior: "requestApproval inserts an approvals row (status='pending') and updates workflow_runs to status='awaiting_review' in a single transaction; verify both rows present after the call"
      test_file: "main/src/orchestrator/__tests__/approvalRouter.test.ts"
      type: unit
    - behavior: "respond after run is canceled: arrange a workflow_runs row with status='canceled' before respond fires; assert the UPDATE returns changes=0 and the socket-reply callback (mocked) is not invoked with behavior='allow'"
      test_file: "main/src/orchestrator/__tests__/approvalRouter.test.ts"
      type: unit
    - behavior: "Two concurrent requestApproval calls for the same runId are serialized by the per-run p-queue; ordering preserved; no overlapping transaction errors"
      test_file: "main/src/orchestrator/__tests__/approvalRouter.test.ts"
      type: unit
    - behavior: "respond with behavior='deny' updates the approvals row to status='rejected' and does NOT change workflow_runs.status (run stays in awaiting_review until Claude exits the tool call; design doc §5.7 is explicit on this)"
      test_file: "main/src/orchestrator/__tests__/approvalRouter.test.ts"
      type: unit
---

# Implement ApprovalRouter Replacing PermissionManager

## Objective

Create `main/src/orchestrator/approvalRouter.ts` as the new singleton consumed by `CyboflowPermissionIpcServer`. ApprovalRouter receives a permission request from the bridge, looks up the run's workflow policy, and under the per-run p-queue performs the atomic co-write that transitions `workflow_runs.status` to `awaiting_review` and inserts a row into `approvals` (status='pending'). When the user (or the timeout in TASK-303, or `clearPendingForRun` in TASK-304) responds, ApprovalRouter writes the socket reply through `CyboflowPermissionIpcServer` and — for the `allow` case — runs the guarded UPDATE `WHERE id=? AND status='awaiting_review'` so a concurrently-canceled run cannot be revived by a late approval. This task implements the request/respond core plus the status-guard race protection (slice 6); the 60-min timeout and clear-pending semantics ship in TASK-303 and TASK-304 respectively.

## Implementation Steps

1. **Create `main/src/orchestrator/approvalRouter.ts`.** Sketch:
   ```ts
   import { EventEmitter } from 'events';
   import type Database from 'better-sqlite3';
   import type PQueue from 'p-queue';
   import type { CyboflowPermissionIpcServer } from '../services/cyboflowPermissionIpcServer';

   export interface ApprovalRequest {
     id: string;           // UUID for the approvals row
     runId: string;        // workflow_runs.id
     toolName: string;
     input: Record<string, unknown>;
     timestamp: number;
   }

   export interface ApprovalDecision {
     behavior: 'allow' | 'deny';
     updatedInput?: Record<string, unknown>;
     message?: string;
   }

   export class ApprovalRouter extends EventEmitter {
     private static instance: ApprovalRouter | null = null;
     private pending = new Map<string, {
       request: ApprovalRequest;
       socketReply: (decision: ApprovalDecision) => void;  // closure that writes to the bridge socket
     }>();

     constructor(
       private db: Database.Database,
       private getQueueForRun: (runId: string) => PQueue,
       private getSocketReplyFor: (approvalId: string) => ((decision: ApprovalDecision) => void) | null,
     ) { super(); }

     static initialize(...args: ConstructorParameters<typeof ApprovalRouter>): ApprovalRouter { ... }
     static getInstance(): ApprovalRouter { ... }

     async requestApproval(runId: string, toolName: string, input: Record<string, unknown>): Promise<ApprovalDecision> { ... }
     async respond(approvalId: string, decision: ApprovalDecision): Promise<void> { ... }
     clearPendingForRun(runId: string): void { /* stub; body lands in TASK-304 */ }
     getPending(): ApprovalRequest[] { return Array.from(this.pending.values()).map(p => p.request); }
   }
   ```
   Do not export a `getInstance()` that constructs lazily — the orchestrator (TASK from IDEA-006) is responsible for calling `ApprovalRouter.initialize(db, queueRegistry.getQueueForRun, ipcServer.bindReplyFor)` once at boot. This keeps Electron / DB references injectable for tests.

2. **Implement `requestApproval(runId, toolName, input)`:**
   - Generate `approvalId = randomUUID()`.
   - Submit the work to `this.getQueueForRun(runId).add(async () => { ... })`. Inside the queue task:
     - Open a `db.transaction(() => { ... })` (better-sqlite3 transactions are `BEGIN IMMEDIATE` by default per the architecture research §9 transaction helper).
     - Inside the transaction:
       1. `UPDATE workflow_runs SET status='awaiting_review' WHERE id=? AND status='running'` — capture `info.changes`. If `info.changes === 0`, throw a `RunNotRunningError`; the transaction rolls back.
       2. `INSERT INTO approvals (id, run_id, tool_name, input, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`.
     - After the transaction commits, register `this.pending.set(approvalId, { request, socketReply })` and emit `'approvalCreated'` for the renderer subscription.
   - Return a `Promise<ApprovalDecision>` that resolves when `respond()` (or the future timeout in TASK-303) fires. The promise is wired by storing its `resolve` function in `socketReply` alongside the actual socket-write call: when `respond` is invoked, it calls both `socketReply(decision)` (writes to the bridge socket, which unblocks Claude) AND resolves this promise.

3. **Implement `respond(approvalId, decision)`:**
   - Look up `this.pending.get(approvalId)`. If absent, throw `ApprovalNotFoundError` (re-attempt scenarios are rare; surface them).
   - Submit to `this.getQueueForRun(request.runId).add(async () => { ... })`.
   - Inside the queue task:
     - If `decision.behavior === 'allow'`: run the guarded UPDATE `UPDATE workflow_runs SET status='running' WHERE id=? AND status='awaiting_review'`. If `info.changes === 0`, the run was canceled (or expired) concurrently — log WARN, update `approvals.status='superseded'`, and do NOT invoke `socketReply` (the bridge / Claude PTY will already have been torn down by `clearPendingForRun` in TASK-304). Return early.
     - If `decision.behavior === 'allow'` and `info.changes > 0`: update `approvals.status='approved'`, call `socketReply(decision)` to write the allow response to the bridge socket.
     - If `decision.behavior === 'deny'`: update `approvals.status='rejected'` only (do not touch `workflow_runs.status` — Claude will see the deny on the socket, may emit a tool-result error, and the run remains in `awaiting_review` until Claude itself yields). Call `socketReply(decision)`.
   - Delete from `this.pending` after socket reply.

4. **Wire `CyboflowPermissionIpcServer` to call `ApprovalRouter` instead of `PermissionManager`** (file: `main/src/services/cyboflowPermissionIpcServer.ts`):
   - Remove `import { PermissionManager } from './permissionManager';`.
   - Add `import { ApprovalRouter } from '../orchestrator/approvalRouter';`.
   - In the `permission-request` handler (line ~54), replace `PermissionManager.getInstance().requestPermission(sessionId, toolName, input)` with:
     - Map the `sessionId` argument to a `runId`. **For this task, treat them as equivalent** — the wiring from `runId` ↔ `sessionId` is owned by `workflow-runs-and-day3-gate` (a downstream epic). Add a TODO comment noting the caller passes whatever ID the bridge subprocess was spawned with; at integration time this will be the `runId`.
     - Call `await ApprovalRouter.getInstance().requestApproval(sessionId, toolName, input)`.
     - Store a `socketReply` closure on the router by passing the `client.write(...)` callback at request time: the router's `getSocketReplyFor(approvalId)` factory closes over the `client` socket + `requestId`. Refactor the handler so it registers the closure before the await.

5. **Wire `claudeCodeManager.ts` cleanup:**
   - Remove `import { PermissionManager } from '../../permissionManager';` (line 11).
   - At line 270, replace `PermissionManager.getInstance().clearPendingRequests(sessionId)` with `ApprovalRouter.getInstance().clearPendingForRun(sessionId)`. The full body of `clearPendingForRun` lands in TASK-304; for now the method exists as a stub that logs and is a no-op. Add an `import { ApprovalRouter } from '../../../orchestrator/approvalRouter';`.

6. **Wire `main/src/index.ts`:**
   - After the `databaseService` and the orchestrator's queue registry (from IDEA-006) are initialized, call `ApprovalRouter.initialize(databaseService.db, queueRegistry.getQueueForRun, ipcServer.bindReplyFor)`. If the orchestrator from IDEA-006 has not yet shipped at execution time, place a TODO marker comment with the exact line and a `throw new Error('ApprovalRouter init depends on orchestrator-and-trpc-router; defer wiring until TASK from IDEA-006 lands')` guard — do not silently no-op, because that hides the integration failure.

7. **Author `main/src/orchestrator/__tests__/approvalRouter.test.ts`** with the four cases listed in `test_strategy.targets`:
   - Use an in-memory better-sqlite3 instance (`new Database(':memory:')`) and run `006_cyboflow_schema.sql` against it in `beforeAll`.
   - Mock `getQueueForRun` with a real `new PQueue({concurrency: 1})` per runId (kept in a `Map`).
   - Mock `getSocketReplyFor` to return a Jest mock function; assert it is / is not called with the expected payload.
   - Seed `workflow_runs` with status='running' before calling `requestApproval`.
   - For the cancel-race case: between `requestApproval` returning the pending promise and calling `respond`, directly execute `UPDATE workflow_runs SET status='canceled' WHERE id=?` to simulate the cancel path bypassing the queue (this is the very race the status guard protects against).

8. **Run `pnpm --filter @cyboflow/main test approvalRouter`** and `pnpm run typecheck`. Both exit 0.

## Acceptance Criteria

See frontmatter. The non-obvious one: AC #6 (`claudeCodeManager.ts` no longer imports PermissionManager) is what enforces the cutover — if any production import path still resolves to `permissionManager.ts`, the inherited no-timeout bug is still reachable.

## Test Strategy

Four unit-test cases per the targets in frontmatter. The cancel-race case (target 2) is the load-bearing one — it directly proves the slice-6 status-guard protection. The cases use an in-memory SQLite database and a real `p-queue` so the serialization and transaction semantics are exercised end-to-end without spinning up Electron or the bridge subprocess.

## Hardest Decision

Whether `clearPendingForRun` lives in TASK-302 or TASK-304. **Decision: declared in TASK-302 as a stub, fully implemented in TASK-304.** The stub keeps `claudeCodeManager.ts`'s import surface stable across the two-task boundary so the executor doesn't have to revisit `cleanupCliResources` twice. TASK-304's body fills in the socket-deny + DB-update body inside the same method signature.

A second close call: whether ApprovalRouter should consult workflow policy (frontmatter `permission_mode`) to auto-approve some tool calls. **Decision: no, not in this task.** The IDEA mentions parsing frontmatter `permission_mode` but auto-approve / dontAsk-allowlist behavior is owned by `workflow-runs-and-day3-gate`. TASK-302 routes every request through the queue unconditionally; the auto-approve fast path bolts on later as a guard at the top of `requestApproval`.

## Rejected Alternatives

- **Use EventEmitter `once(\`response:${id}\`)` like PermissionManager.** Rejected: that's exactly Crystal's broken pattern. The new design returns a Promise whose resolver is stored alongside the `socketReply` closure so both fire together; the EventEmitter is reserved for `'approvalCreated'` fanout to the renderer, not for the response side-channel.
- **Make the queue per-approval rather than per-run.** Rejected: the design doc and architecture research §4 are explicit — `p-queue({concurrency: 1})` is per-run. Per-approval defeats the purpose (an approval and a status-change for the same run must serialize).
- **Use Crystal's existing `withLock(mutex-key)` polling loop instead of p-queue.** Rejected: architecture research §4 documents the polling loop's busy-wait CPU cost and the lack of queue introspection. The orchestrator epic (IDEA-006) installs p-queue specifically for this task.

## Lowest Confidence Area

The `socketReply` closure plumbing in step 4. The bridge sends a single JSON write to the IPC client socket, but the closure must be created *inside* `CyboflowPermissionIpcServer`'s data handler (where the `client` and `requestId` are in scope) and passed to `ApprovalRouter.requestApproval`. The factory pattern (`getSocketReplyFor(approvalId)`) is cleanest but adds an indirection. If the executor finds the indirection awkward, an alternative is to pass `socketReply` directly as an argument to `requestApproval` rather than going through the constructor-injected factory. Either works; the contract that matters is "the closure has access to the client socket and is invoked exactly once."
