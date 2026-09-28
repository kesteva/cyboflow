# Runbook-optional verification + the Xcode 27 DeviceInteraction drive engine (Stage 3)

Status: DESIGN v2, 2026-09-24, green-brook.

v1 went through a four-lens adversarial review (regression safety, feasibility, Stage 3 engine, thesis completeness). The review raised 36 blocking or major findings, and all 36 survived an independent skeptic pass. They are folded in below and cited by their IDs: RS-n, F-n, B-n and T-n (the thesis lens).

- **Part A**: make a missing runbook change *how* a verification request runs, not *whether* it runs.
- **Part B**: Stage 3 of `mobile-verification-tier.md`.

## 0. Evidence

### Production DB (`~/.cyboflow/sessions.db`, 2026-07-10 → 09-24, 101 requests)
- **Skips.** 53 of 101 requests were skipped, and 47 of those were "no proven verification runbook".
- **Passes.** Of the 6 passes, **none** was an ordinary lane request with build/serve: 2 were legacy degenerate requests on the capturePage engine, and 4 were setup self-proofs.
- **Bootstrap.** Every `verify_runbook_bootstrap` row is `failed`: 5× "unusable result", 2× "mobile not auto-derived".
- **Shiny-eagle (Distractodo, iOS).**
  - 12 requests were skipped at gate 3. Each one carried the `build` step that the task-verify recipe mandates.
  - 5 were stamped `web` although they declared `native-screen`, so they ran without a simulator.
  - The two real defects came from rows that escaped gate 3 because they had no `build`. The agent improvised one:
    - `e26dcc9`: a compile break;
    - `e8a7ef1`: a missing `CFBundleExecutable`.
  - The one row classed `deliverable` (`6626c0d`) had every behaviour `not_testable`, yet it looped implement back.
- **Failure sample.** Of 15 sampled failures, none shows the agent giving up. Each one found either a real defect or a real harness defect.
- **Distractodo's mobile runbook reached `proven` on 2026-09-24** via Verify Setup, **but no lane can pin it.** `computeVerifyInputHash` returns null without a `package.json`, and `statusDetail` maps that null to `absent/indeterminate` (T-F2). Every Distractodo lane would still skip "no proven runbook".

### Why the gate exists
The gate comes from `verification-setup-flow.md` §1, "0-for-5". Those five failures were all cyboflow verifying itself: wrong serve form, singleton collisions, ABI, cold install versus deadline, and a stale server on a leased port.

**Correction to v1 (RS-8, F8, T-F4).** The scheduler owns the *provisioning*: the leased port pair, a fresh `VERIFY_DATA_DIR`, the leased simulator and the dependency clone. *Binding* those to the app is runbook content (levers) or prompt content. It is not scheduler-owned. The live dependency guard exists **only on Claude**; the Codex verifier runs `danger-full-access` with no live guard.

## Part A: runbooks accelerate, never gate

### A0. A total input hash (prerequisite, T-F2)
`services/visualVerify/verifyDriftProbes.ts` `computeVerifyInputHash`:

- **Missing `package.json`.** ENOENT or ENOTDIR on `package.json` means "no npm manifest". It is no longer treated as unobservable. Only non-ENOENT fs errors and an unparseable `package.json` return null.
- **Fallback manifests.** Without `package.json`, fold in whichever of these exist, in a fixed order, and then the same ABI facts:
  - `project.yml`
  - root `Package.resolved`
  - `*.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`
  - `Podfile.lock`
  - `Cargo.lock`
  - `go.sum`

  With none of them present, the hash is a constant `no-manifest` tag plus the ABI facts. Never include `project.pbxproj`: it churns on every file added.
