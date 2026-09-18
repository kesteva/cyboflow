# Verification Setup Flow

Status: PHASES 0–3 IMPLEMENTED (2026-07-30 → 2026-08-04, this branch). Phase 3
(onboarding + health panel) landed 2026-08-04 with ONE deliberate deferral —
the consent-gated drive round-trip probe, which cannot be built until §8's
native-screen drive API question is answered (there is nothing to round-trip
through); it renders as an explicit `blocked` row rather than a faked green or
a red that blames the host for machinery we never wrote. Implementation deltas
from the spec as written, all deliberate:
- The "no attestation ⇒ no `passed`" invariant is enforced for DECLARED specs
  (missing/mismatched driver record ⇒ failed-ambiguous-blocking) and for the
  implicit file-identity case; a task with NO spec caps a pass at
  `low_confidence` instead of failing it — transitional, because runbooks
  (which every build/serve task now requires) make attestation mandatory per
  modality, so the no-spec-pass path survives only for degenerate bare-url
  checks where advisory-visible beats hard-failing.
- The dep preparer CLONES the live worktree's dependency dirs into a keyed
  read-side cache (APFS clonefile) and rebuilds the electron ABI inside the
  mirror, rather than performing a fresh install — same §7.2 guarantees,
  layout-agnostic.
- Migrations are 095/096. They were authored as 088/089, collided with main's
  own 088/089 (`artifacts_revision_ensure` / `interactive_prototype`), and were
  renumbered when this branch rebased onto main — the expected, routine outcome
  of developing a schema change on a long-lived branch.
- §5.4's "matrix row 4" (own instance running) is exercised as an attach-mode
  CDP-port squat → env-skip; full-isolation green requires a live dogfood run
  (the levers landed: CYBOFLOW_VITE_PORT / CYBOFLOW_CDP_PORT / CYBOFLOW_DIR).
- LIVE-DOGFOODED 2026-08-01 (see §9). The run reached the terminal gate and
  surfaced 5 findings — including two that made the flow unable to fire any
  verification at all — none of which three rounds of adversarial review had
  found, because each component was correct in isolation. Migrations are now
  095/096/097. The proof path itself has still not been observed green
  end-to-end; that needs a second dogfood run on top of these fixes.
- Native-screen: observe-only as specced; the drive-consent matrix row is a
  `test.todo` pending a live, audited drive API (§8 open question).

Original proposal follows. Follow-up to `verification-agent-redesign.md`.
Scope decisions locked with Krishna in-session. v2 folds in all 11 findings of
the Codex adversarial review (8 high / 3 medium); the review's verdict on v1 —
"no-ship as specified" — targeted spec precision, not the phase structure,
which survived intact. Material v1→v2 changes are marked **[v2]** inline.

## 1. Problem

Visual verification has effectively never worked outside a toy project.
Production DB (`~/.cyboflow/sessions.db`, 2026-07-10 → 07-26): **28 requests,
2 passed** — both on 07-10 under the legacy engine. The verification-agent
engine (default since ~07-23) is **0-for-5**: 3 `launch_failed`, 2 `timeout`.
The dev-instance DB shows 3 passes, all against a static-HTML demo. Every
production failure is cyboflow attempting to verify **itself**.

Failure taxonomy across both engines:

| Class | Count | Era |
|---|---|---|
| `no url or htmlPath provided` | 6 | legacy (unfilled `.cyboflow/verify.json`) |
| `no healthy backend available` | 4 | legacy (native-desktop TCC health-check) |
| `ERR_CONNECTION_REFUSED :4521` | 4 | legacy (guessed port, no dev server) |
| `launch_failed` | 3 | agent |
| `request timed out` (10 min) | 2 | agent |

Root causes of the agent-era failures, confirmed against code and the agents'
own reports:

- **(a) Wrong serve form.** task-verify composes the generic web spec
  (`serve: "pnpm dev --port ${PORT}"`, `target: url`) instead of the Electron
  `attach:"cdp"` form. The exemplar JSON in `sprint/agents/task-verify.md` is
  the web form; the composer follows the exemplar.
- **(b) Singleton collisions.** Vite port 4521 (`strictPort:true`), CDP 9223,
  and Electron's single-instance lock keyed on `CYBOFLOW_DIR`
  (`main/src/index.ts:528-540`, defeating `--user-data-dir`) all collide with
  the user's own running dev instance. The leased `${PORT}` is decorative —
  nothing honors it.
- **(c) ABI mismatch.** Fresh-snapshot `pnpm install` produces host-Node
  better-sqlite3 (NMV 127); `electron .` needs NMV 136. No composed runbook
  included the electron rebuild.
- **(d) Deadline vs cold install.** `DEFAULT_AGENT_REQUEST_TIMEOUT_MS` = 10 min
  (`verificationScheduler.ts:641`); a cold monorepo install consumes most of it.
- **(e) Readiness false positive.** A leased pool port (29260) was answered
  (404) by a stale Vite from an unrelated worktree. The port-pool comment
  (`shared/types/visualVerification.ts:916-928`) documents this exact risk:
  "the per-port lease guards the logical slot, NOT the OS socket."

Two prior designs failed in opposite directions: the legacy waterfall required
a **manually authored** config nobody wrote; the agent engine **guesses
per-run with no memory** and guesses wrong every time. The middle — derive
once, *prove by running*, persist, reuse, invalidate on drift — is the core of
this proposal.

Explicitly rejected: Docker/container isolation (macOS Electron under
Linux/Xvfb is fidelity loss in both directions; the observed collisions are
namespace problems solvable with leases + isolated data dirs); resurrecting
the legacy capture-backend waterfall (see §4).

## 2. Shape: four phases, dependency-ordered

The user-facing framing is three layers (global onboarding → per-project setup
→ modality coverage). The build order is the reverse, plus a phase 0:

