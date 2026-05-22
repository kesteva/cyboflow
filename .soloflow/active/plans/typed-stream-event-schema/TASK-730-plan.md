---
id: TASK-730
idea: FIND-SPRINT-032-2
status: ready
created: "2026-05-22T00:00:00Z"
files_owned:
  - main/src/services/panels/claude/claudeCodeManager.ts
  - main/src/services/panels/claude/__tests__/claudeCodeManagerWiring.test.ts
files_readonly:
  - main/src/services/streamParser/typedEventNarrowing.ts
  - main/src/services/streamParser/index.ts
  - main/src/services/streamParser/eventRouter.ts
  - main/src/orchestrator/runEventBridge.ts
  - main/src/services/cliManagerFactory.ts
  - shared/types/claudeStream.ts
  - main/src/services/panels/claude/__tests__/claudeCodeManager.killProcess.test.ts
  - .soloflow/active/findings/SPRINT-032-findings.md
  - .soloflow/archive/done/typed-stream-event-schema/TASK-729-done.md
acceptance_criteria:
  - criterion: "`ClaudeCodeManager` constructs a `TypedEventNarrowing` instance (either internally or via constructor injection) and assigns it to a `private readonly narrowing` field."
    verification: "grep -nE 'private (readonly )?narrowing' main/src/services/panels/claude/claudeCodeManager.ts returns ≥1 match AND grep -nE 'TypedEventNarrowing' main/src/services/panels/claude/claudeCodeManager.ts returns ≥1 match"
  - criterion: The cast `event as unknown as ClaudeStreamEvent` no longer appears anywhere in `main/src/services/panels/claude/claudeCodeManager.ts`.
    verification: "grep -n 'as unknown as ClaudeStreamEvent' main/src/services/panels/claude/claudeCodeManager.ts returns 0 matches"
  - criterion: "Inside `runSdkQuery`, every value passed to `router.emitForRun` is the return value of `this.narrowing.narrow(...)` (no raw SDK event flows into the router unvalidated)."
    verification: "Manual read of main/src/services/panels/claude/claudeCodeManager.ts confirms the for-await loop calls `const typed = this.narrowing.narrow(event)` (or equivalent) immediately before `router.emitForRun(runId, typed)`."
  - criterion: "The JSDoc block at the former cast site (the 4-line comment ending in 'system/init, assistant, user, result, stream_event' that justified the cast) is deleted."
    verification: "grep -n 'same wire-format shape' main/src/services/panels/claude/claudeCodeManager.ts returns 0 matches"
  - criterion: Repo-wide sweep — no other call site has regressed back to the unvalidated emit pattern.
    verification: "grep -rn 'as unknown as ClaudeStreamEvent' main/src returns 0 matches"
  - criterion: "`pnpm typecheck` exits 0."
    verification: pnpm typecheck exits 0
  - criterion: "`pnpm lint` exits 0."
    verification: pnpm lint exits 0
  - criterion: The existing ClaudeCodeManager test files run green (no regression from the wiring change).
    verification: pnpm --filter main test -- main/src/services/panels/claude/__tests__/claudeCodeManagerWiring.test.ts main/src/services/panels/claude/__tests__/claudeCodeManager.killProcess.test.ts exits 0
  - criterion: "A new test in `claudeCodeManagerWiring.test.ts` asserts that when the SDK iterator yields a malformed event (one the Zod schema rejects), the value routed downstream to `RawEventsSink` is the catch-all `{ kind: '__unknown__', raw: ... }` variant rather than the raw cast."
    verification: "grep -nE \"kind:\\s*['\\\"]__unknown__['\\\"]\" main/src/services/panels/claude/__tests__/claudeCodeManagerWiring.test.ts returns ≥1 match AND the test file's new `it()` block name references 'narrow' or 'TypedEventNarrowing' or 'unknown variant'."
