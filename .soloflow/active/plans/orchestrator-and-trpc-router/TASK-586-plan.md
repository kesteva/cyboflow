---
id: TASK-586
idea: SPRINT-006-compound
status: in-flight
source_sprint: SPRINT-006
created: "2026-05-14T00:00:00Z"
files_owned:
  - main/src/orchestrator/types.ts
  - main/src/orchestrator/Orchestrator.ts
  - main/src/orchestrator/__tests__/Orchestrator.test.ts
  - main/src/index.ts
  - docs/ARCHITECTURE.md
files_readonly:
  - main/src/orchestrator/approvalRouter.ts
  - main/src/orchestrator/RunQueueRegistry.ts
  - main/src/orchestrator/trpc/routers/events.ts
  - main/src/orchestrator/trpc/__tests__/router.test.ts
  - .soloflow/active/findings/SPRINT-006-findings.md
  - .soloflow/active/compound/SPRINT-006-proposal.md
  - .soloflow/active/plans/orchestrator-and-trpc-router/EPIC-orchestrator-and-trpc-router.md
  - .soloflow/active/plans/orchestrator-and-trpc-router/TASK-253-plan.md
acceptance_criteria:
  - criterion: OrchestratorDeps no longer declares an `eventBus` field
    verification: "grep -nE '\\beventBus\\b' main/src/orchestrator/types.ts returns 0 matches"
  - criterion: Orchestrator.ts constructor doc no longer mentions `eventBus`
    verification: "grep -nE '\\beventBus\\b' main/src/orchestrator/Orchestrator.ts returns 0 matches"
  - criterion: "Orchestrator.test.ts no longer constructs a placeholder `EventEmitter` for the eventBus dep — the beforeEach `eventBus = new EventEmitter()` line and every `new Orchestrator({ ..., eventBus, ... })` arg is gone"
    verification: "grep -nE '\\beventBus\\b' main/src/orchestrator/__tests__/Orchestrator.test.ts returns 0 matches"
  - criterion: "main/src/index.ts no longer passes `eventBus: new EventEmitter()` to the Orchestrator constructor; the `EventEmitter` import is removed if no other reference remains"
    verification: "grep -nE '\\beventBus\\b' main/src/index.ts returns 0 matches; if no other code in main/src/index.ts uses `EventEmitter`, then `grep -nE \"import.*\\bEventEmitter\\b.*from 'node:events'\" main/src/index.ts` returns 0 matches"
  - criterion: "docs/ARCHITECTURE.md §Orchestrator (or new equivalent section) documents the post-drop contract: collaborators are `db`, `logger`, `runQueues`. Future cross-orchestrator events (ApprovalRouter→renderer) flow via the per-component EventEmitter (e.g. ApprovalRouter extends EventEmitter and emits `approvalCreated` on itself; the events tRPC sub-router subscribes to that emitter directly when stream-parser-to-main lands) — no shared eventBus."
    verification: "grep -nE 'Orchestrator|orchestrator' docs/ARCHITECTURE.md returns at least 1 match in a section header; the section body mentions the three remaining deps (db, logger, runQueues) and explicitly notes the eventBus removal decision"
  - criterion: Main process typecheck passes — proves no other file referenced the dropped field
    verification: pnpm --filter main typecheck exits 0
  - criterion: Main process lint passes
    verification: pnpm --filter main lint exits 0
  - criterion: Main process unit tests pass — proves the Orchestrator + downstream tests still work with the narrower deps surface
    verification: pnpm --filter main test exits 0
  - criterion: "Repo-wide sweep: zero remaining `eventBus` identifier matches inside main/src/orchestrator/ except inside a leading comment describing the historical removal"
    verification: "grep -rn --include='*.ts' '\\beventBus\\b' main/src/orchestrator/ returns 0 matches"