```
Phase 0  Honest failures        (days; no UX; stops the bleeding)
Phase 1  Modality roster        (defines everything downstream)
Phase 2  Project setup flow     (derive → prove → persist per project)
Phase 3  Onboarding + health    (generated from the roster; probes not checkboxes)
```

Rationale: a grants wizard (old item 1) cannot be specified until the roster
(old item 3) fixes which modalities exist and therefore which grants matter;
the runbook schema (item 2) serializes the roster; and none of the observed
failures are fixed by any wizard — they're fixed by phase 0 + phase 2.

## 3. Phase 0 — honest failures

All independent of the wizards; each is small and scheduler/runner-local.

1. **Attribution split — conservative by construction. [v2]** Add a
   failure-class taxonomy (`env` | `deliverable` | `ambiguous`) to the agent
   report path. Today snapshot-mode `build_failed`/`launch_failed` returns
   `status:'failed'` (`verificationAgentRunner.ts:~344-357`) — a merge-gate
   FAIL charged to the lane's implement-retry budget, sending an agent to
   "fix" working code because a port was taken.

   **The failure mode of the fix is worse than the failure mode it fixes**:
   `skipped` ADVANCES the lane at the merge gate
   (`mergeGateLaneAdvance.ts:143-148`), so a deliverable defect misclassified
   as env ships broken code silently. A bad lockfile commit, a broken package
   script, or a startup regression presents exactly like an env failure in a
   log excerpt. Therefore classification is **evidence-based and
   conservative**:

   - `env` requires **harness-derived provenance**, never model judgment:
     a failed pre-deploy preflight (chromium/node/driver absent), a
     bind-refused probe on the leased port against a pre-verified squatter,
     instance-lock contention detected by the runner, or an attestation
     channel that never came up while the squatter probe shows foreign
     occupancy. Only these skip (and do not increment the lane attempt
     counter).
   - Everything else — including every model-authored `build_failed` /
     `launch_failed` without harness corroboration — is `ambiguous` and
     **remains blocking**: it fails the lane (or, at a configurable threshold,
     routes to human review) exactly as today. Ambiguity is allowed to be
     annoying; it is not allowed to ship regressions.
   - The classifier's inputs and verdict are persisted on the request row so
     the health panel (phase 3) can show the env/deliverable/ambiguous
     histogram and misclassification can be audited.
2. **Degrade path.** A project with no proven runbook (or a stale one, once
   phase 2 exists) → `skipped` + a non-blocking setup CTA finding. Never a
   lane-blocking FAIL for "not configured." (Safe under the conservative rule:
   "no proven runbook" is a harness-known fact, not a log inference.)
3. **`unsupported` — per-modality, self-refreshing. [v2]** Distinct from
   unconfigured: a persisted "cannot pass on this host, reason: X" that
   suppresses enqueue. v1 keyed this per-project, which is incompatible with
   composable modalities (§4): a missing native grant would suppress a
   project's perfectly working CDP checks. Keyed instead by
   **(project, modality, portable-runbook hash, host capability generation)**;
   supported modalities continue independently. And because phase 3 probes run
   at verification time, a fully suppressed capability would never re-probe —
   a recovery deadlock. Suppressed entries therefore re-evaluate on a
   TTL **and** on host-capability-generation bump (any probe, any project,
   observing a changed host fact increments the generation), independent of
   request enqueue. Until phase 1 ships modalities, `native-desktop` and
   `mobile-flow` requests land here with an explicit reason instead of today's
   deploy-and-fail-organically (the agent path never consults `verify_type` —
   dispatch keys solely on the run stamp, `verificationScheduler.ts:1435`, and
   `VerificationAgentRequest` has no type field).
4. **Circuit breaker.** K consecutive **env-class** failures for a
   (project, modality) → auto-demote to skip + one non-blocking finding.
   Ambiguous failures never trip it (they are lane-visible already). (The 5
   agent-era failures each burned the full deadline; nothing tripped.)
5. **Agent-path preflight.** The agent engine bypasses the legacy
   `selectCandidates` health gate entirely; a missing chromium currently
   surfaces *after* budget increment + snapshot provisioning + a full SDK
   deploy (`driverCore.ts:330-336`). Add a pre-deploy check (chromium
   resolvable, node resolvable, driver CLI present, leased port genuinely
   free) that early-returns a structured skip, mirroring the legacy
   `skipReason` pattern. Preflight results are the evidence base for the §3.1
   classifier.
6. **Budget accounting.** `judge_calls_used` sums cumulatively against
   `projects.visual_verify_budget_calls` for the project's lifetime; once
   exhausted, everything silently fail-opens to `skipped`. Setup/proof runs
   (phase 2) must be exempt or separately countered; surface budget state in
   the Verify Queue.

## 4. Phase 1 — modality roster

