# Lane runbook bootstrap — verification that sets itself up

**Status:** SHIPPED (Phases 0-4; see §13). v2 design, rewritten after adversarial
review, then implemented, re-reviewed post-ship, and live-smoked across three
rounds (§16-19). Migrations 107-109 (`bootstrap_proof`, `runbook_bootstrap_stamp`,
`runbook_bootstrap_suppression`).
**Review history:** v1 was reviewed independently by Codex and by a Fable agent.
Codex returned 8 blocking defects; Fable returned 9 more that Codex missed and
judged v1 **not salvageable in its proposed shape**. Five of Codex's and two of
Fable's were verified against the code by hand. v1's design is discarded; §16
records what it got wrong, because those mistakes are the reason this version is
shaped the way it is.
**§15 records the two decisions the user made on 2026-08-18** after this rewrite:
rung 1 is **kept** (the safety claim is correspondingly weakened, and §8 says how),
and the gate probe-path change is **accepted**.

**Related:** `verification-setup-flow.md` (runbook contract, §3.2 degrade gate,
proof-by-running), `verification-agent-redesign.md` (§5.3 agentless visual-verify,
§7.2 dependency guard).

---

## 1. The problem

A sprint lane composes a visual-verification task, the controller enqueues it, the
lane parks at `awaiting-verify` — and on nearly every project, nothing is verified.
The third pre-lease gate (`verificationScheduler.ts:2727`) skips any task that has
to build or serve the deliverable unless the project already has a **proven**
runbook. `verdictDelivery.ts:376` attaches a CTA pointing at the **Verify Setup**
flow — a separate flow a human must launch, with two human gates of its own — and
`mergeGateLaneAdvance` advances the lane to `integrated`. The sprint completes with
a green lane no camera looked at.

We have direct evidence of the dead end from inside the product: an ad-hoc
verification fired from a chat session comes back `skipped` for this reason, and
`setup_proof` — the one request kind that could break the deadlock — is refused
outside the verify-setup flow.

That posture was the correct reaction to a real failure: the agent engine used to
guess the environment per-run with no memory and guessed wrong every time (0-for-5
in production). But **"stop guessing" and "stop trying" are different rules.** The
setup flow already contains what makes an attempt safe — derive, register, and
*prove by actually running it*, with only a passing run flipping a draft to proven,
and the engine rather than the agent doing the flipping. What is missing is an
autonomous entry point.

**The bar, stated honestly.** The goal is that this feature may only convert
"skipped" into "actually ran" — never manufacture a *pass*. For everything the
bootstrap writes **except** a rung-1 config edit, that holds **structurally**: the
drafting agent cannot write, the controller writes one schema-validated file, and
only an engine-enforced proof promotes anything.

For the rung-1 config edit it does **not** hold structurally, and this document will
not pretend otherwise. A config file is executable, so a machine-authored change to
one can in principle alter what gets built or what gets served, and no validator
short of understanding the project can rule that out. The user's decision (§15A) is
to keep rung 1 and accept a **review-backed** guarantee in that one case: the edit is
narrowed to typed operations (§8), it is committed separately, it is surfaced
prominently, and a human passes on it at the terminal merge gate. That makes the
review surface load-bearing rather than decorative — it is the guarantee — and §8
is written accordingly. v1 claimed the structural bar while permitting free-form
config edits, which was the claim and the mechanism contradicting each other (§16).

---

## 2. What the reviews changed

v1 tried to implement this by **adding a lane step**. That single decision put an
autonomous, file-writing agent inside four seams that each already have a strong
owner and a documented invariant:

- the **shared lane worktree and its single git index**,
- the **both-plane `fanOut.inner` contract**,
- the **merge-gate verdict path**,
- and an **idempotency scheme** that was never designed for a second request per
  lane attempt.

It broke all four. The fix is not eight patches; it is to stop threading the
bootstrap through machinery built for something else. v2 is **smaller, earlier, and
read-only where v1 was late and write-capable**:

| | v1 | v2 |
|---|---|---|
| Trigger | react to the skip in the merge gate | **preflight before enqueue**, at the controller seam |
| Who writes files | the drafting agent, into the shared worktree | **the controller**, one file, pathspec commit |
| Drafting agent tools | Read/Grep/Glob/Bash/Write/Edit | **read-only** (no Write, no Edit, no git) |
| Rung ceiling | 0/1, free-form edits guarded post-commit | **0/1, typed operations applied by the controller** (§8) |
| Proof shape | lane's full task, then a probe on failure | **one attestation-only proof** |
| Proof verdict path | the merge gate | **`awaitTerminal`, outside the merge gate entirely** |
| Waiting lanes | park, then re-fire | **degrade to today's skip; next run verifies** |
| Single-flight | in-memory mutex | **persisted run-scoped stamp** |

Every row is a defect being deleted rather than fixed.

---

## 3. The blocking discovery: the gate probes the wrong tree

The finding that most shapes v2, and which v1 had no idea about
(`main/src/index.ts:2055-2064`):

```ts
// Probed against the PROJECT path — both ask a project-level question … while the
// enqueue-time injection (scheduler.resolveProvenRunbook) probes the requesting
// RUN's worktree, which is the tree whose commands would actually execute.
verifyRunbookStatus = async (projectId, modality) => {
  const projectPath = databaseService.getProject(projectId)?.path;
  if (!projectPath) return 'absent';
  return verifyRunbookStore.status(projectId, projectPath, modality);
};
```

The degrade gate probes the **project root**. The enqueue-time runbook injection
probes the **run worktree**. A runbook a lane commits to its session branch is
therefore invisible to the gate until that branch merges — so even after a
successful proof, every ordinary request in the same run still skips with
`VERIFY_NO_RUNBOOK_REASON`. Combined with the singleton-record hazard (§4), each
pre-merge run would re-bootstrap and re-demote the record: **steady-state thrash.**