depends_on: []
estimated_complexity: low
epic: orchestrator-and-trpc-router
test_strategy:
  needed: false
  justification: "Pure removal of an unused dependency field. The existing Orchestrator.test.ts covers start/stop/idempotence/drainAll — those behaviors are unchanged by the field drop and remain green after editing the test fixtures to remove the placeholder eventBus. Sibling-test scan: `main/src/orchestrator/__tests__/` contains `Orchestrator.test.ts`, `approvalRouter.test.ts`, `RunQueueRegistry.test.ts` — only `Orchestrator.test.ts` references eventBus (verified by `grep -n eventBus main/src/orchestrator/__tests__/*.ts` showing matches only in Orchestrator.test.ts). The edits to Orchestrator.test.ts ARE the test-fixture update; no NEW test cases warranted since no NEW behavior is introduced."
---
# Resolve unused `eventBus` in OrchestratorDeps — drop it

## Objective

`OrchestratorDeps.eventBus: EventEmitter` was added by TASK-253 (`main/src/orchestrator/types.ts:59`), instantiated as `new EventEmitter()` at `main/src/index.ts:705`, and threaded through every test harness — but no code reads or writes it. Verification at refinement time:
- `main/src/orchestrator/Orchestrator.ts` only touches `deps.logger` and `deps.runQueues` — zero `this.deps.eventBus` references.
- `main/src/orchestrator/approvalRouter.ts:88` `ApprovalRouter extends EventEmitter` and emits `'approvalCreated'` on **itself** (`approvalRouter.ts:232`), not on the shared bus.
- `main/src/orchestrator/trpc/routers/events.ts:48` uses `makePlaceholderAsyncIterator` — placeholders, no eventBus subscriber.

The speculative API surface is real and the refinement decision must be made now, before stream-parser-to-main lands and locks in a wiring decision either way. Two paths:

**Path (a) — wire it for real**: ApprovalRouter emits `approvalCreated` on the shared bus *as well as* on itself; the events router subscribes to the shared bus.
**Path (b) — drop the field** until a real consumer arrives.

**Chosen: path (b).** Rationale below. This task removes the field. A follow-up note in `docs/ARCHITECTURE.md` documents that future cross-component events (the upcoming stream-parser-to-main events) will flow via the producer's own EventEmitter (e.g. ApprovalRouter, StreamParser), not via a shared bus — keeping ownership clear and avoiding the "did anyone wire this?" failure mode that produced this finding in the first place.

If during execution the stream-parser-to-main planning is found to *require* a shared bus, the executor should escalate to the user before proceeding — this is the kind of decision that benefits from a 30-second cross-check.

## Implementation Steps

1. **Re-check that stream-parser-to-main has no committed design depending on the shared eventBus.** Read `.soloflow/active/plans/typed-stream-event-schema/EPIC-typed-stream-event-schema.md` and `.soloflow/active/plans/typed-stream-event-schema/TASK-101-plan.md` (and any TASK-10x plan in that epic). If any of them name `eventBus` or `OrchestratorDeps.eventBus` as a planned consumer, STOP and escalate to the user — the drop decision is no longer the right path. If none of them name it, proceed.

2. **Edit `main/src/orchestrator/types.ts`**:
   - Remove the `eventBus: EventEmitter;` line from the `OrchestratorDeps` interface (currently line 59).
   - Remove the `import { EventEmitter } from 'node:events';` line at the top — it was added solely for this field.
   - Leave the file's other content (DatabaseLike, LoggerLike, OrchestratorDeps) intact.

3. **Edit `main/src/orchestrator/Orchestrator.ts`**:
   - Update the JSDoc on the constructor (line 23): remove `eventBus` from the `@param deps` enumeration — change `"db, logger, eventBus, runQueues"` to `"db, logger, runQueues"`.
   - No code-body changes needed; the constructor only stores `deps` and `Orchestrator` never reads `deps.eventBus`.

4. **Edit `main/src/orchestrator/__tests__/Orchestrator.test.ts`**:
   - Remove the `import { EventEmitter } from 'node:events';` line.
   - Remove `let eventBus: EventEmitter;` from the describe-block scope.
   - Remove `eventBus = new EventEmitter();` from `beforeEach`.
   - Update every `new Orchestrator({ db, logger, eventBus, runQueues })` call (5 sites in the current file) to `new Orchestrator({ db, logger, runQueues })`.
   - Confirm tests still pass.