depends_on: []
estimated_complexity: low
epic: typed-stream-event-schema
test_strategy:
  needed: true
  justification: "Sibling test exists at main/src/services/panels/claude/__tests__/claudeCodeManagerWiring.test.ts and already exercises the SDK-mock → router pipeline via its query() mock — exactly the seam we are tightening. Adding one regression test there is cheap, prevents anyone from re-introducing the raw cast under a different name, and locks in the load-bearing behavior FIND-SPRINT-032-2 calls out: malformed SDK events MUST land in raw_events as `__unknown__`, not as a TS-trusted but Zod-invalid shape."
  targets:
    - behavior: "When ClaudeCodeManager.runSdkQuery's SDK iterator yields a malformed event (one the Zod schema rejects — e.g. `{ type: 'completely_unknown_variant_xyz' }`), the value routed through EventRouter to RawEventsSink is the `{ kind: '__unknown__', raw }` catch-all, not the raw object."
      test_file: main/src/services/panels/claude/__tests__/claudeCodeManagerWiring.test.ts
      type: unit
    - behavior: "Existing happy-path test (`yield { type: 'result', subtype: 'success' }`) continues to flow through the narrower unchanged — the narrower returns the typed `result` event, not `__unknown__`."
      test_file: main/src/services/panels/claude/__tests__/claudeCodeManagerWiring.test.ts
      type: unit
---
# Converge ClaudeCodeManager.runSdkQuery onto TypedEventNarrowing

## Objective

Close the load-bearing validation gap at `main/src/services/panels/claude/claudeCodeManager.ts:343`: today `runSdkQuery` raw-casts each SDK event with `event as unknown as ClaudeStreamEvent` before calling `router.emitForRun`, while the parallel renderer-bridge path in `runEventBridge.ts:209` correctly funnels through `TypedEventNarrowing.narrow()`. After TASK-729 grew the streamEventSchema delta union, any future SDK variant the Zod schema doesn't yet accept silently flows through `ClaudeCodeManager` as if it were a known type, lands in `raw_events` mislabeled, and is trusted by downstream consumers with the wrong TS type. Convergence: own a `TypedEventNarrowing` in the manager and route every emit through `narrow()`. The narrower is fail-soft (returns `{ kind: '__unknown__', raw }` on Zod failure), so it cannot break the SDK iterator loop.

## Implementation Steps

1. **Pre-flight grep sanity check.** Run `grep -rn 'as unknown as ClaudeStreamEvent' main/src` and confirm exactly one match (line 343 of `claudeCodeManager.ts`). If any other site has regressed back into the same pattern, stop and re-scope — this plan owns the single known site only.

2. **Edit `main/src/services/panels/claude/claudeCodeManager.ts` — add the import.** In the import block at lines 18–22, change `import { EventRouter, RawEventsSink } from '../../streamParser';` to also pull in `TypedEventNarrowing`:
   ```ts
   import { EventRouter, RawEventsSink, TypedEventNarrowing } from '../../streamParser';
   ```

3. **Add a `narrowing` field to the class.** Right after the `cachedNodePath` field (around line 117), add:
   ```ts
   /**
    * Narrower owned by this manager. Every SDK event flows through
    * `narrowing.narrow()` before reaching the EventRouter — the single
    * validated boundary into raw_events. Fail-soft: returns
    * `{ kind: '__unknown__', raw }` on Zod failure, never throws.
    *
    * Internal construction (not constructor-injected) keeps cliManagerFactory
    * call sites unchanged. The narrower has no per-instance state besides an
    * optional verbose-logger, so a fresh instance per manager is the right
    * granularity. Tests inject behavior via the SDK query() mock, not the
    * narrower.
    */
   private readonly narrowing: TypedEventNarrowing = new TypedEventNarrowing();
   ```
   Do NOT widen the constructor signature — call sites in `cliManagerFactory.ts:191` and the two test files (`claudeCodeManagerWiring.test.ts`, `claudeCodeManager.killProcess.test.ts`) stay binary-compatible.

