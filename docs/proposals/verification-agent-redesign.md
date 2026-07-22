# Verification Agent Redesign — from "handed a path" to "handed a task"

Status: PROPOSAL v2 (post-adversarial-review; v1 findings dispositioned in §9)
Supersedes the capture/judge core of `docs/proposals/visual-verification-design.md`
(the scheduler spine, merge gate, and delivery chokepoints from that design are
retained — see "What survives" below).

## 1. Problem

Live visual verification persistently fails. Prod-DB evidence (`~/.cyboflow/sessions.db`,
last 30 days at time of writing):

- 134 runs had `verify_enabled=1`; only 9 (7%) ever enqueued a request.
- Of 21 requests: **13 failed (62%)**, 4 skipped (19%), 2 low_confidence, 2 passed.
- 10 of the 13 failures died **before any screenshot existed**: 7 × `"no url or
  htmlPath provided"`, 3 × `ERR_CONNECTION_REFUSED` on a guessed localhost URL.
- All 4 skips are the native-desktop backend failing its health check (TCC), 4/4.
- The 4 requests that reached the VLM judge were judged sensibly (2 pass, 2
  correct low-confidence calls). **Judging is not the bottleneck; producing a
  truthful screenshot is.**

Root cause is structural, not incidental:

1. **Nobody owns making the target live.** The MCP tool
   `cyboflow_request_verification` carries only
   `intent/type_override/url/html_path/viewports/baseline_key/task_ref`
   (`cyboflowMcpServer.ts` tool schema; `mcpQueryHandler.ts`
   `handleRequestVerification`). There is no channel for build or run
   instructions. The only code that can build/serve anything
   (`DevServerManager`) is gated on a `.cyboflow/verify.json` deliverable
   recipe, which target projects do not have. The in-lane `visual-verify`
   subagent is *explicitly forbidden* from starting a dev server
   (`sprint/agents/visual-verify.md`). Capture therefore succeeds only when a
   target coincidentally happens to be live.
2. **The fail posture is inverted.** A dead URL produces capture `ok:false` →
   terminal `'failed'` → the merge gate **fails closed**: loops the lane back to
   `implement` up to 3× then permanently fails it — an environment problem
   masquerading as a code defect, with a generic finding body that never
   includes the concrete capture error (`verdictDelivery.ts` documents that
   `error_message` is not threaded). Meanwhile `'skipped'`/`'timeout'` **fail
   open** (advance-integrated), so genuine "could not verify" outcomes merge
   silently — including every in-flight request orphaned by an app restart
   (`runRecovery` force-marks them `timeout`).
3. **Wrong-target capture.** If an unrelated dev server (e.g. the user's own
   long-running `pnpm dev` on the main checkout) is listening on the guessed
   port, capture silently succeeds against the wrong code. Nothing verifies the
   captured origin matches the run's worktree. Related: a relative `htmlPath`
   that misses the worktree and project root falls back to Electron's
   `process.cwd()` — a third, uncontrolled root.

## 2. Design decisions (locked with the user)

1. **Keep the scheduler spine** — DB-backed `verification_requests` queue,
   `ResourceLeasePool` over the shared mutex, the fire-and-continue MCP seam,
   and the three-chokepoint verdict delivery (ArtifactRouter → merge gate →
   ReviewItemRouter). **Replace the capture backends + VLM judge core** with a
   verification *agent*.
2. **task-verify composes the verification task.** The existing non-visual
   verification agent verifies code against requirements; on PASS it composes a
   scoped visual-verification task (branch/worktree implied by the run, build
   instructions, behaviors to test) which is queued for the visual verification
   agent — the "centralized smoke sub-agent" model.
3. **Capabilities: build + drive + screenshot.** The verification agent runs
   builds/dev servers, drives the UI, captures screenshots at meaningful
   states, and judges against the composed behaviors.
4. **Fail closed for build/launch failures** (a deliverable that cannot even
   build or start is itself a smoke FAIL → loopback with the real error).
   **Fail open for pure infra failures** (lease starvation, agent-spawn/API
   errors, deadline) — advance with a non-blocking finding, as today.
5. **The verification agent is workflow-defined.** Its instructions
   (systemPrompt), model alias, and effort resolve through the existing
   effective-agent chain — built-in catalogue → project `agent_overrides` →
   workflow `agentConfigs` overlay → variant `agent_overrides_json` deltas —
   via the established `resolveStepAgent(runId, agentKey)` channel. The central
   queue manages **environments and deployment** of those workflow-defined
   agents. A/B variants of verification prompts/models work with zero new
   plumbing.
