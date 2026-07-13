# Design: experiment arms × ship materialize — in-arm eligibility, board promotion, and grading are three different things

**Status:** proposal (read-only design task, no code changed)
**Date:** 2026-07-13
**Bug:** a ship-flow A/B experiment arm dies at step 10 `materialize-batch` with `ship_no_tasks_to_materialize`, because the arm's tasks are still `approved_at NULL` when `cyboflow_create_sprint_batch` runs. Both arms of the observed experiment were backend-stuck identically; the "opus arm limped, sonnet arm hard-blocked" difference was purely agent-side error handling of the same tool error — a symptom, not a fix surface.

---

## 0. Target behavior (acceptance criteria)

The user's stated target, verbatim in spirit:

> When I'm A/B testing a ship workflow, I want to be able to answer in-flight the pieces that have a human review gate (e.g. task decomposition / approve-plan) — but this is SEPARATE from grading the whole experiment, which should only happen once both branches have reached the final merged work state.

That decomposes into three concerns the current code conflates:

| # | Concern | Required trigger | Required scope |
|---|---------|------------------|----------------|
| 1 | **In-arm progression** — answering an arm's approve-plan gate makes that arm's tasks materializable *inside its own sandbox*, so ship's step-10 `materialize-batch` succeeds and the arm runs its sprint to its own final `human-review` gate | The arm's own gate answer, mid-run | Arm-local; must NOT touch the shared board |
| 2 | **Board promotion** — winner entities appear on the shared board | `experiments.decide` only | Winner arm only; loser swept |
| 3 | **Experiment grading** — pairwise judging + `running → grading` | Both arms settled (reached their final state — or failed) | Whole experiment; must never block concern 1 |

The design below satisfies all three, states plainly that the "tie grading to the final gate" framing alone cannot fix the bug, and centers on splitting `approved_at`'s double duty.

---

## 1. Bug mechanics (verified, file:line)

1. Experiment arm runs are launched with `experiment_id` stamped on `workflow_runs` (`main/src/orchestrator/trpc/routers/experiments.ts:717-762`).
2. Every epic/task an experiment-tagged run creates lands `approved_at NULL` **unconditionally** — `computeCreateApprovedAt` short-circuits: *"an experiment-tagged epic/task is PENDING until decide reveals it"* (`main/src/orchestrator/taskChangeRouter.ts:1293-1295`).
3. When the human **answers the arm's approve-plan gate**, `promoteTasksOnPlanApproval` (`main/src/orchestrator/questionRouter.ts:647-667`) calls the shared reveal core `revealRunDrafts` (`questionRouter.ts:756`), which **early-returns with no effect** for any run with a non-null `experiment_id` — the "A/B REVEAL SUPPRESSION" guard (`questionRouter.ts:757-773`). So the arm's tasks stay `approved_at NULL` even after the human approved the plan.
4. Ship step 10 calls `cyboflow_create_sprint_batch` → `handleCreateSprintBatch` (`main/src/orchestrator/mcpServer/mcpQueryHandler.ts:1588-1728`) → `SprintLaneStore.createForRun` → `filterEligibleTaskIds`, whose predicate requires `t.approved_at IS NOT NULL` (`main/src/orchestrator/sprintLaneStore.ts:341`). Every arm task is dropped → `no_eligible_tasks` (`sprintLaneStore.ts:280`) → mapped to `ship_no_tasks_to_materialize` (`mcpQueryHandler.ts:1516-1527`). The arm dies at step 10 of 15.
5. The ONLY reveal path for arm entities is `experiments.decide` → `revealWinnerEntities` (`experiments.ts:784-823`), which stamps `approved_at` **and** clears `experiment_id` (`clearExperiment:true`).

Note the irony: the awaited-reveal ordering fix at `questionRouter.ts:596-607` exists precisely because ship materialize races the approve-plan reveal — the codebase already knows materialize depends on the gate-answer stamping `approved_at`. The experiment guard reintroduces the same failure deterministically.

**Consequence:** any flow with an in-run planning→execution handoff (ship today; any custom flow using `cyboflow_create_sprint_batch`) is structurally unable to run as an experiment arm.

---

## 2. Does "grading at the final gate" fix this bug? **No.**

The user's proposed direction — make experiment grading fire when the run reaches the final gate, "like Eval" (Path A at `main/src/index.ts:1191-1195` fires `EvalWorker.snapshot` on `stepId === 'human-review' && status === 'running'`) — cannot fix the materialize failure, for three independent reasons:

