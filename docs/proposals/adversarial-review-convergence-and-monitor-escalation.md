# Adversarial-review convergence + monitor escalation seams

Status: PLAN, revision 2 (2026-09-18) after one Codex adversarial round (dispositions in the
appendix). Programmatic plane only. The orchestrated flow prompts (`workflows/*.md`) change
ONLY in the artifact-composition contract (item 1); their automatic-revision wording is left
as is (see CR-7).

## Problem

Adversarial-review loops on Planner / Ship / Launch do not converge: every revision round
yields new `AR-n` entries, the human keeps pressing "Rerun planning with findings", and the
gate never gets a clean review. Live evidence (packaged 0.4.2, all laps human-driven):

- run `61afeb…` (planner): reject → monitor `rewind_to_step expand-spec` → 4 revises → 6th
  gate pending; blockers 4→6→4→3→2; reviewer renumbered ids between rounds; the open gate
  says "5 of 5 used — this is the last one" while the controller's counter is 4.
- run `4c19…` (planner, 5 ideas): 15 entries → all "resolved" + 11 NEW (3 blocking) →
  approved → 11 findings filed.
- runs `bba24c5…`, `e6a1a2d…` (planner): BLOCKING reviews (4+5, 3+13 entries) with the
  approve-design gate SKIPPED for "no design surface" — never shown to a human, never filed.
- Human gates account for 30 of the 46 blocking review items on programmatic runs since
  9/1; agent questions 14 (13 = launch interview, by design); agent blocking findings 1.

Root causes (code): the re-review prompt says "review from scratch" and "number NEW entries
continuing"; only previously-blocking ids need a disposition; ids are not frozen; a human
Revise carries no note (no textarea; `resolveReviewItemHandler.ts:665` lets `outcome`
overwrite `resolution`); the loop verdict is read only from the reviewer's final chat text;
the gate-skip predicate ignores the review artifact; the gate's revision budget counts
rejects and diverges from the in-memory counter.

Decisions already taken with the user: keep every designed gate (they mark where the human
wants to be consulted); between gates the monitor's job is "minimize interruptions, best
possible result at the gate"; invert "monitor triggers a loop" into "monitor steers or stops
the loop"; raise the automatic-loop cap to 3; the monitor recommends at gates and reviews
escalations before they reach the human queue; never auto-resolve a designed gate or
auto-answer a question.

## Shared vocabulary

- **Review round**: one completed adversarial-review result. Round 1 is the first review; a
  re-review after any revision (automatic lap or human revise) is round N+1. One monotonic
  counter per review step per walk (`reviewRounds: Map<reviewStepId, number>`), incremented
  on every completed review result, is the ONLY source of the round number.
- **Lap**: an automatic loopback (no human involved). `MAX_REVIEW_AUTO_REVISIONS` bounds laps.
- **Steering**: the monitor's per-entry instruction on a lap: `address` (ids the re-run must
  fix) and `setAside` (ids judged not worth addressing now; filed as findings immediately).
- **Recommendation**: a non-binding, machine-readable line the monitor attaches to a review
  item so the card can emphasize one choice.
- **Consult**: one monitor query. Every consult is bounded by `SUPERVISOR_QUERY_TIMEOUT_MS`,
  fail-soft, and — when it posts chat — serialized on the monitor session's `sendChain`
  (the rule `triageLane` already follows, `monitor.ts:1632-1641`).

---

## Item 1 — Scoped re-review prompt + three-section artifact contract

Files: `main/src/orchestrator/workflows/{planner,ship,launch}/agents/adversarial-review.md`
(three byte-identical copies; parity test `builtInWorkflows.test.ts:642`),
`main/src/orchestrator/programmatic/stepPrompt.ts` (`artifactFollowUp('adversarial-review')`
~L329, `composeAdversarialRevisionSection` L643, the human-gate branch L876-897),
`main/src/orchestrator/workflows/{planner,ship,launch}.md` (artifact composition bullets at
`planner.md:416`, `ship.md:149`, `launch.md:204` — these and ONLY these bullets),
`shared/types/adversarialReview.ts`, `main/src/orchestrator/adversarialReviewGateBody.ts`.

Reviewer contract (replace the RE-REVIEW clause at L64-71):

1. **Frozen ids.** An `AR-n` id refers to the same defect forever. Never renumber, never
   reuse. New entries continue from the highest id ever used in this run.
2. **Carry-forward ledger.** On a re-review emit a `### Prior entries` section listing EVERY
   id from the previous round — blocking and advisory — one line each:
   `- AR-n (blocker|major|minor|advisory) — resolved | unresolved | resolved-with-regression (see AR-m) | set-aside | withdrawn — <one line>`
   The parenthesised word is the entry's severity in the PREVIOUS round (so the gate can
   count prior blockers separately from prior advisories). `set-aside` = the supervisor's
   steering excluded it; `withdrawn` = the reviewer no longer stands behind it. An
   unresolved blocker is re-listed under `## Blocking` with its original id and text,
   updated only where the surface changed.
3. **Scope pin for NEW entries.** A new entry is allowed only for a defect *introduced or
   exposed by the changes since the previous round*, or a `blocker` that makes the design
   unshippable. A pre-existing defect the reviewer did not raise before goes under
   `## Findings` as `advisory`, never under `## Blocking`.
