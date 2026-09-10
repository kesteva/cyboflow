# Visual verification: why it never runs, and the fix set

Status: proposal (2026-09-09). Investigation on `warm-ember-20260908` against the live
`~/.cyboflow/sessions.db` (read-only), the 8/27–9/05 app logs, and the on-disk verification
transcripts. Every claim below was checked against current code; file:line citations are to
this tree at `3d034ce4c`.

## 0. Headline

Visual verification does not so much fail as never run. All-time: 66 `verification_requests`
rows, 6 passed (every one a verify-setup proof run), 27 failed, 7 timeout, 24 skipped. Zero
sprint-lane verifications have passed since 2026-08-01. Three upstream gates close before an
agent is deployed; when one is deployed, the harness strips the environment a terminal agent
would have; when the run passes, post-exec identity matching can still reject it. Improving
the runbook prose or the agent prompt would change nothing.

## 1. Verified failure mechanisms (blast-radius order)

### RC1 — the Codex substrate discards the step's final text → the visual task is dropped before a request row exists

- `main/src/services/panels/codex/codexSdkManager.ts:554` `spawnCliProcess(): Promise<void>`.
  Every sibling manager (`claudeCodeManager.ts:1367`, `piSdkManager.ts:439`) returns
  `Promise<CliSpawnOutcome>` with `resultText`.
- `main/src/orchestrator/programmatic/spawnStepRunner.ts:381` → `resultText: outcome?.resultText ?? null`.
- `main/src/orchestrator/programmatic/workflowController.ts:1514-1527` — null `resultText` logs
  "task-verify produced no result text; skipping visual verification (channel unavailable)"
  and sets `visualVerifyTask = undefined`. No request row is written, so the verify queue and
  the DB show nothing happened.
- Every task-verify invocation since 8/28 ran on `codex-sdk` (62 of 62 in `agent_invocations`);
  62 matching "channel unavailable" log lines. The `claude-primary` and `codex` runtime mixes
  route task-verify to Codex (`shared/tuning/runtimeMix.ts:225-239`); 23 of the 62 predate the
  mix feature and came from a Codex model pin, so this is substrate-level, not a mix bug.
- The same branch also loses the task-verify `VERDICT: FAIL` loopback and the Codex code-review
  `## Blocking` sections.
- The text is already in hand: `codexEvalJudgeQuery.ts:263-265` latches the `item.completed`
  `agentMessage.text` for the eval jury from the very same event stream.

### RC2 — the proven runbook is destroyed by drift that has nothing to do with standing the app up

- `runbookStore.statusDetail` (`main/src/orchestrator/verify/runbookStore.ts:252-305`) demotes
  write-through on three conjuncts: portable-hash drift, input-hash drift, host-fingerprint
  drift. `demoted()` (`:676-690`) writes `status='unproven-draft', proof_json=NULL`. Recovery
  is a full re-prove.
- The portable hash (`runbookHash.ts`) covers the parsed runbook INCLUDING `notes` prose.
- The input hash (`main/src/index.ts:2513-2537`) folds in `package.json` scripts,
  `packageManager`, every lockfile's raw bytes, node major, and `process.versions.modules`
  (the Electron ABI). Any dependency bump demotes.
- The host fingerprint (`index.ts:2545-2560`) includes the versioned playwright chromium path,
  the Electron ABI, and `app.getPath('exe')` — every app release, playwright bump, or
  stable↔dev switch demotes.
- Worktree/root mismatch: `registerDraft` reads the FLOW WORKTREE's file (`runbookStore.ts:343`)
  while `statusDetail` reads the probe path — the project root for the health panel and, for
  lanes, the requesting run's worktree (`index.ts:2593-2599`). `markProven` (`:444-458`) only
  flips status; it never re-stamps `portable_hash`/`input_hash`. So "prove in a worktree, merge,
  read from the main checkout" demotes on the first read if `notes` differ by one character.