1. **Ordering.** The failing seam is step 10 (`materialize-batch`); the final gate is step 15 (`human-review`, `shared/types/workflows.ts:1034`). Nothing that triggers at step 15 can unblock step 10. With the current suppression the arm *never reaches* step 15 at all.
2. **Wrong lever.** Grading (`reconcileExperimentStatus` + `PairwiseJudgeWorker`, wired at `index.ts:1207-1244` via `terminalEvalSubscriber.ts`) reads *run statuses* and *worktree diffs*. It never touches `approved_at`, `filterEligibleTaskIds`, or the sandbox. Changing *when* grading fires has zero effect on the eligibility predicate that kills the arm.
3. **Regression risk.** Grading currently fires on any of the 4 settled statuses (`awaiting_review|completed|failed|canceled`, `terminalEvalSubscriber.ts:39-44`) exactly so a **failed/canceled arm still completes the experiment** (header comment, `terminalEvalSubscriber.ts:8-10`). A gate-reached trigger alone would wedge every experiment whose arm dies before its gate — including, circularly, this very bug — in `running` forever.

Also, the premise "every run has a mandatory final human review gate" is **not true today** (verified):

- sprint + ship: final step is the `human-review` gate (`shared/types/workflows.ts:775`, `:1034`);
- planner: final step is the `decompose` gate (`:675`) — a differently-named gate;
- compound: `approve-learnings` (`:818`) is **not even terminal** — `write-back` (`:827`) follows it — and the flow prose allows skipping it;
- there is **no validator** enforcing a final gate: `main/src/orchestrator/workflowDefinitionSchema.ts` contains no gate/final-step rule (grep for `final|gate` comes back empty), and user-edited workflows (spec_json) can freely drop/rename gates;
- Path A **hardcodes** `'human-review'` (`index.ts:1192`) and the terminal subscriber's dedup (`stepTransitionOwnsEval`, `index.ts:1224-1234`) resolves that same hardcoded id.

So "tie grading to the mandatory final gate" would first require defining and enforcing a per-workflow `finalGateStepId` concept — real work, orthogonal to this bug. Section 5 (Option C) sketches it; it is not the fix.

**What the user actually wants from concern 3 is, however, already ~implemented.** `reconcileExperimentStatus` flips `running → grading` only when **both** arms are settled (`main/src/orchestrator/experimentStore.ts:287-297`), and `PairwiseJudgeWorker.maybeSnapshotAndEnqueue` returns `not_ready` unless both arms are settled (`main/src/orchestrator/eval/pairwiseJudgeWorker.ts:205-209`), captures both frozen diffs only then (`:230-233`), and short-circuits to a human-decides comparison when an arm failed (`:266-277`). "Grade only when both branches reach their final state" is the encoded semantics — it has just never been *exercised* for ship because both arms die at step 10. Fix concern 1 and concern 3 starts behaving as specified with **no grading changes**.

---

## 3. The structural finding: the two signals already exist as two columns

The prompt's framing — `approved_at` is doing double duty, (a) "sprint-eligible within this run" and (b) "visible on the shared board" — is correct about the *write* paths but, crucially, **the read paths already split the two meanings across two columns**:

- **Board visibility is gated on `experiment_id`, not on `approved_at`.** Every board read surface excludes tagged rows regardless of approval:
  - Server: `selectProjectBacklog` drops experiment-tagged rows by default (`main/src/orchestrator/taskListing.ts:742-746`); the tRPC `tasks.list`/`get`, `TaskBatchPickerModal`, and `IdeaPickerModal` all consume it.
  - Client (defense in depth): `isExperimentSandboxed` (`frontend/src/components/Backlog/backlogSelectors.ts:80-82`) is applied unconditionally in `filterTasks` (`backlogSelectors.ts:104-111`), for both top-level items and epic children.
  - MCP: `handleListTasks` also reads `selectProjectBacklog` with the default (tag-excluding) mode (`mcpQueryHandler.ts:1263`).
- **Sprint eligibility is gated on `approved_at`** (`sprintLaneStore.ts:341`), consumed by the three materialization entry points: `createForRun` (`sprintLaneStore.ts:265`), the `runs.start` pre-check (`main/src/orchestrator/trpc/routers/runs.ts:972-978`), and mid-run lane adds (`main/src/orchestrator/taskMutationHandler.ts:22`, `sprintLaneStore.ts:441`).

