# Zone ownership and lane addenda — steering a large batch without restarting it

**Status:** PROPOSAL. Nothing here is implemented. Written alongside the Tier 3
prose-vs-plane audit (`prose-vs-plane-audit.md`) and survey D's monitor inventory.

**Prerequisites:**

- The **rolling lane pool** (Tier 3 Lane B) — replaces the wave-boundary fan-out
  with a continuously-refilled pool. Zone ownership is only interesting when lanes
  are long-lived; under wave semantics a lane's identity ends at every barrier.
- The **conversational action path** already in `monitor.ts`
  (`MONITOR_CONVERSE_SCHEMA`, `buildActionAnswerPrompt`, `DefaultMonitorSession.runAction`)
  and its twelve confirmed action kinds.
- `RunDirectives` (`programmatic/runDirectives.ts`) — the per-run, in-memory,
  mutable object the controller and `SpawnStepRunner` read LIVE mid-walk.

---

## 1. The problem

A sprint of fifteen tasks is dispatched by readiness and file-overlap, and nothing
else. A lane gets whichever ready task the pool hands it, works it, commits, and
dies. The next task in the same directory goes to a different lane, in a fresh
context window, with no memory that a sibling just restructured the module it is
about to edit.

That produces three failure shapes, all of which show up as "the sprint finished
but the diff is incoherent":

1. **Rediscovery.** Every lane that touches `main/src/orchestrator/verify/` pays
   the same cost of learning it. Fifteen tasks, five of them in that directory,
   five independent readings of the same code.
2. **Convention drift.** Lane A introduces a helper; lane C, working the same area
   an hour later, writes a second one with a different name because it never saw
   the first. The sprint-review step catches some of this after the fact, which is
   the expensive place to catch it.
3. **Serialized-by-accident work.** The file-overlap holdout is correct but blunt:
   two tasks that touch one shared file cannot run together even when their real
   work is disjoint. A lane that OWNED the area could sequence them itself.

The existing same-file holdout is a collision *avoidance* mechanism. What is
missing is a collision *ownership* mechanism.

---

## 2. Proposal A (cheap, independently useful): the lane addendum

**What:** a monitor action that appends text to a specific lane's NEXT step prompt,
without bumping the lane's attempt counter and without interrupting the turn in
flight.

**Why it is nearly free:** `RunDirectives.stepGuidance` (`runDirectives.ts`) is
exactly this mechanism one level up. It is a `Map<stepId, string>` that
`SpawnStepRunner` re-reads through its `stepGuidance` thunk on every spawn, and
`composeStepPrompt` renders under `## Operator guidance`. The `steer_step` action
already writes it. Two things are missing:

- **Lane granularity.** `stepGuidance` is keyed by BARE step id, which is shared
  across every lane of a fan-out — steering `implement` steers all of them. The
  per-lane precedent already exists next door: `laneRewinds` is keyed by fan-out
  item id, and `composeStepPrompt` already renders a per-lane channel
  (`laneGuidance`, threaded off the step context rather than the directives map,
  for the supervisor's rescue text). A `laneAddenda: Map<itemId, string>` keyed
  like `laneRewinds` and rendered through the existing `laneGuidance` slot is a
  small, shape-matching addition.
- **A monitor action kind.** `append_addendum` alongside `steer_step`, routed
  through the same staging-and-confirm contract every mutating action uses.

**The attempt-bump rule is the load-bearing part.** `laneRewinds` deliberately
does not bump `laneAttempt`, and `rescueLaneOrNull` follows the same rule at the
three inner-chain sites: an operator's correction must not consume the automatic
loopback budget the lane still needs for genuine review/verify failures. An
addendum is strictly weaker than a rewind — it changes nothing that has happened —
so it must not bump either. (Note the asymmetry the survey records: the two
merge-gate arms DO bump, because the verification scheduler's enqueue key is
`${runId}:${ref}:${attempt}`. An addendum never touches that path.)

**Cost:** one directive field, one action kind, one render path that already
exists. **Value even without zone ownership:** "the module you are editing was
just refactored, read X first" becomes a sentence a human can hand to one lane,
mid-run, for free.

---

## 3. Proposal B: persistent zone ownership

**What:** a lane claims a DIRECTORY ZONE rather than a set of files, holds it
across several tasks, and is preferentially given later tasks in that zone.

**Sketch:**

- A zone is a directory prefix, derived from a task's expected-files hint the same
  way the current overlap check derives its file set.
- The pool's dispatch step gains a preference pass BEFORE its current one: a ready
  task whose zone is already claimed by an idle lane goes to that lane. Only
  unclaimed or contended tasks fall through to the existing rules.
- A lane keeps its zone while it has work in it and releases it when it drains, or
  when a human reassigns it.
- The claim is advisory for dispatch and authoritative for conflict: two lanes
  never hold the same zone, so the file-overlap holdout inside a zone becomes
  unnecessary, and a zone owner can sequence its own overlapping tasks.

**What this buys:** a lane's context window becomes an asset rather than a
per-task cost. The second task in a zone starts with the first one's understanding
already loaded.

**What makes it hard:**

- **A lane is not a session today.** Each step turn is a FRESH SDK session with no
  memory of the previous step, which is the entire premise of `composeStepPrompt`.
  Zone ownership that only re-uses the same lane SLOT buys dispatch coherence but
  not context continuity. Getting the second half means a warm per-lane session, or
  an explicit zone digest threaded into each of the zone's step prompts — a
  `zoneContext` section built from what previous tasks in the zone changed. The
  digest route is strictly cheaper and fits the existing composer.
- **Zone derivation is a guess.** Expected-file hints are written by the planner
  and are frequently wrong or absent. A wrong zone is worse than no zone: it
  serializes unrelated tasks behind one lane.
- **Starvation.** A preference pass that is too strong leaves a zone owner queued
  behind its own zone while idle lanes sit empty. The preference must yield after
  a bounded wait.

**Reassignment** is what makes it safe to ship a guess: `reassign_zone` as a
monitor action, so a human who sees one lane hoarding half the sprint can hand a
zone to another lane. This is the same staged-and-confirmed shape as every other
mutating action.

---

## 4. Proposal C (the full version): a standing monitor that messages a live lane

Today the monitor is on-demand and turn-shaped: a human asks, it answers, it may
stage one action. The lane-triage path is the only thing that acts on a lane
without a human, and it fires only on an exhausted failure.

The full version is a monitor that WATCHES the pool — lanes starting, settling,
failing, claiming zones — and can send a lane an addendum on its own judgement,
subject to a budget. Concretely: lane A's code-review flags a pattern; the monitor
sees lane D about to start in the same zone and appends "lane A just hit X here"
to its prompt before it spawns.

**Why this is last:** it needs everything above (a pool with stable lane identity,
a per-lane addendum channel, a zone notion to reason about), plus an answer to
"when is the monitor allowed to interrupt without being asked", which the current
design deliberately avoids — its own prompt tells it NOT to duplicate an
autonomous rescue precisely because two actors correcting one lane is worse than
neither. A standing monitor makes that collision the normal case rather than the
edge case.

---

## 5. Recommended order

1. **Lane addendum** (§2). Small, independently useful, no dependency on the pool
   beyond stable item ids, which already exist.
2. **Zone ownership, dispatch-only** (§3 minus the context digest). Measurable:
   does preferring a zone owner reduce sprint wall-clock and cross-lane duplicate
   helpers?
3. **Zone context digest.** Only if step 2 shows the dispatch win is real but the
   rediscovery cost stays.
4. **Standing monitor** (§4). Only with an explicit interruption budget.

---

## 6. Open questions

1. **What is a zone, exactly?** Directory prefix is the obvious answer and is
   wrong for a repo with a flat `src/` and for cross-cutting work (a rename that
   touches everything). Is a zone allowed to be a module boundary the planner
   declares rather than a path?
2. **Where does the zone claim live?** In-memory on the pool (dies with the walk,
   simple, invisible to the UI) or in the lane store (survives a re-drive, needs a
   migration, renderable)? The rewind/interrupt precedents are in-memory; the lane
   status precedent is persisted.
3. **Does a zone survive a run re-drive?** If a sprint is retried, should lanes
   re-claim their previous zones? Re-claiming reproduces the previous dispatch,
   which is either exactly what you want or exactly the thing that failed.
4. **How does an addendum interact with a rescue?** `composeStepPrompt` already
   renders operator guidance and supervisor rescue guidance in ONE section with
   separate labels. A third channel is either a third label or a merge — and if it
   merges, whose text wins when they contradict?
5. **Is the attempt-bump exemption still right for an addendum that follows a
   failure?** A human appending "you are failing because of X" after two failed
   attempts is materially a rescue. Does it deserve a fresh attempt, and if so who
   decides — the human, or the kind of the action?
6. **What is the addendum's lifetime?** `stepGuidance` persists for the run, so a
   steer set once applies on every later spawn of that step. For a lane addendum
   tied to one upcoming task that is probably wrong: consume-on-read (like
   `laneRewinds`) is the better default, but then a lane that fails and retries
   loses the guidance that was meant to help it.
7. **How is any of this measured?** Sprint wall-clock is noisy. The honest metrics
   are probably duplicate-helper findings from sprint-review and the count of
   file-overlap holdouts that actually deferred a ready task — both of which need
   to be recorded before the change, not after.