4. **Diminishing returns.** If the previous round's blockers are all resolved and no new
   blocker meets rule 3, the verdict is `REVIEW: CLEAN` even when advisory entries remain.

Artifact contract (CR-1): the reported doc has THREE top-level sections —
`## Blocking`, `## Findings`, `## Prior entries` (the last present only on a re-review;
`None.` on round 1 is acceptable). Amend `artifactFollowUp('adversarial-review')` ("exactly
two top-level sections" → three, carry the ledger verbatim) AND the three orchestrated
composition bullets identically. The parser ignores the section today, so an old-format doc
still parses.

Parser (`parseAdversarialReviewDoc`): add optional `prior: PriorEntry[]` with
`PriorEntry = { id, previousSeverity?: AdversarialSeverity, status: 'resolved'|'unresolved'|'resolved-with-regression'|'set-aside'|'withdrawn', ref?: string, note?: string }`,
recognized only under a `## Prior entries` / `### Prior entries` heading (H2 or H3, outside
fenced blocks). A line whose status word is unknown is dropped, never guessed. Add
`maxAdversarialId(markdown): number` (highest `AR-n` anywhere in the doc).

Round threading (CR-2): the controller keeps `reviewRounds` (see vocabulary) and stamps
`gateRevision.round = reviewRounds.get(reviewStepId)` on BOTH lap and human revisions (for
a human revise the review step is `phase.steps.find(s => s.agent === 'adversarial-review')`).
`composeAdversarialRevisionSection` and the human-gate branch add, when the review markdown
is present: "This is round R+1. Ids used so far: AR-1..AR-k (k = `maxAdversarialId`). Keep
them; list every one under `### Prior entries` with its previous severity."

Gate body: add a **Convergence** line under the counts when `prior` is non-empty:
"Round N: a of b prior blockers resolved, c regressions, d new blockers, e set aside" (b =
prior entries whose `previousSeverity` is blocker|major; d = current blockers whose id is not
in `prior`) and a collapsed list of `unresolved` / `resolved-with-regression` ids.

Tests: parity of the three copies; `artifactFollowUp` snapshot names three sections and the
ledger; parser (ledger present / absent / unknown status / H2 and H3 / inside a fence
ignored); `maxAdversarialId`; gate-body convergence line; stepPrompt round sentence;
controller round counter increments once per review result and survives a human revise.

## Item 2 — Gate skip must respect a populated review; clear the leaked revision flag

Files: `main/src/orchestrator/runEntityOwnership.ts:412` (`hasReviewableDesignSurface`),
`main/src/orchestrator/programmatic/workflowController.ts:695-714` (optional-gate skip
branch).

- `hasReviewableDesignSurface`: before returning `false`, read the run's
  `adversarial-review` artifact via `readAdversarialReviewMarkdown` (exported from
  `adversarialReviewGateBody.ts`) and return `true` when
  `parseAdversarialReviewDoc(md).blocking.length + findings.length > 0`. An empty review
  (run `a07995b…`'s 39-byte doc) still skips. Keep the fail-open catch.
- Skip branch: set `pendingGateRevision = undefined` before `i += 1; continue;` (today the
  "revision requested" section leaks into the epics/tasks steps after a skipped gate; it is
  only cleared at L745 / L865 when the gate actually opens).

**Freshness (follow-up, 2026-09-21).** The critique is ONE row per run, so it survives a
whole-run rewind and a Revise loopback — and a previous walk's critique would open this gate
over a surface that no longer exists. `hasReviewableDesignSurface` now takes an optional
`{ reviewReportedSinceMs }` bound, threaded from the controller through
`shouldSkipHumanGate(step, runId, ctx)`; a critique whose `artifacts.reported_at` (migration
143) predates the bound reads as ABSENT. The bound is the review step's visit start on this
walk, the WALK start when that step did not run this walk (e.g. it self-skipped), and NOTHING
when the review step is in `completedStepIds` (the critique belongs to the surviving
timeline). Unknown age and absent bound both mean no constraint. Only the critique branch is
bounded — the prototype / arch-design / brief / idea surfaces are a separate question.
`reported_at` is re-stamped on EVERY report including an identical re-report, which is
precisely what `revision` (and the `entity_events` delta log) does NOT do.

Tests: `runEntityOwnership` (populated review → true; empty doc → false; no artifact →
existing behaviour); controller: lap → gate skipped → next step's ctx has no `gateRevision`.

## Item 3 — Human note on Revise, with prefix-only verdict parsing

Files: `frontend/src/components/ReviewQueue/ReviewItemCard.tsx` (L372 `handleGateDecision`,
L731-739 buttons), `frontend/src/hooks/useReviewItemActions.ts:124`,
`main/src/orchestrator/resolveReviewItemHandler.ts:665`,
`main/src/orchestrator/trpc/routers/reviewItems.ts:811`, `shared/types/reviews.ts`,
`main/src/orchestrator/programmatic/humanGate.ts:116` (`parseGateVerdict`),
`main/src/orchestrator/gateSideEffects.ts:110` (`gateDecisionFromResolution`; callers at
L269/L273 in `reconcileAtSettle` and the resolve-time `apply`),
`main/src/orchestrator/programmatic/defaultProgrammaticRunner.ts:583`
(`readGateResolutionNote`) and `:510` (`readApproveRunbookResolution`, CR-12).

Resolution grammar (new, in `shared/types/reviews.ts`, next to `RESOLUTION_PREFIX_*`):

```
<verdict>                      approve | reject | revise
<verdict>[<modifier>]          approve[no-findings]            (item 8; the only modifier)
<verdict>: <note>              revise: only AR-2 matters, drop AR-11
<verdict>[<modifier>]: <note>
```

`composeGateResolution({ verdict, modifier?, note? })` and
`parseGateResolution(resolution) → { verdict, modifier?, note? } | null` (regex
`^(approve|reject|revise)(?:\[([a-z-]+)\])?(?::\s*([\s\S]*))?$`, case-insensitive verdict).
`null` for anything else (legacy free text, `idea-verdicts:` maps, `promoted:` etc.).
Modifier validation (CR-12): the parser accepts any `[a-z-]+` so old rows never throw, but
the HANDLER refuses (`invalid_payload`) any modifier other than `no-findings`, any modifier
with a verdict other than `approve`, and `no-findings` on any gate other than the singular
`approve-design` (`gate:human-step:approve-design`).

- Handler L665: when `outcome` AND a non-empty `resolution` are both given, store
  `composeGateResolution({ verdict: outcome, modifier: input.modifier, note: resolution })`.
  Bare `outcome` stores the bare verdict (plus modifier) as today. The auto-resume guard at
  L781 reads `input.outcome` (not the stored string) and needs no change.
- Every verdict reader parses the prefix FIRST and falls back to today's `.includes()` sniff
  only when `parseGateResolution` returns `null` (legacy rows): `parseGateVerdict`,
  `gateDecisionFromResolution`, `readGateResolutionNote` (return the parsed `note`;
  legacy free text passes through as today), `readApproveRunbookResolution` (return the
  parsed `note` or, for legacy rows, the raw string as today). The question-router
  `.includes('revise'|'reject')` readers parse ANSWER labels, not resolutions — untouched.
- Card: a textarea (placeholder "Optional: what to change — e.g. only AR-2 matters, drop
  AR-11") shown for approve-design in-session; "Rerun planning with findings" sends
  `{ outcome: 'revise', resolution: note }`. The note reaches the re-run through the
  existing `readGateResolutionNote` → `gateRevision.note` path ("the reviewer's own words …
  outranks the review").

Tests: grammar round-trips incl. legacy → null; "revise: the architecture rejects empty
input" parses as revise in all readers; handler composes; modifier refusals; card sends both
fields; approve-runbook note without the prefix.

## Item 4 — Honest revision budget in the gate body

File: `main/src/orchestrator/adversarialReviewGateBody.ts:52,89-104,117-128`.

- `countApproveDesignRevisionsUsed`: count a row when `parseGateResolution` yields `revise`,
  OR (parse is `null` AND the legacy sniff `gateDecisionFromResolution` yields `revise`) —
  the same reading the gate readers apply, so the number never disagrees with what the run
  actually did (CR-13). Fix the docblock (a `reject` also resolves this gate).
- `renderBudget`: the enforced budget is the controller's per-walk `MAX_STEP_LOOPBACKS` (5)
  and resets on rewind; the DB count can only over-count. Render "Revisions so far this run:
  n" with no deadline copy. Delete "this is the last one … ends this run as rejected" and the
  "findings are swept when the session is archived" sentence. Delete the local
  `MAX_GATE_REVISIONS` literal.
- Do NOT persist the controller counter.

Tests: count ignores `reject`, counts prefixed and legacy revises; copy has no "last one".

## Item 5 — Loop verdict falls back to the review artifact

Files: `workflowController.ts:2886` (`tryAdversarialReviewLoopback`), `types.ts:574`
(`ControllerHost`), `defaultProgrammaticRunner.ts` (~L760 already reads the artifact live for
revision prompts), `programmaticRunHost.ts`.

- New optional host seam `readAdversarialReview?(): string | undefined` (same reader as the
  revision prompt).

  **Freshness (follow-up, 2026-09-21).** The seam is now
  `readAdversarialReview?(opts?: { reportedSinceMs?: number })`. Because the artifact row is
  one-per-run it outlives its walk, and a reviewer turn that returns no text on the NEXT walk
  would fall back onto the previous walk's blockers — a phantom loop. An artifact last
  reported (`artifacts.reported_at`, migration 143) before the bound reads as absent. The
  bound is the review step's visit start on this walk, the walk start when that step did not
  run this walk, and nothing when the review step completed before this walk; absent bound and
  unknown age both mean no constraint. Both controller reads in a visit (the verdict fallback
  and `selectReviewDocument`) use the SAME instant, and the id-set mismatch check stays the
  second line of defence. (The gate-revision quote was originally left unbounded on the
  reasoning that the human had just read that critique at the gate; the follow-up below makes
  that false on the stale path and bounds it too.) `reported_at` is re-stamped on every
  report, including an identical re-report that moves neither `revision` nor the audit log.

  **Gate body + Approve filing (follow-up, 2026-09-22).** Two consumers of the same row still
  read it unbounded: the gate's own body, and Approve's accepted-risk filing. Both are now
  bound. The instant travels `ControllerStepContext.reviewReportedSinceMs` (set at the three
  `requestHumanGate` call sites, never on an agent step's ctx, so prompts stay byte-identical)
  → `HumanGateRequest.reviewReportedSinceMs` → `HumanGateOpener.openHumanGate(..., opts)`.
  `composeAdversarialReviewGateBody` takes the bound and, for a critique reported BEFORE it,
  renders a "No adversarial review this round" notice instead of its counts — not `null`,
  because the Adversarial review TAB is still showing the previous round's critique beside the
  gate and the human has to be told it is out of date. The opener stamps the bound on the gate
  row as `DecisionPayload.reviewReportedSince` (ISO-8601 UTC) inside the same transaction; it
  survives the resolve because `ReviewItemRouter.runTriage` merges its resolution meta into
  the minted payload rather than replacing it. At resolve time `GateSideEffects.apply` carries
  the settled `reviewItemId`, and `fileAcceptedRiskFindings` re-reads that stamp and applies
  the same bound — so Approve never files a previous round's `AR-n` entries as risks the human
  weighed, and logs when a stale artifact is what suppressed the filing. The ORCHESTRATED-plane
  arm (`maybeApplyOrchestratedGateSideEffects`) passes no `reviewItemId` and stays unbounded.

  **Gate-revision quote (follow-up, 2026-09-22).** The stale gate body creates a third
  consumer, on the other channel: the human it just told "the previous round's critique does
  not describe the current design" presses **Revise**, and the re-run's prompt quotes that same
  document back as the feedback to act on — `ctx.gateRevision.reviewMarkdown` is never set on a
  human-gate revision, so `SpawnStepRunner` falls through to the run's artifact. So the gate's
  bound now rides the revision: `applyGateDecision` SNAPSHOTS the walk's
  `reviewReportedSinceMs` onto `ControllerStepContext.gateRevision`, `SpawnStepRunner` passes
  it to the `adversarialReviewMarkdown` thunk, and the thunk forwards it to
  `readAdversarialReviewMarkdown`. A snapshot, not a live read: the review step sits inside the
  region a revision re-drives and re-stamps the controller's bound at its own visit, so a live
  read would make that turn's quote vanish. Fresh critique ⇒ the same string as before; no
  bound (a resume past the reviewer) ⇒ unbounded as before; only the stale case changes, and
  there the section is dropped exactly as it is on a run with no artifact. The bound is
  destructured OFF before the revision reaches `composeStepPrompt`, so it never renders.
- In `tryAdversarialReviewLoopback`: when `resultText` is empty OR `parseCodeReviewVerdict`
  returns `null` with no populated `## Blocking` in the text, read the artifact and treat
  `parseAdversarialReviewDoc(md).blocking.length > 0` as blocking; the quoted `blocking`
  note then comes from the artifact. Explicit `REVIEW: CLEAN` in the text still wins.
- Return the parsed review alongside the jump (item 6 reuses it).

Tests: empty result text + artifact with blockers → loops; `REVIEW: CLEAN` + stale artifact
with blockers → advances; no artifact → today's behaviour.

## Item 6 — Cap 3, with the monitor steering or stopping each lap

Files: `workflowController.ts:149` (`MAX_REVIEW_AUTO_REVISIONS`), L449 / `types.ts:149` /
`stepPrompt.ts:224` (the three `gateRevision` declarations), L838-856 (call site),
`types.ts:574` (`ControllerHost`) and `:590` (`ControllerStepContext`),
`programmaticRunHost.ts` (new seam beside `triageLaneFailure` L489), `monitor.ts`
(`MonitorSession` L1425, new schema + builder next to `MONITOR_LANE_TRIAGE_SCHEMA` L202 /
`buildLaneTriagePrompt` L606), `stepPrompt.ts` (new `composeMonitorSteeringSection`).

Constants:

```ts
export const MAX_REVIEW_AUTO_REVISIONS = 3;       // laps when the monitor votes 'loop'
export const MAX_REVIEW_MECHANICAL_REVISIONS = 1;  // laps with no monitor verdict (today's behaviour)
```

Controller flow at the call site when the verdict (item 5) is BLOCKING and
`used < MAX_REVIEW_AUTO_REVISIONS`:

1. `reviewRounds` is incremented (a review result completed). Build
   `ReviewLoopRequest { stepId, loopbackStepId, round, maxRounds, reviewMarkdown, parsed,
   priorRounds }` where `priorRounds` is a per-walk
   `Map<stepId, { round, blockingIds, blockingTitles }[]>` the controller appends to on
   every review result (passed explicitly — `step_results` collapses laps).
2. `host.adviseReviewLoop?(req, ctx)` → `ReviewLoopDecision | undefined`.
3. Apply:
   - `loop` → lap, with `pendingGateRevision = { gateStepId, source: 'adversarial-review',
     round, note?, steering: { address, setAside, guidance? } }`.
   - `stop` → advance to the gate WITHOUT a lap; record
     `escalation = { loopStopRationale, setAsideIds }` on the controller and pass it in
     `ControllerStepContext.escalation` when the gate opens (CR-9).
   - `undefined` → mechanical lap only while `used < MAX_REVIEW_MECHANICAL_REVISIONS`,
     else advance (fail-soft = today's behaviour).

Monitor contract (CR-8):

```ts
// MONITOR_REVIEW_LOOP_SCHEMA — additionalProperties: false
required: ['verdict', 'rationale']
verdict:   'loop' | 'stop'
rationale: string                 // 2-4 sentences
address:   string[]               // loop: AR ids the re-run must fix
setAside:  { id: string; reason: string }[]
guidance:  string                 // loop: what to do differently, optional
```

Parse/downgrade table (`parseReviewLoopOutput`, lenient like `parseLaneTriageOutput`):
unparseable / missing verdict → `undefined` (mechanical path); blank rationale → keep the
verdict, rationale "(none given)"; ids not in `parsed` → dropped; an id in both lists → kept
in `address`; duplicate ids → deduped; `setAside` entries with a blank reason → reason
"(no reason given)"; `loop` with an empty `address` after validation → `stop`.

Host side effects (mirroring `triageLaneFailure`; on the monitor's `sendChain` because they
post chat): kill switch `CYBOFLOW_DISABLE_REVIEW_LOOP_TRIAGE=1` → `undefined`; one
non-blocking audit finding per consult (source `monitor`, category `review-loop`, body =
verdict + rationale + steering); for each `setAside` entry file a non-blocking finding NOW
(source `agent:adversarial-review`, title `AR-n — <title>` so `filedAdversarialIds` dedupes
it at the gate, body prefixed "Set aside by the supervisor on round N: <reason>"); one chat
note. Abort: the consult takes the run signal; an aborted consult returns `undefined`.

Prompt (`buildReviewLoopPrompt`): charter (item 7) + run digest + the review markdown +
prior-round blocker ids/titles + round/maxRounds. Menu: `loop` when a concrete, bounded fix
set exists and the remaining laps can plausibly clear it; `stop` when the remaining blockers
are product calls the brief does not settle, when the round-over-round trend shows churn
(new ids replacing old ones, regressions), or when this is the last lap and the set is not
clearly closable. `setAside` is for entries that are advisory in substance, speculative, or
out of the idea's stated scope — each with a one-line reason the human will read as a
finding.

Re-run prompt (`composeMonitorSteeringSection`, rendered inside the existing
`## Adversarial review: revision requested` section when `steering` is present): "The
supervisor's steering — authoritative, outranks the review where they disagree: ADDRESS
AR-a, AR-b (…guidance…). SET ASIDE AR-x (reason), AR-y (reason): do not spend this lap on
them; they are already filed as findings. Reviewer: list set-aside ids under `### Prior
entries` as `set-aside`; do not re-raise them as blocking."

Orchestrated prose: UNCHANGED (CR-7). `planner.md` step 7's "Automatic revision — ONCE"
describes that plane's own behaviour, which has no supervisor; changing it would change
behaviour there.

Tests (fake host): loop with steering renders the section and files set-aside findings;
stop advances to the gate with `ctx.escalation` set; undefined → one mechanical lap then
gate; cap 3 reached → gate; parse/downgrade table; consult aborted by signal → mechanical.

## Item 7 — Monitor charter + one-shot triage retry guidance + optional-step consult

Files: `monitor.ts` (every prompt builder: `buildTriagePrompt` L546, `buildLaneTriagePrompt`
L606, `buildAnswerPrompt`, `buildActionAnswerPrompt`, plus the item 6/8 builders;
`TriageAdvice` L161; `MONITOR_TRIAGE_SCHEMA` L150), `types.ts:207` (`TriageDecision`),
`programmaticRunHost.ts:413` (`triageFailure`), `workflowController.ts:2704`
(`handleRequiredFailure`) and the optional-step failure branch, `runDirectives.ts`,
`spawnStepRunner.ts`, `defaultProgrammaticRunner.ts:776` (owns `directives`).

Charter (`monitorCharter(ctx)`, prepended verbatim to every builder, replacing each one's
own "You are the SUPERVISOR …" opening; task-specific paragraphs unchanged):

> You are the SUPERVISOR of a "<flow>" workflow run in this git worktree. Host code
> sequences the steps; you never run them. Your objective is that this run reaches its next
> human gate with the best result it can, and that the human is interrupted only for
> decisions that are genuinely theirs: product calls the brief does not settle, work that
> needs their own hands or accounts, irreversible or cost-material actions (ending a run, a
> whole-run rewind), and anything after the autonomous budget is spent. Everything else you
> resolve, steer, or record. Never suppress a finding to avoid an interruption — file it
> non-blocking. Every autonomous action you take is recorded in the run's review queue and
> summarized for the human at the next gate.

Triage (required step): `buildTriagePrompt` drops "Prefer this when unsure"; menu becomes
`retry` (REQUIRED `guidance`: what to do differently; "try again" → downgraded to
`escalate`), `escalate` (the charter's human-only cases), `fail`. `TriageAdvice` gains
`guidance?: string`; schema adds it (optional; enforced by the parser's downgrade).

One-shot guidance channel (CR-10): `RunDirectives.retryGuidance: Map<string, string>` —
stepId → guidance CONSUMED (read then deleted) by `SpawnStepRunner` on that step's next
spawn, rendered as its own `## Supervisor retry guidance (this attempt only)` section AFTER
any operator `stepGuidance` (which is untouched and still sticky). The runner, which owns
`directives`, injects `setRetryGuidance(stepId, text)` into the host; `triageFailure` calls
it on `retry` and posts a chat note. Absent injection ⇒ the retry runs without guidance (log
at warn).

Optional-step failure (adjacent gap): today an optional step that fails is skipped silently.
Add ONE consult through `triageFailure` with `optional: true` in the request; `retry` (with
guidance) re-runs the step once (per-walk `optionalTriageRetries`, cap 1); `escalate` and
`fail` both mean "skip as today" (an optional step never opens a gate or ends the run).

Tests: charter present in every builder (first-paragraph snapshot); retry without guidance →
escalate; retry writes `retryGuidance` and the next spawn consumes + deletes it; operator
`stepGuidance` untouched; optional-step retry once then skip.

## Item 8 — `annotate` op + escalation review at human gates + "continue without logging"

Files: `reviewItemRouter.ts` (ops union L207-212, `ReviewActor` L111, new `runAnnotate`),
`shared/types/reviews.ts` (`ReviewItemChangeAction` L528 → `'annotated'`; new
`parseSupervisorRecommendation`, `upsertMarkdownSection`), `humanGate.ts` (`HumanGateRequest`
L25, `HumanGateOpener` L50, `ReviewQueueHumanGate.resolve` L137-285),
`humanStepManager.ts` (opener impl), `programmaticRunHost.ts:309` (`requestHumanGate`),
`types.ts:590` (`ControllerStepContext.escalation?`), `monitor.ts` (`reviewEscalation` on
`MonitorSession`, `buildGateEscalationPrompt`, `MonitorHistory.runDigest`),
`gateSideEffects.ts` (`GateSideEffectArgs` L132, `apply`, `fileAcceptedRiskFindings` L381),
`ReviewItemCard.tsx`, `resolveReviewItemHandler.ts`, `reviewItems.ts` (zod).

Router `annotate`:

```ts
interface ReviewItemAnnotate {
  op: 'annotate'; actor: ReviewActor; reviewItemId: string; runId?: string | null;
  heading: 'Supervisor recommendation';   // closed set for now
  markdown: string;
}
```

Applies `upsertMarkdownSection(body, heading, markdown)` (CR-14): the section is
`## <heading>` up to the next H1/H2 heading that is OUTSIDE a fenced code block; an existing
section is replaced in place, further duplicates removed, otherwise appended. Allowed only
on `pending` items (`invalid_status` otherwise), any kind. Records an `entity_events` row
with delta `{ field: 'body', from, to }` and emits action `'annotated'` (renderer stores
upsert the full item — no new switch arm; `gitOps.ts:642` is unrelated). `ReviewActor`
gains `'monitor'` (no DB CHECK on actor; no migration).

Machine-readable first line of the section: `Recommended: <choice> — <one sentence>`,
`<choice>` ∈ `approve | reject | revise | continue | rerun | dismiss`.
`parseSupervisorRecommendation(body)` reads ONLY inside that section (never a stray
`Recommended:` in the original gate body) and returns `{ choice, sentence } | null`. The
card maps `continue→approve`, `rerun→revise`, `dismiss→approve[no-findings]` for
approve-design and emphasizes the matching button (`variant="primary"`, a "Supervisor
recommends" chip); the others become secondary. The chip renders on BOTH surfaces; button
emphasis applies in-session (the queue surface shows only "Open in session" / "Dismiss" for
run-bound items, `ReviewItemCard.tsx:508`).

Gate consult (`requestHumanGate`, CR-5): the gate body is composed inside the gate-open
transaction (`humanStepManager.ts:181-196`), so the monitor cannot see it pre-open. Order:

1. `HumanGateOpener` gains `readGateItem(reviewItemId): { title, body, status, resolution } | null`.
2. In `ReviewQueueHumanGate.resolve`, right after `targetId = effectiveId` (L264): (a)
   re-read the item; if it is already `resolved` / `dismissed`, settle immediately with that
   resolution (closes the pre-existing lost-event window between `findPendingGate` and the
   target assignment); (b) otherwise, when `req.onOpened` is set, call it fire-and-forget —
   `void Promise.resolve().then(() => req.onOpened(snapshot)).catch(log)` — with
   `snapshot = { reviewItemId, title, body, resumed }`. It is NEVER awaited and a throw can
   never reject the gate promise.
3. The host's `onOpened`: skip when the kill switch is set, the monitor has no
   `reviewEscalation`, or the body already carries a `## Supervisor recommendation` section
   (so a resumed gate that was annotated stays as is, and one that was not gets its consult —
   CR-5); else consult `monitor.reviewEscalation({ kind: 'gate', stepId, stepName,
   reviewItemId, title, body, escalation: ctx.escalation, reviewItems })` and
   `router.annotate(...)` as actor `monitor`. `reviewItems` = bounded summaries (≤ 30 rows:
   id, kind, source, severity, status, title) of this run's pending findings and its
   `monitor`-sourced audit findings, via an injected `listRunReviewItems(runId)` reader —
   this is how set-aside entries, loop stops and autonomous actions reach the gate reviewer
   (CR-9). An annotate refused because the human already resolved is logged at debug.
4. `MonitorHistory.runDigest` (CR-6) replaces the earlier "artifacts" idea: injected reader
   `readRunDigest?(runId)` producing `{ artifacts: { atype, label, markdown }[], entities:
   { kind: 'idea'|'epic'|'task', ref, title, body }[] }` where `artifacts` covers ONLY
   payload-carrying atypes (`adversarial-review`, `project-brief`, `verify-runbook`,
   `compound-recommendations`, `eval-report`) and `entities` are the run-owned ideas / epics
   / tasks (the content the templated `idea-spec` / `decomposed-stories` tabs re-derive).
   Caps: 12k chars per item, 60k total, truncated with a marker. Rendered into the gate and
   review-loop prompts; absent reader ⇒ no section.

Gate escalation contract (CR-8):

```ts
// MONITOR_GATE_ESCALATION_SCHEMA — additionalProperties: false
required: ['action', 'rationale']
action:    'recommend' | 'pass'
choice:    'approve' | 'reject' | 'revise' | 'continue' | 'rerun' | 'dismiss'   // recommend
rationale: string
```

Downgrades: `recommend` without a valid `choice` → `pass`; a `choice` outside the gate's
menu (`continue|rerun|dismiss` only for approve-design; `approve|reject|revise` for the
rest) → `pass`; `resolve` is not in the enum for gates. Timeout / abort / error → `pass`.

"Continue without logging" (approve-design third choice): card button sends
`{ outcome: 'approve', modifier: 'no-findings' }` (zod: `modifier: z.enum(['no-findings']).optional()`);
the handler validates per item 3 and stores `approve[no-findings]`; `gateSideEffects.apply`
parses the modifier and skips `fileAcceptedRiskFindings` while still binding designs.
`reconcileAtSettle` never files findings today and stays that way. The queue-surface
"Dismiss" on an approve-design item (`ReviewItemCard.tsx:524-537`, today `reject` = ends the
run) is re-pointed to this path for approve-design only.

Kill switch (items 8-9): `CYBOFLOW_DISABLE_ESCALATION_REVIEW=1`.

Tests: `upsertMarkdownSection` (replace / append / duplicate removal / heading inside a
fence ignored); annotate refuses non-pending and emits `annotated`; recommendation parser
ignores a `Recommended:` outside the section; resolver settles when the item was resolved
before the target was armed; `onOpened` fires after `targetId`, is not awaited, and a throw
does not reject the gate; host skips when the section exists; card emphasis + chip on both
surfaces; `approve` files at resolve time and `approve[no-findings]` does not; queue Dismiss
on approve-design no longer rejects the run. Integration (CR-15): resolve-during-`onOpened`
and crash-between-commit-and-annotation cases in
`programmatic/__tests__/programmaticIntegration.test.ts` /
`__tests__/integration/crashResume.itest.ts` with the real `HumanStepManager` + router.

## Item 9 — Escalation review at blocking findings (step-boundary park)

Files: `programmaticRunHost.ts:344` (`awaitBlockingReviewItems`), `blockingItemsGate.ts`
(`BlockingItemsOpener` gains `listPendingBlockingItems(runId)`), `workflowController.ts:189`
(constants), `monitor.ts`.

Before delegating to `blockingGate.awaitClear`:

1. **Write barrier (CR-3).** Await the injected `awaitReviewWritesSettled(projectId)`
   (`ReviewItemRouter.awaitProjectWritesSettled`, L311) FIRST — the MCP `report_finding`
   reply lands before its create commits, so a direct `hasPendingBlockingItems` read at the
   boundary can miss the finding the previous step just filed. This barrier also precedes
   the plain `awaitClear` path (a pre-existing race, fixed as part of this item).
2. Fast path: `hasPendingBlockingItems` false → proceed (no consult).
3. Otherwise list pending human-audience blocking items not yet reviewed this walk (per-walk
   `Set<reviewItemId>`), consult `reviewEscalation({ kind: 'blocking-items', items })`, apply
   per item, then `awaitClear` as today.

Contract (CR-8):

```ts
// MONITOR_BLOCKING_ITEMS_SCHEMA — additionalProperties: false
required: ['items']
items: { reviewItemId: string; action: 'resolve' | 'recommend' | 'pass';
         choice?: string; rationale: string }[]
```

Downgrades: unknown `reviewItemId` → dropped; `resolve` on a non-`finding` kind → `recommend`;
`resolve` past either cap → `recommend`; blank rationale → "(none given)"; malformed → all
`pass`.

Caps (CR-11): `MONITOR_WALK_RESOLVE_CAP = 4` (per walk, in-memory) AND a durable
`MONITOR_RUN_RESOLVE_CAP = 8` enforced by counting this run's existing `monitor`-sourced
audit findings with category `escalation-resolve` (injected reader) before each resolve —
so restarts and rewinds cannot multiply autonomous resolutions.

Apply: `resolve` → router `resolve` op as actor `monitor`, resolution
`resolved by supervisor: <rationale>`, plus one audit finding (source `monitor`, category
`escalation-resolve`); `recommend` → `annotate`; `pass` → nothing. All on the monitor's
`sendChain`; aborted by the run signal.

Tests: barrier awaited before the first read; fake opener with one blocking finding: resolve
→ no park; pass → parks; walk cap reached → recommend only; durable cap read from findings;
decision item → never resolved. Integration: MCP fire-and-forget finding + router queue +
step boundary, with the real `ReviewQueueBlockingItemsGate`.

## Item 10 — Agent questions: DEFERRED (CR-4)

Not in this plan. A question's folded review item has `payload: null` and its event carries
neither the question id nor the options; the option UI is `AskUserQuestionCard`, which reads
a `Question`, not a review item; a gate holds 1-4 sub-questions, so a recommendation needs a
per-question key; and pending questions that predate the subscription need replay. That is
a design of its own (question-created bridge event + per-sub-question recommendation on the
question row + card rendering), and the census shows one non-interview question since 9/1.
Tracked as a follow-up; nothing here depends on it.

---

## Cross-cutting constraints

- `index.ts` (6409) and `mcpQueryHandler.ts` (5717) sit AT their size-ratchet caps
  (`fileSizeRatchet.test.ts:31-34`). New wiring (readers for `listRunReviewItems`,
  `readRunDigest`, `awaitReviewWritesSettled`, `listPendingBlockingItems`; the `annotate`
  route) goes in sibling modules, never a cap bump.
- IPC/tRPC type parity: `resolve` input gains `modifier`; `ReviewItemChangeAction` gains
  `annotated`; `ReviewActor` gains `monitor` — shared types and zod mirrors in the same
  commit (`docs/CODE-PATTERNS.md` → IPC / type-parity rules).
- All review-item writes stay on `ReviewItemRouter` ops (`annotate` is a new op).
- The three `adversarial-review.md` copies stay byte-identical.
- `programmatic/` files stay standalone-typecheckable: every DB/entity reader is
  host-injected like `triageLaneFailure`'s collaborators.
- Consults that post chat run on the monitor's `sendChain`; every consult takes the run's
  abort signal and returns its fail-soft value when aborted; the host never awaits a consult
  inside a gate promise or a transaction.
- Fail-soft everywhere: a missing monitor, a timeout, a thrown consult, or a kill switch
  yields exactly today's behaviour.
- No `any`.

## Out of scope (explicit)

- Auto-resolving any designed gate; auto-answering questions; question recommendations
  (item 10, deferred).
- Persisting the controller's revision counter.
- TASK-276 / findings swept on session archive.
- Permission-request items and the systemic usage-limit pause.
- The orchestrated plane's automatic-revision behaviour.

## Order, commits, verification

One commit per item, in the order 1 → 9 (5 before 6; 3 before 8; 8 before 9).
Per item: `pnpm typecheck && pnpm lint` and `cd main && npx vitest run <touched test
files>` (frontend: `cd frontend && npx vitest run <files>`). Items 8 and 9 also run
`programmatic/__tests__/programmaticIntegration.test.ts` and
`pnpm test:integration` (crash-resume). After item 9: full `pnpm test:unit` (first-fail
across packages — run the frontend suite explicitly if main fails). Not live-smoked in this
plan; a smoke of one planner run with `CYBOFLOW_DIR=~/.cyboflow_test` is the follow-up.

Rough size: items 1-5 ≈ 40-120 lines each; 6, 7, 8 ≈ 250-400 lines each incl. tests; 9 ≈
150-200.

---

## Appendix — Codex adversarial round 1 (2026-09-18) dispositions

| CR | Finding | Disposition |
|---|---|---|
| 1 | Ledger dropped by the two-section artifact contract | Fixed: three-section contract in `artifactFollowUp` + the three flow prompts (item 1) |
| 2 | Convergence not derivable; round counters reset | Fixed: `previousSeverity` in the ledger; one monotonic `reviewRounds` counter (item 1) |
| 3 | Step-boundary consult misses a still-queued finding | Fixed: router write barrier before every read (item 9) |
| 4 | Question recommendations have no data path or UI | Deferred: item 10 removed, follow-up design noted |
| 5 | `onOpened` lacks the body; settle races | Fixed: opened-item snapshot, fire-and-forget after `targetId`, re-read after arming, consult on resume when unannotated (item 8) |
| 6 | Templated artifacts carry no markdown | Fixed: `runDigest` = payload artifacts whitelist + run-owned entities, capped (item 8) |
| 7 | "Prose-only" edit changes the orchestrated plane | Fixed: orchestrated wording left unchanged (item 6) |
| 8 | Monitor contracts / async lifecycle under-specified | Fixed: schemas, required fields, downgrade tables, `sendChain` serialization, abort (items 6, 8, 9) |
| 9 | Stop rationale / audits cannot reach the gate | Fixed: `ControllerStepContext.escalation` + bounded review-item summaries in the gate consult (items 6, 8) |
| 10 | Triage guidance unwired and sticky | Fixed: one-shot `retryGuidance` channel injected by the runner; `stepGuidance` untouched (item 7) |
| 11 | Resolve cap resets on crash/rewind | Fixed: per-walk cap + durable per-run cap from audit findings (item 9) |
| 12 | Runbook note reader; modifier validation | Fixed (item 3) |
| 13 | Revision count undercounts legacy revises | Fixed: legacy sniff fallback in the count (item 4) |
| 14 | Section replace/parse boundaries | Fixed: `upsertMarkdownSection` semantics (item 8) |
| 15 | Verification omits lifecycle suites; weak settle test | Fixed: integration cases named; settle claim corrected (items 8, 9) |