5. **Edit `main/src/index.ts`**:
   - Locate the `orchestrator = new Orchestrator({ db, logger: loggerLike, eventBus: new EventEmitter(), runQueues });` line (currently ~705).
   - Change to `orchestrator = new Orchestrator({ db, logger: loggerLike, runQueues });`.
   - Check whether `import { EventEmitter } from 'node:events';` (line 35) is still needed. Run `grep -nE '\bEventEmitter\b' main/src/index.ts` after the edit. If 0 remaining matches, remove the import.

6. **Edit `docs/ARCHITECTURE.md`**:
   - Locate the existing `### Orchestrator` heading (or the closest equivalent).
   - Append (or update) the dep-list description: "Collaborators injected via `OrchestratorDeps`: `db: DatabaseLike`, `logger: LoggerLike`, `runQueues: RunQueueRegistry`."
   - Add a paragraph: "Cross-component events (e.g. `ApprovalRouter` emitting `approvalCreated` for the renderer subscription) flow via per-producer EventEmitters. The Orchestrator does not own a shared event bus; each producer is the canonical source for its events. This was an explicit reversal of the earlier dep-bag design — see SPRINT-006-findings B10 for context."

7. **Run the full verification chain**:
   ```
   pnpm --filter main typecheck
   pnpm --filter main lint
   pnpm --filter main test
   ```

   The typecheck is the canary — if any file I missed referenced `deps.eventBus` or `OrchestratorDeps.eventBus`, typecheck will fail with an error pointing at the offender. Fix and re-run.

8. **Final sweep**:
   ```
   grep -rn --include='*.ts' '\beventBus\b' main/src/orchestrator/
   ```
   Must return 0 matches (excluding the description paragraph in `docs/ARCHITECTURE.md`, which is outside `main/src/orchestrator/`).

## Acceptance Criteria

See frontmatter. Nine criteria covering deletion of the field across types, constructor doc, tests, wiring site, doc update, and the standard build chain plus a final sweep.

## Test Strategy

See frontmatter `test_strategy`. No new tests — the existing Orchestrator.test.ts continues to assert the start/stop/idempotence/drain behaviors after its fixtures are updated to drop the placeholder eventBus.

## Hardest Decision

**Path (a) vs (b).** Chosen: **path (b)**. The argument for (a) — "wire it now so stream-parser-to-main has the plumbing" — sounds principled but is exactly the speculative-API-surface failure mode that produced this finding (TASK-253 wired the field anticipating TASK-254 / TASK-302 would use it; both bypassed it). Each producer's own EventEmitter is sufficient for the renderer-subscription pattern (`ApprovalRouter` already proves this works — see `main/src/orchestrator/trpc/__tests__/router.test.ts` for the eventual subscription wiring). When the *first* real consumer needs cross-producer event aggregation, that consumer's plan will design the bus with knowledge of what events flow through it — far better than pre-baking a typed `EventEmitter<unknown>` and hoping.

## Rejected Alternatives

- **Path (a): wire it now.** Rejected per "Hardest Decision" above. Speculative.
- **Make the field optional (`eventBus?: EventEmitter`).** Rejected: a half-removal — future contributors will still see the field in the type and wonder if they should use it. Better to remove entirely and re-add cleanly when needed.
- **Keep the field but mark it `@deprecated` for a release cycle.** Rejected: this is a single internal interface in a non-public API, with one wiring site in one repo. There's no external compat surface to preserve.

## Lowest Confidence Area

The "stream-parser-to-main has no committed design depending on eventBus" check (step 1). Stream-parser-to-main is the typed-stream-event-schema epic, and `EPIC-typed-stream-event-schema.md` plus the in-flight TASK-10x plans might describe an event-bus consumer the refinement-time grep missed. If the executor finds ambiguity, escalating to the user adds ~1 minute and prevents a path-reversal cost. The grep on `.soloflow/active/plans/typed-stream-event-schema/` from refinement showed no `eventBus` matches, but plans can change.