- **Legacy NULL compatibility** (keeps Distractodo's proof without a re-prove). In `statusDetail`, a stored `input_hash IS NULL` counts as matching only when the probe tree has **no** `package.json`. `statusDetail` stays a pure read.
- `bootstrapSuppressionStore` keys on the same function. Confirm its behaviour in tests.

### A1. Execution mode (gate 3 becomes a selector)
`agentEngine.evaluateAgentGates` clause (3) selects a mode, passed to the runner and recorded in provenance:

| Mode | When | Behaviour |
|---|---|---|
| `pinned` | The row carries a pin: a proven record injected at enqueue, a setup or bootstrap proof, or a *learned pin* (A5) | Today's contract, unchanged |
| `explore` | No pin, **and** the modality is explore-eligible (below) | Deploy. Composed build/serve/target/app are hints |
| `legacy` | Kill switch on | Today's gate-3 behaviour, byte for byte |

**Explore-eligible modalities (RS-8, F8, T-F7).**
- `web`: always. It gets a leased port, a nonce, and headless chromium.
- `mobile`: always. It gets a fresh leased simulator and a harness-owned install and attestation.
- `cdp-app`: only when a lever set with `dataDirEnv` is known. The levers come from **any** registered record for (project, modality), whatever its status (A1.3). Otherwise gate 3 still skips.
- `native-screen`: **pinned-only**, so gate 3 still applies. Window-identity binds by app name and can attest the user's own running instance (T-F7). Explore for it waits for the pid-scoped binding deferred in `visual-verification-brittleness-fixes.md:291-295`.

**Kill switch (RS-11).** The switch is `VisualVerifyConfig.requireProvenRunbook` (default `false`) or env `CYBOFLOW_VERIFY_REQUIRE_RUNBOOK=1`. Read it live, the same way `autoBootstrapRunbook` is read through `liveConfig`; AgentEngine holds a boot snapshot, so it must not read it from there (F12). When on:
1. Gate 3 skips as today, and gate 3a stays in force. The 3a revert is conditional, not a deletion.
2. There is no explore mode: no EXPLORE contract, no explore deadline floor, and `VERIFY_PORT` is exported only when the task has a `serve`. Provenance records `legacy`.
3. A5 is off: no recipe registration and no learned pins.
4. A6 is off.
5. A7's derive arms are reachable again.

These are unconditional bug fixes that ignore the switch:
- A0;
- A2's probe on enqueue;
- A4;
- A8;
- A9;
- A11's breaker reset;
- Part B.

**Test.** A table-driven test with the switch on asserts today's gate and posture outcomes. Cases: a build task, a serve task, a degenerate target-only task, a surfaceless web task, a `mobile-flow` run with no runbook, and a present learned draft.

#### A1.1 Explore mechanics
- **`VERIFY_PORT`** is exported for every web/cdp-app explore request. The port pair is already leased (`mobileGates.ts:239-248`).
- **Deadline floor:** `max(default, exploreDeadlineFloorMs)`, where the new config field defaults to 15 min. The ceiling stays at 20 min.
- **Contract text** becomes mode-conditional: `verifyHarnessContract(provider, mode)` (F3, T-F1).
  - `VERIFY_HARNESS_CONTRACT` stays the pinned constant, so the existing phrase-pin tests hold.
  - In explore mode the function **replaces** these passages rather than appending a contradicting block:
    - "THE SERVE COMMAND MUST BE THE TASK'S, EXACTLY … an unbound surface FAILS";
    - "Run the task's build steps first";
    - "When [VERIFY_PORT] absent, the task points at an already-live target".
  - The explore text says: the composed build and serve are hints. Using the composed serve verbatim through `"$VERIFY_DRIVER" serve` is the only way a web or cdp-app run can reach `passed`. Any other way of standing the app up is allowed, but it caps the verdict at `low_confidence`.
- **Harness-owned provenance.** The report carries `provenance: { executionMode, leverSource?, captureLedger?, driveEngineRequested?, driveEngineUsed?, degradeReason? }`. The runner attaches it *after* normalization and drops any agent-supplied `provenance` key (F6). `executionMode` is also stamped into `failure_evidence_json` or `preflight_json`, so requests that end with no report still record it. That makes the explore-mode `build_failed` loopback rate measurable.

#### A1.2 Attestation floor, mode-aware (F3, T-F1)
**Pinned: unchanged.**
- A declared channel that does not verify is `failed` (ambiguous), which loops implement.
- An undeclared channel caps at `low_confidence`.

**Explore: never blocks on identity.**
- A floor result of `missing` maps to `low_confidence`, with the detail in `error_message` and a non-blocking finding. `missing` covers every binding failure (serve-pid, port-owner, command) and a probe that fails to verify.
- It stays `failed` only on positive harness evidence of a foreign surface: the port-owner probe resolved a listener pid outside the process group the driver recorded.
- `passed` in explore is limited to three cases:
  - **Port-mediated channels** (http-endpoint, dom-marker, cdp-token) reach `passed` only when the task carries `serve.cmd` and the full existing binding holds (port owner plus the verbatim command). Otherwise the verdict is capped at `low_confidence`. The binding steps still run and are recorded as evidence.
  - **`file-identity`**: unchanged.
  - **Mobile `bundle-identity`** that verifies may reach `passed`. The hash is harness-owned.
  - **Serve binding alone** (decided 2026-09-25, after the live smoke). When the task declared no channel, `passed` is allowed if it composed a `serve.cmd` and the binding holds: the port's listener is in the process group the driver started, and that group runs the verbatim composed command. Without this, a runbook-less web deliverable could never pass. The accepted gap is a composed command that deliberately fronts another server. A foreign listener still fails, and an unbound serve stays capped. Pinned rows are unchanged.
  - **Explore mobile** with no declared channel probes an implicit `bundle-identity` built from `app.bundleId`.

#### A1.3 Levers in explore (F8, T-F4)
- **Lever source.** With no pin, resolve the best record for (project, modality): proven, otherwise any `unproven-draft` of any origin. Pass **only its `levers`** to `resolveLeverEnv`, which already applies the name pattern, the deny list and harness-wins. Its build/serve reach the agent as hints in the EXPLORE block, together with its notes.
- **Provenance.** Record the source as `leverSource: { hash, status, origin }`.
- **Host env.** Strip the host's own `CYBOFLOW_DIR` (and the `--cyboflow-dir` equivalent) from the agent and serve env unless a lever re-binds it.

#### A1.4 Explore guardrails
- **Prompt rules, both runtimes:**
  - Serve on `$VERIFY_PORT`, attach on `$VERIFY_DRIVER_PORT`.
  - Never stop or kill a process you did not start.
  - Use only the leased simulator.
  - Never edit tracked sources. The mutation check stays and caps at `low_confidence`.
- **Desktop apps:** before launching, identify how the app picks its data dir and its single-instance lock. If it can't be confined to `$VERIFY_DATA_DIR`, report `unverifiable` rather than launch (T-F4).
- **Mobile, "build the snapshot as-is" (RS-3).**
  - The product must be exactly what the snapshot's own project produces.
  - Forbidden:
    - editing anything under `$VERIFY_DERIVED_DATA` after the build (PlistBuddy, plutil, cp or ditto into the product);
    - building from a copy of the sources, or from outside the snapshot;
    - build-setting overrides beyond `-project`/`-workspace`/`-scheme`/`-configuration`/`-sdk`/`-destination`/`-derivedDataPath`/`-clonedSourcePackagesDirPath` and the code-signing flags.
  - "It builds but its product cannot install or launch, and I found a change that would fix it" is `build_failed`/`launch_failed`, with the fix in the feedback. Never stage the fixed product.
  - `bundle-identity` proves staged-artifact identity only. In explore the residual is wider, so do **not** claim it is "sound however the build was produced".
- **Structural guards (RS-8):**
  - The `$VERIFY_DRIVER` wrapper exports the leased `VERIFY_DRIVER_PORT` as a literal. This works on both runtimes.
  - Claude `canUseTool` denies `kill`/`pkill`/`killall`.
  - On mobile, Claude `canUseTool` denies `xcrun simctl` install / launch / boot / create / delete / shutdown / erase / uninstall. Reuse `SIMCTL_LIFECYCLE_PATTERN` plus `erase|uninstall|all|booted`.
- **Codex live dependency guard (F8).** Required before explore runs on Codex; the prod sprint flow is `claude-primary`, so Codex runs every sprint `visual-verify`. Two possible mechanisms:
  - Preferred: a **PATH shim dir**, prepended to the agent's PATH on both runtimes. It holds wrappers for `pnpm`/`npm`/`yarn`/`bun`/`pod`/`swift`/`npx playwright` that refuse `FORBIDDEN_DEP_COMMAND_PATTERN` subcommands and otherwise exec the real binary.
  - Alternative: a Codex approval policy answered locally, the `isolationRequestPolicy` pattern.

  Either one is defence in depth, not a sandbox. Say so.

### A2. Modality from evidence (F7, RS-9, T-F6)
- **`resolveTaskModality` stays shape-only and unchanged.** It keeps the enqueue consistency guard and the F5 proven-record fallback.
- **`projectSurfaceProbe.ts`** is a new, pure-IO, fail-soft module. It is a rung **inside `resolveEnqueueModality`**, after the proven-record and present-record probes and before the final shape fallback. The function returns `{ modality, task }`, and the returned task goes to the bootstrap decision, the MCP deferral and `prepareVerificationEnqueue` on both seams.
- **It fires when all of the following hold:**
  - no usable declaration: nothing declared, **or** a declared `mobile` without `app`, **or** a declared `native-screen` on a web-typed run;
  - no `app`;
  - no `serve` of any form;
  - no `target.url` or `target.htmlPath`;
  - no cdp-app or web record exists for the project, whatever its status.
- **On an iOS hit** it writes `modality: 'mobile'` and a synthesized `app`. The existing `app.platform` rung then stamps `mobile`. The detection and the fields:
  - Detection: `project.yml` with `platform: iOS` + `type: application`, or `project.pbxproj` with an `SDKROOT = iphoneos` application target.
  - Values are literal only. A `PRODUCT_BUNDLE_IDENTIFIER` containing `$(`/`${`, or several app targets with different ids, is inconclusive and changes nothing.
  - Scheme: from `xcshareddata/xcschemes`, otherwise the app target's name (XcodeGen and xcodebuild auto-create one per target).
  - The block is tagged `"inferred": true` inside `task_json`, stored under an engine-only key so the parser drops it from wire input.
- **On an inferred block:** a bundle-id mismatch at `mobile-install`, an unknown scheme, or a build that needs a forbidden dependency step is `unverifiable`, never `build_failed`.
- **Probe miss:** today's behaviour. A declared `mobile` without `app` drops to the web shape and never reaches `MOBILE_NO_APP_BLOCK` (which is env-classed and feeds the breaker).
- **Native-screen:** stays type-only. It is honoured on `native-desktop` runs.

### A3. Environment mismatch: one automatic re-dispatch (F5, RS-10, RS-1, T-F6)
- **Report outcome** `wrong_environment`: `neededModality` ∈ {`web`, `cdp-app`, `mobile`}, a required `diagnosis`, and an optional `app`. `native-screen` is accepted only on `native-desktop` runs (RS-9).
- **Separate result channel.** The runner returns `redispatch: { modality, app?, diagnosis }` on `VerificationAgentRunResult`, never a normal status. `settleAgentTerminal` checks it **first**, before classification, env conversion, `isUnprovenAdvancingSkip`, delivery and `recordCapabilityOutcome`.
- **Eligibility.** Only explore rows are re-dispatched: `runbook_hash IS NULL AND setup_proof=0 AND bootstrap_proof=0`, and no engine marker present.
- **Marker.** The engine-only key `_redispatchedFrom` in `task_json` is read with a raw `JSON.parse`. The parser drops unknown keys on wire input, so a composer can never set it.
- **Guarded requeue:**

  ```sql
  UPDATE verification_requests
  SET status='queued', modality=?, task_json=?, leased_at=NULL, enqueued_at=CURRENT_TIMESTAMP
  WHERE id=? AND status='running'
  ```

  - If `changes !== 1`, a cancel won: do nothing.
  - Release every lease, remove the `inFlight` controller, do not bump `attempt`, then `nudge()`.
  - The row moves to the back of the FIFO. Use SQLite's own timestamp shape, never a JS ISO string.
  - If the new modality is `mobile` and there is no `app`, run the surface probe. If the probe misses, take the terminal path below.
- **Terminal cases** (second mismatch, a mismatch on a pinned or proof row, or an unresolvable mobile app): terminate as `unverifiable`, which is `low_confidence` (A4).
  - No `failure_class`, and nothing is written to the ledger or the breaker.
  - The diagnosis is filed as a non-blocking finding. It never loops implement.
- **Budget.** A re-dispatched request deploys twice and is charged twice.

### A4. Honest verdicts (RS-1, RS-2, F10, T-F7)
**New outcome `unverifiable`** (requires a `diagnosis`): the surface could not be exercised for reasons outside the change.

**Corroboration** means a harness-observed fact, any one of:
- (a) the surface was stood up and harness attestation verified; only behaviours were unexercisable;
- (b) the drive rung is `none`, or drive coercion fired;
- (c) a harness-detected modality or lease mismatch: the declared `task.modality` differs from the stamped modality, or no simulator or screen was leased for a surface that needs one;
- (d) a harness-observed identity ambiguity: more than one same-name or same-bundle instance, or peekaboo's "Ambiguous application identifier".

**Mapping.**

| Mode | `unverifiable` | Result |
|---|---|---|
| explore | any | `low_confidence` plus finding; no `failure_class` |
| pinned | corroborated | `low_confidence` plus finding |
| pinned | uncorroborated | `failed`, classed `ambiguous` (blocking, as `build_failed` is today) |

A pinned request has a proven recipe, so "I could not stand it up" there is evidence against the change. An explore request's baseline today is a pre-deploy **skip that advances the lane**. So an advancing `low_confidence` with a visible diagnosis can't be worse than today's baseline, and it carries more information.

**`fail` with no failing behaviour.**
- Applies only when the task has ≥1 behaviour and **every** expected behaviour is `not_testable` (reported or uncovered).
- It is treated as `unverifiable` and follows the table above. This is the `6626c0d` case.
- The check belongs in `normalizeVerificationReportV1`, which already takes `expectedBehaviorIds`.
- Zero-behaviour tasks (legacy intent-only, bootstrap proofs, setup proofs) keep `fail` → `failed`. The verify-setup diagnose loop reads `failureClass`.
- If the task declared an attestation, the harness also runs its probe on a `fail` report and applies the same floor mapping. That way an honest `pass` is never punished relative to a `fail` that has no failing behaviour.

**`build_failed` / `launch_failed`** are unchanged in both modes: ambiguous, then failed, then loopback. Do not add "the excerpt cites a tracked file" corroboration: that would have discarded `e8a7`'s real defect (F10).

**Prompt rule.** `fail` must name an observed defect, either in a failing behaviour or, for zero-behaviour tasks, in `issues`/`feedback`. Anything the agent could not exercise is `unverifiable`.

### A5. Learn from success (RS-3, RS-4, RS-5, RS-6, F1, F2, T-F3)
**Learning trigger.** Learn only from a terminal **`passed`** explore request: harness attestation verified, and the snapshot not mutated. Never learn from `low_confidence`, `unverifiable`, `wrong_environment` or `fail`. In explore, web/cdp-app `passed` already requires the verbatim composed serve, so the learned serve is the composed `serve.cmd`.

**Recipe.** The report gains an optional `recipeJson` string (Codex strict schema stays trivial, F6). It is parsed harness-side with the portable-runbook entry parser.

**Validation.** Beyond `parseVerifyRunbookV1` plus `declaresModality`, apply the dependency guard and these checks:
- **Mobile:** every `build[]` entry is a single `xcodebuild` invocation, with no `SHELL_COMPOSITION_PATTERN` match and arguments from the A1.4 allowlist only. `$VERIFY_DERIVED_DATA` may appear only as the `-derivedDataPath`/`-clonedSourcePackagesDirPath` value. Then run `checkMobileBuildIsolation`.
- **Web/cdp-app:** `validateDraftedRunbook` against the snapshot's root `package.json`. No step may write outside the snapshot or `$VERIFY_DATA_DIR`.
- **All:** no literal leased values (port, UDID, snapshot path). Levers are validated by the lever rules.

A rejection means nothing is learned. The verdict is unaffected.

**The pinned proof is the sole validator of an agent-authored recipe. Say so.**

**Store contract** (`runbookStore.ts`, no migration):
- `registerLearnedDraft(projectId, modality, entry, levers, probePath, expectedVersion|null)`:
  - builds a single-modality `portable_json` in memory and never writes to a tree;
  - validates exactly as `registerDraft` does;
  - stamps the input hash and host fingerprint from `probePath`.
  - It is one UPSERT whose INSERT sets `origin='learned'`. `ON CONFLICT DO UPDATE ... WHERE status='unproven-draft' AND origin='learned' AND version=?`. `changes=0` returns `not-eligible` or `cas-conflict`.
- `discardLearnedDraft(projectId, modality, hash, version)`: a CAS DELETE guarded by `origin='learned' AND status='unproven-draft'`. It is skipped while any non-terminal row pins that hash.
- `registerDraft`'s ON CONFLICT sets `origin=NULL` (the later `setOrigin` re-stamps it). `readRow` selects `origin`.
- **Eligibility, from `statusDetail`:** learn only on reason `no-record`, or `draft` with origin `learned` and `fileDeclaresModality=false`. **First writer wins:** an existing learned draft is never overwritten. On `file-only`, or a `draft` whose file declares the modality, file a non-blocking finding carrying the recipe as a suggested runbook entry.
- **Drift for learned rows:** for `origin='learned'` rows, skip the portable-file hash conjunct when the tree's file does not declare the modality. When it does declare it, the answer is `content-drifted`: a committed entry supersedes the learned one.
- **A proven learned record that later drifts** is recovered only by the A7 reprove. If that reprove fails, a new learned draft may replace a `learned`-origin record. `setup-flow` and `bootstrap` origins stay protected.
- Add `'learned'` to the origin union (`shared/types/visualVerification.ts:~1994`) and to the tRPC mapping (`verificationRequests.ts` ~485, ~1008).

**Promotion via a learned pin.** The lane's **own ordinary request** carries it, with `bootstrap_proof=0`, the normal lane key, and full delivery on both planes:
- **Enqueue side.** `prepareVerificationEnqueue.tryInject`: when there is no proven record, call `resolveLearnedDraft(project, modality)`, which returns only `unproven-draft` + `learned` records. Merge the draft and return an ordinary pin, which both seams already persist.
- **Drain side.** Extend `getByHash` / `PinnedRunbookRecord` with `origin`. `learnedPin = record.status==='unproven-draft' && record.origin==='learned'` is used for exactly two things:
  - (a) the runner's accept-unproven proof half of `checkRunbookPin` (`agentEngine.ts:~759`);
  - (b) the `markProven` condition (`agentEngine.ts:~1004`).

  It does **not** feed the gate-3 exemption, the budget or priority exemptions, the bootstrap re-entry guard, or any delivery exclusion.
- **Exits:**
  - `passed` → `markProven`, then deliver.
  - Surface stood up with ≥1 behaviour `fail` → deliver normally, keep the draft.
  - Anything else → CAS-discard the draft, clear the row's pin columns, and re-dispatch the same row once in explore through A3. The one-shot budget is shared with `wrong_environment`. "Anything else" means `build_failed`, `launch_failed`, identity failure, timeout, `low_confidence`, `unverifiable`, a runbook mismatch, or `wrong_environment`. The lane gets the explore verdict.
- **Review surface.** A non-blocking finding when a recipe is learned and again when it is promoted, naming the exact commands and the source request.
- **Tests on both planes:**
  - orchestrated: `verdictDelivery` reaches `applyMergeGateVerdict`;
  - programmatic: `visualVerifyGate` resolves from the row.

### A6. Run posture
When explore is on, `verificationPosture` no longer declines **`mobile-flow`** runs for runbook absence. It still declines `native-desktop` runs, because native-screen is pinned-only. Host-capability declines are unchanged. The mid-run posture flip still fires on host declines; the claim that it becomes unreachable was false (F12).

### A7. Bootstrap under explore (RS-7, F9)
- Explore disables **authoring only**: `decideRunbookBootstrap` returns `'explore-mode'` instead of `{ mode: 'derive' }` for requests that will explore. Add it to `BootstrapDeclineReason`, with `null` in `bootstrapRemedyText`.
- **`'drifted'` → `{ mode: 'reprove' }` is kept exactly as it is today.**
- The `'draft'` arm becomes **prove-only** under explore: `proveRegisteredRecord` with no drafting fallback, gated on the §10 suppression.
- For modalities that don't explore (native-screen, cdp-app with no levers), the bootstrap is unchanged.
- **Drift finding.** When a request explores because its record reads `drifted`/`content-drifted`, file `bootstrapRemedyText('stale-proof')` as a non-blocking finding, once per run and modality.

### A8. Proven stays proven (RS-12)
`registerDraft` is a no-op when **both** the portable hash **and** `bindings_json` equal those of an existing proven record. Any other difference updates and demotes the record. The register tool's description gains: "returns the existing proven record when unchanged".

### A9. Queued-age correctness (F4, RS-10, T-F5): one unit
- **Parse as UTC at all three sites:**
  - `verificationScheduler.ts` `expireOverAgeQueued` (~1107);
  - `armQueuedAgeTimer` (~1153);
  - `verificationRequestRows.ts` `orderAgentDrainRows` (~97).

  Use one helper, `enqueuedAtMs(row)`, in `verificationRequestRows.ts`, built on `parseTimestamp` from `main/src/utils/timestampUtils.ts`. The import is allowed: eslint bans only electron and services. Today's bug expires every row at its first drain on hosts at UTC+0:15 or further east.
- **Progress-aware expiry.**
  - `drain()` stamps an in-memory `lastProgressMs = now()` after `Promise.allSettled(inFlight)` whenever `inFlight.length > 0`.
  - The age anchor is `max(enqueuedMs, lastProgressMs)`, in both `expireOverAgeQueued` and `armQueuedAgeTimer`.
  - An outer hard cap from enqueue is `ceiling + 2 × AGENT_REQUEST_TIMEOUT_CEILING_MS`.
  - Update the sizing note on `DEFAULT_QUEUED_AGE_CEILING_MS`.
- **Ratchet.** `verificationScheduler.ts` is **at its 2230-line cap**. Every change there must be net-zero, so extract helpers into siblings.

### A10. Prompts (sprint and ship copies byte-identical)
**`visual-verify.md`:**
- pinned/explore split;
- A1.4 guardrails;
- `recipeJson`;
- `unverifiable` / `wrong_environment`, and where they sit relative to `build_failed`;
- "fail must name an observed defect";
- xcode drive verbs (B4).

**`task-verify.md`:**
- With no proven runbook, build/serve are best-guess hints; don't stall.
- Declare `dom-marker`/`http-endpoint` only when the repo visibly renders `VERIFY_ATTEST_NONCE`/`data-verify-nonce`; otherwise omit `attestation`. Qualify the `[data-verify-build]` example the same way.
- The cdp-app recipe must name the app's own data-dir mechanism (for cyboflow, `CYBOFLOW_DIR="$VERIFY_DATA_DIR"`).

**Runner contract head:** mode-conditional (A1.1), and the MOBILE block covers xcode (B4).

### A11. Breaker reset (T-F6)
- Extend the `recordHealthyOutcome` condition (`agentEngine.ts:~1299`) to cover a deployed `low_confidence` that has at least one behaviour `pass`/`fail`. An `unverifiable` with no exercised behaviour does not reset it.
- Update the `capabilityRunbookKey` doc: unpinned rows, explore runs included, share the `''` bucket.

### Report-contract widening (F6): one work item, touching
- **`shared/types/visualVerification.ts`:** the outcome union plus a single exported `VERIFICATION_REPORT_OUTCOMES` constant; the normalizer validates `wrong_environment{neededModality, diagnosis, app?}`, `unverifiable{diagnosis}` and `recipeJson` (string only), and applies the A4 coercion with `coerced: true`.
- **`VERIFICATION_REPORT_JSON_SCHEMA`:** add the enum values and the optional properties. `stripStrictSchemaNulls` derives the stripped keys from the schema's non-required properties; that also fixes the missed `attestation`.
- **`mapReportToResult`:** an exhaustive switch with a `never` check. `wrong_environment` goes to the `redispatch` channel and can never reach the pass branch.
- **Other consumers:** `failureClassifier` input type, `verdictDelivery.ts:~384`, and the frontend `isReportOutcome` guard and labels (use the shared constant).
- **Tests:** round-trip on both runtimes for each new outcome, including a Codex strict report with every optional field null.

## Part B: Stage 3, the Xcode 27 DeviceInteraction drive/observe engine

### B0. Live facts (this host, 2026-09-24)
- **Bridge:** Xcode 27.0 (27A266a). `xcrun mcpbridge` (`xcode-tools` 25317) exposes 53 tools; the dump is committed as a fixture.
- **Headless:** `xcrun mcp-server status --format json` returns `permission.enabled`, `permittedAgents[]` (`trust.unsigned{path, sha256, expiration}`), `permittedFolders[]` and `running`. `expiration` is CFAbsoluteTime (+978307200 for unix).
- **Approval** is interactive and blocks the triggering call. It is keyed on the spawning client binary.
  - Unsigned clients get 24 h.
  - Signed clients may get durable trust (`approve --always`); this is unmeasured.
  - Only `XcodeOpenWorkspace`/`XcodeNewProject` prompt. Other tools fail with "This agent isn't approved to use Xcode's tools yet".
- **Runtime:** DeviceInteraction requires an iOS 27.0+ simulator runtime (installed: 27.0, 24A434).
- **Non-workspace session.** `DeviceInteractionStartSession({ deviceIdentifier: <UDID>, sessionIdentifier })` needs no workspace and no folder approval.
  - `DeviceInteractionSynthesize({ interactSessionKey, activationBundleId?, interactionCommand? })` drives any installed app. A tap navigated Settings → Accessibility.
  - It returns `screenshotPath`, `thumbnailScreenshotPath`, `hierarchyPath`, `logsPath` and `applicationState`.
  - The hierarchy lists `Application bundle identifier: <id>` / `Application, pid: N, label: '...'` blocks. Each element carries a role, frame, `label:`, `identifier:` and `hitPoint:`.
  - **Activation launches a not-running app** (Settings was launched), which masks crashes (B-5).
- **Session identity.** The key equals the `sessionIdentifier`, which must be unique among recent ones. Sessions outlive the bridge process.
- **Workspace path:** workable but flaky (scheme-list race, a lost session), no DerivedData lever, per-folder approval. It is not used.
- **Grammar** (the `device-interaction` skill compiled into `IDEDeviceInteraction.framework`):
  - `t x y [dur]` taps, plus double-tap, swipe, drag, multi-touch, buttons, wait and orientation forms;
  - `type <text>` must be last; `\u{000A}` = return.

**Deployment identity** (B-1):

| Deployment | Who spawns `mcpbridge` | Signing | Grant |
|---|---|---|---|
| Packaged | `/Applications/Cyboflow.app/Contents/MacOS/Cyboflow` (runner in main) | Developer-ID | durable possible |
| Dev | node_modules Electron | ad-hoc = unsigned | 24 h, `{path, sha256}`, likely re-keyed per Electron bump |
| Driver node | — | — | never spawns |

### B1. Scope
- **Shipped:** DeviceInteraction as a mobile **drive + observe rung**, `VERIFY_MOBILE_DRIVE=xcode`, harness-owned.
- **Unchanged:** build, install, launch and `bundle-identity` stay on the CLI path (xcodebuild + simctl).
- **Not built:** the Xcode-driven build ("3b"), for the B0 reasons.

### B2. Probe (`xcodeDeviceInteractionProbe.ts`, composed in `mobileComposition.ts`): spawn-free (B-3)
- **Checks:**
  1. `xcrun --find mcpbridge`;
  2. `xcodebuild -version` major ≥ 27;
  3. `xcrun simctl list runtimes -j` has an available iOS ≥ 27;
  4. `xcrun mcp-server status --format json`, parsed once:
     - enabled;
     - approved: `unsafeAlwaysAllowAllAgents`, or a `permittedAgents[]` entry matching `process.execPath`, matched on path + sha256 of that file when unsigned. The entry either has no expiration, or `expiration > now + 20 min + margin`.
- **Outcomes:** `available` | `approval-required` | `expiring` | `inconclusive` | `unavailable(detail)`. Cache for 60 s.
- **Constraints:**
  - **Never spawns `mcpbridge` and never calls `XcodeListWorkspaces`.** Only the runner spawns the bridge, inside a request. Its StartSession is the authoritative approval check.
  - `inconclusive` under `auto` still attempts xcode.
- **Preflight/health id `'xcode-mcp'`**, with a remedy per check:
  - `xcodebuild -downloadPlatform iOS`;
  - `sudo xcrun mcp-server enable`;
  - "Approve Xcode access" (B8);
  - the grant's expiry time.

### B3. Engine selection
- **Config:** `VisualVerifyConfig.mobileDriveEngine: 'auto'|'xcode'|'maestro'|'none'` (default `'auto'`). Floor it in `configManager.getVisualVerifyConfig` and extend the resolved config.
- **`auto`:** xcode when the probe is `available`/`inconclusive`, otherwise maestro when it resolves with a pin flag, otherwise none.
- **Degrade, never skip.** On any xcode failure (probe, StartSession, `deviceUUID !== udid`), fall back to maestro or none. Record it in provenance (`driveEngineRequested`, `driveEngineUsed`, `degradeReason: 'xcode-approval-missing' | 'xcode-approval-expired' | 'xcode-unavailable' | 'xcode-session-failed'`).
- **Runner changes:**
  - retype `mobileDrive` as `'maestro'|'xcode'|'none'|null` (`verificationAgentRunner.ts:~2546`);
  - set it from the final exported rung;
  - move selection into or right after `buildMobileEnv`;
  - keep the drive coercion keyed strictly on `'none'`.
- When xcode is selected, `mobileSimulatorSession.acquire` requires runtime major ≥ 27 (`minRuntimeMajor`).
- **Concurrency:** assumes `mobileSimSlots=1` (the default). If it is raised, add a count-1 `verify:xcode` lease that leaves the row *queued* on a miss. Never degrade the rung on contention.

### B4. Lifecycle (runner mobile arm)
1. Acquire the simulator (existing flow).
2. **If xcode:**
   - Mint `sessionIdentifier = 'Cyboflow Verify ' + randomBytes(16).hex`. Keep it only in runner memory; log the requestId ↔ (hash of the key), never the key itself.
   - **Write the key into the owner marker** (`owner.json`) *before* StartSession.
   - Spawn one bridge: resolved `xcrun` with `['mcpbridge']`, never a shell.
   - `DeviceInteractionStartSession`. Require `deviceUUID === udid`; otherwise EndSession and degrade.
3. **Drive socket.**
   - Location: `<dataDir>/sockets/xd-<16hex>.sock` inside a 0700 dir. If `sun_path` would exceed 103 bytes, use a 0700 `mkdtemp` under a short tmpdir. Assert the length.
   - Never pre-unlink; fail on EADDRINUSE. Do not change the umask.
   - Every frame carries a per-request bearer token (`VERIFY_XCODE_DRIVE_TOKEN`, compared with `timingSafeEqual`, held in memory only, as in `orchAuthToken.ts`).
   - One request ↔ one session.
   - Protocol: newline-delimited JSON `{token, verb, args}` → `{ok, exit, applicationState?, screenshot?, hierarchy?, pid?, message?}`.
4. Export `VERIFY_MOBILE_DRIVE=xcode`, `VERIFY_XCODE_DRIVE_SOCKET` and `VERIFY_XCODE_DRIVE_TOKEN`.
5. **Verbs** (`driver/mobileCommands.ts`; one engine-neutral meaning per name, B-4):

   | Verb | Behaviour under xcode |
   |---|---|
   | `mobile-capture <name>` | New. Synthesize with **no** command and **no** activation |
   | `mobile-screenshot <name>` | Under xcode, routed through a capture too, so every harness screenshot is a ledger entry |
   | `mobile-tap <text-or-id>` | Existing grammar. Capture first, then resolve label or identifier against that fresh hierarchy's `hitPoint`. None or multiple matches → refuse with a distinct exit code and list the candidates |
   | `mobile-tap --at <x> <y>` | New flag |
   | `mobile-swipe <dir>` | Direction mapped from the window frame |
   | `mobile-swipe --from x1 y1 --to x2 y2 [dur]` | New flag |
   | `mobile-type <text>` | Unchanged grammar, sent as `type` |
   | `mobile-press home\|enter` | Hardware home / `type \u{000A}`. `back` is refused (iOS has none) |
   | `mobile-interact "<raw>"` | New. Raw grammar |
   | `mobile-activate` | New. The only verb that passes `activationBundleId`. Use it after `mobile-press home` or when another app or a system alert covers the target |
   | `mobile-flow` | Refused under xcode (exit 2), with a message pointing at `mobile-interact` |

   Commit a real `hierarchy.txt` fixture from this host plus parser tests.
6. **Pid pinning** (B-5).
   - Under xcode, `mobile-launch` reports its parsed `simctl launch` pid to the runner over the socket. That pid becomes the pin and is logged as a `launch` ledger event.
   - Before each Synthesize the runner checks `isProcessAlive(pin)`.
   - After each Synthesize it parses the `Application, pid: N` line in the `Application bundle identifier: $VERIFY_APP_BUNDLE_ID` block.
   - The verb fails without activating or retrying if the pin is dead, the block is missing, the pid differs, or the state is not `Running`. It exits `MOBILE_EXIT_APP_EXITED = 4` and prints `app-exited pid=<pin> state=<s>` plus the `logsPath` tail.
7. **Mid-run bridge errors** ("Session with that key doesn't exist", "Target device doesn't match…", "isn't approved") → verb exit 2, which is `not_testable`.
8. **`finally`** runs after attestation and before the simulator is disposed. Each step is independent, has a bounded timeout (~10 s), and is **not** bound to `controller.signal`, which the `finally` aborts first:
   1. `DeviceInteractionEndSession`
   2. bridge SIGTERM, then SIGKILL
   3. close and unlink the socket
9. **Sweep.** When `sweepStaleSimulators` finds a dead-owner marker carrying a session key, it spawns one bridge and calls `EndSession(key)` best-effort (short timeout; ignore "doesn't exist" and "isn't approved") before `destroyDevice`. Sweep stale `xd-*` sockets at boot. The claim "device deletion ends a session" is UNVERIFIED until the smoke measures it.

**Threat model** (F11, B-2, B-7). The drive socket is an **ergonomics, audit and ledger boundary, not a security boundary.**
- Xcode approval is keyed on the binary that spawns the bridge.
- Every agent Cyboflow hosts can exec that binary (`ELECTRON_RUN_AS_NODE=1`; the `$VERIFY_DRIVER` wrapper already does). While a grant is live, it can therefore reach all 53 tools on every permitted folder.
- The random key and the token only stop accidental cross-request reach. They are not a sandbox, the same framing as `orchAuthToken.ts:36-42`.
- Evidence integrity rests on the runner-held ledger (B5) plus `bundle-identity`.

### B5. Evidence ledger
The runner records every capture in memory:
- name and the copied file's sha256;
- `applicationState`;
- the foreground bundle id;
- the pid;
- an `activated` flag;
- and every `launch` event.

**Pass evidence.** At report validation, a `pass` behaviour under xcode counts only if it cites at least one screenshot whose sha256 is in the ledger with foreground bundle id `== VERIFY_APP_BUNDLE_ID` and no relaunch since the pinned launch. Otherwise it caps at `low_confidence` (the `uncapped` fold of `evaluateAttestationFloor`), with the reason stated.

The ledger is persisted in `provenance.captureLedger`.

### B6. Maestro `JAVA_HOME`
The harness login shell resolves `java` to the macOS stub `/usr/bin/java`, so `maestro test --help` fails and the rung silently becomes `none`. This was measured: with `JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home`, `--udid` resolves.

The toolchain resolves a JDK home in this order:
1. `/usr/libexec/java_home`
2. `/opt/homebrew/opt/openjdk*/libexec/openjdk.jdk/Contents/Home` (newest)
3. `/usr/local/opt/openjdk*/…`

It exports `JAVA_HOME` for the probe and for the agent env.

### B7. Tests and live smoke
- **Unit tests:**
  - the bridge client over injected stdio (a fake built from the committed `tools_list` dump, so a wrong argument key fails the test);
  - the status-JSON probe matrix;
  - the socket server (token, one session, only Synthesize);
  - verbs, including label resolution, the ambiguity refusal, and exit 4 on pid change or missing block;
  - lifecycle ordering, where an aborted controller still sends EndSession and a throwing step never skips teardown;
  - engine selection and degrade provenance;
  - coercion: xcode does NOT coerce `requiresDrive`; a degraded rung does.
- **Integration test:** an `mcpbridge)` arm in `fixtures/fakeAppleToolchain/xcrun` running a fake stdio JSON-RPC server (writes a PNG and a hierarchy). Modes: ok, approval-refused, device-mismatch, pid-change, block-missing, bridge-killed.
- **Live smoke** (this host, dev build):
  - approve through the B8 action, then have Electron main spawn the bridge;
  - use a harness-created `cyboflow-verify-*` iOS 27 device;
  - run a real verification of Distractodo;
  - measure (a) whether deleting the device ends a session, and (b) the window during which a sessionIdentifier counts as "recently used".
- **Follow-up:** a packaged signed smoke covering durable trust.

### B8. Approval UX
- **"Approve Xcode access"** is a main-process action with a tRPC mutation and a health-row button. It calls `XcodeOpenWorkspace` on a scaffold project under `<dataDir>/xcode-approval/` from the main process, which triggers Xcode's own prompt while the user is present.
- Then read `status --format json` and show the exact command, never running it: `sudo xcrun mcp-server approve <id> --always` for a signed build, or `--for-24-hours` for dev. The interactive prompt remains the fallback.
- **Disclosure copy:** approving Cyboflow approves every agent it hosts (Claude and Codex) for the grant window, and it covers all Xcode tools on permitted folders.
- Never use `--unsafe-always-allow-all-agents`.
- The only folder cyboflow ever causes to be approved is the scaffold.
- Offer durable trust only as an explicit opt-in, with that disclosure.

### B9. Docs
- Correct `mobile-verification-tier.md` §3, §11 and §16 against the Xcode 27 dump. §16's Stage 3 becomes "drive/observe rung shipped; Xcode-built 3b rejected with evidence".
- Add the prerequisites to `VISUAL-VERIFICATION-SETUP.md`: the iOS 27 runtime, headless mode, approval, and `JAVA_HOME`.

## Non-goals
- Loosening the dependency-mutation guard, the **pinned** attestation floor, or `build_failed` classification.
- Migrations: none. Mode, lever source and provenance live in harness-owned JSON. `origin` is free text. The re-dispatch marker is an engine-only `task_json` key. A learned pin is derived from the pinned record.
