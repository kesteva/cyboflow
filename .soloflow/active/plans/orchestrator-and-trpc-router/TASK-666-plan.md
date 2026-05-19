---
id: TASK-666
idea: IDEA-SPRINT-022-compound
status: ready
created: 2026-05-19T00:00:00Z
files_owned:
  - main/src/orchestrator/runEventBridge.ts
  - main/src/orchestrator/__tests__/runEventBridge.test.ts
files_readonly:
  - main/src/orchestrator/runExecutor.ts
  - main/src/orchestrator/__tests__/runExecutor.test.ts
acceptance_criteria:
  - criterion: "BridgeEventsOptions.db is declared optional (`db?: Database.Database`) in the type definition."
    verification: "grep -n 'db?: Database.Database' main/src/orchestrator/runEventBridge.ts returns exactly one match on the BridgeEventsOptions interface."
  - criterion: "bridgeEvents() throws a descriptive Error synchronously when skipPersistence is falsy (false, undefined, or absent) AND db is undefined. The error message names both `db` and `skipPersistence` so the caller can resolve it without reading source."
    verification: "Read runEventBridge.ts: an explicit guard appears in bridgeEvents() before any use of db, throws with a message containing both 'db' and 'skipPersistence'. A new unit test 'throws when db is undefined and skipPersistence is not true' covers all three falsy cases (false, undefined, omitted) and passes."
  - criterion: "When skipPersistence: true AND db is undefined, bridgeEvents() does not throw and the bridge functions normally (listener attached, publish fires, onFirstMessage fires)."
    verification: "Unit test '(f) skipPersistence: true with db omitted works end-to-end' constructs the bridge without passing db, emits one output event, asserts the publisher saw the envelope and onFirstMessage fired."
  - criterion: "The five existing skipPersistence tests at runEventBridge.test.ts lines 557-685 that use a throwing-stub `as unknown as Database.Database` (cases a, b, e) drop the `db` field from their bridgeEvents() options entirely. The two cases that intentionally use a real DB to verify zero rows (c, dual-pipeline guarantee at lines 607-625 and 699-739) keep their real DB — they assert against it."
    verification: "grep -nc 'db.prepare must not be called' main/src/orchestrator/__tests__/runEventBridge.test.ts returns 0 (the throwing-stub literal is gone from the file). The cases (a) at 557, (b) at 580, and (e) at 657 each call bridgeEvents() without a `db:` field."
  - criterion: "The JSDoc above the `db` field in BridgeEventsOptions documents the new conditional contract: required when skipPersistence is falsy; ignored when skipPersistence is true; optional in the type so callers can omit it in the skipPersistence-true case."
    verification: "Read lines around the `db?: Database.Database` declaration; the JSDoc clearly states the runtime guard and the back-compat rationale."
  - criterion: "All runEventBridge.test.ts cases pass, including the new test for the runtime guard and the new test for db-omitted success path."
    verification: "Run `pnpm --filter main test -- --run main/src/orchestrator/__tests__/runEventBridge.test.ts` and confirm exit 0."
  - criterion: "runExecutor.ts is unchanged in behaviour — its existing call site at runExecutor.ts:328 (passes `db: this.db`) still compiles and still works. We do not require it to drop the field; the optionality is at the type boundary, not the call site."
    verification: "grep -n 'db: this.db' main/src/orchestrator/runExecutor.ts returns the existing call site; `pnpm --filter main test -- --run main/src/orchestrator/__tests__/runExecutor.test.ts` exits 0; `pnpm typecheck` exits 0."
depends_on: []
estimated_complexity: low
epic: orchestrator-and-trpc-router
test_strategy:
  needed: true
  justification: "This task changes the runtime contract of a public function (bridgeEvents). The new optional-with-guard semantics need explicit coverage to lock in (a) the back-compat invariant (still throws when production callers forget db) and (b) the new omit-db ergonomic. Both must be tested directly; sibling-test scan confirms runEventBridge.test.ts is the canonical home and already has the (a)-(e) skipPersistence describe block that this work amends."
  targets:
    - behavior: "bridgeEvents() throws a descriptive error when db is undefined and skipPersistence is not true. Cover all three forms: { skipPersistence: false, db: undefined }, { skipPersistence: undefined, db: undefined }, and omitting both."
      test_file: "main/src/orchestrator/__tests__/runEventBridge.test.ts"
      type: unit
    - behavior: "bridgeEvents() with skipPersistence: true and db omitted constructs successfully and the publish/onFirstMessage path still fires on an output event."
      test_file: "main/src/orchestrator/__tests__/runEventBridge.test.ts"
      type: unit
    - behavior: "The existing 5 skipPersistence cases ((a), (b), (c), (d), (e), and the dual-pipeline guarantee) all continue to pass — three of them are updated to omit `db` from their options object, two retain a real DB for row-count assertions."
      test_file: "main/src/orchestrator/__tests__/runEventBridge.test.ts"
      type: unit