v1's entire §7 payoff — waiting lanes re-firing into a now-proven runbook — was
unreachable in the current wiring, and no amount of care inside the lane would have
revealed it.

**v2 requires an explicit, reviewed semantic change: for LANE requests, the
pre-lease gate probes the requesting run's worktree** (`worktreePathForRun` already
exists), matching what the injection already does and what actually executes. This
is decision B in §15. Without it, this feature cannot work at all; with it, the
gate and the injection stop disagreeing about which tree they are talking about,
which is arguably a latent bug independent of this proposal.

---

## 4. Never bootstrap over someone else's proof

`status()` collapses three different situations into `'unproven-draft'`, and only
two of them are safe to bootstrap:

| Situation | Safe to bootstrap? |
|---|---|
| No record, no file — nothing was ever derived | **yes** |
| A record exists, marked `unproven-draft` | **yes** |
| A record is **proven**, but *this tree* lacks the portable file | **NO** |

The third is the documented pre-merge case (`runbookStore.ts:195`) — the file is
absent, and the store deliberately answers `unproven-draft` **without demoting**,
because "this tree lacks it" and "this runbook changed" are different facts. But
`registerDraft` UPSERTs a **singleton** `(project_id, modality)` row. A lane on a
branch predating the runbook merge would therefore derive a fresh runbook and
**overwrite the proven record every other branch depends on** — breaking
verification precisely for the projects that set it up properly.

**v2:** `VerifyRunbookStore` grows `statusDetail()`, returning the reason
discriminant alongside the three-valued answer. The preflight never fires on
`'proven-file-absent-here'`, which degrades to today's skip with a finding that
says so — the runbook exists, merge the branch that carries it.

*As implemented (phase 1),* the discriminant is a superset of the four named
above: `status()` already distinguishes two more situations internally, and
folding them in would reintroduce exactly the collapse this type exists to
prevent. The full set is `'proven' | 'no-record' | 'file-only' | 'draft' |
'proven-file-absent-here' | 'drifted' | 'indeterminate'`, where `'file-only'` is
"no record, but this tree carries a parseable runbook a teammate committed"
(adopt and prove it rather than author a competing one) and `'indeterminate'` is
the fail-soft `'absent'` — a pre-096 DB, a SQL error, an input hash that would
not compute. `'indeterminate'` is emphatically **not** `'no-record'`: "I could
not look" is not "nothing is there", and a writing caller must treat it as *do
not touch*. `status()` is now a projection of `statusDetail()` so the gate's
view and a writer's view cannot be computed by two paths that drift.

---

## 5. `bootstrap_proof`: a kind, not a privilege

`setup_proof` bundles three privileges (`verificationScheduler.ts:1623`):
degrade-gate exemption, **lifetime-budget exemption**, and lower-priority draining.
The budget exemption is safe for a flow a human launches once per project and
unsafe as something any lane can reach. The MCP handler names the exact hazard — "a
compound lane reaching for `setup_proof: true` because it read the verify-setup
workflow prompt once" — and answers it by pinning authorization to the run's frozen
workflow identity (`mcpQueryHandler.ts:4607`). Widening that dissolves the
guarantee for the case it was written to stop.

| | `setup_proof` | `bootstrap_proof` |
|---|---|---|
| Degrade gate | exempt | **exempt** |
| Lifetime budget | exempt, never charged | **counted and charged** |
| Drain priority | lower than lane traffic | ordinary |
| Flips a pinned record on PASS | yes | **yes** |
| Settable over the MCP wire | verify-setup runs only | **never — not a wire field** |
| Drives a sprint lane | no | **no — excluded by KIND (§6)** |

`bootstrapProof` is a parameter of `enqueueTaskVerification`, the in-process
controller capability. No agent in any flow can request it, which is strictly
stronger than a workflow-identity check.

---

## 6. The proof must not touch the lane

v1 assumed a proof verdict could double as a lane verdict. It cannot, for two
independently fatal reasons:

1. **`applyMergeGateVerdict` runs for every terminal carrying a taskRef**, and
   `recordRunbookProof` runs *after* it (`verificationScheduler.ts:3266-3289`). A
   FAIL charges the lane's implement budget immediately; a PASS integrates the lane
   before the record is ever promoted, and a CAS-failed promotion still leaves a
   passed verdict standing.
2. **The programmatic plane has a second, independent policy site.**
   `SchedulerVisualVerifyGate.outcomeForTerminalStatus`
   (`visualVerifyGate.ts:304-312`) returns `{kind:'advance'}` for *any* status that
   is not `'failed'`, reading no `error_message` and — by documented design —
   never consulting lane rows for non-failed outcomes. On the only plane in scope,
   a decision written into a lane row is **actuation-dead**.

**v2:** a `bootstrap_proof` request is excluded from lane driving **by kind**, at
both sites. Keying on kind rather than on an absent `taskRef` is required:
`resolveLaneForVerdict` falls back to `if (lanes.length === 1) return lanes[0]`, so
a ref-less proof in a single-lane run would still be attributed to that lane.

The controller consumes the proof through the scheduler's existing **`awaitTerminal`**
seam (verification-setup-flow §5.2 seam 2) — the synchronous primitive built for
exactly this "prove → read outcome → adjust → re-prove in one turn" shape. The
merge gate never sees the request.

---

## 7. One attestation-only proof

v1 fired the lane's full task as the proof, then a probe to disambiguate failures.
Both reviews independently destroyed the disambiguation: the probe **builds and
serves the same lane snapshot**, so a lane edit that breaks compilation, startup,
routing, or the marker breaks the probe too; and identity attestation does not
prove the runbook adequate for the behaviors. The table inferred causality it could
not observe, in both directions.

**v2 proves the runbook with an attestation-only task** — `build`, `serve`,
`attestation`, `behaviors: []` (legal per `visualVerification.ts:551`). This asks
exactly one question: *does this project stand up and identify itself as this
deliverable?* That is the minimal claim a runbook needs, and it is the only claim
this proof is allowed to make.

