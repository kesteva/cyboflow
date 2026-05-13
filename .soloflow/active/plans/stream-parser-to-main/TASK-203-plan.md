---
id: TASK-203
idea: IDEA-005
idea_id: IDEA-005
status: in-flight
created: "2026-05-11T00:00:00Z"
files_owned:
  - main/src/services/streamParser/rawEventsSink.ts
  - main/src/services/streamParser/__tests__/rawEventsSink.test.ts
files_readonly:
  - main/src/services/streamParser/streamParser.ts
  - main/src/services/streamParser/eventRouter.ts
  - main/src/services/streamParser/typedEventNarrowing.ts
  - main/src/database/database.ts
  - main/src/database/migrations/006_cyboflow_schema.sql
  - .soloflow/active/research/ROADMAP-001-research-risks.md
  - .soloflow/active/research/ROADMAP-001-research-architecture.md
acceptance_criteria:
  - criterion: "main/src/services/streamParser/rawEventsSink.ts exports a RawEventsSink class with constructor (db, logger?) and method attachToRouter(router, runId)."
    verification: "grep -n \"export class RawEventsSink\" main/src/services/streamParser/rawEventsSink.ts returns 1 match; grep -n \"attachToRouter\" main/src/services/streamParser/rawEventsSink.ts returns at least 1 match."
  - criterion: "Every event emitted by EventRouter for the attached runId is persisted as one row in the raw_events table. The row includes run_id, event_type (top-level 'type' discriminant), event_subtype (where applicable, e.g. 'init' for system, 'success' for result), payload_json (full event as JSON string), and a monotonically-increasing local id assigned by SQLite."
    verification: "pnpm --filter main test -- rawEventsSink.test.ts passes; integration test uses an in-memory better-sqlite3 DB seeded with the raw_events schema from 006_cyboflow_schema.sql, attaches a RawEventsSink, dispatches 5 mixed-variant events through the router, and asserts SELECT COUNT(*) FROM raw_events WHERE run_id = ? returns 5 with correct event_type and payload_json round-trip."
  - criterion: "Insert errors (e.g., DB lock, constraint violation) are logged at WARN level and do NOT propagate as exceptions. The sink continues processing subsequent events after a failed insert."
    verification: "pnpm --filter main test -- rawEventsSink.test.ts passes; failure-mode test mocks db.prepare().run() to throw on the third call, dispatches 5 events, asserts 4 rows persisted (events 1, 2, 4, 5), exactly one logger.warn call, and no thrown exception."
  - criterion: "The 'unknown' variant from TypedEventNarrowing is persisted with event_type='unknown' and the original parsed payload preserved in payload_json. This makes future replay possible if the schema gains new variants."
    verification: "pnpm --filter main test -- rawEventsSink.test.ts passes; test dispatches { kind: 'unknown', raw: { type: 'future_variant', foo: 'bar' } }, asserts SELECT event_type, payload_json FROM raw_events shows event_type='unknown' and JSON.parse(payload_json).raw.type === 'future_variant'."
  - criterion: "Sink is dispose()-able: calling sink.dispose() detaches the EventRouter listener and stops further inserts. Re-dispatching events after dispose results in zero new rows."
    verification: "pnpm --filter main test -- rawEventsSink.test.ts passes; test attaches sink, dispatches 2 events (2 rows), calls dispose(), dispatches 2 more events, asserts still 2 rows in raw_events."
depends_on:
  - TASK-201
estimated_complexity: low
epic: stream-parser-to-main
test_strategy:
  needed: true
  justification: "RawEventsSink is the persistence boundary for the entire event-sourcing system. A silent insert failure means lost audit log and broken projection replay (the design's recovery mechanism). The fail-soft contract (log warn, never throw) must be tested explicitly because it inverts the normal 'errors propagate' default."
  targets:
    - behavior: "Happy path: 5 mixed events → 5 rows persisted with correct event_type, event_subtype, and payload_json."
      test_file: main/src/services/streamParser/__tests__/rawEventsSink.test.ts
      type: integration
    - behavior: "DB insert error → log warn, continue, no exception. 5 events with 1 forced failure → 4 rows persisted."
      test_file: main/src/services/streamParser/__tests__/rawEventsSink.test.ts
      type: integration
    - behavior: "Unknown variant → event_type='unknown', original payload preserved."
      test_file: main/src/services/streamParser/__tests__/rawEventsSink.test.ts
      type: integration
    - behavior: dispose() detaches listener; subsequent events not persisted.
      test_file: main/src/services/streamParser/__tests__/rawEventsSink.test.ts
      type: integration
---
# Append every parsed event to raw_events table

## Objective

Persist every typed event from the parser pipeline to the `raw_events` audit table as an append-only log. This makes `raw_events` the single source of truth that downstream projections (messages, approvals, usage accumulator) read from, enabling replay if reducer logic changes. The sink must be fail-soft: an insert error logs a warning and the pipeline continues — losing the orchestrator to a transient DB lock is worse than losing one audit row.

## Implementation Steps

