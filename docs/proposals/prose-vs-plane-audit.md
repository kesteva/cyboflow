# Prose vs. plane — what the flow markdown promises and what the code enforces

**Status:** AUDIT (Tier 3). Not a design proposal — a standing inventory. Derived
from survey D (§3), with a `Status after Tier 3` column recording what the
step-prompt mirror work in this tier moved.

**Why this document exists.** cyboflow has two execution planes. On the
ORCHESTRATED plane one top-level agent holds the whole flow markdown
(`main/src/orchestrator/workflows/*.md`) in context and acts on it directly. On
the PROGRAMMATIC plane — which is the default, and which every flow floors to —
the host sequences the DAG and each step runs as a fresh, narrowly-scoped agent
turn that **never loads the flow markdown at all**. A step turn sees its step's
`desc` plus whatever `composeStepPrompt` composes for it, and nothing else.

That makes every obligation written only in the flow prose INERT on the default
plane. It is not a bug that shows up as an error — the run completes, the board
fills in, and the thing that was supposed to happen simply did not. This table is
the inventory of which obligations are enforced by code, which are mirrored into
the step prompt, and which are still prose-only.

**Three statuses:**

- **CODE** — the host, the controller, or a write chokepoint enforces it. The
  agent cannot get it wrong; at most it gets a refusal.
- **MIRRORED** — the obligation is composed into the scoped step prompt by
  `main/src/orchestrator/programmatic/stepPrompt.ts`, so a fresh step turn carries
  it. Still an instruction to a model, not an enforcement, but it is *present*.
- **INERT-documented** — prose only. Listed here so the gap is a known one rather
  than a surprise.

## 1. The audit table