The lane's own task is **not** the proof vehicle. It is enqueued afterward, as an
ordinary request, exactly as it would be on a project that already had a runbook.
This inverts v1's answer to its own open question 1, and deletes the entire
disambiguation apparatus rather than repairing it. The cost is one extra deployment
on the happy path; the gain is that no failure is ever attributed to the wrong
thing, and the lane's attempt budget is never charged for a runbook defect.

---

## 8. The drafting agent writes nothing

v1 gave the agent `Bash/Write/Edit` in the shared worktree and validated the diff
*after* it committed. That cannot enforce a rung ceiling — the guard sees only the
committed diff, not deletions, ignored files, or sibling edits — and the allowed
files are **executable**: twenty lines of Vite or Electron config can change the
build entry or serve a canned attested surface, manufacturing a PASS. `git revert`
is not a rollback primitive in a shared dirty worktree either. Worse, `git add -f`
plus a bare `git commit` **sweeps whatever sibling implement agents have staged**
into the bootstrap commit, and the guard would then "safely" revert other lanes'
uncommitted work.

**v2 inverts the trust direction.** The agent (`runbook-bootstrap`, installed in
the sprint and ship bundles) has **Read/Grep/Glob and read-only Bash** — no Write,
no Edit, no git. It surveys and returns the portable runbook JSON in a fence, for
one modality, rung 0 only. If the project cannot be stood up with levers it already
honors, it returns `BOOTSTRAP: NOT-POSSIBLE — <reason>`, which is a success for
this agent.

The **controller** then validates and writes:

1. `parseVerifyRunbookV1` — strict schema, rejects on the first structural problem.
2. `findForbiddenTaskCommands` — the §7.2 dependency guard, unchanged.
3. **New mechanical rule:** every `build`/`serve` command must resolve to a
   **declared `package.json` script invocation**. This converts the setup agent's
   prose rule ("never guess a command") into a check, and is the single highest-value
   guard in this proposal — it is what makes "the agent proposed a command" and "the
   project documents that command" the same statement.
4. Writes the one file and commits it **by pathspec** (`git commit -- <path>`, or a
   temporary index) with `index.lock` retry — never a bare commit, which would
   sweep siblings' staged work.

### 8.1 Rung 1: typed operations, not a diff

The user kept rung 1 (§15A). The agent still writes nothing — it *proposes* the
change as a **typed operation** in its fence, and the controller applies it. A
free-form diff is not accepted, because "≤20 lines of config" is a size limit, not a
semantic one, and size was never what made v1's guard unsound.

There are exactly three operations, and a fourth is a validation error:

| Operation | Parameters | Applied by the controller as |
|---|---|---|
| `add-script` | script name, command | a new key in `package.json` `scripts`; **addition only**, never overwriting an existing script |
| `port-from-env` | file, the literal port, the env var name | replacing that **literal integer** with a read of the env var, at the single site where it occurs |
| `relax-strict-port` | file, the setting | flipping a `strictPort`-style boolean literal `true` → `false` |

Each is a structural edit the controller performs itself against a parsed or
narrowly-matched target, so the blast radius is what the operation names and nothing
else. Anything the agent cannot express in these three — a new plugin, an import, a
changed build entry, a conditional — is `BOOTSTRAP: NOT-POSSIBLE`, and that project
goes to Verify Setup where a human designs the change.

Constraints that still bind: the hard denylist (lockfiles, `.github/`, `.claude/`,
CI configs, `scripts/`) rejects the operation regardless of shape; `package.json`
changes are confined to `scripts`; and the operation touches **exactly one** file.

**The review surface is the guarantee.** Because this case is review-backed rather
than structural (§1), the design owes the human a surface worth reviewing:

- the rung-1 edit is committed **separately** from the runbook, so it is one
  self-contained, revertible commit in the branch diff;
- the `verify-runbook` artifact renders the operation, its parameters, and the exact
  resulting diff;
- and a **finding is filed naming the file that was auto-edited** — worded as
  something to review, not as an FYI. A rung-1 bootstrap that produced no visible
  review surface would be the failure mode this whole section exists to prevent.

---

## 9. Restart, cancellation, and the shared worktree

v1's single-flight was an in-memory mutex in the controller closure. The controller
reconstructs state on resume and restarts lanes at inner step zero, so a crash after
commit, registration, or enqueue would re-run agents and race stale rows.

**v2 persists a run-scoped bootstrap stamp** keyed `(runId, projectId, modality)`
carrying: owner lane, commit sha, runbook pin (hash + version), request id, round,
and terminal outcome. Every sub-step below it is independently idempotent —
`registerDraft` is CAS'd, the proof's enqueue key is unique, the file write is
content-addressed — so recovery is "read the stamp, resume at the first incomplete
step", not a bespoke state machine.

Two shared-worktree interactions v1 missed:

- **The commit-integrity probe.** `beginCommitProbe` (`index.ts:3103-3120`) reports
  `headAdvanced = endHead !== startHead` on the shared worktree, built to catch a
  lane that "reported green with its changes left untracked on disk (observed
  live)". A machine commit landing mid-lane makes that true for every in-flight
  lane, so a lane that committed nothing would integrate anyway. The bootstrap commit
  sha is recorded on the stamp and **excluded** from the probe's comparison.
- **Enqueue keys.** `findLiveRequestByEnqueueKey` treats *any* non-canceled terminal
  — `skipped` included — as a dedup hit, and the key is
  `${runId}:${laneTaskRef}:${attempt}`. The proof therefore carries an explicit
  `:bootstrap:<round>` generation segment; without it the proof would silently
  return the original skipped request and deploy nothing, which is exactly what v1
  would have done.

---

## 10. Failure, and what it actually costs

v1 claimed failure was "byte-identical to today". It is not, and pretending
otherwise hid real costs. Honestly:

| Failure | State left behind |
|---|---|
| `NOT-POSSIBLE` / unparseable fence | nothing written; lane skips as today |
| Validation or script-resolution failure | nothing written; lane skips as today |
| `proven-file-absent-here` (§4) | nothing written; skip + "merge the branch carrying the runbook" |
| Rung-1 operation rejected (denylist, unparseable target, ambiguous match) | nothing written; lane skips as today |
| Proof FAIL / timeout (≤2 draft rounds) | **one or two commits** (the honest unproven draft, plus any applied rung-1 edit), a registered draft record, budget spent, the lane delayed by the bootstrap's wall-clock |
| Toggle off / kill switch | nothing; today's path, one branch deep |

Only the last row differs from today, and it differs in three ways worth stating
plainly rather than burying: one or two commits land on the branch, verification
budget is spent, and the owning lane waits. When a rung-1 edit was applied and the
proof then failed, the branch carries a machine-authored config change that bought
nothing — it stays, visibly, with its finding, rather than being auto-reverted in a
shared worktree (§8). The lane still advances unverified with a
non-blocking finding — now carrying the diagnosis instead of a bare CTA — and the
unproven draft stays committed and registered, which is the same posture the setup
flow takes on its own exhaustion.

**Suppression.** v1 wrote the suppression under the draft's hash. The capability
ledger is keyed `(project, modality, runbook_hash)` and unpinned no-runbook requests
use the `''` bucket (`verificationScheduler.ts:2492`), so that suppression would
never have fired. v2 writes a **dedicated bootstrap-suppression record** keyed by
project, modality, project-input hash, and host fingerprint, invalidated when either
hash changes — so a real change reopens the question immediately and a dead project
stops paying.

---

## 11. Bookkeeping the reviews surfaced

- **Eval contamination.** `snapshotRunForEval.ts:17-21` exempts verify-setup from
  auto-eval *precisely because* "its diff is a verification runbook plus isolation
  levers whose real acceptance test is its own proof run". The bootstrap moves that
  diff class into sprint/ship runs, which **are** auto-eval'd and A/B-compared. The
  bootstrap commit is excised from the captured diff, or the row is flagged;
  otherwise a run gets rubric-graded on machine-written JSON its agents did not author.
- **The sprint's own reviewers.** `code-review`, `sprint-review`, and
  `address-review` operate on the combined diff and will encounter a commit no lane
  owns; `address-review` "fixes in place", and any post-proof edit to the runbook
  file demotes it by hash drift. The runbook path **and any rung-1 edited file** are denylisted
  from address-review, and the preflight is sequenced before sprint-review — a
  reviewer "fixing" the runbook in place would demote it by hash drift, and one
  reverting the rung-1 edit would silently un-prove the environment.
- **Input-hash instability (accepted, documented).** `status()` recomputes the
  project input hash (package.json scripts, lockfiles, node/electron ABI) and
  **demotes write-through on drift**. A sprint task that edits scripts or the
  lockfile therefore demotes the freshly-proven record. This is pre-existing
  behavior for setup-proven runbooks too, and the demotion is semantically correct —
  but the bootstrap makes proving and script-editing concurrent *by construction*.
  Accepted; documented; the next run re-bootstraps.
- **`expectedFiles` is optional.** v1's strongest denylist rule ("any file the run's
  own tasks touch") rested on metadata that is legitimately absent, and would have
  silently enforced nothing. Moot in v2 — the agent writes nothing.
- **Stale comment, unrelated to this work.** `enqueueFromTask.ts`'s
  `forbiddenCommandError` still tells agents a snapshot's `node_modules` is
  "symlinked from the live worktree"; `snapshotProvisioner.cloneDependencyDirs`
  **clones** (`cp -Rc`) precisely to kill write-through. The guard is still right;
  its stated reason is out of date. Worth a one-line fix on its own.

---

## 12. The flow, end to end

1. Lane reaches `visual-verify`; task-verify composed a task that derives an
   environment. **Before enqueue**, the controller evaluates the shared exported
   predicate (`derivesEnvironment && statusDetail(runWorktree)`).
2. Not bootstrap-eligible (§4) or toggle off ⇒ enqueue as today. Done.
3. Eligible ⇒ claim the persisted stamp. Another lane holds it ⇒ **skip as today**;
   the finding says a bootstrap is in flight and the next run will verify.
4. Spawn the read-only drafting agent. `NOT-POSSIBLE` ⇒ degrade.
5. Controller validates (§8), writes and pathspec-commits the runbook,
   `registerDraft` → `{hash, version}`.
6. Fire ONE attestation-only `bootstrap_proof`, uniquely keyed, pinned; consume via
   `awaitTerminal`. The merge gate never sees it.
7. PASS ⇒ the engine flips the record proven. FAIL ⇒ re-draft once (≤2 rounds), then
   degrade.
8. On proven: enqueue the lane's **ordinary** request, which now merges and pins the
   runbook and passes the gate (given decision B). The lane parks and proceeds
   exactly as on a configured project.
9. Sibling lanes arriving later: ordinary path, now proven. Lanes that already
   skipped during the bootstrap are **not** resurrected — `mergeGateLaneAdvance`
   never resurrects a terminal lane, and pretending otherwise was v1's §7.
10. Report a `verify-runbook` artifact carrying the draft, the proof outcome, and
    the commit, so the human sees at the terminal merge gate what was derived on
    their behalf.

---

## 13. Phasing

- **Phase 0 — seam, dark.** ✅ *shipped.* Migration 107 (`verification_requests.bootstrap_proof`,
  `verify_runbook_local.origin`); `bootstrapProof` on `enqueueTaskVerification`;
  budget-counted + gate-exempt + promotion-eligible; **kind-based exclusion** from
  `applyMergeGateVerdict`, `verdictDelivery`, and `SchedulerVisualVerifyGate`;
  `:bootstrap:<round>` enqueue-key generation. Fully unit-testable.