---

# Make BridgeEventsOptions.db optional when skipPersistence is true

## Objective

Express the existing "db is unused when skipPersistence === true" runtime invariant in the TypeScript type so callers can omit `db` entirely rather than fabricate a throwing stub or allocate an unused `:memory:` database. Add a synchronous runtime guard that preserves the back-compat guarantee for production callers (which always supply `db` because they need persistence). The five test cases added in TASK-664 that currently pass `{ prepare: () => { throw … } } as unknown as Database.Database` get simpler — `db` is just absent.

## Implementation Steps

1. **Make `db` optional in `BridgeEventsOptions`.** Edit `main/src/orchestrator/runEventBridge.ts` line 45:
   - Change `db: Database.Database;` to `db?: Database.Database;`.
   - Replace the existing JSDoc above it (currently lines 44 + 71-74's combined comment) with a single coherent block explaining the conditional contract. Example:
     ```ts
     /**
      * better-sqlite3 database handle used by RawEventsSink for INSERTs.
      *
      * Required when `skipPersistence` is falsy (the default — production callers
      * always supply it because they want raw_events persistence). MAY be omitted
      * when `skipPersistence === true`; in that mode the bridge constructs no
      * EventRouter/RawEventsSink and never touches `db`, so callers (e.g.
      * renderer-only forwarders) need not allocate one.
      *
      * The optionality is enforced at the type level and additionally guarded at
      * runtime in `bridgeEvents()` — see the early throw below — so back-compat
      * is preserved for callers that forget to set `skipPersistence` while also
      * omitting `db`.
      */
     db?: Database.Database;
     ```

2. **Add the runtime guard inside `bridgeEvents()`.** Edit `main/src/orchestrator/runEventBridge.ts` between line 136 (end of the destructuring block) and line 138 (`const narrowing: TypedEventNarrowing = …`). Insert:

   ```ts
   // Guard: db is optional in the type to support skipPersistence callers, but
   // when persistence IS active (the default for production), db is required.
   // Throw synchronously with a descriptive message so misconfigured callers
   // fail loudly at construction rather than silently producing a no-op bridge.
   if (opts.skipPersistence !== true && db === undefined) {
     throw new Error(
       '[runEventBridge] bridgeEvents() requires `db` unless `skipPersistence: true` is set. ' +
       'Production callers MUST supply a better-sqlite3 database; set `skipPersistence: true` ' +
       'only when a parallel pipeline already owns raw_events persistence for this run.',
     );
   }
   ```

   Place this BEFORE the `narrowing` construction so the guard fires on the cheap path. Do NOT move it inside the `if (opts.skipPersistence === true)` branch at line 147 — the guard must fire on the legacy path where the bug it prevents lives.

3. **Sweep the existing `skipPersistence` test cases that fabricate a throwing stub.** Edit `main/src/orchestrator/__tests__/runEventBridge.test.ts`:

   - Case (a) at line 557: delete lines 559-561 (the `stubDb` declaration) and remove `db: stubDb,` from the options object at line 571.
   - Case (b) at line 580: delete lines 581-583 (the `stubDb` declaration) and remove `db: stubDb,` from the options object at line 593.
   - Case (e) at line 657: delete lines 658-660 (the `stubDb` declaration) and remove `db: stubDb,` from the options object at line 670.
   - Do NOT touch case (c) at line 607 — it intentionally allocates a real DB via `makeDb()` (or `makeRawEventsDb()` after TASK-665) to assert that zero rows persist; that assertion only works against a real DB.
   - Do NOT touch case (d) at line 631 — it sets `skipPersistence: false` and asserts 5 rows persist; the real DB is load-bearing.
   - Do NOT touch the dual-pipeline test at line 699 — it allocates a real DB to assert exactly 1 row from the CCM-side sink.

   After this sweep, `grep -nc 'db.prepare must not be called' main/src/orchestrator/__tests__/runEventBridge.test.ts` MUST return 0 (the literal string from the deleted stubs is gone). Run this grep as a completeness gate.

4. **Add new test case: runtime guard fires when db is undefined and skipPersistence is not true.** Inside the `describe('skipPersistence', …)` block in `runEventBridge.test.ts` (the block at line 549), append the following case:

   ```ts
   it('(f) bridgeEvents throws when db is undefined and skipPersistence is not true', () => {
     const { asPublisher } = makePublisher();
     const src = new EventEmitter();

     // (i) skipPersistence: false explicit, no db → throws
     expect(() =>
       bridgeEvents({ runId: SP_RUN_ID, source: src, publisher: asPublisher, skipPersistence: false }),
     ).toThrow(/db.*skipPersistence|skipPersistence.*db/);

     // (ii) skipPersistence omitted, no db → throws
     expect(() =>
       bridgeEvents({ runId: SP_RUN_ID, source: src, publisher: asPublisher }),
     ).toThrow(/db.*skipPersistence|skipPersistence.*db/);
   });
   ```

5. **Add new test case: db-omitted success path with skipPersistence true.** Append to the same `describe('skipPersistence', …)` block:

   ```ts
   it('(g) skipPersistence: true with db omitted: bridge functions normally', () => {
     const onFirstMessage = vi.fn();
     const { publish, asPublisher } = makePublisher();
     const src = new EventEmitter();

     // No db field in options at all.
     bridgeEvents({
       runId: SP_RUN_ID,
       source: src,
       publisher: asPublisher,
       skipPersistence: true,
       onFirstMessage,
     });

     emitOutput(src, SP_RUN_ID, systemEvent);

     expect(publish).toHaveBeenCalledOnce();
     expect(onFirstMessage).toHaveBeenCalledOnce();
   });
   ```

6. **Leave `runExecutor.ts` untouched.** The call site at `runExecutor.ts:328` (`db: this.db`) still compiles and still works after this change — `db: this.db` satisfies an optional field just as well as a required one. The compounder's suggestion to "drop its own db pass-through" is rejected because doing so would force every production caller into the omit-db ergonomic, which we don't want — production callers MUST supply db precisely so the guard fires when persistence is on. Document this in code-review comments only; no edits.

7. **Run typecheck and the affected test file.**
   ```
   pnpm typecheck
   pnpm --filter main test -- --run main/src/orchestrator/__tests__/runEventBridge.test.ts main/src/orchestrator/__tests__/runExecutor.test.ts
   ```
   Both must exit 0.

## Acceptance Criteria

- `db` is optional in `BridgeEventsOptions`; the runtime guard catches misuse on the legacy path.
- Three of the five existing `skipPersistence` test cases drop the throwing-stub workaround.
- Two new test cases lock in the new contract: one for the guard, one for the omit-db happy path.
- No production code outside `runEventBridge.ts` is modified.

## Test Strategy

See `test_strategy` in frontmatter. Targets:
1. Two new cases inside `describe('skipPersistence', …)` covering the guard and the omit-db path.
2. Edits to the existing (a), (b), (e) cases to use the new ergonomic.

No mocking infrastructure needed beyond what the file already has (`EventEmitter`, `makePublisher`, `emitOutput`).

## Hardest Decision

**Whether the guard should be an Error throw or a no-op (skip-bridging) with a warn log.** Chose throw. Reasoning: production callers in cyboflow always intend persistence — silently downgrading to a no-op bridge would mask the missing-`db` bug as "events just don't show up", which is the worst possible failure mode for a stream pipeline. A throw is loud, fails at construction time (not at first event), and is consistent with the back-compat-holdover JSDoc at line 72-74 which described `db` as required even though TypeScript only enforced it. Tests that needed a throwing stub were doing this by accident; the guard makes the intent explicit.

A future iteration could downgrade to a warn-and-no-op if a non-orchestrator caller ever legitimately wants "construct a bridge for visibility but I don't have a DB and I forgot skipPersistence"; nothing about this design precludes that. Today, no such caller exists.

## Rejected Alternatives

- **Discriminated-union type for BridgeEventsOptions** (e.g. `{ skipPersistence: true } | { skipPersistence?: false; db: Database.Database }`). Rejected: the option set has 6 optional sibling fields (`router`, `sink`, `narrowing`, `logger`, `onFirstMessage`); splitting into a union would require duplicating all of them across two branches and would significantly worsen the call-site ergonomics for the common production case. The runtime guard captures the same invariant at a fraction of the type-system cost.
- **Drop db entirely from the type and look it up via a separate Persistence option.** Rejected: bigger refactor than the problem warrants; the JSDoc fix and the optional `?` already convey the contract.
- **Auto-create an in-memory DB when skipPersistence: false and db is undefined.** Rejected: silently hiding the misconfig is exactly the failure mode the guard prevents.

## Lowest Confidence Area

The regex `/db.*skipPersistence|skipPersistence.*db/` in case (f) is intentionally permissive (either order). The implementer may prefer two separate `expect(...).toThrow(/db/i); expect(...).toThrow(/skipPersistence/i);` chains for clarity; either form is acceptable as long as both substrings are guaranteed to appear in the error. Match the project's style if `runEventBridge.test.ts` has a precedent.