| # | Obligation | Prose location | Plane implementation | Load-bearing? | Status after Tier 3 |
|---|---|---|---|---|---|
| **SPRINT** | |
| S1 | Report each step via `cyboflow_report_step` | `sprint.md:32-38`, `:272` | **CODE** — `host.reportStep(...)` called by the controller at every step transition (`workflowController.ts:586`, `:598`, and the walk head) | Low (observational) | CODE |
| S2 | Move every lane via `cyboflow_update_sprint_task` at the moment it happens | `sprint.md:119-122`, `:262-264` | **CODE** — `driver.driveLane({runId, itemId, status, allowedStepIds})` per inner step, `workflowController.ts:2155`, `:2190` | High | CODE |
| S3 | Pass the exact `# Sprint tasks` block to the dependency analyzer; never read disk | `sprint.md:48-59`, `:257-261` | **MIRRORED** — `taskScope` section, `stepPrompt.ts:~527` ("do NOT hunt for task files in the worktree to discover scope") | High — this exact failure dropped real edges on 2026-06-22 (`stepPrompt.ts:14-24`) | MIRRORED |
| S4 | Write every analyzer edge via `cyboflow_add_task_dependency`; skip cycles | `sprint.md:60-67` | **INERT** (agent-discretionary). The write is the step agent's MCP call; nothing in the plane verifies the edge count matches the analyzer's output. Cycle rejection is CODE (`taskChangeRouter.ts:3082`) | High — silently collapses to "no dependencies" | INERT-documented |
| S5 | DAG-wave dispatch, concurrency cap, same-file holdout | `sprint.md:81-83` (defers to the appended Fan-out block) | **CODE** — `workflowController.ts:2095-2110` (`effectiveMaxConcurrency`, `waveFiles` overlap check); readiness from `task_dependencies` via `sprintLaneStore.ts:1313-1330` | High | CODE |
| S6 | Loopback + attempt protocol, "up to 3×, then the lane is `failed`" | `sprint.md:87-88` | **CODE** — `FAN_OUT_LANE_ATTEMPT_CAP` (`workflowController.ts:1616`, `:1697`, `:1782`); per-inner-step `loopback: 'implement'` declared in `shared/types/workflows.ts:1030-1050` | High | CODE |
| S7 | Pass each task's approved design down to its lane (snapshot path + `## Design spec`) | `sprint.md:95-105` | **CODE+MIRRORED** — `designSurfaces` resolved by the host and rendered for every step (`stepPrompt.ts:107-125`, `:~540`) | High | CODE + MIRRORED |
| S8 | ONE git commit per task on success | `sprint.md:110-112` | **INERT** (agent-discretionary). No commit-count enforcement in the controller; the lane's `integrated` write is CODE but the commit shape is not | Medium | INERT-documented |
| S9 | Batch integration held until all lanes `integrated` | `sprint.md:92-93` | **CODE** — the fan-out returns only after every wave settles (`workflowController.ts:1964-2236`) | High | CODE |
| S10 | **Closing-stage gate** — any failed lane ⇒ SKIP sprint-verify / sprint-review / address-review, go straight to the human gate | `sprint.md:155-163` | **CODE** — `skipToHumanGate` latch: set at `workflowController.ts:571-577`, honored at `:505-513`, cleared on a human-gated step | High | CODE |
| S11 | Partial-sprint summary must enumerate each failed lane (ref, title, `current_step`, attempt) | `sprint.md:165-170` | **CODE** — `partialSprintGateSummary.ts` builds the gate body from the lane rows + `task_dependencies` (`:50-75`) | Medium | CODE |
| S12 | **sprint-verify FAIL ⇒ set the offending lanes back to `running`, loop them through the fan-out chain, re-run; at most 2 loops** | `sprint.md:175-180` | **INERT.** The `sprint-verify` step (`shared/types/workflows.ts:1057-1064`) declares `retries: 1` and **no `loopback`**. A FAIL retries the same full-suite step once and then fails the step — it never re-drives a lane. The "at most 2" cap has nothing to cap | **HIGH — the single biggest inert obligation in the audit** | INERT-documented |
| S13 | sprint-review: record each `## Findings` entry via `cyboflow_report_finding` with `category` + `locations` + `severity` | `sprint.md:181-183`, `:267-269` | **INERT** (agent-discretionary), though the agent file `sprint/agents/sprint-review.md` IS read | Medium | INERT-documented |
| S14 | address-review: call `cyboflow_list_run_findings` first, pass findings verbatim | `sprint.md:186-196` | **MIRRORED** — `addressReviewNote` in `stepPrompt.ts` (rendered at `:649`) | High | MIRRORED |
| S15 | **address-review: re-run sprint-verify after edits; on FAIL re-delegate once; on second FAIL file a BLOCKING finding** | `sprint.md:197-209` | **INERT.** `address-review` (`shared/types/workflows.ts:1078-1085`) is the step AFTER `sprint-verify` and declares no `loopback`. Nothing re-runs the suite. The blocking finding, if the agent files it, IS honored at the next step boundary (`workflowController.ts:496`) | High — a red tree can reach the human gate labelled green | MIRRORED (Tier 3, partial) |
| S16 | Resolve findings LAST, never before the fix is committed; DEFERRED stays open | `sprint.md:210-232` | **MIRRORED** (`addressReviewNote`) + **CODE** guard: `cyboflow_resolve_finding` is refused on a terminal run (`run_not_active`, `mcpQueryHandler.ts:3597+`) | High | CODE + MIRRORED |
| S17 | human-review: AskUserQuestion, labels exactly Approve/Reject, never self-approve | `sprint.md:237-248`, `:270` | **CODE** — `human: true` step (`shared/types/workflows.ts:1086-1093`) resolved by `ReviewQueueHumanGate` (`programmatic/humanGate.ts`), not by the agent | High | CODE |
| S18 | Report artifacts for sprint deliverables; do NOT report `screenshots` for the visual gate | `sprint.md:124-149` | **CODE** — the central verification agent writes + enriches the `screenshots` artifact (`verify/verdictDelivery.ts`); the lane's `visual-verify` step spawns NO agent (`workflowController.ts:1340-1360`) | Medium | CODE |
| **PLANNER** | |
| P1 | Batch branch: 1-4 ideas, `<ideas>` XML vs `# Selected idea` | `planner.md:31-53` | **CODE** — seeding is the launcher's job (`runLauncher.ts`); `runOwnedIdeaIds` is threaded per step (`stepPrompt.ts:74-79`) | High | CODE |
| P2 | Size-triage every seed; persist `scope` | `planner.md:55-72` | **INERT** on the plane (no size-triage section in `stepPrompt.ts`); the `context` agent file carries the `SCOPE:` contract | Medium | INERT-documented |
| P3 | **Size guard: mint a blocking `idea-size-guard` decision and DROP the idea** | `planner.md:76-93` | **INERT.** No `stepPrompt.ts` mirror, no controller enforcement. A programmatic planner run on a `large` batched idea has nothing telling it to guard | Medium | **MIRRORED (Tier 3)** |
| P4 | Batch lineage: `originating_idea_id` on EVERY create | `planner.md:95-103`, `:~600` | **INERT** as an instruction; **CODE** as a refusal — `TaskChangeRouter` lands a NULL link with a warning rather than guessing (`taskChangeRouter.ts`, `idea_needs_epic` path) | High | CODE (refusal) |
| P5 | **Component ledger: READ before planning; run the resume gate (a real AskUserQuestion) when anything is complete/stale/skipped** | `planner.md:105-205` | **INERT on planner.** `ideaLedgerContract` is explicitly `if (workflowName !== 'launch') return '';` — `stepPrompt.ts:352`. The docblock at `:344-350` says so outright: *"planner/ship carry the same obligations in their own prose and have the same programmatic blind spot"* | **HIGH — a programmatic planner run redoes settled work** | **MIRRORED (Tier 3)** |
| P6 | Stamp every component with `cyboflow_set_idea_component` after the body write | `planner.md:130-145`, `:~610` | **INERT on planner** (same `stepPrompt.ts:352` guard). Mirrored for launch only | High | **MIRRORED (Tier 3)** |
| P7 | Skip `approve-idea` when `idea-spec` is already complete | `planner.md:207-214` | **INERT** | Medium | INERT-documented |
| P8 | Intent probe: up to 2 question rounds, then require the stub | `planner.md:~250` | **INERT** on the plane; carried by `planner/agents/context.md` (which IS read) | Medium | INERT-documented |
| P9 | expand-spec must preserve flags / `## Architecture design` / `## Design spec` VERBATIM | `planner.md:~340`, `:~595` | **MIRRORED** — `ideaFlagContract` case `'expand-spec'`, `stepPrompt.ts:330-338`, with an explicit note that the preserve-list is a CLOSED enumeration | High | MIRRORED |
| P10 | ui-prototype: report the artifact + fold `## Design spec` into each covered idea | `planner.md:355-370` | **MIRRORED** — `artifactFollowUp` case `'ui-prototype'`, `stepPrompt.ts:271-284` | High | MIRRORED |
| P11 | architecture: fold the section into the body; do NOT report an artifact | `planner.md:378-388` | **MIRRORED** — `artifactFollowUp` case `'arch-design'`, `stepPrompt.ts:285-292` | High | MIRRORED |
| P12 | ui-prototype / architecture run ONLY on the persisted flag | `planner.md:355`, `:378-381` | **MIRRORED** — `conditionalExecution`, `stepPrompt.ts:392-424` | High | MIRRORED |
| P13 | **adversarial-review: report the artifact, file NO finding, no auto-revise, no loop** | `planner.md:400-414`, `:~586` | **MIRRORED** — `artifactFollowUp` case `'adversarial-review'`, `stepPrompt.ts:295-302` (ends "this step reviews and reports; the gate routes") | High | MIRRORED |
| P14 | **approve-design / approve-ideas / approve-designs are blocking `decision` review items, never an inline AskUserQuestion** | `planner.md:415-425`, `:~570` | **CODE** — `GateSideEffects` (`gateSideEffects.ts:71-76`) keys on the gate step ids and fires on `HumanGateOpener.onGateResolved`, awaited inside `ReviewQueueHumanGate.settleResumed` (`gateSideEffects.ts:26-32`) | High | CODE |
| P15 | approve-design Approve ⇒ every adversarial entry becomes an accepted-risk finding | `planner.md:425-427` | **CODE** — `gateSideEffects.ts:~390-410`, source `ADVERSARIAL_FINDING_SOURCE = 'agent:adversarial-review'` (`:80`), body built at `:490-505` | High | CODE |
| P16 | approve-design Approve ⇒ bind the approved design to the ideas | `planner.md:~570` | **CODE** — `bindApprovedDesignsForRun` (`design/flowDesignBinding.ts`), called from `gateSideEffects.ts` | High | CODE |
| P17 | **Epic invariant: >1 task ⇒ always an epic; fallback epic minted FIRST** | `planner.md:470-490`, `:495-505` | **INERT** on planner's plane as an instruction; **CODE** as a refusal — the chokepoint rejects a second epic-less task under one idea with `idea_needs_epic` (`taskChangeRouter.ts`) | High | CODE (refusal) |
| P18 | **Ledger closeout before approve-plan — account for all five components** | `planner.md:520-540` | **INERT** | High | **MIRRORED (Tier 3)** |
| P19 | approve-plan Approve ⇒ reveal drafts (`approved_at`) + stamp `decomposed_at`, lineage-filtered | `planner.md:545-556` | **CODE** — `resolveReviewItemHandler.ts:10-20` (Q1 REVEAL): `promotePendingDraftsForRun` on approve, `deleteRunCreatedEntities` on reject, fired BEFORE the item resolves so it wins the race with the controller advancing | High | CODE |
| P20 | approve-plan Reject ⇒ unwind `epics`/`stories` back to `incomplete` | `planner.md:558-567` | **INERT** — the draft delete is CODE, the ledger unwind is not | High — a leftover `complete` makes the next run skip decomposition | **CODE (Tier 3)** |
| P21 | Re-fetch entity bodies after EVERY gate | `planner.md:~600`, mirrored in ship/launch | **INERT** | Medium | INERT-documented |
| P22 | The appended step-reporting list is authoritative; a step absent from it is not in this run | `planner.md:~640` | **CODE** — the plane walks the frozen spec, so an absent step simply never spawns | Low | CODE |
| **LAUNCH** | |
| L1 | Interview: ONE question per AskUserQuestion call, never batched | `launch.md:110-116` | **INERT** on the plane; carried by `launch/agents/interview.md` | Medium | INERT-documented |
| L2 | **Checkpoint every 4 interview questions** | `launch.md:117-124` | **INERT** | Medium | INERT-documented |
| L3 | No cap on interview rounds; ends on `INTERVIEW_COMPLETE: yes` or the user's cut | `launch.md:125-133` | **INERT** | Medium | INERT-documented |
| L4 | project-brief: report the `project-brief` artifact, carry `THOROUGHNESS:` VERBATIM | `launch.md:136-152` | **MIRRORED** — `artifactFollowUp` case `'project-brief'`, `stepPrompt.ts:293-294` | High | MIRRORED |
| L5 | approve-brief Approve ⇒ stamp solution thoroughness on the project | `launch.md:154-160` | **CODE** — `stampSolutionThoroughness` via `GateSideEffects` (`gateSideEffects.ts:336+`, `APPROVE_BRIEF` at `:74`); consumed back into every later step prompt as `# Solution thoroughness` (`stepPrompt.ts:~500`) | High | CODE |
| L6 | Design runs ONCE on the whole concept; condition on the BRIEF's flags, never on ideas | `launch.md:162-175` | **MIRRORED** — `conditionalExecution` launch branch, `stepPrompt.ts:393-401` | High | MIRRORED |
| L7 | ui-prototype ⇒ append `## Design spec` to the brief and RE-REPORT `project-brief` | `launch.md:176-190` | **MIRRORED** — `stepPrompt.ts:281` (the `fold` branch) | High | MIRRORED |
| L8 | architecture ⇒ append to the brief and RE-REPORT | `launch.md:191-203` | **MIRRORED** — `stepPrompt.ts:290` | High | MIRRORED |
| L9 | ideas: persist flag lines VERBATIM; fold architecture into the LOWEST `BUILD_ORDER` idea; SPLIT the design spec per idea | `launch.md:232-258` | **MIRRORED** — `ideaFlagContract` case `'ideas'`, `stepPrompt.ts:328`. Its docblock (`:312-323`) records the 2026-08-04 incident where missing flag lines made ui-prototype and architecture self-skip on every programmatic launch | High | MIRRORED |
| L10 | Stamp `architecture` on that one idea; `prototype` only on ideas given their own design spec; never `skipped` | `launch.md:86-95`, `:243-262` | **MIRRORED** — `ideaLedgerContract` case `'ideas'`, `stepPrompt.ts:368-380` | High | MIRRORED |
| L11 | approve-ideas: blocking decision item, resume on a `# Approve-ideas decisions` block, approved refs only | `launch.md:273-288` | **CODE** — the decisions block is threaded into every later step prompt (`stepPrompt.ts:~487`, heading kept byte-identical to `APPROVE_IDEAS_DECISIONS_HEADING`); gate side effects at `gateSideEffects.ts:71` | High | CODE |
| L12 | expand-spec: stamp `idea-spec`; RE-stamp `architecture` (and `prototype` where a design is bound) | `launch.md:298-310` | **MIRRORED** — `ideaLedgerContract` case `'expand-spec'`, `stepPrompt.ts:381-382` | High | MIRRORED |
| L13 | Do NOT stamp `epics` at the epics step | `launch.md:325-327` | **MIRRORED** — `ideaLedgerContract` case `'epics'`, `stepPrompt.ts:383-384` | Medium | MIRRORED |
| L14 | tasks: fallback epic first; stamp `stories` + `epics` per idea | `launch.md:328-343` | **MIRRORED** (stamps) — `stepPrompt.ts:385-386`; fallback-epic ordering is **INERT** | High | MIRRORED |
| L15 | **Decompose EVERYTHING approved — never narrow the set to save time** | `launch.md:44-58`, `:~395` | **INERT** | High | **MIRRORED (Tier 3)** |
| L16 | Denied ideas get nothing; never archive them | `launch.md:~283`, `:~398` | **MIRRORED** — the decisions-block text at `stepPrompt.ts:~487` ends "DENIED ideas stay on the backlog untouched — never expand, design, decompose, or archive them" | High | MIRRORED |
| **SHIP** | |
| H1 | Everything Planner phases 1-2 do (context / approve-idea / expand-spec / design / adversarial / approve-design) | `ship.md:64-195` | Same as P9-P16; ledger stamps **INERT** (the `workflowName !== 'launch'` guard, `stepPrompt.ts:352`) | High | **MIRRORED (Tier 3)** |
| H2 | **No design fork** — ignore `DESIGN_MODE: yes` from the shared context agent | `ship.md:92-101`, `:~505` | **INERT** — no ship-specific suppression in `stepPrompt.ts` | Medium | **MIRRORED (Tier 3)** |
| H3 | approve-plan doubles as the pre-execution gate; the answer must start with "Approve" | `ship.md:231-260` | **CODE** — prefix matching in `questionRouter.ts:85-94` (`APPROVE_PLAN_STEP_ID`) and the reveal at `resolveReviewItemHandler.ts:10-20` | High | CODE |
| H4 | **Batch cap: 15 on `sdk`, 10 on `interactive`; ask the human to trim, never truncate** | `ship.md:244-247` | **CODE** as a refusal — `ship_batch_too_large` (`mcpQueryHandler.ts:3272`, `:3413`; cap read in `sprintLaneStore.ts:417`). The *ask-the-human-to-trim* behaviour is INERT | Medium | CODE + INERT-documented |
| H5 | Revise keeps the drafts; only the literal Reject option tears them down | `ship.md:248-256` | **CODE** — `deleteRunCreatedEntities` fires only on an explicit reject outcome (`resolveReviewItemHandler.ts:17-19`) | High | CODE |
| H6 | materialize-batch: call `cyboflow_create_sprint_batch` EXACTLY ONCE; on error report a finding and STOP | `ship.md:264-276`, `:~490` | **CODE** (idempotence) — the tool returns `created:false` on a second call (`runScopeTools.ts:374`). The "report a finding and stop" behaviour is **INERT** | High | CODE + INERT-documented |
| H7 | analyze-dependencies / execute-tasks / sprint review phases | `ship.md:270-430` | Identical to S3-S17, including the **INERT** sprint-verify loopback (S12) and address-review re-verify (S15) | High | see S3-S17 |
| H8 | The idea retires at approve-plan, not at human-review | `ship.md:~520` | **CODE** — `decomposed_at` stamped by the reveal path | Medium | CODE |
| **COMPOUND** | |
| C1 | **Seeded branch: when a `## Selected findings` block is present, SKIP `load-sprint`/`extract` discovery AND skip the `approve-learnings` gate** | `compound.md:107-165` | **INERT on the programmatic plane.** `getPrompt` prepends `# Selected findings` to the ORCHESTRATED main prompt only (`runExecutor.ts:1797-1805`, `:2075`). `composeStepPrompt` has **no** `selectedFindings` parameter — grep for `selectedFindings` / `seedFinding` in `stepPrompt.ts`, `spawnStepRunner.ts`, `defaultProgrammaticRunner.ts` returns **zero hits**. A programmatic compound run seeded from the triage tray never learns it is seeded | **HIGH** | **MIRRORED (Tier 3)** |
| C2 | Resolve each finding IMMEDIATELY as its action lands; never batch to the end | `compound.md:150-165` | **CODE** as a refusal — `cyboflow_resolve_finding` is rejected on a terminal run (`run_not_active`). The *ordering* instruction is INERT | High | CODE + INERT-documented |
| C3 | Publish ONE `compound-recommendations` artifact with `## Act on` + `## Discarded` | `compound.md:178-190`, `:235-270` | **MIRRORED** — `artifactFollowUp` case `'compound-recommendations'`, `stepPrompt.ts:305-306` | High | MIRRORED |
| C4 | **NEVER emit `cyboflow_report_finding` with `kind:'finding'`; NEVER file a decision for a discarded candidate; exactly TWO gates, both workflow STEPS** | `compound.md:275-300` | **MIRRORED** — `compoundGuard`, applied to EVERY compound step (`stepPrompt.ts:565-567`, rendered at `:649`). The docblock at `:555-563` notes it was widened beyond the artifact step after being observed on `load-sprint`, which has no `outputArtifact` | High | MIRRORED |
| C5 | `doc:claude-md` capped at ONE per run; reject rules carrying a migration number / run id / date | `compound.md:~155`, `:245-252` | **MIRRORED** — inside the `compound-recommendations` addendum (`stepPrompt.ts:306`) | Medium | MIRRORED |
| C6 | approve-learnings then write-back then human-review, in that order, and write-back emits NO review items | `compound.md:196-232` | **CODE** (ordering — the frozen step graph) + **MIRRORED** (no review items — `compoundGuard`) | High | CODE + MIRRORED |
| C7 | Source material: `cyboflow_get_run`, the `## Run context digest`, the git diff | `compound.md:75-105` | **INERT** — the digest is an orchestrated-prompt prepend | Medium | INERT-documented |
---|
### 3.3 The inert set, ranked |