4. **Rewrite the for-await loop in `runSdkQuery` (lines 322–356).** Replace the existing emit block (lines 337–355) with:
   ```ts
       // Narrow the raw SDK event to a typed ClaudeStreamEvent.  This is the
       // single validated boundary into raw_events — see TASK-730 / FIND-SPRINT-032-2.
       // narrow() is fail-soft: returns { kind: '__unknown__', raw } on Zod
       // failure, so it cannot break the iterator loop.
       const typed = this.narrowing.narrow(event);

       // Forward the narrowed event to the EventRouter / RawEventsSink pipeline.
       try {
         router.emitForRun(runId, typed);
       } catch (routerErr) {
         this.logger?.warn(`[ClaudeCodeManager] EventRouter emit error: ${routerErr instanceof Error ? routerErr.message : String(routerErr)}`);
       }

       // Forward to AbstractAIPanelManager via 'output' event. The raw `event`
       // is passed to listeners so runEventBridge can run its own narrowing
       // against the same source-of-truth payload (see runEventBridge.ts:209).
       // Do NOT swap to `typed` here: runEventBridge relies on receiving the
       // unvalidated payload so that double-narrowing stays a no-op rather
       // than narrowing-of-already-narrowed.
       this.emit('output', {
         panelId,
         sessionId,
         type: 'json',
         data: event,
         timestamp: new Date()
       });
   ```
   The 4-line JSDoc that previously justified the cast ("The SDK emits typed SDKMessage objects… same wire-format shape…") is gone — the narrower is now self-documenting.