- **Phase 1 — honesty in the store.** ✅ *shipped.* `statusDetail()` (§4) and the
  gate probe-path change (§3, decision B), each with its own tests — this phase is
  independently valuable and lands the latent probe-path disagreement fix. The
  probe path threads as an OPTIONAL third argument on the `runbookStatus` thunk:
  the scheduler's gate passes `worktreePathForRun(row.run_id) ?? undefined` (the
  same ladder `resolveProvenRunbook` uses), and omitting it still resolves to the
  project root, which is the level the health badge's question is asked at.
- **Phase 2 — the preflight.** ✅ *shipped.* Shared exported predicate
  (`bootstrapEligibility.ts`), persisted stamp (migration 108 +
  `bootstrapStampStore.ts`), toggle + kill switch, degrade paths and findings.
  No agent yet; logs and falls through.

  Two things the phase resolved beyond the list. **The degrade paths landed as
  real remedies, not logs**: the gate now emits its own skip reason for
  `proven-file-absent-here`, `drifted`, and `indeterminate`, and verdictDelivery
  attaches the matching guidance — the pre-merge case explicitly says *merge the
  branch, do not re-run setup*, because the default CTA is the destructive
  instruction there. The bootstrappable situations keep `VERIFY_NO_RUNBOOK_REASON`
  verbatim, so every existing consumer matches what it always matched. **The
  preflight sits in `enqueueTaskVerification`, before the shared preparation** —
  the last moment a decision exists, since a `skipped` terminal burns the enqueue
  key that step 8's re-enqueue needs.
- **Phase 3 — draft and prove.** ✅ *shipped.* The read-only agent
  (`workflows/{sprint,ship}/agents/runbook-bootstrap.md`, deployed by the
  controller rather than bound to a step — the first canonical agent key with no
  step), controller validation + pathspec commit, the three typed rung-1
  operations (§8.1) with their denylist and separate commit, `registerDraft` +
  the `origin` stamp, the attestation-only proof via `awaitTerminal`, re-enqueue
  on proven, bootstrap suppression (migration 109).

  Three things the phase resolved beyond the list. **The drafting agent's Bash is
  an ALLOWLIST, not a denylist.** §7.2's dependency guard can be a denylist
  because a structural control sits underneath it — the provisioner clones
  `node_modules`, so a contained write is discarded with the snapshot. This agent
  surveys the LIVE run worktree and has no such backstop, so a denylist would be
  the only control, which is the posture §8 rejects. **The proof re-enters the
  same enqueue seam**, so that seam skips the bootstrap for a `bootstrapProof`
  request — otherwise it would recurse into a second bootstrap while the first is
  mid-flight, and the stamp would report the recursion as its own owner
  re-entering. **A validation rejection does not suppress; only `NOT-POSSIBLE`
  does.** An undeclared command is a claim about this DRAFT, and suppressing on it
  would let one bad draft silence a project whose next draft would have been fine.

  Also caught by its own tests before shipping: the rung-1 target check fenced
  only the ROOT `package.json`, so `relax-strict-port` — which, unlike
  `port-from-env`, has no extension rule of its own — would have flipped a boolean
  inside `apps/web/package.json`. Now matched on the basename.
- **Phase 4 — bookkeeping.** ✅ *shipped.* Eval-diff excision (by path, from the
  frozen diff, with stats subtracted rather than recomputed so git's own counting
  still governs every unaffected row), commit-probe exclusion (`rev-list` minus
  the run's bootstrap shas — including the rung-1 commit, which §8.1 splits off,
  so excluding only the runbook commit would have left the probe reaching the same
  wrong conclusion), the address-review denylist (prompt section + a standing rule
  in the agent, since the subagent cannot see the step prompt), the `verify-runbook`
  artifact, the §8.1 finding naming the auto-edited file, and the `origin` badge on
  the setup list.

  The artifact is reported on the FAILED path too. v1 claimed failure was
  "byte-identical to today"; it is not — a failed bootstrap leaves a committed
  unproven draft, a spent budget, and possibly a config change that bought nothing
  — and an artifact that only appeared on success would be the same overclaim in a
  different place.

## 14. Test plan

- **Unit** — the eligibility predicate over all four `statusDetail` discriminants
  (especially: `proven-file-absent-here` never bootstraps); kind-based lane-driving
  exclusion at **both** policy sites, including the single-lane
  `resolveLaneForVerdict` fallback; enqueue-key generation defeats the terminal
  dedup; command-resolves-to-a-declared-script validation; each of the three
  typed rung-1 operations applied correctly and each rejection path (denylist,
  unparseable target, ambiguous or multi-site match, `package.json` outside
  `scripts`, script overwrite); stamp claim/resume;
  suppression keying actually matching the bucket the next request reads.
- **Tripwire** — `bootstrap_proof` unreachable from `mcpQueryHandler`, in the style
  of the existing `setup_proof_not_authorized` tests.
- **Migration** — `migration107.test.ts` plus pre-107 defensive-read degradation.
- **Integration** (`*.itest.ts`, mocked SDK) — preflight → draft → commit → prove →
  ordinary enqueue → lane verified; and every degrade path leaving the lane exactly
  where today's skip leaves it.
- **Regression the reviews imply** — a proven-elsewhere project is never demoted by
  a bootstrap; a bootstrap commit does not satisfy another lane's commit probe.
- **Existing suites to update** — `acceptanceMatrix`, `mergeGateLaneAdvance`,
  `verdictDelivery`, `visualVerifyGate`, `enqueueFromTask`, `runbookStore`,
  `builtInWorkflows` / `workflowBundle.builtins`.

---

## 15. Decisions (resolved 2026-08-18)

