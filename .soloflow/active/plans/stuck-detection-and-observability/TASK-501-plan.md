---
id: TASK-501
idea: IDEA-011
status: in-flight
created: "2026-05-11T00:00:00Z"
files_owned:
  - main/src/orchestrator/stuckDetector.ts
  - main/src/orchestrator/__tests__/stuckDetector.test.ts
  - main/src/database/migrations/007_add_stuck_reason.sql
  - main/src/orchestrator/index.ts
  - shared/types/stuckDetection.ts
files_readonly:
  - main/src/orchestrator/approvalRouter.ts
  - main/src/database/migrations/006_cyboflow_schema.sql
  - main/src/services/database.ts
  - main/src/services/panels/claude/claudeCodeManager.ts
  - main/src/utils/logger.ts
  - docs/cyboflow_system_design.md
  - .soloflow/active/research/ROADMAP-001-research-architecture.md
  - .soloflow/active/research/ROADMAP-001-research-risks.md
acceptance_criteria:
  - criterion: "Migration `007_add_stuck_reason.sql` adds a nullable `stuck_reason TEXT` column and `stuck_detected_at INTEGER` (unix ms) column to `workflow_runs`, with `IF NOT EXISTS`-style guards so re-runs are idempotent."
    verification: "`grep -E 'stuck_reason|stuck_detected_at' main/src/database/migrations/007_add_stuck_reason.sql` returns both column names; running migrations twice on a fresh DB does not error (verified by integration test in `stuckDetector.test.ts` setup that calls the migration runner twice)."
  - criterion: "`StuckDetector` exposes `start()` and `stop()` lifecycle methods, and `start()` schedules a recurring scan every 60000 ms via `setInterval` whose handle is cleared by `stop()`."
    verification: "Unit test in `stuckDetector.test.ts` uses `vi.useFakeTimers()` (or equivalent), constructs a `StuckDetector`, asserts no scans occurred before `start()`, then advances time 60001 ms and asserts the scan callback fired exactly once; `stop()` clears the interval and no further scans fire."
  - criterion: "Each scan executes the canonical SQL `SELECT * FROM approvals WHERE status = 'pending' AND created_at < ?` where `?` is `now() - 5 * 60 * 1000` (5 minutes in ms)."
    verification: "Unit test seeds two `approvals` rows — one created 4 min ago, one created 6 min ago — runs one scan tick, asserts only the 6-min-old approval is evaluated for stuck classification (verified by inspecting `classifyStaleApproval` call args via spy)."
  - criterion: "`classifyStaleApproval(approval)` returns a `StuckReason` discriminated union with variants: `self_deadlock` (same `run_id` has another pending approval older than the candidate or distinct from it), `cross_run_deadlock` (placeholder heuristic for v1: any other run is also in `awaiting_review` with a pending approval older than 5 min), `orphan_pty` (Claude PTY for the run is no longer in `ClaudeCodeManager.processes`), or `stale_socket` (no permission-socket client connected for the run's session)."
    verification: "`grep -n \"type StuckReason\" shared/types/stuckDetection.ts` returns a discriminated union with exactly those four variant tags; unit tests in `stuckDetector.test.ts` cover all four classification paths with fixture data."
  - criterion: "When a stale approval is classified as stuck, the detector calls a `db.transaction()` that updates `workflow_runs` for the run: `status = 'stuck'`, `stuck_reason = <variant tag>`, `stuck_detected_at = Date.now()` — guarded by `WHERE id = ? AND status = 'awaiting_review'` so a concurrently-canceled run is not revived."
    verification: "Unit test simulates a stale pending approval whose run row is already in `status = 'canceled'`; asserts the transaction's UPDATE returns `changes === 0` and no `stuck` transition occurs; the test inspects the run row after and confirms status is still `canceled`."
  - criterion: "Once a run has transitioned to `stuck`, subsequent scans skip it (no duplicate transitions, no notification re-fires). The detector tracks already-stuck runs by re-checking `status = 'awaiting_review'` on the UPDATE guard."
    verification: "Unit test runs three scan ticks against the same stale approval; asserts the `runs:stuck` event emitter fired exactly once across all three ticks."
  - criterion: "On stuck transition, `StuckDetector` emits a typed `runs:stuck` event on the shared orchestrator `EventEmitter` (or equivalent bus the orchestrator exposes) carrying `{ runId, approvalId, reason, detectedAt }`. The event is the integration point downstream tasks subscribe to."
    verification: "Unit test attaches a listener on the orchestrator's event bus, runs one scan tick that produces a stuck transition, asserts the listener receives exactly one event matching the expected shape."
  - criterion: All scan work runs inside a single try/catch; any thrown error is logged via `main/src/utils/logger.ts` at WARN level and the next scan is still scheduled (a single failed scan must not stop the detector).
    verification: Unit test installs a spy that throws on the first `classifyStaleApproval` call but returns normally on the second; advances fake timers two scan intervals; asserts both scans ran and the logger was called once at WARN.
  - criterion: "`Orchestrator.start()` (in `main/src/orchestrator/index.ts`) constructs a `StuckDetector` and calls `start()`; `Orchestrator.stop()` calls `detector.stop()`. The detector is not constructed by Electron-facing code — orchestrator boundary discipline preserved."
    verification: "`grep -n 'StuckDetector' main/src/orchestrator/index.ts` returns the constructor call and the start/stop wiring; `grep -rn 'electron' main/src/orchestrator/stuckDetector.ts` returns 0 matches."