6. **Claude-scoped for now.** The visual-verification agent resolves in the
   **Claude provider namespace unconditionally** (§5.4). The workflow editor
   must *communicate* this (no Codex runtime option offered; "always runs on
   Claude" instead of runtime inheritance), and the deploy seam enforces it.
7. **Screenshot artifact emission survives, plus a verification report.** The
   run's `screenshots` artifact keeps working exactly as today (harness-written
   through ArtifactRouter), and its payload is extended with a structured
   **verification report**: the behaviors tested and each behavior's result.
   MCP scoping for the verification agent is defined explicitly (see §5.4): it
   gets **no MCP servers at all** — every state write is harness-mediated.
8. *(v2, from adversarial review)* **Lane-consistent snapshot builds.** The
   verification build runs against a temporary `git worktree` at a recorded
   snapshot commit, not the live shared sprint worktree — so a neighboring
   lane's mid-edit state can never break (or be blamed for) this lane's
   verification (§5.5). When snapshot preconditions cannot be met, build
   failures are routed to the fail-open infra bucket instead of consuming the
   lane's retry budget.
9. *(v2)* **Honest isolation framing + guards, not a false read-only claim.**
   The verifier shares the trust tier of the implement/write-tests agents (which
   already run unrestricted Bash in the same worktree today). v1 hardens with
   hermetic SDK settings, a post-run mutation check, and lease quarantine; an
   OS-enforced sandbox is a listed hardening follow-up (§5.4).
10. *(v2)* **The baseline feature is retired entirely.** Accept-as-baseline +
    SSIM pre-diff have zero live usage; the button is removed and
    `baselineStore`/`pixelDiff` retire with the legacy path (§5.10).

## 3. What survives, what is replaced, what is retired

**Survives unchanged (or extended per §5):**

- `verification_requests` queue + drain loop + `ResourceLeasePool` + per-request
  deadline/abort + `runRecovery` (`verificationScheduler.ts`) — extended with a
  queued-age deadline, delivery outbox, and queued-row recovery (§5.6).
- The fire-and-continue MCP seam (`cyboflow_request_verification` — schema
  extended, §5.2).
- `verdictDelivery.ts` three-chokepoint sequence and `mergeGateLaneAdvance.ts`
  (posture table amended §5.7; finding supersession added).
- The `awaiting-verify` lane park + `SchedulerVisualVerifyGate` actuation in
  programmatic mode.
- Immutable per-run stamps `verify_enabled` / `verify_type` / `verify_chain`
  (chain value changes, §5.8).
- The Verify-Queue panel (`VerifyQueueView`) — extended for task/report rows
  (§5.11).

**Replaced:**

- Capture backends (`capturePageBackend`, `playwrightBackend`,
  `peekabooBackend`), `DevServerManager`/`StaticServerManager`-driven
  deliverable resolution, and `vlmJudge` → one **VerificationAgentRunner** that
  deploys the workflow-defined `visual-verify` agent per request.
- The in-lane `visual-verify` *dispatcher subagent* → retired. The lane step
  remains (vocabulary unchanged) but becomes agentless (§5.3).

**Retired in place (`@cyboflow-hidden`, not deleted):** the replaced modules
above, plus `pixelDiff` + `baselineStore` + the Accept-as-baseline surface
(button, `artifacts.acceptAsBaseline` tRPC — §5.10), with a legacy kill-switch
for rollback (§5.8).

## 4. Architecture overview

```
task-verify (in-lane, per task)
  │  PASS → REQUIRED composition contract (§5.1/§5.3): either a
  │  `## Visual verification task` fence or an explicit NOT-APPLICABLE line
  ▼
visual-verify lane step (agentless)
  │  programmatic: WorkflowController reads the typed step output, enqueues
  │    directly on the scheduler (idempotency key: runId+taskRef+attempt)
  │  orchestrated: orchestrator calls cyboflow_request_verification(task=...)
  │  then parks the lane at awaiting-verify (unchanged)
  ▼
VerificationScheduler (queue/lease spine, + queued-age deadline + outbox)
  │  resolves EffectiveAgent for 'visual-verify' (Claude namespace, §5.4)
  │  provisions environment: SNAPSHOT worktree @ recorded sha, leased port,
  │  artifacts dir, env vars
  ▼
VerificationAgentRunner (new)
  │  deploys ONE Claude SDK session: cwd = snapshot worktree,
  │  system prompt = workflow-defined instructions + immutable harness contract,
  │  tools = Bash/Read/Grep/Glob (hard ceiling; no Write/Edit; ZERO MCP servers)
  │  agent: builds, serves on $VERIFY_PORT, drives UI via bundled driver CLI,
  │  screenshots into $VERIFY_ARTIFACTS_DIR, returns VerificationReportV1
  │  harness: validates report + files, mutation check, kills process tree,
  │  quarantines-or-releases leases, disposes snapshot
  ▼
verdictDelivery (unchanged seams; outbox-replayable; extended payload)
  ├─ ArtifactRouter: atomic MERGE into screenshots artifact
  │    { fileNames, reports[], verdict }
  ├─ applyMergeGateVerdict: PASS advance / FAIL loopback / infra fail-open
  │    + supersession of prior visual findings for this lane generation
  └─ ReviewItemRouter: finding carries the report + real error text