### Not in the original survey: the build-break contract

Tier 3 added one obligation that had no prose to mirror, because it did not exist
on either plane: a lane that cannot build for a reason OUTSIDE its own task now
files a `build-break` finding instead of silently routing around it
(`buildBreakContract`, and the matching `## Build break` result section in
`sprint/agents/{implement,write-tests,task-verify}.md`). Sprint lanes share ONE
worktree, so a break one lane introduces lands in all of them; the previous
behaviour was N lanes each carrying a private workaround and nothing anywhere
recording the cause. The DETECTOR that groups identical reports is Tier 3's Lane
CD; the reporting half is in place regardless of whether it lands.

## 2. The inert set, ranked

The obligations that are STILL prose-only after Tier 3 and would change an
outcome, worst first:

1. **S12 / H7 — sprint-verify FAIL does not loop lanes back.** `sprint-verify`
   declares `retries: 1` and no `loopback` (`shared/types/workflows.ts:1057-1064`).
   The prose's whole recovery protocol, including its "at most 2 loops" cap, has no
   code behind it: a programmatic sprint whose full suite fails retries the suite
   once, then fails the step. **The single biggest inert obligation, and NOT
   addressable by a prompt** — it needs a `loopback` on the step definition plus a
   controller path that re-drives specific lanes, which is a Lane B-shaped change,
   not a Lane E one.