**Shipped precedent that the two can legally diverge:** sprint task-seeded experiments only work because `cloneSeedTask` creates each arm's clone experiment-tagged and then *immediately stamps `approved_at`* via a second chokepoint write, explicitly *"so the sprint launcher's eligibility filter accepts the clone as a seed task while it stays hidden by the tag"* (`experiments.ts:355-391`). Entire sprints have been running on tagged-but-approved tasks, executing through all lane stages, without ever surfacing on the shared board. The sandbox's board invisibility is carried **entirely** by the tag.

### Addressing the "double-vision board" objection head-on

The concern was raised that letting an arm's approve-plan gate stamp `approved_at` would put BOTH arms' tasks onto the shared board simultaneously. **Verified false on this codebase**: no board query keys visibility off `approved_at` alone. A tagged row is excluded server-side before `approved_at` is ever consulted (`taskListing.ts:746`), and the client selector excludes it again (`backlogSelectors.ts:110`). Sprint experiments are the running counterexample: two arms × N approved-and-tagged clones each, zero board pollution. What stamping `approved_at` on a tagged row changes is *exactly one* consumer: `filterEligibleTaskIds` — the one we need.

So the requested split maps onto the existing column pair with **no new column**:

| Signal | Carrier | Written by |
|---|---|---|
| (a) sandbox-local sprint-eligibility | `approved_at IS NOT NULL` (tag still set) | the arm's own approve-plan gate answer |
| (b) shared-board visibility | `approved_at IS NOT NULL` **AND** `experiment_id IS NULL` | `experiments.decide` → `revealWinnerEntities` (`clearExperiment:true`) |

For a normal run the two coincide (untagged ⇒ (a) ≡ (b)) — behavior unchanged. For an arm they diverge exactly as required: gate answer sets (a); decide sets (b) for the winner by clearing the tag; the loser sweep is **tag-gated, not approval-gated** (`taskChangeRouter.ts:812-824` — "a target is swept iff its `experiment_id` matches"), so approved loser entities are still correctly hard-deleted.

The residual risk is *semantic drift*: code/comments in ~8 places describe `approved_at` as "visible + sprint-eligible" as one meaning. Option B below buys explicitness with a new column; Option A buys minimalism with a comment/doc sweep plus leak-audit tests. The audit table of every `approved_at` consumer is in §4.1.

---

## 4. Design options

### Option A (recommended): narrow the reveal suppression — `approved_at` means only "plan-approved / sprint-eligible"; `experiment_id` alone means "hidden until decide"

**Mechanism.** Two symmetric edits, both inside the existing chokepoints; no schema change; `filterEligibleTaskIds` and every board query untouched.

1. **Gate-answer seam** — `questionRouter.ts:757-773`: delete (or narrow to a comment) the A/B early-return in `revealRunDrafts`. The reveal core then runs for arm runs exactly as for normal runs: stamp `workflow_runs.plan_approved_at` (arm-run-scoped, `:791-796`), stamp `approved_at` on run-created epics+tasks via the chokepoint `approved:true` toggle (`:798-831`; idempotent — `taskChangeRouter.ts:1498-1503` no-ops when already stamped), retire owned ideas (`:844-848` — the arm's *clone*, already off-board by tag; `decomposed_at` additionally retires it, harmless to decide's fold which reads the clone body regardless, `experiments.ts:1082-1096`), and move tasks to Ready-for-development (`:850-873` — satisfies the `bs.position >= 6` leg of the eligibility predicate). Crucially the reveal core **never passes `clearExperiment`**, so the tag — and with it board invisibility and the write-sandbox guard (`taskChangeRouter.ts:1403-1435`) — survives untouched until decide.
2. **Create seam** — `taskChangeRouter.ts:1293-1295`: drop `computeCreateApprovedAt`'s unconditional `return null` for tagged creates; fall through to the normal plan-gate logic (`:1296-1321`). Effects, all correct:
   - arm ship/planner run, pre-approval → `runId` present, plan-gated, unapproved → `NULL` (pending, as today);
   - arm ship run, post-approval, mid-sprint follow-up task (`cyboflow_create_task` → `taskMutationHandler` lane-add) → `approved_at = now` → the lane-add eligibility check (`sprintLaneStore.ts:441`) passes. Without this companion edit, the same bug class recurs the first time an arm's agent mints a clean-up task mid-sprint;
   - arm sprint run (not plan-gated) → `now`, matching a normal sprint;
   - seed clones (explicit `experimentId`, no `runId`) → `now`; `cloneSeedTask`'s second approve write (`experiments.ts:383-389`) becomes an idempotent no-op — keep it as belt-and-braces or delete it, either is safe.