```

Ownership split: **the workflow defines who verifies** (instructions, model,
effort — editable, overridable, A/B-testable); **the central queue defines
where and how they run** (snapshot, environment, leases, tool sandbox,
timeouts, verdict delivery).

## 5. Detailed design

### 5.1 `VerificationTaskV1` — the composed task

New shared type (`shared/types/visualVerification.ts`):

```ts
interface VerificationTaskV1 {
  version: 1;
  taskRef?: string;            // lane attribution (unchanged semantics)
  summary: string;             // replaces the old one-sentence `intent`
  build?: string[];            // shell steps, run in the snapshot worktree, in order
  serve?: {                    // optional long-running serve step
    cmd: string;               // may reference ${PORT}
    readyWhen?: { urlPath?: string; timeoutMs?: number };
  };
  target?: { url?: string; htmlPath?: string };  // pre-live target (degenerate path)
  behaviors: Array<{           // the verification steps — the core payload
    id: string;                // stable within the task, e.g. "b1"
    description: string;       // what behavior, in user terms
    steps?: string[];          // how to exercise it (navigate/click/type/…)
    expected: string;          // what must be observed for PASS
  }>;
  viewports?: ViewportSpec[];
  timeoutMs?: number;          // capped by scheduler config
}
```

Composition: **task-verify** gains a **required, two-sided** result contract.
When visual verification is enabled for the run, every `VERDICT: PASS` result
MUST contain exactly one of:

````markdown
## Visual verification task
```json
{ ...VerificationTaskV1 }
```
````

or the explicit line `VISUAL-VERIFICATION: NOT-APPLICABLE — <one-line reason>`
(backend-only change, no user-visible UI). Absence of *both*, a duplicate
fence, or an unparseable/schema-invalid fence is an **output-contract failure**:
the orchestrator/controller re-delegates task-verify once with the contract
error, and a second failure marks the lane `failed`. A missing section is
NEVER silently treated as "nothing to verify" — that would let a truncated
response bypass the gate (v1-review finding 2). Parsing uses the shared
CommonMark-paired fence grammar (same parser family as arch-section parsing).

Build/serve commands come from what task-verify can actually see: the project's
own docs (README/CLAUDE.md), `package.json` scripts, an existing
`.cyboflow/verify.json` (now a *hint*, no longer a prerequisite), and the diff
itself. Behaviors derive from the task's acceptance criteria — task-verify
already holds them and has just evaluated them, so it is the best-placed
author.

Grading-your-own-homework note: task-verify *authors the steps* but does not
*execute or judge* them — the verification agent independently drives and
judges, and the human-facing report lists the behaviors verbatim, so
easy-grader drift is visible in review.

### 5.2 MCP + request plumbing (dual-format contract)

`cyboflow_request_verification` gains one optional field: `task` (a
`VerificationTaskV1` object; JSON-schema-validated). `intent` remains accepted
(a task-less request behaves as a degenerate task with `summary=intent` and no
build/behaviors).

Persistence is **dual-write** (v1-review finding 9): every new row writes BOTH
the new nullable `verification_requests.task_json` AND a legacy-shaped
`deliverable_json` (`{ intent: task.summary, url?, htmlPath?, taskRef }` — the
NOT-NULL column every legacy reader, the recovery sweep, and the Verify-Queue
projection already consume). Dispatch is keyed on the run's stamped
`verify_chain` (§5.8), never on which column happens to be populated. `taskRef`
precedence: `task.taskRef ?? task_ref` wire arg, written identically into both
columns.

### 5.3 Lane flow — who fires the request, and the typed step-output channel

The in-lane `visual-verify` dispatcher subagent is retired. The `visual-verify`
inner step stays in the canonical chain (lane vocabulary, gate parking, and
`awaiting-verify` semantics unchanged) but becomes **agentless**.

**Typed step output (new seam, v1-review finding 2).** Today
`SpawnStepRunner.runStep` resolves to `ok/failed/aborted` only — the controller
never sees the step agent's text, so there is nothing to parse. v2 adds a
**durable typed step-output channel**: the spawn seam captures the step agent's
final assistant message, persists it on the step record, and returns it in the
step result. For task-verify the controller parses it into
`{ verdict, visualTask?: VerificationTaskV1 | 'not_applicable' }` (contract in
§5.1). This channel is generic (any step's parsed output can ride it) but v2
only consumes it for task-verify.

- **Programmatic mode:** after task-verify PASS, `WorkflowController.driveItem`
  reads the parsed output. `visualTask` present → enqueue **directly on the
  scheduler** (main-process call, no MCP hop) with **idempotency key
  `(runId, taskRef, attempt)`** — re-walking the chain after a crash or
  loopback never double-enqueues; a fresh attempt (bumped by the merge-gate
  loopback) is a NEW key and re-fires. `'not_applicable'` → advance without a
  request. Contract failure → §5.1 handling. The lane then parks at
  `awaiting-verify` as today. **Feedback threading:** on a visual FAIL
  loopback, the re-delegated implement prompt carries the verification
  report's failed behaviors + evidence verbatim (the controller has the report
  via the outbox row, §5.6) — not just "a blocking finding exists".
- **Orchestrated mode:** `fan-out-instructions.ts` and `sprint.md`/`ship.md`
  prose change: the orchestrator itself calls
  `cyboflow_request_verification(task=<the fence content>, task_ref=...)` and
  parks the lane; on loopback it re-delegates implement with the finding's
  report body and, after the fix, re-runs task-verify → the fresh fence
  re-fires the request. The same required/not-applicable contract applies (the
  orchestrator enforces it per the prose).

The `visual-verify` **agentKey survives** and is repurposed: it now names the
centrally-deployed verification agent. Existing workflow `agentConfigs`,
project overrides, and variant deltas keyed on it apply to the new agent — this
is precisely the "workflow-defined verification agent" the design wants, and it
preserves the editor gallery slot and A/B continuity. Its built-in prompt
(`sprint/agents/visual-verify.md` + the byte-identical ship copy, per
`agentParity.test.ts`) is rewritten as the verification agent's instructions.

### 5.4 VerificationAgentRunner — deployment, isolation, MCP scoping

New module `main/src/orchestrator/verify/verificationAgentRunner.ts` (electron-
free, injected into the scheduler like backends are today), built on the
established one-shot structured SDK-query pattern (`evalJudgeQuery.ts` /
`revisionQuery.ts`: `loadSdkQuery()` lazy load, `pathToClaudeCodeExecutable`,
abort-tied deadline, drain stream, last `result.structured_output`). It does
**not** route through `ClaudeCodeManager`/panels (no PTY, no warm-session
machinery, no `panels/claude` churn).

Per request, the runner:

1. **Resolves the workflow-defined agent** via the injected
   `resolveStepAgent(runId, 'visual-verify')` → `EffectiveAgent`
   (systemPrompt/effort). **Model resolution is Claude-namespace-only**
   (v1-review finding 8): a pinned Claude alias is used; an unpinned agent
   inherits the run model ONLY when the run's provider is Claude; on a Codex
   run (or any non-Claude inherit) it falls back to a validated Claude default
   from config — a `gpt-*`/`codexModel` id can never reach the query. A
   `runtime: 'codex-sdk'` pin is dropped with a logged warning + Sentry seam
   breadcrumb.
2. **Provisions the environment:**
   - **Snapshot worktree** (§5.5): `git worktree add <tmp> <snapshotSha>` +
     dependency-dir linking; the agent never touches the live sprint worktree.
   - Leases: `verify:port` (when the task implies a server) + the
     `sprint-verify-<batchId>` batch lease + a new `verify:agent` count-1
     lease bounding concurrent deployments.
   - Env: `VERIFY_PORT`, `VERIFY_ARTIFACTS_DIR` (the run's artifacts dir),
     `VERIFY_DRIVER` (path to the bundled driver CLI).
3. **Deploys the agent:** `query()` with `cwd` = the snapshot worktree,
   `customSystemPrompt` = the workflow-defined instructions **plus an immutable
   harness-appended contract** (environment variables, output schema,
   prohibitions — config shapes the persona and judgment style, never the
   sandbox), `allowedTools: ['Bash', 'Read', 'Grep', 'Glob']` (a hard ceiling
   the config cannot widen), **hermetic SDK settings** (v1-review finding 1):
   `settingSources: []`, `strictMcpConfig: true`, no plugins, and
   `mcpServers: {}` — the well-defined MCP scope is *empty*. The agent's
   outputs are files (PNGs into `VERIFY_ARTIFACTS_DIR`) plus its structured
   report; every cyboflow-state write (artifact, finding, lane) is
   harness-mediated through the existing chokepoints, preserving the "verify
   agents never write cyboflow state" invariant.

   **Honest threat model (v1-review finding 1).** Bash is arbitrary code
   execution; removing Write/Edit is a *behavioral* contract, not a security
   boundary, and build steps composed from repository content are a
   prompt-injection-to-shell path. This is explicitly the SAME trust tier as
   the implement/write-tests agents, which already run unrestricted Bash in
   the same worktree today — the verifier adds no new privilege. v1 guards:
   the snapshot worktree means tracked-source mutation cannot corrupt the real
   run worktree at all; a **post-run mutation check** (`git diff --quiet` on
   tracked files in the snapshot) demotes the report to `low_confidence` with
   a finding when the verifier modified sources it was judging; and the
   process-tree reaper + port probe below. An OS-enforced sandbox (read-only
   source mount, restricted network, process namespace) is a designated
   hardening follow-up, not a v1 gate.
4. **The agent executes the task:** runs `build` steps; starts `serve` (told to
   background it and record the PID); waits for readiness; exercises each
   behavior via the **bundled driver CLI** — a small node script shipped with
   the app (using the app's own `playwright` prod dep, so the *target project*
   needs no playwright install): `$VERIFY_DRIVER goto <url> / click <selector>
   / type <selector> <text> / screenshot <name> [--viewport WxH]`, headless,
   screenshots written under `VERIFY_ARTIFACTS_DIR`. The agent inspects its own
   screenshots (Read renders images) and judges each behavior against its
   `expected`.
5. **Returns `VerificationReportV1`** via `outputFormat: json_schema`:

```ts
interface VerificationReportV1 {
  version: 1;
  behaviors: Array<{
    id: string;                 // must echo the task's behavior ids
    result: 'pass' | 'fail' | 'not_testable';
    evidence: { screenshots: string[]; notes: string };
  }>;
  screenshots: Array<{ fileName: string; caption: string }>;
  outcome: 'pass' | 'fail' | 'build_failed' | 'launch_failed';
  buildLogExcerpt?: string;     // required when outcome is build_/launch_failed
  confidence: number;           // 0..1
  feedback: string;             // maps onto VerdictV1.feedback
  issues: VerdictV1['issues'];  // reuse the existing issue shape
}
```

6. **Cleans up deterministically:** kills the SDK subprocess's entire process
   tree (or on abort/deadline), probes the leased port; a port that will not
   free is **quarantined, not released** (v1-review finding 1) — the lease
   stays held with a logged reason until a sweep confirms it free, so a leaked
   server can never collide with the next verification. The snapshot worktree
   is `git worktree remove --force`d. Deadline default rises to **10 minutes**
   (`task.timeoutMs` capped by config), still under the scheduler's existing
   per-request abort/`raceWithAbort` machinery.

Report validation is harness-side and strict: every `screenshots.fileName`
must exist in `VERIFY_ARTIFACTS_DIR` (basename-only, same safety rules as
`cyboflow_report_artifact`), behavior ids must match the task, and an
`outcome: 'pass'` with any `behaviors[].result === 'fail'` is coerced to
`fail` (the structured verdict, not prose, drives the gate).

### 5.5 Lane-consistent snapshot builds

Sprint lanes share one worktree; other lanes' *uncommitted, mid-edit* state
would otherwise break this lane's build and be blamed for it under fail-closed
(v1-review finding 7). Resolution (user-locked): verification builds run
against a **temporary `git worktree` at a recorded `snapshotSha`**.

- `snapshotSha` is captured at enqueue time (the shared branch HEAD). Committed
  neighbor work is included (deterministic and gate-vetted by those lanes'
  own chains); uncommitted mess is excluded by construction.
- **Precondition:** the lane's own diff must be committed before its
  visual-verify step fires. The sprint lane chain already commits per task in
  agent space; implementation must verify/enforce commit-before-verify
  ordering in both modes (prose + controller). **Fallback:** when the lane's
  files are still dirty at enqueue (ordering violated), the harness verifies
  the live shared worktree instead and routes any build/launch failure to the
  fail-open infra bucket — attribution is unprovable there, so it must not
  consume the lane's retry budget.
- **Dependency dirs:** a fresh `git worktree` has no `node_modules`. The
  provisioner links untracked dependency roots (`node_modules`, and any
  project-declared equivalents) from the run worktree into the snapshot
  (symlink; hardlink-copy where a tool resolves symlinks poorly). Documented
  risk: stale deps when the diff changes lockfiles — the agent's build step
  surfaces that as a real build error with the log excerpt in the report.
- Snapshot disposal is unconditional (teardown step 6), including on abort.

### 5.6 Scheduler robustness: queued-age deadline + delivery outbox

Two retained-spine gaps become load-bearing under the agent engine and are
fixed in v2 (v1-review findings 3 and 4):

- **Queued-age deadline.** The per-request deadline today starts only after a
  lease is acquired; contended rows can sit `queued` forever with no retry
  scheduled and `SchedulerVisualVerifyGate` waiting indefinitely. v2 adds an
  enqueue-age deadline covering queued + lease-wait time, a wake-up armed on
  every lease release AND a fallback timer while any row is queued, and a boot
  recovery sweep for stale `queued` rows. Expiry transitions through the
  normal terminal-delivery path as `skipped` with the concrete lease reason.
- **Delivery outbox.** Today the terminal status commits first and the three
  deliveries (artifact, lane, finding) run after — a crash between them
  strands the lane at `awaiting-verify` forever, and `runRecovery` only
  sweeps leased/running rows. v2 writes `delivery_state='pending'` atomically
  with the terminal status + `report_json`, makes all three consumers
  idempotent by requestId, replays every terminal-but-pending request at boot,
  and stamps `delivered` only after all three effects commit.

### 5.7 Fail posture (amended) + finding supersession

| Outcome | Request status | Merge gate | Finding |
|---|---|---|---|
| All behaviors pass | `passed` | advance → integrated | none; **prior under-cap visual findings for this lane generation are auto-resolved (superseded)** |
| Any behavior fails | `failed` (verdict) | **fail closed**: loopback ≤3× → failed | blocking; body = report (behaviors failed + evidence + feedback) |
| `build_failed` / `launch_failed` in the snapshot | `failed` (verdict-less, `error_message` = buildLogExcerpt) | **fail closed** (a deliverable that cannot build from its own committed state is a smoke FAIL, and is frequently code-caused) | blocking; body **includes the build/launch log excerpt** |
| Build/launch failure in the dirty-worktree fallback (§5.5) | `skipped` | fail open: advance | non-blocking, reason = unattributable shared-worktree build failure |
| Agent spawn/SDK/API error, budget exhausted | `skipped` | fail open: advance | non-blocking, with the concrete reason |
| Queued-age/lease-starvation expiry | `skipped` | fail open: advance | non-blocking, with the lease reason |
| Deadline exceeded / orphaned by restart | `timeout` | fail open: advance | non-blocking |
| Behaviors `not_testable` (but none failed) | `low_confidence` | advisory pass-through | non-blocking "needs human visual review", listing untested behaviors |
| Post-run mutation check tripped | `low_confidence` | advisory pass-through | non-blocking, "verifier modified tracked sources" |

**Finding supersession (v1-review finding 5).** Visual findings are correlated
by `(runId, taskRef, attempt)`. On every terminal verdict for a lane, prior
unresolved visual-verify findings for the same `(runId, taskRef)` at lower
attempts are resolved through `ReviewItemRouter` with a supersession note —
so a recovered lane leaves no stale blocking item to park the sprint at a
later outer-step boundary, and repeated failures don't accumulate blockers
(only the latest is live).

The FAIL finding body change closes the loop the investigation flagged: the
re-delegated implement agent finally receives *what was tested, what failed,
and why*, not "investigate the capture/judge step".

### 5.8 Engine stamp, rollback, retirement

- `resolveVisualVerification` stamps `verify_chain: ['agent']` for new runs.
  Dispatch keys on the stamp: `['agent']` → runner; legacy chains → the
  retired-in-place legacy path, which keeps draining pre-upgrade in-flight
  runs (stamps are immutable per run).
- Kill switch: `CYBOFLOW_VERIFY_LEGACY=1` (a) stamps legacy chains for NEW
  runs and (b) at boot, terminalizes any queued/leased/running agent-chain
  rows as `skipped` (reason "agent engine disabled") **through the normal
  delivery path** — parked lanes advance with a finding instead of wedging
  (v1-review finding 9).
- **Old-binary rollback:** a pre-upgrade binary reads the dual-written
  `deliverable_json` fine; it has no 'agent' backend registered, so agent-chain
  rows resolve to `skipped` (fail-open) rather than erroring. `task_json` /
  `report_json` / `delivery_state` are additive nullable columns it ignores.
- `maxPerRunJudgeCalls` is generalized to a per-run **agent-deployment budget**
  (same `projects.visual_verify_budget_calls` knob; an exhausted budget →
  `skipped` with reason, fail-open).

### 5.9 Artifact payload — screenshots + report (atomic merge)

`ScreenshotsArtifactPayload` (`shared/types/artifacts.ts`) is extended:

```ts
interface TaskVerificationReportEntry {
  taskRef: string | null;
  requestId: string;             // disambiguates; part of the merge identity
  attempt: number;
  summary: string;               // the task's summary
  behaviors: Array<{ id: string; description: string; expected: string;
                     result: 'pass' | 'fail' | 'not_testable';
                     screenshots: string[]; notes: string }>;
  outcome: VerificationReportV1['outcome'];
  completedAt: string;
}
interface ScreenshotsArtifactPayload {
  fileNames?: string[];
  verdict?: VerdictV1;           // latest verdict (existing banner, unchanged)
  reports?: TaskVerificationReportEntry[];   // NEW
  captureOrigin?: CaptureOrigin; // gains 'agent' member
  diagnostics?: string[];
  [key: string]: unknown;
}
```

**Atomic merge (v1-review finding 6).** A read-then-`apply` sequence outside
the router is a lost-update race (two deliveries read the same payload; the
second write drops the first's report — and the auto-mint scan has the same
stale-read window). v2 adds an ArtifactRouter **merge operation** that reads,
validates, merges, and writes *inside* the per-project queue + DB transaction.
Verdict delivery AND the auto-mint safety-net scan route through it. Reports
are keyed by `(taskRef, requestId)` — latest attempt per lane wins for the
banner; older entries are retained (bounded, newest-N) for the report history.
The screenshots tab renderer adds a per-task "Behaviors tested" table
(behavior, result badge, evidence screenshot links) under the existing verdict
banner.

### 5.10 Baseline retirement

Accept-as-baseline + the SSIM pre-diff have zero live usage (one screenshots
artifact ever; no baseline ever stored). They retire entirely (user-locked):
the verdict-banner button is removed, the `artifacts.acceptAsBaseline` tRPC
endpoint is withdrawn, and `pixelDiff` + `baselineStore` join the legacy
modules under `@cyboflow-hidden`. `VerdictV1.baselineKey` stays type-tolerated
for legacy rows' rendering. If deterministic screenshot-compare ever matters,
it returns as a designed follow-up on the agent path — never as a write-only
button.

### 5.11 Verify-Queue panel

`VerifyQueueView` currently renders `deliverable_json.intent` and
capture-specific lifecycle copy ("Awaiting a free capture slot", "Capturing /
judging") — agent-engine rows would show blank summaries and stale states
(v1-review finding 11). v2 extends the shared row + tRPC projection + polling
equality check with: task summary (from `task_json`, falling back to
`deliverable_json.intent` for legacy rows), agent deployment state, report
outcome, and engine identity; the view renders both row formats.

### 5.12 Workflow editor — communicating Claude-only

New shared constant `CLAUDE_ONLY_AGENT_KEYS: ReadonlySet<string> =
new Set(['visual-verify'])` (`shared/types/agentRuntime.ts`), consumed in
three places:

1. **`AgentEditorForm.tsx`** — for a Claude-only agentKey the runtime row
   renders no select at all: a static "Always runs on Claude" line with the
   helper note *"Visual verification runs on Claude (vision judging +
   structured report). A Codex runtime isn't available for this agent."*
   (no "inherits run runtime" option — inheritance is provider-conditional
   per §5.4 and offering it would misstate the invariant). Codex-model
   controls never render.
2. **`WorkflowStepInspector.tsx`** (per-step `agentConfigs` editing) — same
   treatment.
3. **Server-side enforcement** at the deploy seam (§5.4) — because
   `agentConfigs` can also be written via the MCP workflow-config tools,
   bypassing the editor. UI communicates; the resolver enforces.

### 5.13 Data model / migration

One migration (number assigned at land time — check the branch-collision
landmine list first):

- `verification_requests` + `task_json TEXT NULL`, `report_json TEXT NULL`,
  `delivery_state TEXT NULL` (§5.6), `snapshot_sha TEXT NULL` (§5.5).
- No `workflow_runs` changes (existing stamps suffice).
- Both migration test fixtures + `createTestDb` follow the established
  pattern (verify columns already flow through `includeSubstrate` /
  `includeWorkflowRunTaskColumns`; do NOT re-ALTER in fixtures).

### 5.14 Known limitations (documented, not solved here)

- **The 93% funnel:** most verify-enabled runs never reach the verify step at
  all (canceled/failed runs; `__quick__` sessions never wire it in). This
  redesign fixes what happens once the step fires, not run survival.
- **native-desktop / mobile types:** out of scope; those `verify_type`s keep
  resolving to `skipped` with a reason.
- **OS-sandboxed runner:** designated hardening follow-up (§5.4).
- **Commit-side batch mutex:** still deferred; the snapshot design (§5.5)
  removes the dirty-neighbor dependency on it, but batch-wide commit
  choreography remains a future improvement.

## 6. Testing plan

- Unit (`pnpm test:unit`, the AC gate): task-fence composer/parser round-trip
  incl. the required/NOT-APPLICABLE contract and duplicate/malformed-fence
  failures; `VerificationTaskV1`/`ReportV1` schema validation incl. the
  pass-with-failed-behavior coercion; dual-write + chain-keyed dispatch (new
  rows readable by legacy readers; legacy rows by the new path); typed
  step-output capture + idempotent enqueue by `(runId, taskRef, attempt)`;
  queued-age deadline + wake-up + boot sweep; outbox replay (terminal-but-
  pending redelivery, consumer idempotency); atomic artifact merge under
  interleaved deliveries + auto-mint; finding supersession across attempts;
  Claude-namespace model resolution (Codex-run inherit → Claude default);
  posture table incl. snapshot-vs-fallback build-failure routing and the
  mutation-check demotion; editor rendering for `CLAUDE_ONLY_AGENT_KEYS`;
  Verify-Queue projection for mixed row formats.
- The runner is tested against an injected fake structured-query fn (the
  `JudgeClient`-style seam — no SDK import in the module under test); snapshot
  provisioning/teardown against a fixture repo.
- `agentParity.test.ts`: the rewritten `visual-verify.md` ships byte-identical
  sprint→ship.
- No `main/src/services/panels/claude/` changes are planned; if any land,
  `pnpm test:integration` becomes part of the gate per CLAUDE.md.
- Live smoke (manual, before merge): enable the per-run toggle → sprint with a
  real UI task → watch snapshot build → drive → screenshots + report in the
  artifact tab → FAIL loopback carries the report → PASS supersedes the
  finding.

## 7. Task breakdown (indicative sprint slicing)

1. Shared types + schemas (`VerificationTaskV1`, `VerificationReportV1`,
   payload extension, `CLAUDE_ONLY_AGENT_KEYS`) + fence parser reuse.
2. Migration + dual-format request plumbing (`task_json`/`report_json`/
   `delivery_state`/`snapshot_sha`, MCP schema field, dual-write handler).
3. Typed step-output channel (spawn seam capture → persisted step record →
   controller parse) + the task-verify contract enforcement.
4. task-verify prompt contract (sprint + ship, byte-identical) + fan-out
   instruction rewrite + `sprint.md`/`ship.md` prose (incl. loopback re-fire +
   report threading).
5. Agentless `visual-verify` step: controller/spawnStepRunner special-case +
   idempotent direct enqueue (programmatic).
6. Snapshot provisioner (worktree add/link-deps/dispose + commit-precondition
   check + dirty fallback routing).
7. Driver CLI (bundled playwright wrapper) + packaging entry.
8. `VerificationAgentRunner` (Claude-namespace resolve → provision → deploy →
   validate → mutation check → teardown/quarantine) + scheduler integration
   behind the `['agent']` chain stamp.
9. Scheduler robustness: queued-age deadline + wake-ups + boot sweep; delivery
   outbox + idempotent consumers + replay.
10. Verdict delivery: atomic artifact merge op (router + auto-mint reroute),
    report-carrying findings, posture amendments, finding supersession.
11. Frontend: editor Claude-only rendering; screenshots-tab report table;
    Verify-Queue projection + view for mixed rows; baseline button/tRPC
    removal.
12. Legacy + baseline retirement: `@cyboflow-hidden` marks,
    `CYBOFLOW_VERIFY_LEGACY` semantics (incl. boot terminalization), budget
    generalization.
13. Test hardening pass + live smoke.

## 8. Open questions

1. Driver CLI vs. granting a Playwright MCP server in the agent's `mcpServers`
   map: the CLI keeps the tool surface auditable and the MCP scope empty; an
   MCP server would give richer interaction (snapshots, waiting) at the cost of
   a bigger, harder-to-bound surface. Proposal picks the CLI.
2. Should a trivially static deliverable (bare `htmlPath`, no build, no
   behaviors beyond "renders") skip the agent and keep a cheap deterministic
   path? Proposal says no for v1 (one engine, simpler invariants) — the agent
   handles it quickly anyway.
3. Transcript persistence for the verification agent (an
   `AgentThreadEventsSink`-style durable transcript vs. report-only). Proposal:
   report + `error_message` only for v1; transcripts deferred.

## 9. Adversarial review dispositions (v1 → v2)

Codex review of v1 returned no-ship with 9 must-fix + 2 advisory findings.
Dispositions:

| # | Finding | Disposition |
|---|---|---|
| 1 | Bash falsifies the read-only isolation claim; hermetic SDK settings missing; reaper gaps | **Accepted, reframed** (user-locked): honest threat model (same tier as implement), hermetic settings, snapshot isolation, post-run mutation check, lease quarantine (§5.4); OS sandbox = follow-up (§5.14) |
| 2 | No programmatic result channel; missing fence silently bypasses re-verification | **Accepted**: typed step-output channel, required/NOT-APPLICABLE contract, idempotent enqueue by attempt, report threading into implement (§5.1, §5.3) |
| 3 | Lease starvation parks lanes forever (no queued-age deadline, no wake-up, no queued recovery) | **Accepted**: §5.6 |
| 4 | Terminal status + delivery not crash-atomic; stranded `awaiting-verify` lanes | **Accepted**: delivery outbox + idempotent consumers + boot replay (§5.6) |
| 5 | Retry-success leaves prior blocking findings pending; sprints park later anyway | **Accepted**: finding supersession by `(runId, taskRef, attempt)` (§5.7) |
| 6 | Artifact read-merge-write is a lost-update race (incl. auto-mint) | **Accepted**: atomic ArtifactRouter merge op; both writers rerouted (§5.9) |
| 7 | Fail-closed builds blame dirty neighbor lanes | **Accepted** (user-locked): lane-consistent snapshot builds; dirty fallback routes to fail-open infra (§5.5, §5.7) |
| 8 | Claude-only fallback can pass a Codex model to Claude | **Accepted**: Claude-namespace-only resolution + editor shows "Always runs on Claude" (§5.4, §5.12) |
| 9 | Migration/rollback lacks a dual-format contract | **Accepted**: dual-write, chain-keyed dispatch, kill-switch boot terminalization, old-binary posture (§5.2, §5.8) |
| 10 | Accept-as-baseline becomes write-only | **Accepted, resolved by retirement** (user-locked): feature removed entirely (§5.10) |
| 11 | Verify-Queue panel can't render new rows | **Accepted**: projection + view extension (§5.11) |