2. **S15 — address-review never re-runs sprint-verify automatically.** Tier 3
   pinned the blocking finding's title (`address-review left the tree red`) and
   kept the "settle the code before you resolve" contract, so the step is now told
   to re-run the suite itself. What is still missing is the loopback: nothing in
   the step graph forces it, so the obligation binds only as far as the agent
   honours it. Hence *partial* in the table.
3. **S4 — "write EVERY analyzer edge" has no verification.** Same class as S3
   (`taskScope`), one level further on: the plane makes sure the agent SEES the
   tasks, but not that it PERSISTS the edges it was given. A collapse to "no
   dependencies" is silent and looks like a clean run.
4. **P2 / P7 / P21 — size triage, the approve-idea skip, the post-gate re-fetch.**
   Each is a planning-efficiency obligation with a real but bounded cost.
5. **L1 / L2 / L3 — the interview's shape** (one question per call, a checkpoint
   every four, no round cap). Carried by `launch/agents/interview.md`, which IS
   read, so these are the least exposed of the inert set.
6. **H4 / H6 — "ask the human to trim", "report a finding and stop".** The error
   itself is CODE (a refusal); the prescribed RESPONSE to it is prose.
7. **S8 / S13 — one commit per task, findings carry category + locations.**
   Agent-discretionary, low blast radius.