3. **Comment/doc sweep** — update the prose at `taskChangeRouter.ts:1029-1034` ("An experiment-tagged epic/task ALSO lands PENDING…"), `questionRouter.ts:757-762`, `sprintLaneStore.ts:315` ("backend-invisible"), and `backlogSelectors.ts:62-64` to state the split: *`approved_at` = plan-approved/sprint-eligible; `experiment_id` = board-hidden + write-sandboxed until decide; visibility ⇔ approved ∧ untagged*.

**How the three concerns are triggered/gated after Option A:**

| Concern | Trigger | Seam | Guard that keeps it scoped |
|---|---|---|---|
| 1. In-arm progression | Human answers the arm's `approve-plan` gate | `respond()` awaits `promoteTasksOnPlanApproval` **before** the agent resumes (`questionRouter.ts:596-607`) → `revealRunDrafts` stamps `approved_at` | `experiment_id` stays set ⇒ board reads (`taskListing.ts:742-746`, `backlogSelectors.ts:104-111`) and the bidirectional write sandbox (`taskChangeRouter.ts:1403-1435`) unchanged |
| 2. Board promotion | `experiments.decide` (winner) | `revealWinnerEntities` — `approved:true` (now usually a no-op) + `clearExperiment:true` + reparent (`experiments.ts:784-823`) | loser/discard sweep is tag-gated (`taskChangeRouter.ts:812-824`); decline sweep still only deletes `approved_at NULL` drafts (`taskChangeRouter.ts:644-706`) — mutually exclusive with the approve path |
| 3. Grading | Both arms settled (any of the 4 settled statuses) | `terminalEvalSubscriber.handleTerminalStatusEvent` → `reconcileExperimentStatus` (`experimentStore.ts:287-297`) + `maybeSnapshotAndEnqueue` (both-arms-settled precondition, `pairwiseJudgeWorker.ts:205-209`) | **unchanged** — with concern 1 fixed, healthy arms now actually park at `human-review`/`awaiting_review`, so "both branches reached the final merged work state" becomes the normal grading precondition; a failed arm still settles the experiment via the failed short-circuit (`pairwiseJudgeWorker.ts:266-277`) |

Per-arm rubric eval (Path A, `index.ts:1191-1195`) also starts working for ship arms as a side effect — the arm now *reaches* `human-review`, so the pre-human-influence snapshot fires; the Path-A/terminal dedup (`index.ts:1224-1234`, `terminalEvalSubscriber.ts:112-130`) already handles the tagged-run case.

**Migration needs:** none.

**Failure modes + mitigations:**
- *A future read surface keys visibility off `approved_at` alone.* This is the real cost of reusing the column. Mitigate with the §6 leak-audit regression test (board projections must exclude a tagged+approved task) and the comment sweep. Today's full consumer audit (§4.1) shows no such surface.
- *Cancel-sweep interplay.* A canceled arm's post-approval entities are no longer `approved_at NULL`, so the pending-draft cancel sweep spares them; they linger tagged-and-invisible until decide/abandon sweeps them by tag. Same lifecycle as a normal run's approved entities, and the sweep that matters is tag-gated — acceptable, but assert it in tests.
- *Both arms progress ⇒ two full sprints run.* That is the feature (the whole point of a ship A/B), but it doubles execution cost per experiment; no code implication.
- *`plan_approved_at` now stamped on arm runs.* Consumed only by `runIsPlanGated`/reveal-idempotency and `computeCreateApprovedAt` — all arm-run-scoped; verified no experiment-status logic reads it.

#### 4.1 `approved_at` consumer audit (why stamping a tagged row leaks nowhere)