depends_on: []
estimated_complexity: medium
epic: stuck-detection-and-observability
test_strategy:
  needed: true
  justification: "Stuck detection is a stateful, time-driven service whose correctness depends on conditional classification paths, transition guards, and idempotent scheduling. Each classification variant and each guard is a distinct failure mode worth covering with unit tests."
  targets:
    - behavior: "60-second interval scheduling and stop() cancellation"
      test_file: main/src/orchestrator/__tests__/stuckDetector.test.ts
      type: unit
    - behavior: "5-minute threshold filtering of pending approvals"
      test_file: main/src/orchestrator/__tests__/stuckDetector.test.ts
      type: unit
    - behavior: Classification into self_deadlock / cross_run_deadlock / orphan_pty / stale_socket
      test_file: main/src/orchestrator/__tests__/stuckDetector.test.ts
      type: unit
    - behavior: Stuck transition is no-op when run is not in awaiting_review (status guard)
      test_file: main/src/orchestrator/__tests__/stuckDetector.test.ts
      type: unit
    - behavior: Already-stuck runs are not re-transitioned on subsequent scans
      test_file: main/src/orchestrator/__tests__/stuckDetector.test.ts
      type: unit
    - behavior: Scan error in one tick does not stop the interval
      test_file: main/src/orchestrator/__tests__/stuckDetector.test.ts
      type: unit
    - behavior: "runs:stuck event is emitted on the orchestrator event bus on transition"
      test_file: main/src/orchestrator/__tests__/stuckDetector.test.ts
      type: unit
---
# Periodic stuck-state detector with deadlock classification

## Objective

Build the orchestrator-side `StuckDetector` service that runs every 60 seconds, scans for `approvals` pending longer than 5 minutes, classifies the failure into one of four deadlock variants (`self_deadlock`, `cross_run_deadlock`, `orphan_pty`, `stale_socket`), and transitions the affected `workflow_runs` row to `status = 'stuck'` with a `stuck_reason` and `stuck_detected_at` timestamp. Emits a typed `runs:stuck` event on the orchestrator event bus that downstream tasks (UI surface, notification, inspector) subscribe to. This is the backend foundation for the entire epic.

## Implementation Steps