5. **Edit `main/src/services/panels/claude/__tests__/claudeCodeManagerWiring.test.ts` — add the regression test.**
   - In the existing `vi.mock('@anthropic-ai/claude-agent-sdk', ...)` block (around line 45–56), keep the current happy-path mock as the default. Add a way to override per-test by promoting `queryFn`'s yielded sequence to a `vi.hoisted()` variable so individual tests can swap in a malformed event. Concretely: add to the existing `vi.hoisted()` block (or create one) a `sdkYields: vi.fn(async function* () { yield { type: 'result', subtype: 'success' }; })` factory; have the mock invoke it.
   - Add a new `describe('TypedEventNarrowing convergence (TASK-730)', () => { ... })` block at the bottom of the file containing two `it()` cases:
     1. **Malformed event → `__unknown__` lands in raw_events.** Set up the same DB + ApprovalRouter scaffolding the file already uses. Override `sdkYields` to yield `{ type: 'completely_unknown_variant_xyz', timestamp: '2026-05-22T00:00:00Z' }`. Spawn the manager, await `spawnCliProcess`, then `db.prepare('SELECT data FROM raw_events WHERE run_id = ?').get(panelId)` (or equivalent — match the file's existing sink-assertion pattern; if no precedent exists, use `db.prepare('SELECT * FROM raw_events').all()`). Assert at least one row contains `"kind":"__unknown__"` in its `data` column. Reference the sibling test file for the exact `RawEventsSink` column shape.
     2. **Happy path still flows the typed variant.** Default `sdkYields` (yields `{ type: 'result', subtype: 'success' }`). Assert the persisted row's `data` parses to a `result` event (NOT `__unknown__`) — minimal positive regression to prove the narrower didn't drop normal events.

6. **Re-run the completeness gate.** Re-run the step-1 grep — confirm zero matches across `main/src` for `'as unknown as ClaudeStreamEvent'`. Run `pnpm typecheck` and `pnpm lint`. Run the two specific test files in step 5's test_strategy. All four must exit 0.

## Acceptance Criteria

1. **Narrower owned.** `claudeCodeManager.ts` declares a `private readonly narrowing` field constructed as `new TypedEventNarrowing()`. Verified by grep for `private readonly narrowing` and for `TypedEventNarrowing` in the same file.

2. **No cast remains.** The exact string `as unknown as ClaudeStreamEvent` is absent from `claudeCodeManager.ts` (and from `main/src` more broadly).

3. **All emits validated.** `runSdkQuery`'s `router.emitForRun` receives only narrower output. Verified by manual read confirming `const typed = this.narrowing.narrow(event)` appears immediately before the `router.emitForRun(runId, typed)` call.

4. **JSDoc justifying the cast is gone.** The phrase `same wire-format shape` is no longer in the file.

5. **Type/lint/test gates green.** `pnpm typecheck`, `pnpm lint`, and the two ClaudeCodeManager test files all exit 0.

6. **Regression test in place.** `claudeCodeManagerWiring.test.ts` contains a new test asserting that a Zod-malformed SDK event lands in raw_events as `__unknown__`, plus a parallel positive case for the happy path.

## Test Strategy

Two new `it()` blocks in `main/src/services/panels/claude/__tests__/claudeCodeManagerWiring.test.ts` (see frontmatter `test_strategy.targets`):
- One forces the SDK mock to yield a Zod-malformed event and asserts the persisted row in `raw_events` carries `kind: "__unknown__"`.
- One confirms the happy path (a `result` event) is preserved through the narrower without falling through to `__unknown__`.

Fixture setup reuses the existing `createTestDb()` and `ApprovalRouter` scaffolding in the same file. No new mocks beyond promoting the SDK mock's yielded sequence to a controllable factory.

No new test file needed — sibling test file is the right home and already mocks every dependency the narrower path touches.

## Hardest Decision

**Construct the narrower internally vs. inject it via the constructor.** Two options:

- **(a) Internal construction (chosen).** `private readonly narrowing = new TypedEventNarrowing()`. No constructor signature change. Both production call sites (`cliManagerFactory.ts:191`) and the four test-file constructor invocations in `claudeCodeManagerWiring.test.ts` and `claudeCodeManager.killProcess.test.ts` stay binary-compatible. The narrower has no per-instance state besides an optional logger — there is no shared cache or lifecycle to coordinate.

- **(b) Constructor injection.** Add `narrowing?: TypedEventNarrowing` as a 5th constructor arg or as part of an options bag. Aligns with the `runEventBridge` test-seam pattern at `runEventBridge.ts:75`. But it would require updating every `new ClaudeCodeManager(...)` site (4 in tests + 1 in factory), and the testing benefit is illusory — the SDK mock at the `query()` boundary controls what events the narrower sees, so injecting a fake narrower would only let tests bypass the very validation they're supposed to verify.

Chose (a) because the testing affordance (b) would provide is unwanted: we want tests to exercise the real narrower against fake SDK input, not fake narrowing against real input. The single seam at `vi.mock('@anthropic-ai/claude-agent-sdk', ...)` is sufficient and already established.

## Rejected Alternatives

- **Pass `typed` (not `event`) to the `this.emit('output', ...)` listener.** Considered for symmetry. Rejected because `runEventBridge.ts:187–216` runs its own `narrowing.narrow(p.data)` on the incoming payload, expecting the unvalidated SDK shape. Forwarding the already-narrowed value would mean `__unknown__` events get double-wrapped (`{ kind: '__unknown__', raw: { kind: '__unknown__', raw: ... } }`) — the narrower is idempotent in name only. Keeping the `event` argument unchanged on the EventEmitter forward preserves the contract documented in `runEventBridge.ts:104-113`.

- **Make `narrowing` a singleton at module scope.** Rejected — the existing pattern in `runEventBridge.ts:155` constructs a per-bridge instance, and `TypedEventNarrowing` is cheap to construct (one constructor field). Module-level state would be a regression in testability if anyone later wants to inject a logger.

Would change my mind on the injection question if a future task needs to share a single narrower across CCM and runEventBridge for telemetry counters — at that point, hoist it to a shared module-level provider and inject everywhere.

## Lowest Confidence Area

The regression test in step 5 asserts `kind: "__unknown__"` is observable in the `raw_events.data` column. I have not opened the `RawEventsSink` to confirm whether `data` stores the JSON-stringified narrower output verbatim or unwraps the `kind` envelope. If the sink only persists the inner `raw` payload for `__unknown__` variants, the assertion shape needs to be inverted (assert that the persisted row contains the *original* yielded fields like `completely_unknown_variant_xyz` AND that the deriveEventType-derived `event_type` column is `unknown` or similar). The test author should open `main/src/services/streamParser/rawEventsSink.ts` and `derivers.ts` before writing the assertion — sibling test patterns in `claudeCodeManagerWiring.test.ts` will tell them which column to inspect.