| Consumer | Location | Effect of tagged+approved row |
|---|---|---|
| Sprint eligibility | `sprintLaneStore.ts:341` (+ `runs.ts:972-978`, `taskMutationHandler.ts:22`) | becomes eligible — **the intended fix** |
| Board projection (server) | `taskListing.ts:742-746` | still excluded by tag |
| Board projection (client) | `backlogSelectors.ts:66-68` (`isPending`) + `:80-82`/`104-111` | row never reaches client; sandbox selector as backstop |
| Batch/idea pickers | `TaskBatchPickerModal.tsx:111-122` via `tasks.list` | still excluded server-side |
| MCP `list_tasks` | `mcpQueryHandler.ts:1263` | still excluded (pre-existing quirk: arm agents can't list their own drafts either — unchanged) |
| Decline sweep (only pending drafts) | `taskChangeRouter.ts:683-693` | approve and decline paths are mutually exclusive per gate answer |
| Loser/discard/abandon sweep | `taskChangeRouter.ts:812-824` | tag-gated; approval irrelevant |
| `revealWinnerEntities` | `experiments.ts:802-812` | `approved:true` no-ops (idempotent, `taskChangeRouter.ts:1498`) |
| Seed-task validation | `experiments.ts:341` (`readSeedTask`) | requires untagged anyway (`:339`) |

### Option B: explicit second column — `tasks.sprint_eligible_at` / `epics.sprint_eligible_at` (migration ~060)

**Mechanism.** Mint a new nullable timestamp meaning exactly signal (a). `revealRunDrafts`, for experiment-arm runs only, stamps `sprint_eligible_at` instead of `approved_at`; `computeCreateApprovedAt` keeps its tagged-⇒-pending rule but a sibling `computeCreateSprintEligibleAt` applies the plan-gate logic; `filterEligibleTaskIds` becomes `AND (t.approved_at IS NOT NULL OR t.sprint_eligible_at IS NOT NULL)` (both `sprintLaneStore.ts:341` and the mirrored predicate in `readSeedTask`, `experiments.ts:341-344`); `revealWinnerEntities` continues to stamp `approved_at` at decide. A new chokepoint toggle (`sprintEligible: true`, orchestrator-only) carries the write; the decline/cancel sweeps add `sprint_eligible_at` to their pending predicates or (simpler) leave them keyed on `approved_at` alone.

**Migration needs:** one migration (2 × ALTER TABLE), plus schema-parity test updates, plus the pre-migration defensive-read dance (`columnExists`) in ~5 read/write sites.

**Failure modes:** the two-column predicate now has four states, and the seed-clone path becomes inconsistent with the arm-created path unless `cloneSeedTask` (`experiments.ts:383-389`) is migrated from its `approved:true` write to the new toggle — i.e. the *shipped precedent already violates Option B's purity*, and either stays as a special case or gets a backfill. Every future eligibility consumer must remember the OR. The gain — protection against a hypothetical future `approved_at`-as-visibility reader — is exactly what the §6 leak tests already assert.

**Verdict:** defensible, strictly more moving parts, and it fights the existing precedent rather than generalizing it. Choose only if the team wants `approved_at`'s docstring ("visible + eligible") to stay literally true rather than being corrected.

### Option C: the user's original framing — reveal/grade at a mandatory final gate

**Mechanism (sketch).** Define `finalGateStepId` per workflow (sprint/ship `human-review`, planner `decompose`, compound `approve-learnings`); add a `workflowDefinitionSchema` validation that every definition ends in a human gate; replace Path A's hardcoded `'human-review'` (`index.ts:1192`) with a resolver over the frozen spec; fire experiment grading when *both* arms have reported their final gate `running` (a new `stepTransitionEvents` subscriber keyed on the resolved id), with the terminal-settlement trigger retained as fallback for failed arms.

**Why it is not the fix:** it does not touch step 10 (§2 reason 1); it requires enforcement machinery that does not exist (compound's gate is neither final nor mandatory; custom flows are unconstrained); and its only behavioral delta over today's grading — snapshotting slightly earlier for healthy arms — is marginal, because a run parked at its final gate settles to `awaiting_review` and triggers grading through the existing terminal path anyway. **Salvageable kernel as a separate follow-up:** moving the *pairwise diff capture* (`pairwiseJudgeWorker.ts:230-233`) to final-gate-reached would freeze pre-human-influence diffs, mirroring Path A's rationale for rubric evals. File it as an enhancement; do not couple it to this bug.

---

## 5. Recommendation

**Option A**, with the comment sweep and the leak-audit tests treated as part of the change, plus Option C's diff-capture kernel filed as a separate backlog item. Rationale: the sandbox's two-axis model (tag = visibility + write-isolation; `approved_at` = plan approval) is already how the code *reads*; Option A makes the *writes* consistent with it, deletes a guard instead of adding state, fixes the mid-sprint lane-add variant of the same bug for free, and leaves grading — which already implements the user's "both branches at final state" requirement — completely untouched.

Explicitly against the acceptance criteria in §0:
1. **In-flight gate answers work per-arm** — approve-plan resumes the arm with materializable tasks (step 10 passes); each arm independently runs to its own `human-review` gate, which the user answers in-flight like any run.
2. **No board pollution mid-experiment** — the tag is cleared only at decide; both server and client projections exclude tagged rows irrespective of approval (verified §3, tested §6).
3. **Grading fires only when both branches are done** — unchanged both-arms-settled precondition; a failed arm degrades to the human-decides comparison instead of wedging the experiment.

---

## 6. Test strategy

All tests are unit-tier (`pnpm test:unit` is the AC gate), following the repo's established pattern: in-memory SQLite + injected worker closures (see `terminalEvalSubscriber.ts` header; existing suites under `main/src/orchestrator/__tests__` and `trpc/routers/__tests__` already build migrated in-memory DBs and drive `TaskChangeRouter`/`QuestionRouter`/`SprintLaneStore` directly).

1. **Arm reveal narrows, not disables** (`questionRouter` suite): seed a plan-gated run with `experiment_id`+arm; create pending tagged tasks via the chokepoint with that `runId`; answer approve-plan → assert `approved_at NOT NULL`, `experiment_id` unchanged, `experiment_arm` unchanged, stage at position 6, `plan_approved_at` stamped.
2. **Materialize unblocks** (`sprintLaneStore` / `mcpQueryHandler` suites): after (1), `filterEligibleTaskIds` returns the ids and `createForRun` mints the batch; regression-assert the *pre-fix* shape too (pending tagged tasks still yield `no_eligible_tasks`).
3. **Leak audit** (the load-bearing tests): with a tagged+approved task present — `selectProjectBacklog(db, pid)` (default mode) excludes it; `selectProjectBacklog(..., {includeExperimentTagged:true})` includes it; frontend `filterTasks` excludes it if handed one directly. Add a structural assertion that `revealRunDrafts` never emits a `clearExperiment` delta (spy on the chokepoint, assert no `experiment_id` FieldDelta from the reveal path).
4. **Create-path matrix** (`taskChangeRouter` suite) for `computeCreateApprovedAt`: tagged + plan-gated-unapproved run → NULL; tagged + approved run → now; tagged + no runId (seed clone) → now; untagged cases byte-identical to today.
5. **Decide unaffected**: winner path — `revealWinnerEntities` over pre-approved entities is idempotent and clears the tag; loser path — `deleteExperimentArmEntities` hard-deletes approved+tagged entities (tag gate, not approval gate); decline path — pending tagged drafts still swept, approved ones untouched (mutually exclusive answers).
6. **Grading regression** (existing `terminalEvalSubscriber` / `pairwiseJudgeWorker` suites): an arm failing pre-gate still settles → `reconcileExperimentStatus` flips to grading when the sibling settles; both-arms-settled precondition unchanged; Path-A-vs-terminal eval dedup unchanged for tagged ship runs.
7. **Mid-sprint lane add in an arm**: post-approval tagged task create → `addLane` eligibility passes (the companion-edit guard).

Manual smoke (not gate-blocking): run a small ship A/B end-to-end in `pnpm dev`, answer both arms' gates, confirm swimlanes render per arm, board stays clean until decide, decide promotes the winner.

---

## 7. What I could not verify from the code (flagged)

- **Runtime behavior**: no experiment was executed; all conclusions are static reads of the current worktree (`quick-20260713-200549`).
- **`awaiting_review` ⇔ "parked at the final gate"**: inferred from the summary-panel/`runEndEligible` wiring and the settled-status set; the full run-status machine was not traced end-to-end. If `awaiting_review` can occur *before* `human-review` in some path, grading's "final merged work state" alignment weakens slightly (it would still be both-arms-settled).
- **Gate presentation in arms**: assumed arm runs present approve-plan/human-review gates to the human exactly like normal runs (nothing suppresses `AskUserQuestion` for tagged runs as far as grepped); corroborated by the observed incident (the user *did* reach and answer gates) but not re-traced through `QuestionRouter.requestQuestion`.
- **Original intent of the suppression guard**: taken from its own comment block (`questionRouter.ts:757-762` — visibility rationale). `git log`/design-doc archaeology for a second, undocumented rationale (e.g. deliberately preventing arm sprints for cost) was not performed.
- **Custom/user-edited flow variants**: user-edited ship variants with renamed step ids were not audited; the fix is step-id-agnostic (it keys off `APPROVE_PLAN_STEP_ID` presence via `runIsPlanGated`, unchanged), but exotic variants may still fail materialize for unrelated prose reasons.