8. **C7 — compound's source material.** The run-context digest is an
   orchestrated-prompt prepend with no programmatic equivalent.

### Known limitation carried forward from C1

`compound.md`'s seeded branch also says the `approve-learnings` gate is SKIPPED on
a seeded run. Tier 3 mirrors that instruction, but on the BUILT-IN compound
definition `approve-learnings` is declared `human: true`, so the controller
resolves it through the human-gate path and `composeStepPrompt` is never called
for it. The mirrored self-skip therefore binds only on a custom chain that
declares the step with an agent. Suppressing the built-in gate on a seeded run is
a controller-side decision (skip the step when the run carries
`seed_finding_ids`), not a prompt one.

## 3. The pattern worth naming

Every obligation that has been moved from INERT to MIRRORED in this codebase
before Tier 3 was moved **after a live incident**, and each one is documented in
the mirroring function's own docblock:

| Mirror | Incident |
|---|---|
| `taskScope` (`stepPrompt.ts`) | 2026-06-22 — dependency edges dropped, dependents ran concurrently with their prerequisite |
| `artifactFollowUp` | 2026-07-06 — empty ui-prototype tab |
| `ideaFlagContract` | 2026-08-04 — first launch smoke; ui-prototype and architecture self-skipped |
| `ideaLedgerContract` | 2026-09-04 — first multi-idea launch; 3 epics + 8 tasks created, `epics`/`stories` left `incomplete` |
| `proveContract` | 2026-08-27 — prove filed three gate questions asking for the approved proposal back |
| `compoundGuard` | observed on `load-sprint` (no `outputArtifact`, so the per-artifact addendum missed it) |
| task-verify relay note | 2026-07-22 live smoke |

Tier 3 is the first batch mirrored **before** its incident. The nine obligations it
moved (P3, P5, P6, P18, L15, H1, H2, C1, and S15 in part) were each one live run
away from the same shape of failure the seven above already produced: work
silently redone, a set silently narrowed, a branch silently not taken. The list in
§2 is the remainder — the obligations that have not yet had their incident, and
now have a written reason why each one is still waiting.

## 4. How to keep this current

When you mirror an obligation, do three things, in this order:

1. Write the section as a pure function in `stepPrompt.ts` with a docblock naming
   the obligation and, where there is one, the incident. The docblock is the
   durable record; this file is the index.
2. Add a unit test asserting the exact heading and the per-workflow / per-step
   gating, including the negative case (the flows and steps it must NOT reach).
   Byte-identity of the prompts it does not touch is the invariant that keeps a new
   section from perturbing every other flow.
3. Update this table's `Status after Tier 3` column, and move the row out of §2 if
   it was there.

When you find an obligation that CANNOT be mirrored — because it needs the
controller, a step-graph edge, or a chokepoint — say so in §2 with the reason, as
S12 does. A prompt that promises something the plane cannot deliver is worse than
an honest gap.
