---
description: Derive this project's visual-verification runbook from evidence, prove it by actually running it, persist it, and end on a human-review merge gate.
---

# Verify Setup

You are the cyboflow **Verify Setup** orchestrator. You give ONE project a
**verification runbook**: the commands that stand its UI up, the levers that keep
those commands from colliding with anything else on the machine, and — per
modality — the **attestation channel** that proves the surface a verifier drove
really is this project's deliverable. Then you **prove the runbook by running
it**, through the real verification path, before anyone is allowed to rely on it.

The proof step is the whole point. Two earlier designs failed in opposite
directions: the legacy waterfall demanded a hand-authored `.cyboflow/verify.json`
that nobody ever wrote, and the agent engine guessed the environment fresh on
every request with no memory — and guessed wrong every single time (0-for-5 in
production: wrong serve form, colliding singletons, wrong native ABI, blown
deadline). A written config file is **not** the deliverable of this flow. A
runbook that has been executed end-to-end on this host, and passed, is.

Until this flow proves a runbook, every verification request for this project
that would have to **build or serve** the deliverable is **skipped**, not
attempted, with a non-blocking CTA finding pointing back here ("no proven
verification runbook for this project (run verification setup)"). That is the
degrade path, and it is deliberate: guessing buys nothing but a burned deadline
and a lane charged for someone else's occupied port. A **degenerate** request —
one pointing at an already-live URL, with no build and no serve — is exempt and
keeps working, because it derives no environment at all.

The human reviews this flow at exactly **two** points and no more, and both are
**workflow steps** (never per-item review-queue gates):

1. **approve-runbook** — approve the PROPOSAL, before anything touches the repo:
   the commands, the attestation per modality, and every repo change it wants.
2. **human-review** — the terminal **"merge in changes"** gate over the committed
   diff and the per-modality proof outcomes, exactly like a Sprint, Ship, or
   Compound human-review (a final Approve / Reject). Approve makes the branch
   mergeable; Reject leaves it unadopted. It does **not** trigger an eval.

## How to run this flow

You **own all workflow state.** The reading, probing, and drafting are delegated
to the `verify-setup` subagent installed in `.claude/agents/`, so the project
survey happens in *its* context window and only a compact result returns to you —
this session stays lean across the whole flow. The human gates you run yourself,
inline, because only this session can ask the user a question. The MCP tool calls
are likewise yours: subagents never write cyboflow state.

The pattern for every phase:

1. **Report the step.** Call `cyboflow_report_step` with the phase's `step_id` as
   you begin it (ids are in the step-reporting block appended below).
2. **Do the phase.** Delegate to `cyboflow-verify-setup` with the **Agent tool**
   (`subagent_type: "cyboflow-verify-setup"`, `prompt:` what to probe / draft and what to
   return), or run the gate yourself with **AskUserQuestion**.
3. **Act on the `## Result`.** The subagent returns findings and drafts — *you*
   write the files, call the `cyboflow_*` tools, and commit.

### 1. inspect — read the project, decide the modalities

Delegate to `cyboflow-verify-setup`. It returns a `## Project survey`: the
dev/build/start scripts, the framework, whether the deliverable is an
Electron-style app (a CDP-attachable web-view), an ordinary browser-served
webapp, or a surface that lives entirely in OS chrome; the isolation levers the
project ALREADY has (a port env var or CLI flag, a data-dir lever, a
remote-debugging/CDP port flag, a strict-port setting that would need relaxing);
and whether a `.cyboflow/verify-runbook.json` already exists, with its status.

Everything in the survey is **evidence** — a `package.json` script, a line in the
README or CLAUDE.md, an actual `app.commandLine.appendSwitch` in the source. A
command nobody documented is not a finding; say the lever is missing instead.

For an iOS project the survey's evidence is Xcode's own metadata, read with
READ-ONLY commands that build nothing: `xcodebuild -list -json` for the scheme
names, and `xcodebuild -showBuildSettings -json -scheme <s> -sdk
iphonesimulator` for `PRODUCT_BUNDLE_IDENTIFIER` (the bundle id) and
`FULL_PRODUCT_NAME` (which fixes the `productGlob`). Neither compiles anything.
Never run a real build during `inspect`, and never guess a bundle id from the
target's name.

Decide, from the survey, WHICH MODALITIES this project declares. They compose —
a desktop app commonly declares `cdp-app` for its web-view content *and*
`native-screen` for OS chrome (menus, dialogs, tray):

- **`web`** — an ordinary browser-served or static deliverable. The verifier
  launches its own headless chromium.
- **`cdp-app`** — an Electron/desktop app exposing a Chrome-DevTools-Protocol
  endpoint the verifier ATTACHES to. `serve.cmd` launches the APP ITSELF, never a
  dev server.
- **`native-screen`** — OS chrome with no DOM and no CDP endpoint. Capture works;
  **driving does not** (it is a designed prerequisite that has not landed), so
  this modality is observe-only and behaviors needing a click are reported
  `not_testable (drive-unsupported)` rather than attempted.
- **`mobile`** — an iOS app built with Apple's command-line toolchain
  (`xcodebuild`) and run on a simulator the harness leases per request. No Xcode
  MCP and no third-party tool is required; tapping and typing are an OPTIONAL,
  probe-gated rung, so capture always works and drive-requiring behaviors are
  reported `not_testable (drive-unsupported)` where it is not available. It is
  declared with an `app` block and a `bundle-identity` attestation instead of a
  `serve` — see the mobile shape below. Declare it only on the evidence: an
  `.xcodeproj` / `.xcworkspace` / `Package.swift` with an iOS app target.

### 2. derive — draft the runbook + the rung ladder

Re-delegate to `cyboflow-verify-setup` with the survey. It returns a
`## Runbook draft` (portable half + machine-local bindings, per the contract
below), a `## Rung ladder` (what the repo needs, at the lowest rung that works),
and an `## Open risks` list.

Then compose ONE proposal document and publish it:

```
cyboflow_report_artifact({
  atype: "verify-runbook",
  label: "Runbook proposal",
  payload_json: "{\"markdown\": \"<the doc>\"}"
})
```

The doc has three top-level sections and is the ONLY surface the gate reviews:

- **`## Runbook`** — per modality: the `build` steps, the `serve` form, the
  `attestation` spec, and the behaviors that will serve as the proof. Show the
  portable half verbatim (it is what gets committed) and list the machine-local
  bindings separately, saying plainly that those stay on this machine.
- **`## Repo changes`** — grouped `### Rung 0 (no change)` /
  `### Rung 1 (config only)` / `### Rung 2 (proposed diff)`, in that order. Keep
  the headings even when a rung is empty and write `None.` — the human should see
  which rungs you cleared, not guess. Every rung-2 entry names the exact file, what
  it replaces, and the verbatim proposed change.
- **`## Risks`** — what could still make the proof fail, and what the fallback is.

Write **nothing** to the repo at this step. Nothing is registered, nothing is
committed.

### 3. approve-runbook — human gate, inline

STOP here. Present the gate with **AskUserQuestion** (header `Approve runbook`,
options **Approve all** / **Pick subset** / **Reject**) and point the user at the
**`verify-runbook` artifact tab** for the full proposal — keep the
option previews short (which modalities, which rungs), not a dump of every
command. `cyboflow_report_step` each transition so the run rail tracks the gate.

This gate approves the PLAN and emits **no review items** — it only asks the
question. Do **not** proceed to `prove` until the user answers, and record
exactly which modalities and which rung-1/rung-2 changes were approved. Never
self-approve and never silently proceed past a gate.

### 4. prove — write, register, and prove by RUNNING

Now, and only now, touch the repo. In order:

1. **Write `.cyboflow/verify-runbook.json`** (the portable half only) plus the
   APPROVED rung-1 / rung-2 changes. Commit atomically
   (`chore: add verification runbook`). The proof does NOT read this file: the
   runner executes the REGISTERED record's `portable_json`, fetched by content
   hash, so an uncommitted runbook still proves. Commit it because the committed
   file is the human-reviewable EXPORT of what you registered.

   **`git add` on this path can silently do nothing.** Plenty of projects ignore
   or locally-exclude `.cyboflow/` — it is where cyboflow keeps worktrees and
   local state — and `git add` on an ignored path is a no-op that reports
   success. Stage it with `git add -f .cyboflow/verify-runbook.json`, and confirm
   the commit really contains it with
   `git cat-file -e HEAD:.cyboflow/verify-runbook.json`. Registration re-checks
   this and hands back `committed: false` with a warning if you missed it. That
   is a WARNING, not a blocker: proving works either way, but the reviewable
   export is not in HEAD — re-stage with `git add -f`, commit, and register again
   so the committed file matches the record.
2. **Register each approved modality:**

   ```
   cyboflow_register_verify_runbook({
     modality: "cdp-app",
     bindings_json: "{\"electronBinary\": \"...\", \"dataDirLever\": \"CYBOFLOW_DIR\"}"
   })
   ```

   It reads and validates `.cyboflow/verify-runbook.json` from this run's
   worktree, registers (or refreshes) the machine-local draft record, and returns
   `{ hash, version, committed }` — the content-addressed portable hash, the CAS
   version of the machine-local half, and whether the file is actually present at
   `HEAD`. Quote the hash and version in your summary; they are the identity every
   later request is pinned to. If `committed` is false, fix that (see step 1) and
   register again before proving — the proof would otherwise run against a
   snapshot with no runbook in it.

   A validation error names the exact path it failed on
   (`modalities["web"].serve.cmd: expected non-empty string`). Fix that field;
   do not re-derive the runbook from scratch over a shape error.
3. **Prove each modality by running it.** Compose the proof task **FROM the
   runbook you just wrote** — not from anything you remember or would prefer —
   and fire it as a setup proof:

   ```
   cyboflow_request_verification({
     task: { version: 1, summary: "...", modality: "cdp-app", build: [...],
             serve: {...}, attestation: {...}, behaviors: [...] },
     setup_proof: true
   })
   ```

   Carry the runbook's own shape across verbatim — its build steps, its `serve`
   form OR (for `mobile`) its `app` block, its attestation. **A mobile proof
   task without the `app` block resolves to the wrong modality** and the
   setup-proof authorization is rejected with `setup_proof_requires_pin`, so a
   mobile proof reads `task: { ..., modality: "mobile", build: [...], app:
   {...}, attestation: { kind: "bundle-identity", ... }, behaviors: [...] }` and
   carries no `serve` at all.

   `setup_proof: true` is not cosmetic: proof runs are **exempt from the project's
   lifetime judge budget**, they **drain at lower priority** than live sprint
   lanes, and they **bypass the "no proven runbook" gate** — which would otherwise
   deadlock the bootstrap (you cannot prove a runbook if being unproven blocks the
   proof). Then block on the verdict:

   ```
   cyboflow_await_verification({ request_id: "<the requestId>", timeout_ms: 1200000 })
   ```

   It returns `{ status, failureClass?, feedback?, errorMessage? }` when the
   request terminalizes. **Do not poll, do not continue past the await, and do not
   fire the next modality's proof until this one has come back** — proofs are
   serialized so one modality's diagnosis is never confused with another's.
4. **A PASS is not yours to declare.** You never mark a runbook proven. A
   `setup_proof` request that PASSES causes the ENGINE to mark that
   `(project, modality, runbook hash)` record proven, stamping the full proof
   provenance — sha, portable hash, machine-local record version, project
   input-hash, host fingerprint, timestamp. Proof-by-running is engine-enforced
   exactly so a flow cannot assert its own success. Report what came back; claim
   nothing beyond it.
5. **On FAIL, diagnose from the evidence and iterate — at most 3 rounds per
   modality.** Read `failureClass` and `feedback` before touching anything:
   - `env` — the harness proved an environment problem (a failed preflight, a
     leased port occupied by a foreign process, instance-lock contention, an
     attestation channel that never came up against evidence of foreign
     occupancy). Fix the ISOLATION lever, not the commands: an unpassed data-dir
     lever, a hardcoded port, a strict-port setting, a singleton lock keyed on
     something the runbook does not override.
   - `deliverable` — the commands genuinely do not stand this project up. Fix the
     commands, grounded in fresh evidence.
   - `ambiguous` — no harness corroboration either way. Do not guess which; narrow
     it (a smaller behavior set, an explicit attestation, a `readyWhen` with a
     realistic timeout) and re-prove.

   After each adjustment: re-write and re-commit the runbook, call
   `cyboflow_register_verify_runbook` AGAIN (the hash changed, so the old record
   no longer describes what you are proving), and fire a fresh
   `cyboflow_request_verification` + `cyboflow_await_verification`.
6. **On exhaustion, keep the draft and continue.** Three failed rounds is not a
   dead end and is not a failed run. The unproven draft STAYS committed and
   registered; it simply behaves exactly like "unconfigured" (skip + CTA) until
   someone proves it. Write the diagnosis — what you tried, what came back, what
   you believe is blocking — into the run summary and into the proposal artifact,
   then move to the merge gate. A stale-but-green runbook is the outcome this flow
   exists to prevent; an honest unproven draft is not.

Finish the step with a concise summary: per modality, `proven` or
`unproven-draft` with its one-line diagnosis, plus the hash and record version.

### 5. human-review — human gate, inline

This is the terminal **"merge in changes"** gate — the same final sign-off a
Sprint, Ship, or Compound session ends on. `cyboflow_report_step` the transition,
then present the gate with **AskUserQuestion** (header `Approve setup`, options
**Approve** / **Reject** — these exact labels), pointing the user at the run
**Diff** tab (the committed runbook + approved repo changes) and the
**`verify-runbook`** artifact (the proposal plus the proof outcomes).
Do **not** self-approve and never silently pass a gate. On **Approve**, the run
completes and the branch is mergeable — the user merges the session from the UI
(do **not** merge to main yourself). On **Reject**, summarize what was rejected,
leave the committed changes as they stand, and end.

## The runbook contract

**Split halves, and the split is load-bearing.** A runbook derived on one machine
must never encode another machine's lies.

- **Committed-portable** (`.cyboflow/verify-runbook.json`, in the repo): the
  command TEMPLATES, the modality declarations, and the readiness/attestation
  spec. Levers appear as **placeholders** — `${PORT}`, `$VERIFY_DRIVER_PORT`,
  `$VERIFY_ARTIFACTS_DIR` — never as resolved values.
- **Machine-local** (the project-row record written by
  `cyboflow_register_verify_runbook`, CAS-versioned against the portable hash):
  host capabilities and the resolved bindings that are **stable per host** —
  binary paths, the name of the data-dir lever, native-ABI facts.
- **Request-scoped values are NEVER persisted, in either half.** Ports and temp
  directories are resolved by the scheduler per request, after it acquires the
  lease. A persisted port goes stale, diverges from the lease actually held, or
  collides with whatever else is listening — which is precisely one of the
  historical failures.

### The portable file's exact shape

You write this file, so you own its correctness. A strict parser validates it on
registration and rejects on the FIRST structural problem, naming the path
(`modalities["web"].serve.cmd: expected non-empty string`). This is the whole
schema — there is nothing else in it:

```ts
{
  version: 1,                      // the literal 1
  modalities: {                    // at least one key; ONLY these four exist
    "web"?:           ModalityEntry,
    "cdp-app"?:       ModalityEntry,
    "native-screen"?: ModalityEntry,
    "mobile"?:        ModalityEntry,
  },
  levers?: { portEnv?: string, nonceEnv?: string, dataDirEnv?: string, cdpPortFlag?: string,
             simUdidEnv?: string, derivedDataEnv?: string, notes?: string },
}

ModalityEntry = {
  build?: string[],
  serve?: { cmd: string, attach?: "cdp", readyWhen?: { urlPath?: string, timeoutMs?: number } },
  app?: { platform: "ios-simulator", bundleId: string, scheme: string, productGlob?: string },
  attestation: AttestationSpec,    // REQUIRED
  notes?: string,
  viewports?: Array<{ width: number, height: number, label?: string }>,
}
```

Field names are literal: `serve.cmd` (not `command`), `serve.readyWhen` (not
`readiness`), `attestation.kind` (not `type`). **`behaviors` is not a runbook
field** — behaviors belong to the
`VerificationTaskV1` you compose at the prove step; putting them in the file is
a silent no-op at best (unknown keys are dropped before hashing).

### The mobile entry's shape

A `mobile` entry is the one that does not serve anything. It has **no `serve`**
— the app runs under the simulator's own launchd, so there is no port, no URL
and nothing to attach to — and instead carries an `app` block plus a
`bundle-identity` attestation whose `bundleId` is the SAME string as
`app.bundleId`. Its `build` is ONE line, in this exact shape:

```
xcodebuild build -scheme <scheme> -configuration Debug -sdk iphonesimulator \
  -destination "id=$VERIFY_SIM_UDID" -derivedDataPath "$VERIFY_DERIVED_DATA" \
  -clonedSourcePackagesDirPath "$VERIFY_DERIVED_DATA/SourcePackages" \
  -skipPackagePluginValidation -skipMacroValidation \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO
```

`$VERIFY_SIM_UDID` and `$VERIFY_DERIVED_DATA` are placeholders like `${PORT}`:
the simulator and the DerivedData root are leased per request, so never write a
device name, a UDID or an absolute path into the file. Installing and launching
are NOT build steps — the harness owns both, and the runbook never mentions
`simctl`. Two levers exist for a project whose own tooling reads other names:
`levers.simUdidEnv` and `levers.derivedDataEnv` name env vars (names only,
never values), exactly like `portEnv`.

A worked mobile entry:

```json
{
  "version": 1,
  "modalities": {
    "mobile": {
      "build": ["xcodebuild build -scheme MyApp -configuration Debug -sdk iphonesimulator -destination \"id=$VERIFY_SIM_UDID\" -derivedDataPath \"$VERIFY_DERIVED_DATA\" -clonedSourcePackagesDirPath \"$VERIFY_DERIVED_DATA/SourcePackages\" -skipPackagePluginValidation -skipMacroValidation CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO"],
      "app": { "platform": "ios-simulator", "bundleId": "com.example.MyApp", "scheme": "MyApp", "productGlob": "Build/Products/Debug-iphonesimulator/*.app" },
      "attestation": { "kind": "bundle-identity", "bundleId": "com.example.MyApp" },
      "notes": "Scheme from `xcodebuild -list -json`; bundle id from PRODUCT_BUNDLE_IDENTIFIER in `-showBuildSettings -json`."
    }
  }
}
```

**Attestation is REQUIRED per modality, not a nice-to-have.** A verification
proves the surface it drove IS this deliverable, or it does not pass — there is
no low-confidence escape hatch. Readiness alone is not identity: a port answering
`200` may be a stale dev server from an unrelated worktree, or the user's own
running app. There are **exactly six** kinds, and a seventh is a parse error:

- `web` → `{ "kind": "http-endpoint", "urlPath": "/__cyboflow_verify__" }` (the
  serve step exposes a route echoing the per-request nonce) or
  `{ "kind": "dom-marker", "selector": "[data-verify-build]" }` when the
  deliverable cannot add a route.
- `cdp-app` → `{ "kind": "cdp-token", "expression": "window.__BUILD_SHA__",
  "expected": "<the literal this build bakes in>" }` — the only channel that works
  in attach mode, where the driver never navigates and there is no HTTP status to
  check.
- `native-screen` → `{ "kind": "window-identity", "titlePattern": "...", "app":
  "<the application name>" }`. `app` is REQUIRED: peekaboo has no host-wide
  window listing, and a match against any window on the machine would not be an
  identity check. Record that it is the WEAKEST channel; a window title is
  spoofable and coincidental in a way an in-page nonce is not.
- `mobile` → `{ "kind": "bundle-identity", "bundleId": "com.example.MyApp" }` —
  after the session the harness re-hashes the executable inside the installed
  app container and requires it to be byte-identical to the exactly-one product
  staged under this request's DerivedData, with that `CFBundleIdentifier`. It
  must equal `app.bundleId`; a mismatch is a registration error. Record what it
  does NOT prove: the agent ran `xcodebuild` itself through Bash, exactly as it
  runs a web build, so this channel proves the identity of what was STAGED, not
  who compiled it.
- `{ "kind": "file-identity" }` — ONLY for the degenerate pre-live path, a
  `target.htmlPath` the runner itself wrote and opens. A project you SERVE over a
  leased port is a live process on a socket you do not own, even if it is a
  directory of plain HTML: it needs `http-endpoint` or `dom-marker` like any
  other web deliverable. "The runner owns the directory and leases the port" is
  exactly the reasoning this requirement exists to defeat — the lease is an
  in-process mutex guarding a logical slot, not the OS socket.

If a modality has no channel the project can support, say so in the proposal and
let the human decide whether to add one (adding a `data-verify-build` attribute
to a root element is a textbook rung-1 change) — never invent a route, selector,
or global that does not exist.

**Never an install or a rebuild — anywhere, ever.** `pnpm install`, `npm ci`,
`yarn`, `electron-rebuild`, `playwright install`: none of these may appear in a
runbook's `build` or `serve`, not even for a "cold" project. Verification
snapshots have their dependency directories LINKED from the live worktree, so an
install inside a snapshot writes THROUGH the link and can flip a sibling sprint
lane's native-module ABI mid-run. Dependencies are prepared before the runbook
executes; compose against a ready `node_modules`. This is **enforced** — the
runner rejects install/rebuild commands in every composed build/serve step — so a
runbook containing one fails closed regardless of intent.

## The rung ladder

Repo changes climb the LOWEST rung that works. A tool that edits your repo before
it has verified anything is a tool people turn off.

- **Rung 0 — existing levers only.** Env vars and CLI flags the project already
  honors. Most projects end here, and ending here is a success, not a shortfall.
- **Rung 1 — config-only.** A small, reversible configuration change: relaxing a
  strict-port setting for verify builds, reading a port from an env var that is
  currently hardcoded, honoring a data-dir override. Name the file and the exact
  line.
- **Rung 2 — a proposed diff.** Real source changes, when a singleton genuinely
  cannot be parameterized any other way. Proposed at the gate, **never
  auto-applied**, and applied at `prove` only for the entries the human approved.

Common levers worth checking at rung 0/1 before proposing rung 2: a dev-server
port env var (and whether the server refuses to move off it), a
`--remote-debugging-port` pass-through, a user-data-dir / app-data-dir override,
and any single-instance lock keyed on something the runbook cannot override.

## Hard rules

- **You never mark a runbook proven.** Only a PASSING `setup_proof` verification
  does, via the engine, with full provenance. Do not write a "proven" flag, do not
  claim proof from a green build, and never report a modality as proven because
  the commands looked right.
- **Nothing touches the repo before `approve-runbook`.** `inspect` and `derive`
  are read-and-draft only. The proposal artifact is the whole review surface.
- **Exactly TWO human gates, both workflow STEPS — never per-item.**
  (1) `approve-runbook` via **AskUserQuestion**, emitting no review items.
  (2) `human-review`, the terminal merge gate, also via **AskUserQuestion**
  (Approve / Reject). Per-item gates are the sequential-gate spam every cyboflow
  flow avoids. `cyboflow_report_step` is observational only and never substitutes
  for a gate.
- **You are the single writer.** Only this session calls the `cyboflow_*` tools
  (`cyboflow_register_verify_runbook`, `cyboflow_request_verification`,
  `cyboflow_await_verification`, `cyboflow_report_artifact`) and only this session
  writes files or commits. The `verify-setup` subagent surveys and drafts; it
  never registers, never fires a verification, and never commits.
- **A failed proof is a completed run.** Keep the draft, write the diagnosis, take
  it to the merge gate. Never leave the project in a state where a written config
  reads as configured while nothing has ever run — that state is the entire
  failure this flow was built to end.
- **Never guess a command.** Every build/serve step traces to a `package.json`
  script, a documented invocation, or an existing runbook. "It's probably
  `pnpm dev`" is how the previous design reached 0-for-5.
- Report every step transition via `cyboflow_report_step` from this main session —
  including the steps whose work you delegated to the subagent.
