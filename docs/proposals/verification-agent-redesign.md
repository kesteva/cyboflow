# Verification Agent Redesign — from "handed a path" to "handed a task"

Status: PROPOSAL (pre-implementation, pending adversarial review)
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
6. **Claude-scoped for now.** `runtime: 'codex-sdk'` is not supported for this
   agent. The workflow editor must *communicate* this (no Codex runtime option
   offered for the visual-verification agent), and the deploy seam must enforce
   it (an out-of-band Codex pin — e.g. written via the MCP config tools — is
   dropped with a logged warning, falling back to Claude).
7. **Screenshot artifact emission survives, plus a verification report.** The
   run's `screenshots` artifact keeps working exactly as today (harness-written
   through ArtifactRouter), and its payload is extended with a structured
   **verification report**: the behaviors tested and each behavior's result.
   MCP scoping for the verification agent is defined explicitly (see §5.4): it
   gets **no MCP servers at all** — every state write is harness-mediated.

## 3. What survives, what is replaced, what is retired

**Survives unchanged (or lightly extended):**

- `verification_requests` queue + drain loop + `ResourceLeasePool` + per-request
  deadline/abort + `runRecovery` (`verificationScheduler.ts`).
- The fire-and-continue MCP seam (`cyboflow_request_verification` — schema
  extended, §5.2).
- `verdictDelivery.ts` three-chokepoint sequence and `mergeGateLaneAdvance.ts`
  (posture table amended, §5.6).
- The `awaiting-verify` lane park + `SchedulerVisualVerifyGate` actuation in
  programmatic mode.
- Immutable per-run stamps `verify_enabled` / `verify_type` / `verify_chain`
  (chain value changes, §5.7).
- `baselineStore` + Accept-as-baseline (baselineKey still threads through).

**Replaced:**

- Capture backends (`capturePageBackend`, `playwrightBackend`,
  `peekabooBackend`), `DevServerManager`/`StaticServerManager`-driven
  deliverable resolution, `pixelDiff` SSIM pre-diff, and `vlmJudge` → one
  **VerificationAgentRunner** that deploys the workflow-defined `visual-verify`
  agent per request.
- The in-lane `visual-verify` *dispatcher subagent* → retired. The lane step
  remains (vocabulary unchanged) but becomes agentless (§5.3).

**Retired in place (`@cyboflow-hidden`, not deleted):** the replaced modules
above, consistent with repo convention, with a legacy kill-switch for rollback
(§5.7).

## 4. Architecture overview

```
task-verify (in-lane, per task)
  │  PASS + UI deliverable → composes VerificationTaskV1
  │  (behaviors from acceptance criteria; build/serve from repo docs/verify.json hint)
  ▼
visual-verify lane step (agentless)
  │  programmatic: WorkflowController enqueues directly on the scheduler
  │  orchestrated: orchestrator calls cyboflow_request_verification(task=...)
  │  then parks the lane at awaiting-verify (unchanged)
  ▼
VerificationScheduler (queue/lease spine, unchanged)
  │  resolves EffectiveAgent for 'visual-verify' via resolveStepAgent(runId, key)
  │  provisions environment: leased port, artifacts dir, env vars
  ▼
VerificationAgentRunner (new)
  │  deploys ONE Claude SDK session: cwd = run worktree,
  │  system prompt = workflow-defined instructions + immutable harness contract,
  │  tools = Bash/Read/Grep/Glob (hard ceiling; no Write/Edit; no MCP)
  │  agent: builds, serves on $VERIFY_PORT, drives UI via bundled driver CLI,
  │  screenshots into $VERIFY_ARTIFACTS_DIR, returns VerificationReportV1
  │  harness: validates report + files, kills process tree, releases leases
  ▼
verdictDelivery (unchanged seams, extended payload)
  ├─ ArtifactRouter: screenshots artifact { fileNames, reports[], verdict }
  ├─ applyMergeGateVerdict: PASS advance / FAIL loopback / infra fail-open
  └─ ReviewItemRouter: finding carries the report + real error text
```

Ownership split: **the workflow defines who verifies** (instructions, model,
effort — editable, overridable, A/B-testable); **the central queue defines
where and how they run** (worktree, environment, leases, tool sandbox,
timeouts, verdict delivery).

## 5. Detailed design

### 5.1 `VerificationTaskV1` — the composed task

New shared type (`shared/types/visualVerification.ts`):