**A. Rung 1 is KEPT; the safety claim is weakened accordingly.**
Both reviews concluded independently that rung 1 cannot be made *structurally* safe
autonomously, because the allowed files are executable and no validator short of
understanding the project can rule out a config change altering what is built or
served. I raised that; the user's decision is to keep rung 1 and accept a
**review-backed** guarantee in that one case. §8.1 narrows it as far as it can go
without a human in the loop — three typed operations applied by the controller, one
file, separate commit, rendered in the artifact, and a finding that names the edited
file — and §1 states the resulting claim honestly rather than overclaiming. Rung 0
retains the structural guarantee; only the rung-1 path trades it for review.

**B. The gate probes the run worktree — ACCEPTED.**
The pre-lease gate will probe the requesting run's worktree for lane requests,
matching what the enqueue-time injection already does (§3). This is required for the
feature to work at all, and it independently resolves a latent disagreement between
the gate and the injection about which tree they describe. It changes shipped
behavior — a runbook committed on a branch begins satisfying that branch's lanes
before merge — so it lands in **phase 1**, on its own, with its own tests, rather
than riding in silently on the bootstrap.

## 16. What v1 got wrong

Recorded because the mistakes are load-bearing, not to be thorough:

1. **Claimed a safety invariant its own guard could not enforce** — the ≤20-line
   config allowlist permits edits to executable files, which is the invariant
   failing outright.
2. **Assumed the proof could double as the lane verdict** — two independent policy
   sites drive lanes off terminals, and promotion runs after delivery.
3. **Assumed a second request per lane attempt would deploy** — the enqueue key
   dedups against terminals, so the happy path was a no-op.
4. **Assumed a lane step could be programmatic-only** — `fanOut.inner` is an
   explicitly both-plane contract with a generic fallback renderer.
5. **Assumed `status() !== 'proven'` meant "no runbook"** — it also means "proven,
   just not in this tree", where bootstrapping destroys another branch's proof.
6. **Never checked which tree the gate probes** (§3) — the payoff was unreachable.
7. **Claimed failure was byte-identical to today** while proposing paths that
   commit, register, spend budget, and delay lanes.
8. **Wrote a suppression into a bucket nothing would read.**

The through-line: v1 reasoned about the feature it wanted and asserted the
properties it needed from seams it had not read closely enough. Every correction
above came from reading the seam.

---

## 16. Post-implementation adversarial review (2026-08-19)

The shipped diff was reviewed adversarially after phases 0–4 landed. Five
blocking defects were found and fixed; each was verified by EXECUTING the code,
not by reading it.

**Four of the five were surviving instances of the same mistake v2 was written to
avoid** — asserting a property of a seam rather than checking it. Three of those
were guards that enumerated the syntax their author thought of instead of the
syntax they permit:

1. **The read-only shell allowlist inspected only a segment's head**, so `env sh
   -c '…'` and `command rm -rf x` — exec wrappers sitting on a list of readers —
   passed anything, and `env node -e` defeated the per-head flag bans too.
   `awk`'s `system()` and `sed`'s `w` need none of the rejected syntax, and `node
   <file>` runs any file the repo already ships. 11 of 13 candidate escapes
   passed. Fixed by removing those four heads outright, restricting `node` to a
   version probe, and giving `branch`/`remote`/`config` per-subcommand ARGUMENT
   rules — `git config user.email x` is a write whose write-ness lives entirely
   in the operand count, where no flag denylist could reach it.
2. **The declared-script rule listed `&&` and missed a bare `&`.** `pnpm dev & rm
   -rf x` resolved to the declared script `dev` and passed — and a runbook
   command is committed, proven, and re-executed on every later verification,
   which is precisely the "unreviewed command forever" outcome §8 check 3 exists
   to prevent. `--prefix` and friends went with it: they resolve a declared
   script and run a different project's copy of it.
3. **The rung-1 denylist matched lowercase on a filesystem that does not.**
   `.Claude/settings.json` was admitted and is the same file as the one that
   decides whether the approval gate binds at all; `relax-strict-port` turned out
   to be "flip any named boolean in any non-manifest file", so the denylist was
   the only thing standing in front of it.
4. **The rung-1 edit could be committed and never surfaced.** Every step after
   the commit could fail back through `refuse`, which published nothing — leaving
   a machine-authored commit on a human's branch that only a log line mentioned.
   §15A accepted rung 1 as REVIEW-BACKED; the operation being narrow was never
   the whole trade, narrow AND surfaced was, and the review half was reachable
   only on the paths that happened to succeed.

The fifth was an ordering race in a seam this proposal had already read once:

5. **`awaitTerminal` polls the request ROW, which goes terminal before the record
   flips.** §5.3 deliberately promoted after delivery so a promotion failure
   could not disturb a committed verdict — but that put a whole IO pipeline
   between "the row says passed" and "the record says proven", so a bootstrap
   could report success and have the lane's very next enqueue skip anyway. The
   flip now precedes the terminal write, wrapped so it still cannot prevent a
   verdict. Ordering alone was not enough: the engine legitimately refuses to
   promote a proof that ran without a clean snapshot or a pin, so the runner now
   CONFIRMS against the record rather than inferring from the request.

Two serious defects were fixed alongside: `autoBootstrapRunbook` was read from a
boot-time config snapshot, so the Settings toggle was inert until relaunch in
both directions; and migrations 108/109 can only be renumbered as a pair, since
109 ALTERs the table 108 creates and reordering them degrades a fresh database
silently rather than loudly.

**What this says about the reviews in §15.** Both v1 reviews concluded rung 1
could not be made structurally safe and the compensating controls were the trade.
They were right, and defect 4 is the proof: the controls were specified
correctly and wired only into the success paths. A control that exists on the
happy path is not a control.

## 17. First live smoke (2026-08-20)

Three real sprint runs against three throwaway projects, in an isolated dev
instance (own `CYBOFLOW_DIR`, vite `:4531`, CDP `:9233`). Everything below was
observed against the running app, not a fake.

**Round 1 — `widgetboard`, rung 0: the feature works.** A lane whose visual
verification would have been skipped derived a runbook, committed it, proved it,
and then verified and integrated normally. The proof screenshot carries build id
`wb-<uuid>` rather than the default `wb-dev`: the verification agent read the
drafting agent's `levers.notes`, injected the build-time nonce, and the served
page carried it — so the `dom-marker` attestation actually discriminated. The
drafting agent found `/healthz` unprompted and used it for `readyWhen`.

**Round 2 — `dialboard`, port literal under `scripts/`: honest failure.** The
agent noticed the hardcoded port, correctly declined `port-from-env` because
`scripts/` is denied for every operation, and shipped a runbook with no port
lever. The harness leased 29260, the server bound 4300, the attestation could not
bind, the proof failed, the record stayed `unproven-draft`, the lane's own
request enqueued unpinned and was `skipped`, and suppression was written. It
never manufactured a pass, and the recorded reason names the cause, the fix that
would work, and why that fix is refused.

**Round 3 — `gaugeboard`, port literal in a root config: rung 1 fires
correctly.** Two separate single-file commits; the config diff is exactly one
line (`port: 4300,` → `port: Number(process.env.PORT ?? 4300),`) with the
comments and neighbouring keys untouched. The proof still failed — see the flake
below — and the §15A finding was published naming `app.config.mjs`, its isolated
commit sha, and the fact that the change bought nothing and should probably be
reverted. That is the review-backed control working on the failure path, which
is the only path where it matters.

**Confirmed live, beyond the above:** migrations 108+109 apply in order on a
fresh DB (`rung1_path`/`rung1_commit_sha` present); `cyboflow-runbook-bootstrap`
ships in the sprint bundle byte-identical to source; the runbook commits land
despite `.gitignore` excluding `.cyboflow/` (the `git add -f` path) and never
sweep a sibling lane's staged work; the eval excises the machine-authored runbook
from the graded diff; a bootstrap proof goes terminal with the lane untouched;
and the read-only shell guard refused a real command in all three runs.

**The toggle read is live.** `autoBootstrapRunbook` was switched on in Settings
with no relaunch. Against the boot snapshot the preflight would have logged
`declined: disabled` forever; it bootstrapped instead.

### What the smoke found

**A rung-0 bootstrap that committed and then refused published NOTHING** —
`publishAbandoned` keyed on `rung1` alone. Fixed, with a test pinning round 2's
exact sequence. This is defect 4 recurring one level down: §8.1 gives the rung-1
edit a SECOND commit, and the guard mistook "no rung-1 edit" for "changed
nothing".

**The drafting agent's shell opener is always refused.** Three agents, three
`cd "$(pwd)" && …` openers, three rejections. The prompt named the allowed heads
but never said composition is refused. Fixed in both bundle copies.

### Open after the smoke

**The verification agent is not reproducible across runs, and that decides
bootstrap outcomes.** Rounds 1 and 3 were the same project shape with the same
`levers` and the same nonce mechanism documented in `notes`. Round 1's agent
applied the build-time nonce and PASSED; round 3's ran `serve` verbatim, found
the leased port empty, recovered by hand with `PORT=$VERIFY_PORT` — proving the
project and the rung-1 edit were both fine — and still returned `fail`. Round
3's second drafting round then concluded the deliverable "has no way to reflect
the per-request nonce", contradicting the mechanism its own round-1 notes
described. So a correct runbook and a correct config edit were discarded, and the
project was suppressed on a reason that is not true. The controls all held; what
did not hold is the judgment upstream of them. Worth a look before this is
turned on by default.

**A runbook with no port lever binds a fixed port in the snapshot** and collides
with anything else on it, including a concurrent verification. Observed directly:
round 2's proof server held 4300 and answered a probe meant for another project.

Still not done: no `*.itest.ts` end-to-end (§14).

## 18. Making the levers real (2026-08-20)

§17's open item — "the verification agent is not reproducible, and that decides
bootstrap outcomes" — had a cause underneath it that is not about the agent at
all. Both runbooks the smoke produced declared `levers.portEnv: "PORT"`, and
both described their build-time nonce variable in `levers.notes` as prose. The
harness read neither: `levers` was parsed, hashed, and documented in four
prompts while `verificationAgentRunner` exported only its own `VERIFY_*` set.

So the two facts a web verification actually turns on — does the served surface
bind the LEASED port, and does it carry THIS request's nonce — were left to what
the verification agent inferred from a `notes` string. Round 1's agent inferred
both and proved the runbook. Round 3's ran the serve command verbatim, as its
own contract instructs ("the serve command must be the task's, exactly"), and
failed. The reproducibility gap was real, but it was the harness that left the
decision there to be made.

**The fix is that declaring a lever now binds it.** `resolveLeverEnv`
(`main/src/orchestrator/verify/runbookLevers.ts`) layers the runbook's declared
names over the harness env after provisioning, so build and serve alike inherit
them:

- `levers.portEnv` → the leased port. This is the mechanism `port-from-env`
  (rung 1) was designed around: the operation teaches the project's code to READ
  the variable, and the lever is what makes it EXIST at verification time. Before
  this, the two halves never met, and the only spelling that could have worked
  was `envVar: "VERIFY_PORT"` — which nothing in any prompt suggested.
- `levers.nonceEnv` → this request's attestation nonce. New field. Without it a
  runbook has no structured way to say "stamp your identity marker from here",
  and a `dom-marker` attestation reads whatever fixed default the build uses.

Two rules, both because a runbook is machine-authored: a lever may never shadow a
variable the harness owns (base env wins; a lever naming an already-correct
harness var is a silent no-op), and a name that configures execution rather than
the deliverable — `PATH`, `NODE_OPTIONS`, `DYLD_*`, `LD_*`, `IFS` — is dropped
rather than exported. A dropped lever is logged, and surfaces downstream as an
honest attestation failure rather than a pass.

Both bootstrap prompts and Verify Setup now teach the levers, including the rule
that `port-from-env` without a matching `levers.portEnv` is a config edit a human
reviews for nothing.

**What this does NOT retroactively fix.** Widgetboard's already-`proven` record
declares `portEnv`, so its port binding becomes genuinely correct. Its nonce
binding does not: no runbook written before this release declares `nonceEnv`, so
those records still depend on the agent reading `notes`. Re-derivation is the fix
for them; the feature was default-OFF at the time this was written, which is why
that cost nothing then — F9 (`visual-verification-brittleness-fixes.md`) flips
the default to ON, so this gap now needs re-derivation to actually happen.

## 19. Second live smoke (2026-08-20) — and the bug it found

Two fresh fixtures with the round-3 shape (port literal in a root config, an
identity marker the build stamps from an env var): `meterboard` (round 4, the
lever fix alone) and `panelboard` (round 5, both fixes).

### The lever fix works, and it is reproducible

Both drafting agents emitted BOTH levers as structured data — `portEnv: "PORT"`
plus `nonceEnv: "<PROJECT>_BUILD_ID"` — where round 3's agent had declared only
the (then-dead) `portEnv` and buried the nonce mechanism in prose. Round 5's
`levers.notes` states the contract in the prompt's own terms: "the port-from-env
operation teaches that file to read PORT", "binding it per-request makes the
data-build attribute carry this request's nonce".

Both proofs passed with a discriminating build id (`mb-aff49a53-…`,
`pb-…`) rather than the fixture default, and both records went `proven`.

The export is load-bearing, not decoration. Round 5's lane agent PROBED the
variable instead of setting it:

    $ echo "PANELBOARD_BUILD_ID=${PANELBOARD_BUILD_ID:-<unset>}"
    PANELBOARD_BUILD_ID=9a4914fe-a94c-4a1d-8eb5-b5074e96c7eb
    MATCH: build id == attest nonce

and reported that "the harness had pre-seeded PANELBOARD_BUILD_ID with this
request's nonce, so the task's own UNMODIFIED build stamps it". That is the
round-3 failure mode closed: the fact now arrives whether or not the agent
thinks to arrange it.

### The bug round 4 found

Round 4's bootstrap proved its runbook and its LANE VERIFICATION THEN FAILED
(`ambiguous`), on a deliverable whose behaviors both passed. The branch says why:

    05c209d  chore: derive a web verification runbook   ← proof snapshot
    df63cd2  chore: port-from-env on app.config.mjs     ← the enabling edit
    1f2330b  test: cover the Latency widget             ← LANE snapshot

`enqueueTaskVerification` captured the snapshot sha at the top of the function,
before the bootstrap ran — so the lane was pinned BELOW the two commits the
bootstrap had just written. At `1f2330b` the port is still a literal, the
exported `portEnv` is read by nothing, the server binds its default, and the
serve-identity probe finds no listener on the leased port. Every first lane
verification on a project needing a rung-1 edit would have failed this way, and
the feature's own success would have been the trigger.

Fixed by moving the capture below the bootstrap (a pure reordering — nothing
between the two positions consumes the sha). Round 5 confirms it live: the lane
request pins `8a23383b`, the same post-bootstrap sha as the proof, and

    BOOTSTRAP proven  rung1=app.config.mjs  commit=8a23383b
    REQ …ef93ccb passed proof=1 snap=8a23383b
    REQ …b85522c passed proof=0 snap=8a23383b
    LANE integrated

which is the first time the full loop has run to an INTEGRATED lane on a project
that needed a config change. Round 1 proved a runbook; round 5 shipped a task
through one.

### Review surface, unchanged and correct

Round 4 filed the §15A config-edit finding naming `app.config.mjs`
(non-blocking, source `runbook-bootstrap`) and escalated the verification failure
as BLOCKING — which is how the ordering bug reached a human rather than passing
quietly. Both are the designed behavior.

### Still open

The round-5 lane agent prefixed the serve string (`PORT=$VERIFY_PORT npm run
preview`) even though the harness had already exported `PORT`, so this smoke does
not independently discriminate the port half of the export the way it does the
nonce half; the unit tests cover it. Worth noting separately that a deviation
from the verbatim serve string passed the §7.1 identity binding, because the
binding checks process-group membership rather than the string — correct by
design, but not the guarantee the prompt's wording implies.

Still not done: no `*.itest.ts` end-to-end (§14).

## 20. Default flip (F9, 2026-09-09) — the flip does not reach upgraded installs

`visual-verification-brittleness-fixes.md` §F9 flips
`VISUAL_VERIFY_DEFAULTS.autoBootstrapRunbook` false→true
(`shared/types/visualVerification.ts`) so a project stays verifiable without a
second opt-in once `enabled` is on. An adversarial fix-round review found the
flip is a no-op for every install that has ever pressed Save in Settings —
including the one this proposal's own live smokes ran against. `Settings.tsx`
unconditionally stamps `autoBootstrapRunbook` into the saved config on every
Save, from any tab, because the renderer state is lifted into one payload
object; under the old default that stamped a literal `false`.
`ConfigManager.getVisualVerifyConfig()` resolves via
`vv?.autoBootstrapRunbook ?? VISUAL_VERIFY_DEFAULTS.autoBootstrapRunbook`, so a
persisted `false` wins over the new floor forever — `??` only ever sees an
`undefined` on a config.json that has never been through Settings' save path.
There is no config migration for this key (the only migration in
`ConfigManager.initialize()` is `enableCrystalFooter` → `enableCyboflowFooter`).

The fix is a one-time migration in `ConfigManager.initialize()`, mirroring that
existing one: on load, if `visualVerify.autoBootstrapRunbook === false` and a
new migration marker is absent, delete the stored `false` (letting it fall
through to the new floor) and stamp the marker so a later, deliberate opt-out
is never re-flipped. `main/src/services/configManager.ts` is outside this
proposal's own file boundary and was not edited here — this section exists so
the gap is written down rather than silently narrowing F9's scope. Until that
migration lands, F9 only reaches a fresh `config.json`.