1. Create migration `main/src/database/migrations/007_add_stuck_reason.sql`. Use the pattern from existing inline migrations (the runner does `PRAGMA table_info()` checks rather than `IF NOT EXISTS` on `ALTER`, so emit two `ALTER TABLE workflow_runs ADD COLUMN stuck_reason TEXT` and `ADD COLUMN stuck_detected_at INTEGER` statements guarded by a `SELECT` for existing columns, mirroring `main/src/database/migrations/add_archived_field.sql` style). Index `workflow_runs(status, stuck_detected_at)` for queue-card queries.
2. Create `shared/types/stuckDetection.ts` exporting the `StuckReason` discriminated union (`{ kind: 'self_deadlock' } | { kind: 'cross_run_deadlock', conflictingRunId: string } | { kind: 'orphan_pty' } | { kind: 'stale_socket' }`) plus the `StuckDetectedEvent` shape. Both `main/` and `frontend/` will import from here.
3. Create `main/src/orchestrator/stuckDetector.ts`. Constructor takes `{ db: DatabaseService, claudeManager: ClaudeCodeManager, permissionServer: PermissionIpcServer, eventBus: EventEmitter, logger: Logger }`. No Electron imports — the boundary discipline is non-negotiable per `docs/cyboflow_system_design.md` §6.3.
4. Implement `start()` that calls `setInterval(this.scan, 60_000)` and stores the handle on `this`. Implement `stop()` that calls `clearInterval` and nulls the handle.
5. Implement `scan()` as `private async`. Body: prepared statement `SELECT * FROM approvals WHERE status = 'pending' AND created_at < ?` with `Date.now() - 5 * 60 * 1000`. For each row, call `classifyStaleApproval(approval)`.
6. Implement `classifyStaleApproval(approval)`. Logic order (first match wins):
   - **`orphan_pty`** if `this.claudeManager.processes.has(approval.session_id) === false`
   - **`stale_socket`** if `this.permissionServer.hasClientForSession(approval.session_id) === false` (add a thin `hasClientForSession` method to `PermissionIpcServer` — see step 7 caveat)
   - **`self_deadlock`** if `SELECT COUNT(*) FROM approvals WHERE run_id = ? AND status = 'pending' AND id != ?` > 0
   - **`cross_run_deadlock`** (v1 heuristic) if `SELECT id FROM workflow_runs WHERE status = 'awaiting_review' AND id != ? LIMIT 1` returns a row — record that `conflictingRunId`
   - else: return null (do not transition; not deterministically stuck)
7. **Caveat on `permissionServer.hasClientForSession`:** if adding to `PermissionIpcServer` would expand scope beyond this task's `files_owned`, instead implement the check by inspecting the orchestrator's own `ApprovalRouter` (which TASK-509 / `approval-router-and-permission-fix` epic owns) via a method already exposed on it — `approvalRouter.hasOpenSocketForRun(runId)`. If neither method exists, default the `stale_socket` classification to `false` and log a one-time WARN; the other three classifications are sufficient for first detection.
8. Implement the transition: when classification returns non-null, run a `db.transaction()` that executes:
   ```sql
   UPDATE workflow_runs
   SET status = 'stuck', stuck_reason = ?, stuck_detected_at = ?
   WHERE id = ? AND status = 'awaiting_review'
   ```
   Check `info.changes` — only emit the event if `changes === 1`. This is the idempotency guard.
9. Emit `eventBus.emit('runs:stuck', { runId, approvalId, reason, detectedAt })` after a successful transition. Type the payload using `shared/types/stuckDetection.ts`.
10. Wrap the entire scan in `try { ... } catch (err) { this.logger.warn('[StuckDetector] scan failed', err) }` so a single bad scan does not stop the interval.
11. Wire into `main/src/orchestrator/index.ts` (created by epic `orchestrator-and-trpc-router`, TASK that precedes this one). Add a `private detector?: StuckDetector` field on the `Orchestrator` class; construct and `start()` it in `Orchestrator.start()` after the event bus and DB are wired; call `detector.stop()` in `Orchestrator.stop()`. If `main/src/orchestrator/index.ts` does not yet contain a clean lifecycle, this task adds the minimum hooks for the detector without refactoring unrelated wiring.
12. Write unit tests in `main/src/orchestrator/__tests__/stuckDetector.test.ts` covering each `acceptance_criteria` test target. Use `vi.useFakeTimers()` for interval testing. Use an in-memory `better-sqlite3` instance with migrations applied for DB-touching tests.

## Acceptance Criteria