```ts
interface VerificationTaskV1 {
  version: 1;
  taskRef?: string;            // lane attribution (unchanged semantics)
  summary: string;             // replaces the old one-sentence `intent`
  build?: string[];            // shell steps, run in the worktree, in order
  serve?: {                    // optional long-running serve step
    cmd: string;               // may reference ${PORT}
    readyWhen?: { urlPath?: string; timeoutMs?: number };
  };
  target?: { url?: string; htmlPath?: string };  // pre-live target (legacy path)
  behaviors: Array<{           // the verification steps — the core payload
    id: string;                // stable within the task, e.g. "b1"
    description: string;       // what behavior, in user terms
    steps?: string[];          // how to exercise it (navigate/click/type/…)
    expected: string;          // what must be observed for PASS
  }>;
  viewports?: ViewportSpec[];
  baselineKey?: string;
  timeoutMs?: number;          // capped by scheduler config
}
```

Composition: **task-verify** gains a result-contract section. On `VERDICT: PASS`
for a task with a user-visible UI deliverable, it appends:

````markdown
## Visual verification task
```json
{ ...VerificationTaskV1 }
```
````

parsed with the existing shared CommonMark-paired fence grammar (same parser
family as arch-section parsing). Build/serve commands come from what task-verify
can actually see: the project's own docs (README/CLAUDE.md), `package.json`
scripts, an existing `.cyboflow/verify.json` (now a *hint*, no longer a
prerequisite), and the diff itself. Behaviors derive from the task's acceptance
criteria — task-verify already holds them and has just evaluated them, so it is
the best-placed author. Backend-only tasks simply omit the section (visual
verification is skipped for that lane exactly as today's `VERDICT: SKIPPED`).

Grading-your-own-homework note: task-verify *authors the steps* but does not
*execute or judge* them — the verification agent independently drives and
judges, and the human-facing report lists the behaviors verbatim, so
easy-grader drift is visible in review.

### 5.2 MCP + request plumbing

`cyboflow_request_verification` gains one optional field: `task` (a
`VerificationTaskV1` object; JSON-schema-validated). `intent` remains accepted
for backward compatibility (a task-less request behaves as a degenerate task
with `summary=intent` and no build/behaviors). `mcpQueryHandler.
handleRequestVerification` persists it to a new nullable
`verification_requests.task_json` column. `deliverable_json` stays for legacy
rows.

### 5.3 Lane flow — who fires the request

The in-lane `visual-verify` dispatcher subagent is retired. The `visual-verify`
inner step stays in the canonical chain (lane vocabulary, gate parking, and
`awaiting-verify` semantics unchanged) but becomes **agentless**, mirroring the
existing `human` gate precedent (`resolveStepAgentKey` returns null → the
runner special-cases it):

- **Programmatic mode:** after task-verify PASS, `WorkflowController.driveItem`
  parses the `## Visual verification task` fence from the task-verify result.
  If present, it enqueues **directly on the scheduler** (main-process call — no
  MCP hop) and parks the lane at `awaiting-verify`. If absent → advance (no UI
  deliverable), identical to today's SKIPPED handling.
- **Orchestrated mode:** `fan-out-instructions.ts` and `sprint.md`/`ship.md`
  prose change: the orchestrator itself calls
  `cyboflow_request_verification(task=<the fence content>, task_ref=...)` and
  parks the lane. No subagent delegation for this step.

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
   (systemPrompt/model/effort). **Claude-only enforcement:** if the effective
   agent carries `runtime: 'codex-sdk'`, the runtime pin is dropped with a
   logged warning (and a Sentry seam breadcrumb) and the agent runs on the
   resolved Claude model. Model alias `null` inherits the run model as usual.
2. **Provisions the environment:** acquires `verify:port` (when
   `task.build/serve/target.url` implies one) + the `sprint-verify-<batchId>`
   batch lease (serialization vs sibling lanes, unchanged) + a new
   `verify:agent` count-1 lease bounding concurrent agent deployments; exports
   `VERIFY_PORT`, `VERIFY_ARTIFACTS_DIR` (the run's artifacts dir),
   `VERIFY_DRIVER` (path to the bundled driver CLI, below).
3. **Deploys the agent:** `query()` with `cwd` = the run's worktree
   (server-resolved from `workflow_runs.worktree_path` — the agent is never
   trusted to name it), `customSystemPrompt` = the workflow-defined
   instructions **plus an immutable harness-appended contract** (environment
   variables, output schema, prohibitions — config can shape the persona and
   judgment style, never the sandbox), `allowedTools: ['Bash', 'Read', 'Grep',
   'Glob']` — a **hard ceiling the config cannot widen**: no Write/Edit (the
   agent must not modify the worktree it judges), and **no MCP servers of any
   kind** (`mcpServers: {}`). That is the well-defined MCP scope: *empty*. The
   agent's outputs are files (PNGs into `VERIFY_ARTIFACTS_DIR`) plus its
   structured report; every cyboflow-state write (artifact, finding, lane) is
   harness-mediated through the existing chokepoints, preserving the "verify
   agents never write cyboflow state" invariant.
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

6. **Cleans up deterministically:** the harness kills the SDK subprocess's
   entire process tree after the report (or on abort/deadline) — the backstop
   for any serve process the agent leaked — then probes the leased port is
   free before releasing it. Deadline default rises to **10 minutes** (builds
   are real work; the old 5-minute default stays the floor, `task.timeoutMs`
   capped by config), still under the scheduler's existing per-request
   abort/`raceWithAbort` machinery.

Report validation is harness-side and strict: every `screenshots.fileName`
must exist in `VERIFY_ARTIFACTS_DIR` (basename-only, same safety rules as
`cyboflow_report_artifact`), behavior ids must match the task, and an
`outcome: 'pass'` with any `behaviors[].result === 'fail'` is coerced to
`fail` (the structured verdict, not prose, drives the gate).

### 5.5 Artifact payload — screenshots + report

`ScreenshotsArtifactPayload` (`shared/types/artifacts.ts`) is extended:

```ts
interface TaskVerificationReportEntry {
  taskRef: string | null;
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
  reports?: TaskVerificationReportEntry[];   // NEW: merged by taskRef
  captureOrigin?: CaptureOrigin; // gains 'agent' member
  diagnostics?: string[];
  [key: string]: unknown;
}
```

Delivery changes from replace-wholesale to **read-merge-write**: the enrich
step reads the current payload, unions `fileNames`, and upserts the report
entry by `taskRef` (last write wins per task). This also fixes the existing
multi-lane wart where each lane's verdict clobbered the previous payload. The
known auto-mint re-mint hazard (the safety-net scan historically rewrote
`{fileNames}`-only payloads) must preserve `reports` the same way it now
preserves `verdict`. The screenshots tab renderer adds a per-task "Behaviors
tested" table (behavior, result badge, evidence screenshot links) under the
existing verdict banner.

### 5.6 Fail posture (amended)

| Outcome | Request status | Merge gate | Finding |
|---|---|---|---|
| All behaviors pass | `passed` | advance → integrated | none |
| Any behavior fails | `failed` (verdict) | **fail closed**: loopback ≤3× → failed | blocking; body = report (behaviors failed + evidence + feedback) |
| `build_failed` / `launch_failed` | `failed` (verdict-less, `error_message` = buildLogExcerpt) | **fail closed** (locked decision: a deliverable that cannot build/launch is a smoke FAIL — and is frequently code-caused, so loopback is actionable) | blocking; body **includes the build/launch log excerpt** (fixes the non-actionable-feedback defect) |
| Agent spawn/SDK/API error, lease starvation, budget exhausted | `skipped` | fail open: advance | non-blocking, with the concrete reason |
| Deadline exceeded / orphaned by restart | `timeout` | fail open: advance | non-blocking |
| Behaviors `not_testable` (but none failed) | `low_confidence` | advisory pass-through | non-blocking "needs human visual review", listing untested behaviors |

The FAIL finding body change closes the loop the investigation flagged: the
re-delegated implement agent finally receives *what was tested, what failed,
and why*, not "investigate the capture/judge step".

### 5.7 Engine stamp, rollback, retirement

- `resolveVisualVerification` stamps `verify_chain: ['agent']` for new runs
  (the stamp is already immutable per run, so in-flight legacy runs keep their
  old chain and are drained by the legacy path until gone).
- Kill switch: `CYBOFLOW_VERIFY_LEGACY=1` makes the resolver stamp the old
  chain — cheap insurance since the legacy modules are retired in place with
  `@cyboflow-hidden`, not deleted.
- `maxPerRunJudgeCalls` is generalized to a per-run **agent-deployment budget**
  (same `projects.visual_verify_budget_calls` knob; an exhausted budget →
  `skipped` with reason, fail-open).

### 5.8 Workflow editor — communicating Claude-only

New shared constant `CLAUDE_ONLY_AGENT_KEYS: ReadonlySet<string> =
new Set(['visual-verify'])` (`shared/types/agentRuntime.ts`), consumed in
three places:

1. **`AgentEditorForm.tsx`** — for a Claude-only agentKey the runtime select
   renders only "inherits run runtime" and the Claude runtime option (no
   `codex-sdk` entry), with a helper note: *"Visual verification runs on Claude
   (vision judging + structured report). A Codex runtime isn't available for
   this agent."* Codex-model controls never render.
2. **`WorkflowStepInspector.tsx`** (per-step `agentConfigs` editing) — same
   filtering + note.
3. **Server-side enforcement** at the deploy seam (§5.4) — because
   `agentConfigs` can also be written via the MCP workflow-config tools,
   bypassing the editor. UI communicates; the resolver enforces.

### 5.9 Data model / migration

One migration (number assigned at land time — check the branch-collision
landmine list first):

- `verification_requests` + `task_json TEXT NULL`, `report_json TEXT NULL`.
- No `workflow_runs` changes (existing stamps suffice).
- Both migration test fixtures + `createTestDb` follow the established
  pattern (verify columns already flow through `includeSubstrate` /
  `includeWorkflowRunTaskColumns`; do NOT re-ALTER in fixtures).

### 5.10 Known limitations (documented, not solved here)

- **Shared-worktree dirty neighbors:** a sprint builds one shared worktree, so
  a mid-sprint build can compile other lanes' half-finished edits. The
  `sprint-verify-<batchId>` lease still serializes verifications; the deferred
  commit-side batch mutex (route lane commits through an orchestrator
  chokepoint) becomes *more* valuable once verification actually builds, and
  stays deferred.
- **The 93% funnel:** most verify-enabled runs never reach the verify step at
  all (canceled/failed runs; `__quick__` sessions never wire it in). This
  redesign fixes what happens once the step fires, not run survival.
- **native-desktop / mobile types:** out of scope; those `verify_type`s keep
  resolving to `skipped` with a reason.

## 6. Testing plan

- Unit (`pnpm test:unit`, the AC gate): task-fence composer/parser round-trip;
  `VerificationTaskV1`/`ReportV1` schema validation incl. the
  pass-with-failed-behavior coercion; report→payload merge by `taskRef` (incl.
  the auto-mint preservation case); Claude-only runtime drop in the resolver;
  posture table in `mergeGateLaneAdvance`/`verdictDelivery` (build_failed
  blocking, skipped/timeout non-blocking); editor option filtering
  (`AgentEditorForm` + `WorkflowStepInspector` component tests); agentless
  `visual-verify` step special-case in `spawnStepRunner`/controller walk.
- The runner is tested against an injected fake structured-query fn (the
  `JudgeClient`-style seam — no SDK import in the module under test).
- `agentParity.test.ts`: the rewritten `visual-verify.md` ships byte-identical
  sprint→ship.
- No `main/src/services/panels/claude/` changes are planned; if any land,
  `pnpm test:integration` becomes part of the gate per CLAUDE.md.
- Live smoke (manual, before merge): enable the per-run toggle → sprint with a
  real UI task → watch build → drive → screenshots + report in the artifact tab
  → FAIL loopback carries the report.

## 7. Task breakdown (indicative sprint slicing)

1. Shared types + schemas (`VerificationTaskV1`, `VerificationReportV1`,
   payload extension, `CLAUDE_ONLY_AGENT_KEYS`) + fence parser reuse.
2. Migration + request plumbing (`task_json`/`report_json`, MCP schema field,
   handler threading).
3. task-verify prompt contract (sprint + ship, byte-identical) + fan-out
   instruction rewrite + `sprint.md`/`ship.md` prose.
4. Agentless `visual-verify` step: controller/spawnStepRunner special-case +
   direct enqueue (programmatic); orchestrated prose already in (3).
5. Driver CLI (bundled playwright wrapper) + packaging entry.
6. `VerificationAgentRunner` (resolve → provision → deploy → validate →
   teardown) + scheduler integration behind the `['agent']` chain stamp.
7. Verdict delivery: read-merge-write payload, report-carrying findings,
   posture amendments.
8. Frontend: editor Claude-only filtering + notes; screenshots tab report
   rendering.
9. Legacy retirement: `@cyboflow-hidden` marks, `CYBOFLOW_VERIFY_LEGACY`
   resolver path, budget generalization.
10. Test hardening pass + live smoke.

## 8. Open questions (for adversarial review)

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
4. Whether `build_failed` fail-closed needs a per-project escape hatch
   (`verify.json: failOpenOnBuildError`) for projects with flaky builds.
   Proposal: no escape hatch in v1; the non-blocking-finding path already
   exists for infra classes.