Tiering does not return as capture-backend rungs. The redesign collapsed the
waterfall deliberately (rungs could only *capture*, never stand the
deliverable up; fall-forward was never implemented; the doc's stated
philosophy is "build it as an agent-path capability, never resurrect a
waterfall rung"). Tiering returns as a **modality axis on the agent engine**:
the runbook declares what the project's UI is, the roster declares what this
host can do, and the request resolves against both — the only fall-through is
skip-with-reason.

Scope decision (Krishna, 2026-07-30): **Playwright/CDP + Peekaboo**, with
Maestro and mobile held back at the time pending clarity on Apple's own MCP
for Xcode. That MCP turned out unable to create, boot, install, launch,
screenshot or drive a simulator on any host, so `mobile` ships instead on
`xcodebuild` + `xcrun simctl`, the toolchain already present on the owner's
machine (`docs/proposals/mobile-verification-tier.md`, §3). The roster row
below is that shipped shape, not a placeholder.

| Modality | Drives via | Drive? | Observe? | Grants | Concurrency (target¹) |
|---|---|---|---|---|---|
| `web` | driver launches headless chromium (CDP) | yes | yes | none | parallel (port lease) |
| `cdp-app` | attach to app's own CDP endpoint (`attach:"cdp"`, `VERIFY_DRIVER_ATTACH_ONLY`) | yes | yes | none | parallel (port lease + isolated data dir) |
| `native-screen` | Peekaboo (capture today; drive is a **designed prerequisite**²) | prereq² | yes | Screen Recording + Accessibility | **exclusive** (`VERIFY_SCREEN_LEASE`, count 1) |
| `mobile` | harness-owned driver commands (`mobile-install`/`mobile-launch`) on `xcrun simctl`; observe via `simctl io screenshot` | probe-gated² (Maestro present ⇒ tap/type/swipe/press/flow; absent ⇒ observe-only) | yes | Xcode CLT + ≥1 iOS runtime + ≥1 device type — **no TCC grant, no MCP grant** | bounded `verify:mobile:<i>` pool, default **1**, clamped [1,4]; **no port lease** |

¹ **[v2] "Parallel" is the design target, not current behavior.** Today every
agent verification serializes behind the count-1 `VERIFY_AGENT_LEASE`
(`verificationScheduler.ts:111-117,1649-1663`) regardless of modality, and
`ResourceLeasePool` has no priority mechanism (non-blocking probes in caller
order, `:158-169,227-260`). Delivering the table's concurrency column is a
**budgeted scheduler work item in this phase**: replace the global agent lease
with bounded modality-aware resources (N web/cdp slots, 1 screen slot), add an
explicit priority queue with anti-starvation rules, and define how screen,
port, CPU, and setup-proof leases compose. Until it lands, phase 2's
"setup runs at lower priority" (§5.4) is not implementable.

² **[v2] Native driving currently has NO executable path, independent of the
Peekaboo setting fix.** The repository's only Peekaboo integration is
capture-only (`peekabooBackend.ts:79-100,169-181`); the verify agent runs
Bash-only with `strictMcpConfig` and an **empty MCP map**
(`verificationAgentQuery.ts:297-314`); and `DriverCommand` is CDP-selector
only (`driverCore.ts:81-86`). Drive support is therefore a designed
prerequisite of this modality, not a setting flip: exact drive commands,
**target identity** (how a click names its target with no DOM — accessibility
label / owned-window coordinates), abort semantics, cleanup, and per-action
result evidence. Until a live, audited drive API exists (starting with a
manual smoke of Krishna's fixed Peekaboo), `native-screen` is declared
**observe-only**, and drive-required behaviors are deterministically composed
out: task-verify marks them `not_testable (drive-unsupported)` in the report —
never silently dropped, never attempted.

Design consequences the roster must pin down:

- **Behavior targeting differs by modality.** CDP behaviors address elements
  by selector; native behaviors address them descriptively (accessibility
  label / visual description / coordinates) — no DOM exists. The
  `VerificationTaskV1` behavior schema gains a modality discriminant that
  changes how task-verify composes steps. Widening happens in lockstep across
  the request row, `VerificationAgentRequest` (which gains the type/modality
  field it currently lacks), and `VerificationTaskV1`/`ReportV1` — per the
  shared-type file's "single contract split across files — widen together"
  note.
- **Modalities compose per project.** A desktop app declares `cdp-app` for
  web-view content *and* `native-screen` for OS chrome (menus, dialogs, tray).
  Capability/proof state is tracked per modality (§3.3) so one modality's
  outage never suppresses another.
- **Screen exclusivity is a product policy, not just a lease. [v2]** A driving
  native verification moves the user's pointer and types on their machine —
  and `VERIFY_SCREEN_LEASE` only serializes cyboflow's *own* clients; it
  cannot fence concurrent user input or other automation. Decided for v1:
  **explicit per-run go-ahead** (idle-queueing revisited later), a visible
  "verification is driving" affordance while held, foreground-target identity
  revalidated immediately before every input, and abort on any user input or
  focus change. No native-screen action ever fires without the lease AND the
  consent.
- **Isolation levers are part of the roster contract**, not per-project
  improvisation: leased ports, per-request temp data dir (`--user-data-dir`
  or the app's own lever, e.g. `CYBOFLOW_DIR`), electron-ABI rebuild handled
  by the dependency preparer (§7.2 — never by runbook commands), and
  per-modality attestation (§7.1).
- **Driver additions for `native-screen`**: new `DriverCommand` variants (or a
  scoped Peekaboo tool grant) + harness-contract prompt update +
  `visual-verify.md` update; the retired `peekabooBackend.healthCheck()`
  (both-grants probe, never-throws) is reused as the live grant probe.

## 5. Phase 2 — project setup flow

A guided, per-project flow: **derive → prove → persist → reuse → re-derive on
drift.** The proof step is the whole difference from the failed
`.cyboflow/verify.json` model — the exit criterion is a real boot + screenshot
via the actual verification path, not a written file.

### 5.1 Flow mechanics (reuse, honestly costed) [v2]

- A 5th registered built-in flow (`workflow_runs`-backed — a `design.md`-style
  chat prompt has no gate/verification machinery). v1 called registration
  "cheap"; the tuple is in fact an **app-wide exhaustive discriminant** and
  the phase must budget every consumer: `CYBOFLOW_WORKFLOW_NAMES` +
  `WORKFLOW_DEFINITIONS` + flow `.md` + agent keys in `CANONICAL_AGENT_KEYS`,
  plus `INITIAL_STEP_IDS` (`stepTransitionBridge.ts:62-67`), workflow display
  labels (`ProposalCardBodies.tsx:41-46`, `workflowMeta.ts`), the code-review
  eval auto-entry posture (`snapshotRunForEval.ts:160-177` — the setup flow
  must be exempted), permission-mode frontmatter, MCP/agent grants, and a
  defined **launch path**: `runLauncher` requires every run to have a session
  (`runLauncher.ts:393-403`) and the flow is backlog-entity-free, so it needs
  an explicit no-seed launch seam (Compound-style) specified up front. No DB
  migration for registration itself (`ensureGlobalBuiltIns()` self-seeds).
- **Compound's `approve-learnings → write-back → human-review` is the 1:1
  template** for "propose runbook/diff → approve (inline AskUserQuestion) →
  apply + commit → terminal merge gate over the diff."
- Repo changes follow a **rung ladder**: rung 0 — existing levers only (env
  vars, CLI flags; most projects end here); rung 1 — config-only; rung 2 — a
  proposed diff, human-approved, never auto-applied. A tool that wants to edit
  your repo before it verifies anything is a tool people turn off.

### 5.2 New seams (build; the plan must name them or the flow will improvise)

1. **Runbook persistence.** No writer exists: `verifyConfigLoader.ts` is the
   *sole reader* of `.cyboflow/verify.json`; no MCP tool, no project-row
   columns for it. The portable half is written as an ordinary repo file edit
   + commit (the Compound write-back pattern); the machine-local half (§5.3)
   registers on the project row via the router chokepoint (migration).
2. **Synchronous proof primitive.** `cyboflow_request_verification` is
   fire-and-continue and its only verdict delivery path is sprint-lane
   driving. The setup flow's "test-execute the runbook" step needs a
   wait-for-verdict seam (bounded, with the verdict surfaced inline).
3. **Pinned compose-time injection. [v2]** The verifier runs in a detached
   snapshot at the task's sha (`git worktree add --detach`): an uncommitted
   runbook is invisible; a committed one is absent from every branch cut
   before it — so the runbook cannot be *resolved from inside* the snapshot.
   But v1's "read from the live worktree at compose time" breaks snapshot
   attribution the other way: revision-B commands executing against
   revision-A code yield a verdict attesting to a hybrid no revision ever
   contained. v2 rule: task-verify injects a **content-addressed runbook
   revision** — the portable-half hash and the machine-local record version
   are both stamped onto the request row at enqueue; the runner executes
   exactly that revision and **rejects on any mismatch** (hash absent,
   local-half CAS conflict, or a runbook lever the snapshot's tree
   demonstrably lacks) with structured "runbook/sha mismatch" feedback —
   env-class, non-attempt-charging — rather than improvising against live
   state.

### 5.3 Runbook contract

- **Split halves. [v2]** Committed-portable: commands (parameterized —
  `${PORT}`-style lever *templates*, never resolved values), behaviors,
  modality declarations, readiness/attestation spec. Machine-local
  (project-row record, CAS-versioned **against the portable hash**): host
  capabilities and resolved lever *bindings that are stable per host* —
  binary paths, data-dir lever name, ABI facts. **Request-scoped values —
  ports, temp dirs — are never persisted**: the scheduler resolves them per
  request after lease acquisition (`verificationScheduler.ts:1655-1664`) and
  a persisted port would go stale, diverge from the held lease, or collide.
  A committed runbook derived on one machine must not encode another
  machine's lies.
- **Proof provenance.** Each proof records: sha, portable-runbook hash,
  machine-local record version, project input-hash (dev/build scripts,
  lockfile, electron/node versions), **host fingerprint** (chromium binary,
  TCC grant state, node major, app binary path), timestamp. Any component
  changing demotes the runbook to `unproven-draft`.
- **`unproven-draft` behaves exactly like unconfigured** (phase-0 skip + CTA).
  A failed proof persists the draft + diagnosis and exits the wizard cleanly —
  never a dead-end, never a stale-but-green runbook.
- **Proof runs in the verifier's environment class** (detached snapshot +
  prepared deps), not the setup flow's own worktree — a proof obtained in
  environment X asserted about environment Y is not a proof.
- **Dependency mutation is runner-enforced, not linted. [v2]** See §7.2 —
  install/rebuild commands are rejected by the runner in *every* composed
  task's `build`/`serve` steps (runbook-sourced or agent-composed alike),
  because `VerificationTaskV1.build` can carry `pnpm install` today —
  task-verify's own exemplar recommends it (`task-verify.md:73-74`). The
  exemplar changes in this phase; the runner guard is the backstop.

### 5.4 Contention + acceptance

- Setup's own test runs lease from the same pools **once the §4 scheduler
  work item lands** (priority + anti-starvation are new machinery, not
  configuration — see footnote ¹); until then setup proofs run only when no
  lane requests are queued. Pool size decoupled from `SPRINT_BATCH_CAP` (both
  are 5 today — setup can starve live lanes past the 15-min queued-age
  ceiling).
- Setup/proof runs exempt from the lifetime judge budget (phase 0 item 6).
- **Dogfood prerequisite**: parameterize cyboflow's own singletons (vite port
  env-var + strictPort relaxation for verify builds, CDP port flag
  pass-through, `CYBOFLOW_DIR`-keyed lock → per-request temp dir). The only
  project generating real failure data is the one the rung ladder would
  otherwise defer.
- **Acceptance = a failure-injection matrix, not repetition. [v2]** v1's
  "3 consecutive green runs" is gameable — three warmed CDP happy-path passes
  prove none of the guarantees this proposal exists for. Done means the matrix
  passes on cyboflow itself:

  | Case | Must observe |
  |---|---|
  | cold deps (fresh prepared-set build) | green within deadline |
  | warm deps | green |
  | leased port pre-occupied by foreign process | env-skip via squatter probe, **zero** lane-attempt increment |
  | user's own cyboflow instance running | green (isolated data dir; no lock contention) |
  | app restart mid-queue | request recovers or terminalizes cleanly, no wedged lane |
  | injected deliverable regression (broken renderer commit) | **FAIL, attributed deliverable**, lane loops back |
  | injected env fault (chromium removed) | preflight skip, circuit-breaker after K, no attempt charged |
  | runbook input-hash drift (edited dev script) | demotion to `unproven-draft`, skip + CTA |
  | host-fingerprint drift | demotion, re-probe recovers after re-proof |
  | attestation channel absent | no `passed` possible (§7.1) |
  | native-screen (if drive lands) | explicit-consent gate honored; abort-on-input verified |

  Every row is a scripted scenario, runnable unattended except the consent
  row. Three green *matrix* passes replace three green *runs*.

## 6. Phase 3 — onboarding + health

Generated from the phase-1 roster; nearly invisible for most users.

- **Probes, not checkboxes.** Every row is a live probe, not a remembered
  wizard answer: TCC grants rot silently on any app-path/version change while
  a wizard's checkmark keeps saying "configured". Probe results are recorded
  on the request row.
- **Read-probes run freely; drive-probes require consent. [v2]** v1 had the
  health panel perform a synthetic click "at open" — that violates the §4
  consent policy it coexists with, and a focus change between target
  selection and click can land input in the wrong application. v2: passive
  probes (grant bits, binary presence, endpoint liveness) run at panel open
  and at verification time; the **drive round-trip probe** (one synthetic
  click, verified effect) runs only on explicit user action ("Test driving
  now"), under the screen lease, against an **owned probe window** cyboflow
  itself creates, with foreground identity revalidated immediately before the
  click and abort on any user input or focus change. "Grant present but
  driving broken" — the exact live state that motivated this probe — is thus
  detectable on demand without ambient input injection.
- **Chromium is provisioning, not consent**: auto-install (reviving the
  retired `playwrightInstaller.ensureChromium` pattern on the agent path) with
  a visible health row — never a deep post-deploy failure.
- **Conditional grants branch.** The Peekaboo grant pair appears only when
  some project's runbook declares `native-screen`. CDP-only users never see a
  permissions screen. **[SUPERSEDED 2026-08-05 — see "The probe table is three
  rows" below.]** Hiding the rows made the panel silent at exactly the moment
  the answer was needed: you cannot decide whether to declare `native-screen`
  without first being told whether screen capture works on this host.
- **Health panel** on `VerifyQueueView` (the natural "verification screen"):
  per-project-per-modality attempts, pass rate, failure-class histogram
  (env / deliverable / ambiguous, from §3.1), median duration, budget
  consumed, probe states, suppressed-capability entries with their re-probe
  TTLs, and fix-it CTAs. Ships **before** the setup wizard is polished, so its
  effect is measurable — the 2-for-28 baseline was discovered by hand-querying
  sqlite; the app currently reports nothing.
- UI anchors that exist today: the bare master checkbox
  (`Settings.tsx:999-1015`; the six advanced config fields have no UI),
  `VerifyQueueView` empty state, an onboarding-carousel step, the session
  wizard's Advanced verification radio.

**IMPLEMENTED 2026-08-04.** What landed, and the two places reality diverged
from the section above:

- `cyboflow.verificationRequests.health` — per-modality attempts, pass rate,
  failure-class histogram, median duration, capability ledger, runbook state;
  and `hostProbes` / `provisionChromium` for the live probe table. All
  read-only over the existing 055/056/078/095/096 schema: **no migration was
  needed**, because every number this section asks for was already derivable
  and simply never reported.
- The panel renders on `VerifyQueueView` (both the populated and the empty
  state), and carries the setup CTA — the primary entry point for verify-setup,
  which is hidden from the session wizard's list as a "setup flow" (it
  configures the project rather than doing project work). Hiding is
  presentation-only: the registry still lists the row, or the Workflows editor
  and the run rail's name map would lose it, and the gallery's Run action still
  launches it by row id.
- **The CTA is unconditional; only its label tracks state.** First written to
  appear only when the health query succeeded AND no modality was proven, which
  inverted the requirement: it vanished on a failed health query, and one
  proven modality hid the affordance for repairing the others. For a flow
  hidden from the launcher, a conditional entry point is no entry point.
- **Pass rate counts skips in its denominator.** Not stated above, but forced
  by §3.2: a SKIP is the most common way verification fails to happen, so a
  skip-excluding rate would report a healthy project whose checks never ran.
  This is also what reproduces the "2 for 28" baseline honestly.
- **The runbook row leads each modality**, ahead of the outcome numbers. This
  section listed runbook state nowhere, but without it the rest of the panel
  misleads: until a runbook is proven the degrade gate skips everything for
  that modality, so an empty queue is the symptom rather than the all-clear.
- **Deferred: the drive round-trip probe.** §6 specifies a consent-gated
  "Test driving now" under a screen lease against an owned probe window. §8
  still lists the drive API shape as open, so there is no audited API to drive
  through and the safety machinery the bullet describes has nothing to wrap.
  The acceptance-matrix `it.todo` stays; the disclosure now rides the
  `accessibility` row rather than a probe row of its own (below).
- **The capability row shown is the one the ENGINE reads**, keyed by the
  request pin's `runbook_hash` (a proven revision's hash, else migration 095's
  `''`) — not the most recently updated row. `verify_capability_state` is keyed
  `(project, modality, runbook_hash)` and holds a row per revision; an old
  pinned request finishing after a new runbook is registered updates the stale
  row LAST, so "newest wins" reported suppressions the scheduler would never
  honour and hid ones it would.
- **Host probes run once per panel open, not on the health poll.** Each pass
  resolves a Playwright browser path and shells out for the screen-recording
  grant; riding the 15s health interval turned "probed at call time" into
  perpetual background subprocess work for facts that only change when a human
  acts. Health still polls — it is one indexed read.
- **Found while building (not fixed here):** setup-proof runs are exempt from
  the budget CHECK (`!setupProof && isProjectBudgetExhausted(...)`) but their
  `judge_calls_used` remains inside the `SUM` that check reads — so proof spend
  consumes the allowance ordinary lanes are measured against, despite the
  `cyboflow_request_verification` contract promising a proof run is "never
  counted against it". The panel surfaces the overlap
  (`setupProofCallsUsed`) rather than silently changing enforcement, since §8
  lists proof-run cost accounting as an open question.

**The probe table is three rows [2026-08-05].** The first cut listed five —
`node`, `chromium`, `driver-cli`, `native-capture`, `native-drive` — of which
one offered an action and two described our own machinery rather than the
host. Rebuilt around what a user can actually decide about:

- **`browser-driving` rolls up node + chromium + the driver CLI.** They are not
  three decisions; Playwright either drives a browser here or it does not. The
  row names every part that fell over, and still offers chromium's install.
- **The two macOS TCC grants get a row each, always shown.** They are granted
  separately, in separate System Settings panes, and holding one but not the
  other is the common case — a single ANDed boolean could only say "something
  is wrong". This retires the "conditional grants branch" bullet above.
  (`nativeScreenDeclared` briefly survived to set how loudly an unmet grant
  rendered; see the 2026-08-06 entry, which deleted it.)
- **`native-drive` is gone rather than relabelled.** It probed nothing about
  the host — it reported that §8's drive API is unbuilt. That disclosure moved
  onto the `accessibility` row, whose grant is the one driving would need.
- **Remedies are per-row and honest about their limits.** Chromium installs in
  place. Accessibility gets the OS consent prompt with a Settings fallback,
  because macOS fires that prompt at most once per binary and then silently
  no-ops — a button wired to the prompt alone works exactly one time in the
  app's lifetime. Screen Recording gets the pane only: macOS exposes no request
  API for it at any privilege level.
- **The grant probe was reading a flag that does not exist.** `peekaboo
  permissions --json` exits 64 on the unknown option (it is `--json-output`),
  and the parser looked for `{permissions}` where v2 nests under
  `{data:{permissions}}`. Both bugs pointed the same way, so `healthCheck()`
  was false on every host and `native-screen` could never be available — even
  on one holding both grants. Neither showed up in three review rounds; the
  live CLI did, in one invocation.
- **The gate and the driver must measure the SAME binary.** Pointing only the
  capability probe at the bundled copy created a divergence that did not exist
  while both sides defaulted to the bare PATH name: `VerificationAgentRunner`'s
  `peekabooBin` was never wired in `index.ts`, so the deployed driver still
  shelled `peekaboo` off PATH. On the exact host bundling exists for — grants
  held, nothing on PATH — the gate would affirm `native-screen`, the request
  would take the count-1 screen lease, spend budget, provision a snapshot and
  deploy a full SDK agent, and only then ENOENT inside the run. `index.ts` now
  resolves the path ONCE and hands it to both. Caught by the adversarial review,
  not by the suite: the `peekabooBin` channel is well tested, and the untested
  part was the one line of wiring in a file no unit test can import.
- **The capture binary now ships inside the app** (`optionalDependencies` +
  `asarUnpack`, resolved by `peekabooExecutablePath.ts`, PATH kept as a last
  resort). Beyond sparing users a manual install, it keeps the gate and the
  driver measuring one binary (see the bullet above). A third reason claimed
  here originally — that TCC grants attach to a BINARY, so an npx copy under a
  content-hashed path loses its grants on every version bump — was WRONG and
  untested; see the 2026-08-06 entry. Still on the deprecated v2 package; v3 is 52 MB plus
  a sidecar dylib against v2's 2.2 MB, for a capture-only path. The parser
  reads both output shapes, so that bump is a one-line change when the size is
  worth paying.

**Panel simplification, and a TCC claim retracted [2026-08-06].** A second
adversarial review (plus one live test by the user) against the phase-3 panel:

- **TCC follows the RESPONSIBLE PROCESS, not the binary.** Revoking Cyboflow's
  own Accessibility grant flips what the app-spawned peekaboo reports. Three
  docblocks and a commit message had asserted the opposite — that the app's
  identity and the capture binary's are separate and merely coincide — and
  built arguments on it: part of the bundling rationale, and the severity of
  the "grant button tests the wrong binary" finding. The claim was never
  tested; one revocation settled it. The docblocks are corrected in place; the
  commit message (754c8716, pre-rebase) stands uncorrected and is wrong.
  The CODE changes both claims produced are still right, for narrower reasons.
- **The probe table reports a status, not a sentence.** `Healthy` / `Pending
  action` / `Unhealthy`, with `Unknown` reserved strictly for a probe that
  could not answer and `N/A` for machinery missing on our side. The probe's own
  detail survives as the row tooltip.
- **Every capability is checked the same way on every host**, and
  `nativeScreenDeclared` is deleted outright. Softening an unmet grant that no
  runbook declared to `unknown` was the conditional-grants defect in a quieter
  form: hiding the row withheld the answer, softening it withheld the answer's
  meaning, and it rendered a grey we-don't-know beside a live remedy button.
- **The setup CTA is a per-project list.** A runbook is registered against ONE
  project, so a single global button could only ever configure whichever
  project the queue filter was showing. KNOWN GAP: a project row reads `Set up`
  when ANY modality is proven, so a project with `web` proven and
  `native-screen` not shows no sign that native-screen checks are skipping —
  the per-modality runbook line used to say that, and the outcomes block it
  lived in is no longer rendered (health still serves it; this is a rendering
  decision, not a teardown).
- **`window-identity` was broken the same way the permissions probe was.**
  `list windows --json` exits 64: the flag is `--json-output`, and `--app` is
  mandatory. Since window-identity is the only attestation channel
  `native-screen` has, fixing the permissions probe is what made this
  reachable — a runbook could spend its screen lease, budget and full agent
  deploy, then fail an attestation floor that could never pass. peekaboo has no
  host-wide window listing at all, so `AttestationSpec` now carries the app;
  scoping to one application is also what makes it an identity check rather
  than "something on this machine has a matching title". Smoked against the
  bundled binary this time. Any persisted window-identity runbook must be
  re-registered — nothing proven can exist, since it could never have passed.

**STILL OPEN after phase 3** — surfaced by the adversarial review of this work,
each wider than the panel and deliberately not folded into it:

1. **`bumpHostGeneration` has no production caller.** §3.3 says a suppression
   self-refreshes when "the host generation moved on", but nothing moves it:
   the only exit is the 24h TTL. So a user who installs the missing chromium,
   watches the panel's row turn green, and re-runs gets skipped anyway until
   the TTL lapses — the exact "green but lying" shape §1 is about. The fix
   needs a decision the panel cannot make alone: WHERE the host fingerprint
   lives, and which facts (chromium path, TCC grant, node major, app binary
   path, ABI) constitute a change. `verify_runbook_local.host_fingerprint_json`
   already stores one per runbook record, but a generation bump is host-wide.
2. **Packaged chromium provisioning is best-effort.** The panel's Install
   button drives `PlaywrightInstaller`, which spawns `npx playwright install
   chromium`. A packaged app neither bundles `npx` nor puts it on PATH, and
   where a system one exists it resolves a Playwright revision independent of
   the app's pinned copy. Fails soft (the row stays `missing`), so the button
   is reliable in a dev checkout and a coin flip in a packaged build.
3. **The `node` probe's `missing` state is unreachable.** `findNodeExecutable`
   falls back to `return 'node'` rather than throwing, so the one probe whose
   rejection was declared affirmative evidence never rejects. Harmless today
   (the row reads `ok` with a bare `node`, which is what the harness will
   actually exec) but the row promises more than it checks.

## 7. Cross-cutting hazards (fix regardless of phases)

1. **Verified-artifact identity — per-modality attestation. [v2]** The
   false-ready incident is designed in: the port pool is an in-process mutex
   ("guards the logical slot, NOT the OS socket"); the sole TCP probe runs at
   teardown only; the driver's `goto` checks HTTP status, never identity.
   PID-verified readiness is insufficient (warm caches, the user's own
   running app) — and so is a bare env-var nonce, which is not observable
   from an arbitrary page. Each modality defines a concrete **attestation
   channel**, and setup **proves the channel exists** as part of the proof:
   - `web`: a required marker the serve step injects and the driver reads
     back — an HTTP endpoint (`/__cyboflow_verify__` returning the
     per-request nonce) or a DOM/meta marker carrying it.
   - `cdp-app`: an immutable build token evaluated over CDP
     (`Runtime.evaluate` of a build-stamped global), covering attach mode
     where no navigation happens.
   - `native-screen`: window-title/process-identity assertion of the launched
     app (weakest channel; recorded as such on the verdict).
   - `mobile`: `bundle-identity` — the harness sha256-compares the executable
     staged under the request's private DerivedData against the executable
     actually installed on the leased simulator, plus a bundle-id and
     realpath-confinement check (`docs/proposals/mobile-verification-tier.md`
     §9). Strength: stronger than `window-identity` against *accidental*
     mis-targeting — byte identity, not a spoofable title match, on a device
     created seconds earlier for this request alone. Residual, in two parts:
     (a) it does not prove the staged product was compiled from this
     snapshot — a sufficiently determined agent could stage a prebuilt
     bundle, since the agent runs `build[]` through Bash exactly as every
     other modality does; and (b) it proves what is installed, not that the
     screenshots were of its foreground.
   No attestation ⇒ **no `passed`, period** (v1's low-confidence escape hatch
   is removed — it weakened the invariant). A missing/mismatched attestation
   with foreign-occupancy evidence is env-class; without evidence it is
   ambiguous (§3.1) and blocks.
2. **Snapshot dep isolation — a specified preparer, runner-enforced. [v2]**
   `snapshotProvisioner.linkDependencyDirs` symlinks `node_modules` from the
   live sprint worktree into the snapshot (`snapshotProvisioner.ts:142-178`);
   any install/rebuild inside the snapshot writes **through** the symlink into
   the shared worktree — flipping better-sqlite3's ABI under sibling lanes —
   and `checkSnapshotMutated` (`git diff HEAD`, tracked files only) cannot see
   it. Two-part fix:
   - **Runner guard**: install/rebuild/browser-install commands are rejected
     in every composed task's `build`/`serve` steps at execution time —
     runbook-sourced and agent-composed alike (lint alone cannot reach
     `VerificationTaskV1.build`).
   - **Dependency preparer**: snapshots consume a prepared, read-only dep set
     keyed by **(lockfile hash, platform, arch, node major, electron ABI,
     browser build)**, built outside any snapshot under a concurrency lock,
     published atomically (build-then-rename), garbage-collected by LRU. The
     electron-ABI rebuild lives *here*, which also removes root cause (c) and
     most of the cold-install deadline pressure (d).
3. **Immutable stamping.** `verify_enabled/type/chain` are stamped once at
   `createRun` with no UPDATE path: setup completing mid-sprint affects only
   subsequent runs — state this in the UI.
4. **Deadline.** Raise the agent deadline toward the existing 20-min ceiling
   for cold-install projects; the prepared-deps cache (§7.2) is the real fix.

## 8. Open questions

- Native-screen drive API shape: extend `DriverCommand` vs a scoped Peekaboo
  tool grant to the verify agent (leaning: driver extension — keeps the
  strictMcpConfig/empty-MCP posture intact).
- Idle-queueing for native-screen runs as a later relaxation of the
  explicit-consent-per-run v1 policy.
- Machine-local half: confirmed project-row record via the router chokepoint
  (CAS against portable hash); exact column/table shape TBD at migration
  time.
- Proof-run cost accounting: exempt entirely vs separate counter surfaced in
  the health panel (leaning: separate counter).
- Scheduler work item (§4 fn.¹) sizing: whether bounded modality-aware
  resources land in phase 1 (blocking the roster's concurrency claims) or
  phase 2 (blocking setup priority) — it gates both.

## 9. Review log

- v1 (2026-07-30): initial proposal from the four-phase synthesis
  (recon workflow + adversarial critique).
- **DOGFOOD (2026-08-01): first live run of the flow, end to end, against a real
  project (`cyboflow-web`, `web` modality) in a dev app built from this branch.**
  5 findings, all fixed (`b452a916..d5c10714`). Three rounds of adversarial
  review had found none of them, because every one lives in an INTERACTION —
  each component is correct in isolation, so no unit test could have failed.
  - **The flow could not fire a verification at all** (two independent blockers
    on the same path). `PROGRAMMATIC_STEP_DISALLOWED_TOOLS` and the MCP
    ownership guard both rejected `cyboflow_request_verification` on any
    `execution_model = 'programmatic'` run. That rule was written for
    sprint/ship, where the controller owns the enqueue; "programmatic" was a
    proxy for that, and verify-setup — programmatic, no fan-out, no
    controller-owned visual-verify step — is the counterexample. Separately,
    `verify_enabled` resolved 0: the enablement ladder floors to the global
    master switch, which ships off, so the flow that exists to make that switch
    worth turning on was gated behind it. Fixed by re-keying both guards onto
    "does a controller own the enqueue on this run?" and adding a bootstrap rung
    above the enablement ladder.
  - **The runbook contract was described in prose, not embedded.** The drafting
    agent recovered `VerifyRunbookV1` only by grepping cyboflow's own source off
    the local disk — which exists on no other machine — and before it found the
    types it produced a draft the validator rejects on its first field, plus an
    INVENTED attestation kind (`static-file-by-construction`) justified by "the
    runner owns the dir and leases `${PORT}`", precisely the reasoning §7.1
    exists to defeat. The strict validator held, so the guard worked; the prompt
    should not have left the question open. Both prompts now carry the literal
    schema, all five kinds, and a worked example, pinned by an invariant test.
  - **A repo that excludes `.cyboflow/` silently breaks the write-back.** `git
    add` on an ignored path is a no-op that reports success, so the runbook
    registers against the working tree and the proof then builds a snapshot
    without it. Registration now reports `committed` from `git cat-file -e
    HEAD:<path>` and the prove step force-adds and verifies.
  - **The proposal doc had no atype of its own**, so the one surface the
    approve-runbook gate asks a human to approve repo changes from rendered as a
    Compound deliverable. Added `verify-runbook` (migration 097).
  - What the run PROVED works: migrations apply on a fresh DB; verify-setup
    registers as the 5th built-in and its DAG runs; the survey threads verbatim
    into derive; "nothing touches the repo before `approve-runbook`" held
    EMPIRICALLY (byte-clean worktree); registration produced a valid record; and
    under a condition that made proving impossible the flow did not fake a pass
    — it committed the runbook, left it `unproven-draft`, and filed an honest
    finding naming the missing tool. That is the §5 "an honest unproven draft is
    not a failure" contract behaving exactly as designed.
  - Still open (both PRE-EXISTING on main, neither introduced by this branch,
    each needing its own reproduction): resolving a blocking gate while the run
    is transiently `running` leaves the resume refused — the path is already
    instrumented (`resolveReviewItemHandler` warns and returns `runStatus`), but
    the observed consequence was a walk that redid completed work, and the
    dogfood's auto-approver supplied unusual timing, so the cause is not yet
    established; and the run session view's blocking "needs your input" card can
    stay pinned to an already-decided approval, whose Approve then no-ops and
    makes the run look wedged (approve from the Human Review queue meanwhile).
- v3.1 (2026-07-31): Codex round-3 re-review of the fix delta — 6 findings
  (3 critical), all fixed (`b4c2fc39..84f1eccc`): ordinary requests can no
  longer carry wire pins (authorized setup proofs only); the MCP enqueue path
  now stamps the snapshot sha (the orchestrated plane had been running the
  dirty fallback as its normal mode — proofs additionally refuse promotion on
  a sha-null run); attestation gained kernel-truth serve-identity binding
  (port-owner process group + pinned-command match, defeating nonce-echoing
  decoy servers); the transport carve-out narrowed by transcript emptiness
  (mid-session deaths block — an accepted §3.1 annoyance); mirror GC gained a
  15-min grace window; driver serve gained replace semantics.
- v3 (2026-07-31): Codex adversarial review of the IMPLEMENTATION branch —
  7 findings (2 critical / 5 high), all fixed (`4ffd6dbb..aabb1379`):
  gate-integrity chokepoint (deployed+ambiguous skips now block; transport +
  fallback carve-outs typed and documented); attestation moved HARNESS-SIDE
  (the agent-writable attest.json was forgeable and is no longer read; the
  runner probes the live surface itself and owns serve teardown via the new
  driver `serve` command); pin validation requires proven status (ordinary) /
  exact draft version (setup); setup_proof authorized from the run's frozen
  workflow identity + a resolvable pin; dependency dirs are CLONED into
  snapshots (APFS clonefile) instead of symlinked — write-through dead in
  both paths, pnpm workspace links resolve, the §7.2 regex demoted to
  diagnostics; capability ledger keyed by pinned runbook hash.
- v2 (2026-07-30): folded all 11 Codex adversarial-review findings —
  conservative three-way failure classifier (skip requires harness-derived
  proof); per-modality `unsupported` with TTL/generation re-probe; pinned
  content-addressed runbook injection; runner-enforced dependency guard +
  specified prepared-deps preparer; native-screen drive demoted to designed
  prerequisite with deterministic observe-only fallback; explicit-consent
  drive probes (no ambient clicks); honest concurrency column + budgeted
  scheduler work item; per-modality attestation replacing the env-var nonce
  (low-confidence escape removed); request-scoped values purged from the
  machine-local half; fifth-built-in registration honestly costed (exhaustive
  discriminant consumers + no-seed launch seam); acceptance rewritten as a
  failure-injection matrix.