Each criterion above must pass with the exact verification command. Highlight: the `stuck_reason` column MUST be added by `007_add_stuck_reason.sql` (not retrofitted into `006_cyboflow_schema.sql`, which is owned by a different epic) so migration ordering remains the migration-runner's responsibility. The detector MUST emit the `runs:stuck` event on the orchestrator's shared `EventEmitter` so TASK-502 / 503 / 504 can subscribe without further plumbing.

## Test Strategy

Seven test targets in one file (`stuckDetector.test.ts`):

1. **Scheduling**: `vi.useFakeTimers()`; assert one scan after 60001 ms, two after 120001 ms; `stop()` halts further scans.
2. **5-minute filter**: insert two approvals — one 4 min old, one 6 min old — assert only the 6-min one reaches `classifyStaleApproval`.
3. **Four classification variants**: four fixture-driven tests, one per variant. Each sets up the DB / `claudeManager.processes` map / approvalRouter mock to satisfy exactly one variant, then asserts the returned reason kind.
4. **Status guard**: insert a stale pending approval where the `workflow_runs.status` is already `canceled`; assert no transition fires.
5. **Idempotency**: same stale approval across three scan ticks; assert exactly one `runs:stuck` event.
6. **Error isolation**: classifier throws on tick 1, succeeds on tick 2; assert logger.warn called once and tick 2 still ran.
7. **Event emission shape**: attach listener, run one stuck transition, assert payload matches `StuckDetectedEvent`.

Setup: in-memory `better-sqlite3`, manual migration application (use the project's migration runner against a fresh `:memory:` DB to ensure 006 and 007 both apply). Tear-down: `stop()` the detector and close the DB.

## Hardest Decision

How precisely to model `cross_run_deadlock` in v1. A literal "Run A's reviewer is itself Run B which is awaiting Run A's approval" check requires a reviewer-identity concept that does not exist in the data model (every reviewer is the local human, not another run). Two options were considered:

1. **Drop the variant entirely**, ship only self_deadlock / orphan_pty / stale_socket. This is honest but does not match the design doc's §5.7 language ("cross-run deadlock detection").
2. **Use a v1 heuristic**: if any other run is also in `awaiting_review` with a stale approval, label this one `cross_run_deadlock`. This is technically a false-positive-prone heuristic — two runs simultaneously awaiting human attention is not actually a deadlock — but it surfaces the "you have multiple stuck things at once, look at the queue" signal, which is the user-actionable outcome the design doc describes.

Chose option 2. The user-visible behavior (a stuck flag pointing at a specific other run) is correct enough for v1; the literal deadlock semantics are out of scope until reviewer-identity is modeled (likely never in v1, possibly never at all).

## Rejected Alternatives

- **Trigger-based detection (DB trigger on approvals INSERT/UPDATE).** Would fire instantly instead of polling every 60s. Rejected: SQLite triggers cannot emit events into Node land without a polling layer anyway, so the trigger only saves the SELECT cost. The IDEA's 60s assumption is also explicit. Reconsider if `raw_events` growth makes the periodic SELECT expensive.
- **Per-run timer instead of one global interval.** A `setTimeout(_, 5*60*1000)` per pending approval would be more precise. Rejected: requires lifecycle bookkeeping (cancel timer on decision) that duplicates the `approvals.status` machinery, and the 60s polling latency is irrelevant when the threshold itself is 5 minutes.
- **Configurable threshold/interval surface.** Rejected for v1 — both are tunable constants in code per IDEA-011 assumption "tunable post-MVP."

## Lowest Confidence Area

The `cross_run_deadlock` heuristic (Hardest Decision above) is the noisiest part of this plan — it may produce false positives during normal high-volume sprint+prune days where two runs are simply both awaiting human attention without any actual deadlock relationship. The notification-collapse work in TASK-503 partially mitigates the user-visible noise (only first stuck per session fires), but the inspector view in TASK-504 will need to show the `conflictingRunId` honestly even when there is no real circular dependency. If the heuristic proves unhelpful during the 1-day self-host, the fallback is to drop the variant and ship only self/orphan/stale — the schema and event shape accommodate that.