- Whole-file hash: both project-6 rows (cdp-app, native-screen) share hash `86ae5ace` v6.
  Registration and demotion are per `(project_id, modality)` row (`runbookStore.ts:380`,
  `:686`), so registering one modality does NOT demote the other — but any content change to
  the shared file (a `notes` edit under one modality) invalidates BOTH rows on their next read.
- Opening the Project Overview runs `setupByProject` → `effectiveRunbookStatus` →
  `statusDetail` against the PROJECT ROOT with demotion armed
  (`main/src/orchestrator/trpc/routers/verificationRequests.ts:508-523`, `:915-960`). A UI
  read can permanently demote every project's proof.
- Live state: cyboflow's cdp-app proof (9/01) pinned Electron ABI 136; the tree is on
  Electron 44 (NMV 149). A notes-only fix will not restore it — it needs a re-prove.

### RC3 — the modality selector is the LLM's guess

- `resolveTaskModality` (`shared/types/visualVerification.ts:1231-1238`): modality is
  `'cdp-app'` iff the COMPOSED task says `serve.attach === 'cdp'`, else `'web'` (unless the
  run's verify type is native-desktop/mobile-flow).
- `enqueueFromTask.ts:213-218` resolves the proven runbook by THAT modality. Cyboflow's runbook
  declares only `cdp-app` and `native-screen`, so a task-verify composer that omits `attach`
  gets "no proven runbook" against a perfect proof. Nothing tells the composer which
  modalities are proven. `native-screen` is unreachable from any lane (requires the run's
  verify type to be `native-desktop`, which is never inferred).
- On an ordinary lane the composed build/serve/attestation CONTENT is never executed
  (`mergeRunbookIntoTask` replaces it) but its PRESENCE is load-bearing
  (`bootstrapEligibility.taskDerivesEnvironment`) and a malformed one still fails the lane.

### RC4 — the agent's environment is worse than a terminal

- `verificationAgentQuery.ts:443` `env: { ...process.env, ...env }` → the packaged app's GUI
  PATH (`/usr/bin:/bin:/usr/sbin:/sbin`; transcript vr_addb4401 shows `pnpm: command not
  found`, `node not found`). `getShellPath()` (`main/src/utils/shellPath.ts:82`) is used by
  every other spawn seam (`claudeCodeManager.resolveSpawnPath` :3344) and by nothing under
  `verify/`.
- The same PATH breaks `depPreparer`'s `npx electron-builder install-app-deps`
  (`depPreparer.ts:262`, `:551`; log 9/01: `spawn npx ENOENT` ×3) → the dep mirror never warms;
  the first 9/01 snapshot had ZERO `node_modules` → `build_failed` → classified `ambiguous`
  (blocking) though purely environmental.
- The driver needs `NODE_PATH=<snapshot>/node_modules` to `require('playwright')` from
  `app.asar.unpacked`; the harness never sets it (`runbookLevers` denies it as a lever).
- The driver wrapper exports `ELECTRON_RUN_AS_NODE=1` and `driverCore.ts:1503`
  `spawn('sh', ['-c', cmd], { detached: true })` passes no env → every Electron runbook must
  carry `unset ELECTRON_RUN_AS_NODE;` as a load-bearing prefix.
- `levers.dataDirEnv` is parsed and hashed but bound by nothing (`runbookLevers.ts:88-96`:
  "Only `portEnv` and `nonceEnv` are exported") → `$VERIFY_ARTIFACTS_DIR/cyboflow-home` is
  reused across attempts; the passing run vr_bcae0966 reported a stale `orch.sock`
  `EADDRINUSE` inside the verified instance.
- `settingSources: []`, `mcpServers: {}`, tools Bash/Read/Grep/Glob, maxTurns 80 — no
  project instructions, no memory of prior attempts.

### RC5 — a composed `timeoutMs` undercuts the default deadline with no floor

- `verificationScheduler.ts:3276-3280`: `agentDeadlineMs = min(task.timeoutMs > 0 ? task.timeoutMs : default(10m), ceiling(20m))`.
- The outer `timeoutMs` is documented on no composer-facing surface while
  `serve.readyWhen.timeoutMs` is; the prove step composed `180000` → vr_addb4401 was killed
  at 180s mid-attest with the build passed and the app booted. The identical task at
  `1200000` passed in 7m18s. 2 of 7 all-time timeouts are this.

### RC6 — post-exec argv string matching rejects genuine passes

- `serveCommandMatches` (`verificationAgentRunner.ts:1161-1166`) requires the leader's `ps`
  argv to CONTAIN the pinned command string. `sh -c '<single simple command>'` exec-optimizes,
  so the leader argv becomes the resolved binary (`node …/pnpm run electron-dev`, Xcode's
  `Python -m http.server`). vr_a7fc7e33 and vr_e6e0ab68: report outcome `pass`, all behaviors
  pass, REJECTED as "a substitute or a wrapper was started". The runbook now carries a
  load-bearing `unset X;` semicolon solely to keep `sh` as the group leader.
- native-screen: `peekaboo --app com.github.Electron` binds the FIRST of N same-bundle-id
  Electron instances silently (vr_1e379c46) and the mismatch is classified `deliverable`,
  sending an implementer to fix working code. A host with no active display
  (`SCStreamError -3811`) is also classified `deliverable`.

### RC7 — nothing shows any of this

- `SprintSwimlaneCanvas.tsx:133-136`: an `integrated` lane paints every step, including
  "Visual check", green regardless of whether verification ran.
- `verdictDelivery.ts:443-453`: the FAILED finding body omits `errorMessage` and the failure
  class, so an attestation rejection reads "sent back to re-implement" above a report saying
  everything passed.
- `mergeGateLaneAdvance.ts:122-148`: `skipped`/`timeout` advance to integrated (fail-open);
  an env-caused `ambiguous` FAIL burns an implement attempt (fail-closed). The asymmetry is by
  design; the missing piece is visibility, not a flip.
- Pre-row drops (RC1, RC3) write nothing to the DB and log at INFO/WARN only.

### Not causes

- The per-project lifetime verification budget (all projects NULL = unlimited).
- The runbook prose or the verification agent prompt.
- `autoBootstrapRunbook` is OFF (`~/.cyboflow/config.json`); only projects 6 (cyboflow) and 7
  (Margin Letter) have any runbook record; distractodo-launch ran 39 lanes 9/04–05 with none
  — so even with RC1 fixed those lanes skip on "no proven runbook".

## 2. Fix set, in order

Each item names the seam, the change, and the invariant it must keep.

### F1. Capture Codex result text (RC1)

- `codexSdkManager.spawnCliProcess` returns `Promise<CliSpawnOutcome>`: latch the last
  `item.completed` `agentMessage.text` on the turn context (mirror
  `codexEvalJudgeQuery.ts:263`) and return `{ resultText }` on clean completion. Thread it
  through the `Promise<void>` chain to `substrateDispatchFacade.spawnCliProcess:620` so
  `spawnStepRunner.ts:381` sees it.
- Keep `resultText: null` for a genuinely text-less turn (interrupted/aborted). Do NOT pin
  task-verify back to Claude in the runtime mix (overrides a shipped user setting).
- Acceptance: a programmatic sprint run with mix `claude-primary` produces a
  `verification_requests` row per task-verify PASS; a Codex task-verify `VERDICT: FAIL`
  routes to loopback; unit test on the manager's result latch.

### F2. Deadline floor (RC5)

- `agentDeadlineMs = min(ceiling, max(default, requested))`. One line at
  `verificationScheduler.ts:3277-3279`. Update the doc comment.
- Stop the composer setting the outer `timeoutMs`: drop it from the task-verify fence
  contract in `sprint/agents/task-verify.md` / `verify-setup.md` (keep `serve.readyWhen.timeoutMs`).

### F3. Restore the agent environment (RC4)

- PATH: at `verificationAgentQuery.ts:443` and in the env the runner builds
  (`verificationAgentRunner.ts:2170-2200`), resolve `PATH` via `getShellPath()` and prepend
  the directory of the resolved node executable (`deps.resolveNode()`), so the agent and the
  driver see what a terminal sees. Same for `depPreparer.defaultDepExec` (`:262`): pass
  `env: { ...process.env, PATH: <shell path> }`. This does not widen the sandbox: the §7.2
  dependency guard and `settingSources: []` are separate controls (Codex review, confirmed).
- `NODE_PATH`: set to CYBOFLOW'S OWN `node_modules` root — never the snapshot's or the live
  worktree's (the driver contract at `driver/driverCli.ts:7` is "under the app's own node
  runtime, the target project needs no playwright install", and a deliverable-controlled
  playwright would be the driver's implementation). Derive it by walking up from
  `deps.driverCliPath` to the nearest `node_modules` (dev: `<repo>/node_modules`; packaged:
  `app.asar.unpacked/node_modules`). CAVEAT (packaged builds): `asarUnpack` in `package.json`
  unpacks the driver JS but NOT `node_modules/playwright*`; a plain-node child cannot read
  inside `app.asar`, so the packaged driver still needs `node_modules/playwright/**` and
  `node_modules/playwright-core/**` added to `asarUnpack`. That is a build-config change and
  is NOT made by this change set — it is flagged for a separate decision.
- Driver serve spawn (`driverCore.ts:1503`): pass an explicit `env` that deletes
  `ELECTRON_RUN_AS_NODE` (and `ELECTRON_NO_ATTACH_CONSOLE`), so Electron deliverables no
  longer need the `unset …;` prefix. Keep every other inherited var.
- Per-request data dir: the runner provisions a FRESH, EMPTY dir per request
  (`<artifactsDir>/data/<requestId>`; `VERIFY_ARTIFACTS_DIR` itself is RUN-scoped —
  `verificationScheduler.ts:3414` — so anything keyed on it is reused across attempts) and
  exports it as a new harness var `VERIFY_DATA_DIR`. `levers.dataDirEnv` is bound to the same
  value via `resolveLeverEnv` (extend `LeverValues` with `dataDir`), so a project whose app
  reads a data-dir env var gets isolation without a serve-command edit. Cyboflow's own
  runbook assigns `CYBOFLOW_DIR="$VERIFY_ARTIFACTS_DIR/cyboflow-home"` INLINE, which overrides
  any lever binding — the runbook is updated to `CYBOFLOW_DIR="$VERIFY_DATA_DIR"` (explicit
  on purpose: a dropped lever must never let the instance fall back to the developer's real
  `~/.cyboflow`). That edit changes the portable hash and requires re-registration and a
  re-prove (F6).
- Invariant: levers never SHADOW harness keys (`resolveLeverEnv` rule 1 stays).

### F4. Non-destructive drift + a re-prove path (RC2)

- `runbookStore.demoted()` becomes compute-and-return: it logs and returns
  `{ status: 'unproven-draft', reason: 'drifted' }` WITHOUT writing. `statusDetail`
  recomputes the full conjunction on every gate/badge read (`verificationRequests.ts:475`,
  `:953` revalidate stored proven rows — Codex review, confirmed), so the persisted column
  no longer needs to be destroyed to keep the badge and the gate honest.
- Do NOT add an early return that skips the input-hash/fingerprint conjuncts — the full
  conjunction must still be evaluated on every read.
- WHAT THE PERSISTED `status` STILL FEEDS (Codex #2): `getByHash` returns it without
  recomputing drift, and the runner's pin check rejects a non-`proven` record at deployment
  (`verificationAgentRunner.ts:967`). With non-writing demotion that execution-time signal
  only fires for a re-registered (superseded) record, not for a drifted one. Accepted and
  documented: the request is content-addressed to `portable_json`, the gate validated
  freshness at enqueue moments earlier, and the snapshot sha is fixed — the window is the
  same one that exists today between the gate read and a later demoting read.
- `markProven` re-stamps `input_hash` and `host_fingerprint_json` — NOT `portable_hash`
  (Codex #1: the hash is the content address of `portable_json`; the executed revision is
  the DB record, not the snapshot file, and the snapshot is disposed before promotion
  runs). Both CAS predicates (`portable_hash AND version`) stay. The fresh values are
  computed at promotion time by the scheduler over the requesting run's worktree — the same
  tree the gate probes — via the store's existing `computeInputHash`/`hostFingerprint` deps.
- RE-PROVE PATH (Codex #2, required): with non-writing demotion a `drifted` record would
  decline the bootstrap forever (`bootstrapEligibility.ts:116` maps `drifted` →
  `stale-proof` → never bootstrap). Today's write-through made the NEXT read answer `draft`
  and RE-DERIVE — throwing a human-authored runbook away, which the design says is wrong.
  New behavior: on `stale-proof`, the bootstrap runner RE-PROVES the existing record instead
  of re-deriving — it enqueues a bootstrap-proof request pinned to the record's current
  `(hash, version)`, composed from the record's own modality entry, through the existing
  proof machinery (claim stamp, `bootstrapProof: true`, budget exemption, lane re-enqueue on
  pass). On pass the engine's existing promotion path calls `markProven`, which refreshes the
  hashes. Gated by the same `autoBootstrapRunbook` toggle and kill switch; still no channel
  to fail a lane.
- The setup badge must keep reporting the GATE's answer (a drifted record shows
  `unproven-draft`), which compute-and-return preserves.

### F5. Resolve modality ONCE, early, from declaration then proven record (RC3)

- Resolve the lane's modality ONE time at the top of `enqueueTaskVerification`
  (`enqueueFromTask.ts`), BEFORE the bootstrap preflight at `:419` (Codex #3: today the
  bootstrap runs on the composer-derived modality and F5's original seam at `:487` ran
  after it, so a task with no `attach` could bootstrap a fresh `web` runbook on a project
  with a proven `cdp-app` one, spending budget and rewriting the shared file). The resolved
  value is reused by the bootstrap, the prepare/injection step, and the stamped row.
- Precedence: (1) the run's verify type — `native-desktop` → `native-screen`,
  `mobile-flow` → `mobile`, unchanged; (2) the composer's declared `task.modality` when it
  is `web` or `cdp-app` (the field already exists — `visualVerification.ts:353-359` — and
  the task-verify prompt already asks for it); (3) `serve.attach === 'cdp'` → `cdp-app`;
  (4) otherwise probe the proven records for this project/probe path in the order
  `cdp-app`, `web` and take the first proven one; (5) default `web`.
- Both proven with nothing declared: `cdp-app` wins (a project with a proven cdp-app entry
  is an app; a composer that wants its web surface says so). Declared-but-not-proven keeps
  today's behavior: the gate skips with the existing reason naming the modality.
- The stamped modality must equal the resolved one (the existing
  `resolveTaskModality(args.type, merged) !== modality` guard stays). Since
  `mergeRunbookIntoTask` replaces `serve`, the merged task's `attach` comes from the runbook
  entry, so the guard holds for a record-resolved `cdp-app`.
- Prompt: `sprint/agents/task-verify.md` and `ship/agents/task-verify.md` state that
  `modality` is the authoritative declaration and that the harness resolves an undeclared
  web-shaped task against the project's proven runbook.

### F6. Re-prove, measure, then narrow the hashes (RC2, deferred)

- Not in this change set. After F1–F5 land, re-run verify-setup on cyboflow, then log which
  conjunct trips over the next two weeks before scoping the input hash to the script bodies
  the runbook invokes and dropping lockfile bytes and `app.getPath('exe')`.

### F7. Serve identity that survives `sh` exec-optimization (RC6)

- `driverCore.ts:1503`: spawn `sh -c '<cmd>\n:'` — the verbatim command followed by a
  NEWLINE and a no-op builtin. MEASURED on this host: macOS `/bin/sh` (bash 3.2),
  `/bin/bash`, and `/bin/dash` all keep the shell as the detached group leader with the
  verbatim command in its argv; the `: ; <cmd>` PREFIX form does NOT (dash execs the last
  simple command — Codex #10). Windows keeps the cmd.exe path unchanged. Linux is not a
  supported verification host today.
- `serveCommandMatches` is UNCHANGED. No basename normalization (Codex #5: normalizing argv0
  on both sides makes a pinned `/trusted/python3` indistinguishable from `/other/python3`;
  the kernel port-owner and pgid checks establish group membership only, and the command
  comparison is a separate check with its own known substring residual, which this change
  neither widens nor narrows). With the shell retained as leader, the leader argv contains
  the pinned string verbatim, so the two rejected genuine passes no longer need any
  relaxation.
- native-screen (bundle-id binding, no-display classification) is DEFERRED to a follow-up:
  the serve pgid is the shell, not the Electron process (Codex #7), so a correct fix must
  resolve the window-owning pid WITHIN the serve group and use that binding for both capture
  and the `window-identity` attestation — a design of its own, and native-screen is
  reachable from no lane today.

### F8. Never skip silently (RC7)

- Pre-row drops raise a NON-blocking finding on the run naming the reason verbatim:
  `workflowController.ts:1514-1527` (channel-unavailable) and the enqueue seam's
  `skipped` outcomes other than `verification-disabled` (a deliberate off switch is not a
  surprise). Gate-side skips already produce a `skipped` row and a finding via
  `verdictDelivery`; nothing changes there.
- Swimlane: the "Visual check" step is DERIVED from the lane's latest verification request
  (Codex #9: a stamp on pre-row drops alone still paints `skipped`/`timeout`/`low_confidence`
  lanes green, because `mergeGateLaneAdvance.ts:122-148` integrates them). The `sprintLanes`
  payload gains `visualVerification: { status, failureClass?, errorMessage? } | null` — the
  most recent `verification_requests` row for `(run_id, task_ref)` EXCLUDING setup and
  bootstrap proofs (the same exclusion `verdictDelivery.ts:766` and
  `visualVerifyGate.ts:328` apply), `null` when no row exists. `SprintSwimlaneCanvas`
  renders: `passed` → done; `low_confidence` → advisory; `skipped`/`timeout`/`null` on an
  integrated lane → "not run" (grey, reason on hover); `failed` → failed. No new column.
- `verdictDelivery` FAILED body: always append `Reason: <errorMessage>` and
  `Class: <failureClass>` when present.

### F9. Bootstrap on by default

- Flip `VISUAL_VERIFY_DEFAULTS.autoBootstrapRunbook` to `true` (and the Settings default).
  Rung-1 behavior is UNCHANGED from lane-runbook-bootstrap.md: a typed, denylisted config
  operation applied in its own commit with a review-queue finding naming the file — that is
  already "a git change suggested only when the codebase needs it". Without the flip every
  project except cyboflow and Margin Letter stays permanently unverifiable.
- Invariant: the bootstrap has no channel to fail a lane (§12 of lane-runbook-bootstrap.md).

### F10. Storage: DB-authoritative gate, file as export (the "untracked runbook" ask)

- Nothing reads `.cyboflow/verify-runbook.json` inside the detached snapshot: the runner
  fetches `portable_json` by content hash from `verify_runbook_local`
  (`runbookHash.ts:5-16`, `runbookStore.getByHash`). The DB record is already the dynamic
  store. So:
  - The enqueue gate's `statusDetail` treats a GENUINELY ABSENT file at the probe path as
    "use the record" (today: `proven-file-absent-here` → unproven): the portable-hash
    conjunct is skipped, the input-hash and host-fingerprint conjuncts still run, so a
    branch whose scripts drifted from the proof still skips. Codex #8: the production
    reader (`index.ts:2567`) collapses EVERY fs error to `null`; it must return `null` only
    for ENOENT and THROW otherwise, so an unreadable file degrades to `'absent'/'indeterminate'`
    without ever entering the record-authoritative path. A present-but-malformed file keeps
    today's rejection (`unproven-draft`, reason `drifted`, now non-writing).
  - Delete the "committed:false is a blocker" prose in `stepPrompt.ts:351` and
    `runScopeTools.ts:638`; `registerDraft` reads the worktree file it is handed, and the
    proof runs against the registered `portable_json`, not the snapshot's file.
  - Keep writing the file on register/prove as a human-reviewable export. Git suggestions
    are emitted ONLY for the three typed rung-1 lever operations (port-from-env, data-dir
    lever, attestation marker), each on harness evidence that the lever is missing, never
    on inference.
- Caveat (both design judges): leaving git before an export-and-adopt path exists turns
  "reviewed like code" into "reviewed by nobody". The file stays as the export; whether it
  stays git-tracked is per-project and is decided after F1–F9 show what still fails.

## 3. Rejected (do not implement)

- Any ordinary lane pass calling `markProven` (only a setup-proof pass promotes).
- Running `unproven-draft` runbooks capped at `low_confidence` (`low_confidence` ADVANCES
  the lane today).
- Env-classified FAIL advancing to integrated.
- Regex-over-subprocess-output env classification (the classifier's `env` verdicts stay
  harness-evidence-only).
- Stripping `notes` from the identity hash (make drift non-expiring instead: F4).
- Pinning task-verify to Claude in the runtime mix.
- Basename-normalizing argv0 in the serve-command comparison (Codex #5).
- Re-stamping `portable_hash` at promotion (Codex #1).
- `NODE_PATH` pointing at the snapshot's or the live worktree's `node_modules` (Codex #4).

## 4. Codex adversarial review (2026-09-09, one round)

Codex (gpt-6-astra via the bundled 0.153.3 CLI, read-only sandbox) reviewed the previous
revision. Dispositions:

| # | Finding | Disposition |
|---|---------|-------------|
| 1 | Blocker: re-stamping `portable_hash` at promotion breaks the pin and the hash↔`portable_json` link; snapshot disposed before promotion | Accepted. F4 re-stamps only `input_hash`/`host_fingerprint_json`, computed at promotion over the run's worktree; both CAS predicates kept. |
| 2 | Persisted `status` feeds `getByHash`/runner pin check; non-writing drift strands `drifted` records (bootstrap declines them) | Accepted. F4 documents the execution-time window and adds the re-prove path. |
| 3 | F5 resolved modality after the bootstrap had already run on the composer's guess | Accepted. Modality resolved once before the bootstrap; precedence and both-proven rule defined. |
| 4 | `NODE_PATH` to the deliverable's playwright violates the driver contract | Accepted. `NODE_PATH` → cyboflow's own `node_modules`; packaged `asarUnpack` gap flagged, not changed. |
| 5 | Basename argv0 normalization weakens executable identity | Accepted. Dropped; the shell-leader wrapper alone fixes the observed rejections. |
| 6 | Per-request data dir does nothing while the runbook assigns `CYBOFLOW_DIR` inline; `VERIFY_ARTIFACTS_DIR` is run-scoped | Accepted. New request-scoped `VERIFY_DATA_DIR`; runbook updated; re-prove required. |
| 7 | Serve pgid is the shell, not the GUI app; window attestation uses pinned `spec.app` | Accepted. native-screen binding deferred out of this change set. |
| 8 | F10 treats unreadable as absent and lets a malformed file bypass rejection | Accepted. ENOENT-only `null`; malformed keeps rejection. |
| 9 | F8 stamp still paints skipped/timeout/low_confidence lanes green | Accepted. Swimlane state derived from the latest non-proof verification row. |
| 10 | `dash` claim wrong for the `: ;` prefix | Accepted. Measured: trailing `\n:` retains the leader on sh, bash, dash. |
| 11 | Registering one modality does not demote the other | Accepted. RC2 text corrected. |

Confirmed by Codex and unchanged: the F1 per-turn latch design (with warm A→B and
abort-after-text tests), PATH restoration not bypassing the dependency guard, F4 badge
correctness, the deadline and hidden-error diagnoses.

## 5. Verification plan for the change set

- Unit: `cd main && npx vitest run` over `verify/`, `programmatic/`, `panels/codex/` (the
  targeted suites for touched files), plus `pnpm typecheck && pnpm lint`.
- Integration: `pnpm test:integration` (panels/codex change is a substrate seam).
- Live: re-run verify-setup on cyboflow after landing; confirm a `claude-primary` sprint lane
  writes a `verification_requests` row and the swimlane shows the real verdict.