1. Create `main/src/services/streamParser/rawEventsSink.ts`. Export class `RawEventsSink` with constructor `(db: Database, logger?: Logger)` where `Database` is the `better-sqlite3` type. Inside, prepare the INSERT statement once at construction time (better-sqlite3 best practice): `this.insertStmt = db.prepare('INSERT INTO raw_events (run_id, event_type, event_subtype, payload_json, created_at) VALUES (?, ?, ?, ?, ?)')`.

2. Implement `attachToRouter(router: EventRouter, runId: string): void`. Subscribe via `router.onRun(runId, (event) => this.handleEvent(runId, event))` and store the teardown function returned by `onRun` (TASK-201 spec) on a private map keyed by runId for later `dispose()` use.

3. Implement `private handleEvent(runId: string, event: ClaudeStreamEvent): void`. Determine `event_type` and `event_subtype` from the typed union: for `{ kind: 'unknown', raw }` use `event_type='unknown'` and `event_subtype=null`; for typed variants extract `type` and `subtype` (where present — `system` and `result` have subtypes; `assistant`, `user`, `stream_event` do not). Serialize the full event with `JSON.stringify(event)`. Wrap the insert in try/catch — on catch, `logger?.warn('[rawEventsSink] insert failed for runId=' + runId + ': ' + err.message)` and return. Never re-throw.

4. Use the current ISO timestamp for `created_at`: `new Date().toISOString()`. Better-sqlite3 stores it as TEXT in the column.

5. Implement `dispose(runId?: string): void`. If runId provided, look up the stored teardown function and call it. If no runId, iterate all stored teardowns. Clear the internal map. Idempotent: calling dispose twice is a no-op.

6. Write `main/src/services/streamParser/__tests__/rawEventsSink.test.ts` using vitest. Use an in-memory better-sqlite3 (`new Database(':memory:')`) and apply the raw_events table schema from `006_cyboflow_schema.sql` (TASK from IDEA-004's family — listed in `files_readonly`). If that migration file does not exist at task-start time, inline the table DDL: `CREATE TABLE raw_events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, event_type TEXT NOT NULL, event_subtype TEXT, payload_json TEXT NOT NULL, created_at TEXT NOT NULL)` and add a TODO referencing IDEA-004 to switch to the migration once landed. The schema MUST match the IDEA-004 migration exactly — coordinate via the readonly reference.

## Acceptance Criteria

- Each typed event written to the EventRouter for the attached runId results in exactly one INSERT into `raw_events`.
- The `event_type` column holds the top-level discriminant ('system' | 'assistant' | 'user' | 'result' | 'stream_event' | 'unknown'). The `event_subtype` column holds the sub-discriminant where applicable ('init' | 'api_retry' | 'compact' for system; 'success' | 'error_max_turns' | 'error_max_budget_usd' | 'error_during_execution' for result; null otherwise).
- The `payload_json` column holds the JSON.stringify of the full typed event (including any `.passthrough()` extra fields preserved by Zod).
- Insert failures log a warn and do NOT throw. Pipeline continues processing subsequent events.
- `dispose()` is idempotent and detaches the EventRouter listener.

## Test Strategy

See frontmatter. Use in-memory better-sqlite3 — fast, isolated, no fs side effects. Mandatory tests: happy path (5 events → 5 rows with correct columns), DB-error path (forced throw → continues), unknown-variant path (raw payload preserved), dispose path (no further inserts). The DB-error test is the most load-bearing — it asserts the fail-soft contract that distinguishes this sink from a naive INSERT loop.

## Hardest Decision

Whether to batch inserts inside a transaction for performance or insert per-event. Chose: per-event INSERT with no transaction wrapper. The risks research §8 projects ~115k events/day; even at 30 events/min/run with 8 runs, that's 4 inserts/sec — better-sqlite3 handles this trivially without batching, and per-event INSERT keeps the audit-log contract clean ("every event is durable the moment it arrives" rather than "events arrive in batches and may be lost on crash"). A future optimization could add a write-behind buffer with `BEGIN IMMEDIATE`, but day-1 simplicity wins.

## Rejected Alternatives

- **Write events to a JSONL file instead of SQLite.** Rejected — projections (messages, approvals) need SQL queries against the audit log for replay, and the design doc commits to SQLite as the audit-log store.
- **Drop the unknown variant from persistence.** Rejected — the explicit purpose of `{ kind: 'unknown', raw }` is to preserve future variants for replay. Dropping it makes the audit log non-recoverable if Anthropic adds a new event type mid-session.
- **Re-throw insert errors.** Rejected — the parser pipeline is the orchestrator's hot path. A DB hiccup (e.g., WAL checkpoint mid-write) becoming an unhandled exception kills the orchestrator process per the risks research §10 hang scenarios.

## Lowest Confidence Area

The exact column names and types of the `raw_events` table. They are specified in IDEA-004's task family (`006_cyboflow_schema.sql`), which has not been refined yet. I've encoded the columns I infer from the design doc and architecture research §8: `id`, `run_id`, `event_type`, `event_subtype`, `payload_json`, `created_at`. If IDEA-004's executor names them differently (e.g., `kind` instead of `event_type`, or omits `event_subtype`), the prepared statement in step 1 and the per-column extraction in step 3 need to be reconciled. The `files_readonly` reference to the migration file makes this dependency explicit; the executor should re-read it after IDEA-004 completes and adjust.
