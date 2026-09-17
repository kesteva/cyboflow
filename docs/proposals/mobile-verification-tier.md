# Mobile verification tier — iOS Simulator on Apple's own toolchain

Status: PROPOSED (2026-09-17). Follow-up to `verification-setup-flow.md` §4,
which deferred `mobile` with the note "Maestro/mobile deferred — Xcode has a new
MCP coming". That note is now answerable, and the answer is not the one the note
expected: **Apple's Xcode MCP cannot be the mobile tier, on any host, today.**
This proposal ships the tier on `xcodebuild` + `xcrun simctl`, which are present
on the owner's machine right now, and wires the Xcode MCP as an optional,
probe-gated, read-only diagnostic grant that the engine does not depend on.

Synthesized from three competing designs (`apple-native-engine`, `mcp-first`,
`minimal-diff-staged`) and three adversarial judgments (architecture-fit,
hermeticity/security, cost-to-ship). The engine is `apple-native-engine`'s. The
task *shape* is `mcp-first`'s. The v1 *scope cut* is `minimal-diff-staged`'s.
Every `mustFixBeforeBuild` item the judges raised is resolved in §14.

One thing was settled by experiment rather than by argument during this design
pass, and it is the keystone: see §9.1.

---

## 1. Problem

`mobile` has existed as a `VerificationModality` member since the modality axis
landed, and has never been executable. It is refused in three independent
places, each of which must open:

| Gate | Site | Today |
|---|---|---|
| Run-level posture | `verificationPosture.ts:166-168` | unconditional `unavailable`, `MOBILE_DEFERRED_REASON`, zero probes |
| Scheduler gate 1 | `verificationScheduler.ts:150-162`, `:3022-3038` | static `UNSUPPORTED_MODALITY_REASONS.mobile = 'deferred — pending Xcode MCP'`; the doc at `:154-157` says mobile is *unconditional* |
| Runbook contract | `shared/types/verifyRunbook.ts:89-92` | `Extract<VerificationModality, 'web'\|'cdp-app'\|'native-screen'>` — mobile cannot be *declared*, so it can never be *proven* |

And a fourth, subtler refusal that no prior reader mapped: **nothing can stamp a
sprint/ship run `verify_type='mobile-flow'`.** `requestedVerifyType` has zero
producers repo-wide (declared `workflowRegistry.ts:1388`, consumed `:2079`);
`inferTypeFromDeliverable` explicitly refuses to infer it
(`visualVerificationResolver.ts:247-252`); the `type_override` path is fenced
inside `if (isQuickRun && …)` (`mcpQueryHandler.ts:3686`). Fixing only the three
gates would ship an unreachable feature. §7 is the answer.

The precedent to copy is `native-screen`, which is *conditionally* supported on
exactly this shape: a host probe answers "can this machine do it", a runbook
answers "does this project have a proven way to stand itself up", and the only
fall-through is a skip with a legible reason.

---

## 2. Shape in one paragraph

A `mobile` request builds the deliverable with `xcodebuild` inside the detached
snapshot worktree, into a **per-request private DerivedData root**; installs and
launches the built `.app` on a **per-request created iOS Simulator** that the
harness makes and destroys; observes with `xcrun simctl io … screenshot`, which
the existing report path already understands; and is attested by a new sixth
`AttestationSpec` kind, `bundle-identity`, which the **harness** proves for
itself by sha256-comparing the executable it built against the executable
actually installed on the leased device. Driving is a probe-gated rung on
Maestro; absent it, `requiresDrive` behaviors are coerced to
`not_testable (drive-unsupported)`, byte-for-byte the `native-screen`
precedent. The Xcode MCP is granted read-only, behind its own probe *and* a
config flag defaulting to false, and the engine has zero dependency on it.

---

## 3. What the Xcode MCP can and cannot do

This section exists because the owner's stated intent — "add support for the
Xcode MCP as the mobile tier" — **cannot be met literally on any host**, and
that needs saying plainly before any code is written.

**Confirmed, from a real `tools/list` JSON-RPC dump against Xcode 26.3.0 RC1
(20 tools):** `XcodeRead`, `XcodeWrite`, `XcodeUpdate`, `XcodeGrep`,
`XcodeGlob`, `XcodeLS`, `XcodeMakeDir`, `XcodeRM`, `XcodeMV`, `BuildProject`,
`GetBuildLog`, `RunAllTests`, `RunSomeTests`, `GetTestList`,
`XcodeListNavigatorIssues`, `XcodeRefreshCodeIssuesInFile`, `ExecuteSnippet`,
`RenderPreview`, `DocumentationSearch`, `XcodeListWindows`.

| Capability the tier needs | Xcode 26.3 mcpbridge |
|---|---|
| Boot / create / destroy a simulator | **No tool exists** |
| Install an app on a simulator | **No tool exists** |
| Launch an app on a simulator | **No tool exists** |
| Screenshot a *running app* | **No tool exists** (`RenderPreview` snapshots the SwiftUI *Preview canvas*, which can diverge from the running app) |
| Tap / type / swipe / read the UI hierarchy | **No tool exists** |
| Build into a caller-chosen `-derivedDataPath` | **No** — it builds the frontmost window's scheme into Xcode's own DerivedData |
| Target a directory the caller names | **No** — every tool but `XcodeListWindows` takes a `tabIdentifier` naming a window **Xcode.app already has open in the foreground** |
| Read structured build diagnostics | **Yes** — `GetBuildLog`, `XcodeListNavigatorIssues` are genuinely better than parsing `xcodebuild` output |
| Search Apple framework docs while judging | **Yes** — `DocumentationSearch` |

The `tabIdentifier` binding is the disqualifier, not the missing simulator
tools. The verifier builds in a **detached snapshot worktree** that Xcode.app
has never opened. A verdict derived from `BuildProject` would be a statement
about whatever the developer happens to have on screen — including their
uncommitted local edits — presented as a statement about the code under test.
That is precisely the class of failure the whole verification redesign exists to
end, so `BuildProject`/`RunProject`/`RunAllTests`/`RunSomeTests`/`ExecuteSnippet`/
`RenderPreview` and every write tool are on a **hard per-call deny list**, not
merely omitted from an allowlist.

**Xcode 27 changes the picture, but not the ship path.** Xcode 27.0 went GA
on 2026-09-14 (build 27A266a) and its bridge exposes **54 tools** (community
`tools/list` capture of the RC build, same build number as GA). Confirmed
present: `XcodeOpenWorkspace` by **absolute path** with a `workspaceIdentifier`
usable in a **headless mode** (Settings → Intelligence → External Agent Access =
"Always" — tools reachable with Xcode closed, per one secondary source; the
default is still "While Xcode is Open"), `XcodeListRunDestinations` /
`XcodeSwitchRunDestination`, `RunProject` / `StopProject`, `GetConsoleOutput`,
and a `DeviceInteraction*` family (`StartSession` / `StartWorkspaceSession` by
device identifier, `InstallAndRun`, `Synthesize` — tap/swipe/type via a
free-text mini-language returning screenshot + hierarchy + console paths — and
`EndSession`). So on an Xcode 27 host the owner's literal ask — the Xcode MCP
*as* the tier — is plausible for the first time: open the snapshot worktree by
path, start a workspace device session, install-and-run, synthesize, screenshot.

Three reasons this design still ships on the CLI engine first and treats the
Xcode 27 path as **Stage 3, an alternative engine behind the same contracts**:
(1) this host runs Xcode 26.2 and has no `mcpbridge`, so nothing MCP-shaped can
be smoked here today, while every CLI command the engine uses is present;
(2) the headless semantics, the `Synthesize` command grammar, and RC-vs-GA tool
parity are each attested by a single non-Apple source; (3) `InstallAndRun`
builds through Xcode's own DerivedData with no `-derivedDataPath` lever, so §9's
provenance attestation would have to be re-derived from
`xcodebuild -showBuildSettings` of the opened workspace — workable, unproven.
Everything in this proposal that is *not* the stand-up/observe/drive
implementation — the `app` block, `bundle-identity`, the gates, the slot pool,
reachability, the migration, the prompts — is engine-agnostic and is exactly
what a Stage 3 Xcode 27 engine would plug into.

**Additionally, this host cannot test any of it.** Probed live 2026-09-17:
Xcode **26.2 (17C52)**, `xcrun --find mcpbridge` → *unable to find utility*.
Even after an upgrade the user must flip Settings → Intelligence → "Allow
external agents to use Xcode tools", which cyboflow cannot do for them.

**Honest summary:** Apple's own *command-line* toolchain does the work. Apple's
*MCP* is granted where it genuinely helps — turning a failed build into
file-and-line diagnostics — and nowhere else. That is the most of the owner's
intent that reality permits, and the design says so rather than dressing up a
tool grant as a capability.

---

## 4. The roster row

Filling `verification-setup-flow.md` §4's empty `mobile` row:

| | mobile (iOS Simulator) |
|---|---|
| **Build** | `xcodebuild` in the snapshot worktree, into a per-request `-derivedDataPath` |
| **Stand up** | `xcrun simctl install` + `xcrun simctl launch` — **no `serve`**, no port, nothing long-running |
| **Observe** | `xcrun simctl io <udid> screenshot` → flat PNG basenames in `$VERIFY_ARTIFACTS_DIR`; `simctl openurl` is *navigation*, not driving |
| **Drive** | Probe-gated. Maestro present ⇒ tap/type/swipe/press/flow. Absent ⇒ observe-only, `requiresDrive` ⇒ `not_testable (drive-unsupported)` |
| **Host grants** | Xcode command-line tools + ≥1 available iOS runtime + ≥1 compatible device type. **No TCC grant** (contrast `native-screen`) |
| **Optional grant** | `xcrun mcpbridge`, read-only, config default **off**. Adds diagnostics, never capability |
| **Concurrency** | Bounded `verify:mobile:<i>` pool, `mobileSimSlots` default **1**, clamped `Math.max(1, …)` |
| **Isolation** | Simulator **created** per request (not leased from a persisted list); per-request DerivedData; SwiftPM checkouts pinned inside it; `CODE_SIGNING_ALLOWED=NO` |
| **Attestation** | `bundle-identity` — harness-computed byte identity between built and installed executable (§9) |
| **Cost** | A booted simulator (~2 GB) + a cold `xcodebuild` + 1–5 GB of DerivedData per request. Reclaimed in teardown *and* swept at boot |

Non-darwin hosts: every probe answers false and the health row is omitted
entirely, matching the existing TCC-row choice.

---

## 5. Engine

### 5.1 Build — agent Bash, harness-exported levers

The runbook's `build[]` steps run through the agent's Bash inside the
provisioned snapshot, unchanged contract. Canonical form:

```
xcodebuild build -scheme <declared> -configuration Debug -sdk iphonesimulator \
  -destination "id=$VERIFY_SIM_UDID" \
  -derivedDataPath "$VERIFY_DERIVED_DATA" \
  -clonedSourcePackagesDirPath "$VERIFY_DERIVED_DATA/SourcePackages" \
  -skipPackagePluginValidation -skipMacroValidation \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO
xcrun simctl install "$VERIFY_SIM_UDID" "$VERIFY_DERIVED_DATA/Build/Products/Debug-iphonesimulator/<Product>.app"
xcrun simctl launch  "$VERIFY_SIM_UDID" <bundleId>
```

`install` and `launch` are **build steps**, not a `serve`. See §6.2 for why that
is load-bearing rather than cosmetic.

An explicit `-derivedDataPath` does **not** get Xcode's per-workspace path
hashing, so two concurrent lanes sharing one DerivedData corrupt each other —
this is XcodeBuildMCP issue #340, and the per-request root avoids it by
construction. Every mobile build is therefore **cold** by design; warm reuse is
out of scope (§13).

### 5.2 Determinism

On boot the harness runs
`simctl status_bar <udid> override --time 9:41 --batteryState charged --batteryLevel 100 --cellularBars 4`
and `simctl ui <udid> appearance light`, so clock/battery/signal never move a
screenshot between attempts.

### 5.3 Observe

`"$VERIFY_DRIVER" mobile-screenshot <name>` → `simctl io <udid> screenshot
$VERIFY_ARTIFACTS_DIR/<name>`, read back with the agent's Read tool and judged
by the existing path. No new judge, no new artifact shape.

`"$VERIFY_DRIVER" mobile-openurl <url>` → `simctl openurl`. **This is
navigation, not driving.** It routes through the OS's own URL handling, needs no
drive rung, and is stated explicitly in the harness contract so an observe-only
arm does not read as "you may only screenshot the launch screen".

`driverCore.ts:696-706`'s `native-screen` drive refusal gains a `mobile` arm:
`goto/click/type/screenshot` are refused loudly with a message pointing at the
`mobile-*` family, so a confused agent never falls through to a CDP
connect-or-launch against whatever happens to be listening.

### 5.4 Drive — probe-gated, on Maestro

Probed live on this host 2026-09-17: **Maestro 2.3.0** at
`~/.maestro/bin/maestro`, `maestro test --help` prints
`--udid, --device=<deviceId>`, and `openjdk 17.0.18` satisfies its JVM
prerequisite. **AXe, idb and idb_companion are all absent.**

So v1's drive rung is **Maestro**, not AXe — the one drive tool already on the
machine, with the pinning flag verified present in the installed build. The
binary path is resolved **once** at boot and handed to both the capability probe
and the driver as `VERIFY_MAESTRO_BIN`. That is not fastidiousness: `~/.maestro/bin`
is not on a Finder/Dock-launched app's `PATH`, and `index.ts:2543-2551` records
this exact lesson from the 2026-08-05 peekaboo review, where the gate probed a
bundled copy while the driver shelled a bare `PATH` name.

- Present ⇒ `VERIFY_MOBILE_DRIVE=maestro`; the driver exposes `mobile-tap`,
  `mobile-type`, `mobile-swipe`, `mobile-press` (each a one-command generated
  flow) plus `mobile-flow <yaml>` for a multi-step agent-authored flow. Every
  invocation carries `--udid <leasedUdid>`.
- Absent ⇒ `VERIFY_MOBILE_DRIVE=none`; the driver **refuses** every drive
  command loudly, and `coerceDriveUnsupportedBehaviors`
  (`verificationAgentRunner.ts:1426-1450`) coerces every `requiresDrive`
  behavior to `not_testable` whatever the agent claimed. The report then reaches
  `low_confidence` through `mapReportToResult`'s existing
  `anyNotTestable && !anyFail` branch.

The driver resolves the pinning flag once by parsing `maestro --help`,
preferring `--udid`, falling back to `--device`, and **refusing to drive** if
neither is present (observe-only rather than an unpinned flow). Maestro 2.4.0
overhauled device selection; this makes that a degradation, not a silent
mis-targeting of the developer's own simulator.

---

## 6. Contracts that widen

### 6.1 The runbook modality axis — one compile-breaking line, plus two

`shared/types/verifyRunbook.ts` widens in lockstep, and the `Extract` form is
preserved (never re-spelled) so the pinning survives:

```ts
// :89-92 — the deliberately compile-breaking line
export type VerifyRunbookModality = Extract<
  VerificationModality, 'web' | 'cdp-app' | 'native-screen' | 'mobile'>;
// :98-102
export const VERIFY_RUNBOOK_MODALITIES = ['web','cdp-app','native-screen','mobile'] as const;
// :105-107 — hand-written disjunction, one clause added
export function isVerifyRunbookModality(v: unknown): v is VerifyRunbookModality {
  return v === 'web' || v === 'cdp-app' || v === 'native-screen' || v === 'mobile';
}
```

The modality axis itself needs **no change**: `mobile` is already a
`VerificationModality` member, already in `VERIFICATION_MODALITIES`, already
accepted by `isVerificationModality`, already mapped by `resolveTaskModality`
(`visualVerification.ts:1236-1243`), and already accepted and round-tripped by
`parseVerificationTaskV1` (`:640-646` validates, `:738` re-emits). Mobile is
being turned **on**, not added.

### 6.2 The `app` block — a shape discriminant, not a `serve` literal

**This is the single most important graft from the runners-up, and all three
judges converged on it.** `apple-native-engine` proposed
`serve.attach: 'ios-sim'`. That is wrong, for four reasons that compound:

1. `serve`'s contract (`verifyRunbook.ts:128-138`) is "the long-running step
   that makes the deliverable observable". `xcrun simctl launch` prints a PID and
   **exits immediately** — the app runs under the simulator's own launchd.
2. `driverCore.ts:924-951`'s `serveCommand` spawns a detached shell and
   pid-tracks the leader; `reapServe` (`verificationAgentRunner.ts:2763-2769`)
   would kill an already-exited shell and leave the app running regardless.
3. `readyWhen`'s only implemented predicate is HTTP (`urlPath`). With no port
   there is nothing for `readyWhen.timeoutMs` to bound; it degenerates to prose.
4. Patching `taskImpliesServer` (`verificationScheduler.ts:3002-3008`) is **not
   sufficient**: `preflight.ts:303` gates the port-free check on
   `task.serve !== undefined && !isAttachCdp`, so an `ios-sim` task would still
   run a spurious port-free check. (The same design correctly catches and fixes
   the analogous chromium bug 20 lines above, at `:286-288`.)

Instead, `mcp-first`'s first-class block, on **both** `VerificationTaskV1` and
`VerifyRunbookModalityEntry`:

```ts
app?: {
  platform: 'ios-simulator';
  bundleId: string;                // installed, launched, and ATTESTED
  scheme: string;                  // recorded so a human can read the entry
  productGlob?: string;            // rel. to DerivedData; default 'Build/Products/*-iphonesimulator/*.app'
};
```

A mobile entry declares `build[]` + `app` + `attestation` and **omits `serve`
entirely**. Consequences, all free:

- `serve.attach` stays literal-`'cdp'` in **both** hand-rolled parsers
  (`verifyRunbook.ts:138-140`/`:257-263` and `visualVerification.ts:611-617`) —
  untouched.
- `taskImpliesServer` answers false with no carve-out; `VERIFY_PORT` is never
  exported; `preflight.ts:303` skips itself by its existing condition.
- `bundle-identity` is deliberately **not** in `PORT_MEDIATED_CHANNELS`
  (`verificationAgentRunner.ts:1153-1157`), so `serveBindingTarget` (`:1194`)
  returns null and the §7.1 kernel port/process-group binding correctly does not
  apply.
- `bootstrapEligibility.ts:42-43`'s `taskDerivesEnvironment` still returns
  **true** off the non-empty `build[]`, so the §3.2 degrade gate and the runbook
  pin still bind. This is the load-bearing detail and it holds.

`resolveTaskModality` gains one arm — and its **parameter must widen**, which
two of the three source designs read a new field through without noticing:

```ts
export function resolveTaskModality(
  type: VerificationType,
  task: Pick<VerificationTaskV1, 'serve' | 'app'> | null,   // <- widened from 'serve'
): VerificationModality {
  if (type === 'native-desktop') return 'native-screen';
  if (type === 'mobile-flow')    return 'mobile';
  if (task?.app?.platform === 'ios-simulator') return 'mobile';   // NEW
  return task?.serve?.attach === 'cdp' ? 'cdp-app' : 'web';
}
```

Verified: **12** non-definition call sites (8 in `enqueueFromTask.ts`, 2 in
`verificationScheduler.ts`, 1 in `verificationAgentRunner.ts`, 1 in
`mcpQueryHandler.ts`). Mechanical, zero behaviour change, compile-enforced.

### 6.3 Levers

`VerifyRunbookV1['levers']` gains `simUdidEnv?` and `derivedDataEnv?` — **names
only, never values**; a persisted UDID is exactly the resolved value §5.3
forbids. Both must also be added to `parseVerifyRunbookV1`'s string-check field
loop at `verifyRunbook.ts:394`, which is hand-written and does not follow the
shape. The harness always exports `VERIFY_SIM_UDID` and `VERIFY_DERIVED_DATA`;
these levers exist only for a project whose own script insists on its own name.

### 6.4 Worked example

```json
{
  "version": 1,
  "modalities": {
    "mobile": {
      "build": [
        "xcodebuild build -scheme Acme -configuration Debug -sdk iphonesimulator -destination \"id=$VERIFY_SIM_UDID\" -derivedDataPath \"$VERIFY_DERIVED_DATA\" -clonedSourcePackagesDirPath \"$VERIFY_DERIVED_DATA/SourcePackages\" -skipPackagePluginValidation -skipMacroValidation CODE_SIGNING_ALLOWED=NO",
        "xcrun simctl install \"$VERIFY_SIM_UDID\" \"$VERIFY_DERIVED_DATA/Build/Products/Debug-iphonesimulator/Acme.app\"",
        "xcrun simctl launch \"$VERIFY_SIM_UDID\" com.acme.ios"
      ],
      "app": {
        "platform": "ios-simulator",
        "bundleId": "com.acme.ios",
        "scheme": "Acme",
        "productGlob": "Build/Products/Debug-iphonesimulator/Acme.app"
      },
      "attestation": { "kind": "bundle-identity", "bundleId": "com.acme.ios" },
      "notes": "No serve: the app runs inside the leased simulator; there is no port and nothing to attach to. Scheme and product path derived from `xcodebuild -list -json` and `-showBuildSettings -json` (BUILT_PRODUCTS_DIR / FULL_PRODUCT_NAME). Observe with `xcrun simctl io \"$VERIFY_SIM_UDID\" screenshot`."
    }
  }
}
```

---

## 7. Reachability — how a lane ever runs mobile, without hand-edited JSON

Four rungs, in precedence order. The first is the one everything rests on.

**(1) The shape becomes expressible.** `app.platform === 'ios-simulator'` on the
persisted task, derived by `resolveTaskModality`. This is exactly the role
`serve.attach === 'cdp'` plays for `cdp-app`, and it is what makes the stamp
consistent *by construction*: `enqueueFromTask.ts:537` drops any injection whose
`resolveTaskModality(type, merged) !== candidate`, and `:206-229`'s doc explains
that a task-declared `mobile` is ignored today precisely because the row's
modality is re-derived from `(type, task)` at the INSERT. A shape-derived mobile
resolution is one the stamp reproduces.

**(2) Composer declaration.** `declaredWebModality`
(`enqueueFromTask.ts:210-231`) gains a mobile arm symmetric to its web/cdp-app
arm, and `task-verify.md` (sprint **and** ship) gains a fourth "pick the
modality" bullet: declare `"modality": "mobile"` with an `app` block and **no
serve** when the repo carries an `.xcodeproj`/`.xcworkspace`/iOS `Package.swift`
and the behaviours under test are in that app's UI; address behaviours by
on-screen text or accessibility label, never a CSS selector; mark tap/type
behaviours `requiresDrive: true` honestly.

**(3) Record probe — mobile LAST.** `RECORD_PROBE_ORDER`
(`enqueueFromTask.ts:202`) becomes `['cdp-app', 'web', 'mobile']`. The probe is
**first-hit-wins**, so ordering mobile last means no project holding a proven
web or cdp-app record can silently flip. This matters concretely: a React
Native / Expo project legitimately proves **both** a web and a mobile runbook,
and `mcp-first`'s `['cdp-app','mobile','web']` would re-route its undeclared web
lanes to mobile. A regression test pins the both-records case.
`mergeRunbookIntoTask` (`:402-421`) must be taught to carry `entry.app` — it
rebuilds the task field-by-field and would otherwise drop it silently.

**(4) Posture gate.** `verificationPosture.ts:166-168`'s unconditional
short-circuit becomes the structural twin of the `native-desktop` branch
immediately below it (`:169-183`): `await deps.runbookStatus(projectId,
'mobile', worktreePath)`, classified by the same `declineForRunbookStatus`.
This unblocks the two surviving *type* routes — `.cyboflow/verify.json`
`defaultType: 'mobile-flow'` and a quick-run `type_override` — neither of which
a sprint lane needs, but both of which are dead without it.

`verifyConfigLoader.ts` needs **no change**: `defaultType` already flows through
it into the resolver's project rung, and `mobile-flow` is already a valid
`VerificationType`.

---

## 8. Isolation, leases, concurrency

| Lever | Decision | Why |
|---|---|---|
| **Simulator** | `simctl create cyboflow-verify-<req>` per request; destroyed in teardown. `mobileSimTemplate` opt-in clone for pre-seeded state | A leased developer device inherits settings, keychain, granted permissions and other apps — "a verification that inherits state is a verification whose failures are unreproducible". Also closes the empty-candidate-list deadlock *structurally*: there is no persisted UDID list to be empty |
| **Device type / runtime** | Resolved from `simctl list runtimes -j`, **intersected with that runtime's `supportedDeviceTypes`** | Probed live: naively taking the newest `devicetypes` entry yields `iPhone-6s-Plus`, which `simctl create` rejects against iOS 26.2 with `Incompatible device` (code 403). Nothing is hardcoded — "iPhone 17 Pro" is not a stable string |
| **DerivedData** | Fresh empty dir per request under the request's artifacts root, exported as `VERIFY_DERIVED_DATA`, **removed in teardown** | An explicit `-derivedDataPath` gets no per-workspace hashing; sharing one corrupts concurrent lanes (XcodeBuildMCP #340). 1–5 GB per request, so removal is mandatory, not tidy |
| **SwiftPM** | `-clonedSourcePackagesDirPath "$VERIFY_DERIVED_DATA/SourcePackages"` | Package resolution mutates nothing shared |
| **Signing** | `CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO` | Removes the keychain/provisioning dependency entirely for simulator destinations |
| **Persisted state** | **None.** The UDID rides only the in-memory `VerificationAgentRequest` and the agent env | `bindings_json`'s existing HOST-STABLE-only contract already forbids it |
| **Concurrency** | New bounded `verify:mobile:<i>` pool, `mobileSimSlots` default 1, `Math.max(1, Math.floor(…))` | N simulators genuinely run in parallel (unlike the one physical display behind `VERIFY_SCREEN_LEASE`); the bound is host RAM. Acquired in `processAgentRow` in the screen-lease position (`verificationScheduler.ts:3238-3253`), released on every later miss, threaded through `runAgentChosen`, released in its `finally` |
| **Not reused** | `config.simulatorDevices` + `verifySimLease` stay on the legacy path (`verificationScheduler.ts:4352-4362`) | `VISUAL_VERIFY_DEFAULTS.simulatorDevices` is `[]` (`visualVerification.ts:1400`) with no floor; feeding the agent path from it queues every mobile request until the age ceiling terminalizes it — a silent whole-feature outage |

### 8.1 Teardown — both layers, in the right order

```
try { …agent session…; attestation probe… }
finally {
  …stopDriver / reapBrowser / reapServe (existing)…
  simctl terminate <udid> <bundleId>   // best-effort
  simctl shutdown  <udid>              // best-effort
  simctl delete    <udid>              // best-effort
  rm -rf $VERIFY_DERIVED_DATA          // best-effort, bounded to a harness-composed path
  await snapshot.dispose();            // LAST — it is unwrapped
}
```

Two orderings are load-bearing. (a) All of it runs **after** the attestation
probe — `verificationAgentRunner.ts:2735-2745`'s own comment says moving any
teardown earlier "would make every declared channel unprovable and every honest
pass a FAIL". (b) All of it runs **before** `await snapshot.dispose()`, which is
the block's unwrapped last statement: anything appended after it is skipped if
dispose throws.

A `finally` does not run on SIGKILL, an Electron crash or a power loss, so
`XcodeToolchainBackend.sweepStaleSimulators()` runs **once at boot** and deletes
every device named `cyboflow-verify-*` predating this launch. The name prefix is
what makes the sweep safe; it never touches a device the user created.

---

## 9. Attestation — `bundle-identity`

`AttestationSpec` is a closed 5-member union (`visualVerification.ts:508-513`),
`attestation` is **required** on every runbook entry, and
`harnessAttestation.ts:134-202`'s `probeOnce` switches with **no default arm**.
A sixth kind is therefore compile-forced across every co-site — which is exactly
what makes this safe to add:

```ts
| { kind: 'bundle-identity'; bundleId: string; markerPath?: string }
```

The harness proves it for itself, after the agent's session ends and before
teardown, with **no source cooperation**:

1. Glob `$VERIFY_DERIVED_DATA/<productGlob>` — the build output in **this
   request's private, harness-created, initially-empty** dir. Nothing there ⇒
   `verified:false`, detail: *"nothing was built into this request's DerivedData
   — the app on the simulator did not come from this snapshot."*
2. `simctl get_app_container <leasedUdid> <bundleId> app` → the installed path.
3. sha256 the **CFBundleExecutable of each**. Equal ⇒ `verified:true`.
4. Optional, opt-in: when `markerPath` is declared, **also** require this
   request's `VERIFY_ATTEST_NONCE` inside
   `get_app_container … data`/`<markerPath>` — evidence the *running process* is
   this build.

### 9.1 The keystone, settled by experiment

All three designs assumed `xcrun simctl install` preserves the bundle
byte-for-byte, and all three judges flagged the assumption as unproven and
blocking. **It was proven during this design pass, on this host:**

```
built    b10dbb83…4c82  Probe.app/Probe          5e292754…56df  Probe.app/Info.plist
installed b10dbb83…4c82  <container>/Probe        5e292754…56df  <container>/Info.plist
```

(Minimal simulator `.app`, `xcrun -sdk iphonesimulator clang -target
arm64-apple-ios17.0-simulator`, installed onto a freshly created iOS 26.2
device, hashed on both sides; mtimes preserved, i.e. an APFS clone.)
**`simctl install` is byte-preserving on Xcode 26.2 / iOS 26.2.** The channel is
sound. Hash the **executable only** — including `Info.plist`, as `mcp-first`
proposed, adds a normalization failure mode for no identity gain, even though it
happened to hold here.

### 9.2 Why this channel and not the alternatives

| Candidate | Verdict |
|---|---|
| `bundle-identity` (built vs installed hash) | **Chosen.** Harness-computed on both sides. Proves **provenance**: the installed app is the artifact this request built into a dir the harness created empty seconds earlier |
| Agent-written nonce in the `.app` (`minimal-diff-staged`'s `app-container-marker`) | **Rejected as primary.** The agent already holds `VERIFY_ATTEST_NONCE` (`visual-verify.md:29-31`) and writes it with a shell `printf` into a path *it* chose. It proves **freshness**, not provenance: an agent whose build failed, or that used Xcode.app's shared DerivedData, can stamp any `.app` and pass |
| `INFOPLIST_KEY_*` nonce | **Rejected.** Needs `GENERATE_INFOPLIST_FILE=YES` (most real projects ship a checked-in plist) and a read-back path the harness cannot reach without driving |
| `markerPath` data-container nonce | **Kept as an optional second predicate.** Upgrades the claim to the running process, for projects willing to write one line at launch |

**Strength, recorded on the verdict** the way `window-identity` records "weakest
channel": stronger than `window-identity` (byte identity, not a spoofable title
match) on a device created for this request alone — "a stale process" and "the
user's own running app" cannot exist on it. **Residual, stated plainly:** it
proves *what is installed and where it came from*, not that the screenshots were
of its foreground. An optional cheap second predicate
(`$VERIFY_DERIVED_DATA/Logs/Build/*.xcactivitylog` exists, i.e. a real
`xcodebuild` ran in this dir) raises the floor for one line.

`bundle-identity` is deliberately **not** in `PORT_MEDIATED_CHANNELS`, so
`serveBindingTarget` returns null and the §7.1 port binding does not apply.

---

## 10. Failure classes and the two gates

| Condition | Where | Outcome | Class |
|---|---|---|---|
| No mobile probe wired (phase-0 posture) | `verificationScheduler.ts:3022-3038` | `skipped`, the static table detail **byte-for-byte** | `env` |
| Probe says incapable | same | `skipped`, `MOBILE_TOOLCHAIN_UNAVAILABLE_DETAIL` naming the three separable facts (Xcode CLT / an available iOS runtime / a usable device type) | `env` |
| Probe **throws** | same | `skipped`, same detail, same warn log — **fail-closed**; a broken probe must never open onto a 2 GB simulator boot | `env` |
| Project has no proven mobile runbook | gate 3 (§3.2 degrade gate); `verificationPosture.ts` for a `mobile-flow`-stamped run | `skipped` + setup CTA | `env` |
| Simulator create/boot fails | `preflight.ts` `mobile-simulator` check via `prepareSimulator` — a **throw is AFFIRMATIVE failure**, the `checkDataDir` rule (`:205-215`) | `skipped` with the preflight evidence row | `env` |
| Toolchain probe throws at **preflight** | `preflight.ts` `mobile-toolchain` check | `ok:true`, inconclusive — **fail-open**, the `checkNativeCapture` rule | — |
| Drive rung absent, behavior `requiresDrive` | `coerceDriveUnsupportedBehaviors` | `not_testable (drive-unsupported)` ⇒ verdict caps at `low_confidence` | — |
| Built `.app` missing, or hashes differ | `harnessAttestation` `bundle-identity` arm | `verified:false` ⇒ never `passed` | `deliverable` |

The two probe layers keep **opposite, correct** rules: gate 1 fails **closed**
(an unanswerable probe must not lease a simulator); preflight fails **open** (an
unanswerable pre-deploy probe must never be the reason a lane advances on an
unrun verification). The health panel keeps a third: a probe that could not
answer renders `inconclusive`, never `missing`.

### 10.1 Migration 139

`verify_capability_state` "unsupported" marks **never self-clear on a pass** —
only the 24 h TTL or a host-generation bump clears them. Without a reset, an
upgraded install keeps refusing mobile at gate 2 for a full day on a perfectly
capable host:

```sql
DELETE FROM verify_capability_state WHERE modality = 'mobile' AND status = 'unsupported';
```

Verified safe: `095_verify_failure_classes.sql:105-107` declares
`modality TEXT NOT NULL` with the only CHECK on `status`; **no CHECK is
widened**. `138_agent_proposal_create_workflow_kind.sql` is the highest prefix
today, so 139 is free — re-check immediately before committing (this repo has a
documented history of rebase collisions), which is why it is a single-file task.

---

## 11. The Xcode MCP grant (Stage 3 — designed now, default off)

Gated on **two** independent facts: `xcrun --find mcpbridge` succeeds (its own
probe, separate from the engine's toolchain probe) **and**
`mobileXcodeMcpGrant` is true (config default **false**). On this host the first
is false, so the grant never composes and the engine is untouched.

- **Injection:** `mcpServers: { xcode: { type: 'stdio', command: <resolved
  xcrun>, args: ['mcpbridge'] } }`, per request, for a mobile request only.
  `settingSources: []` and `strictMcpConfig: true`
  (`verificationAgentQuery.ts:446-448`) are **unchanged** — `strictMcpConfig`
  disables config-*file* discovery, which `composeMcpServers` already proves
  compatible with a programmatic entry. cyboflow's own MCP server is never in
  the map and there is no code path that could put it there: the grant is
  composed from a closed union in the runner, not from any config file.
- **Allowlist:** `discovered-at-probe-time ∩ our sanctioned read-only list`
  (grafted from `mcp-first`). This fails closed in **both** directions — a
  renamed Apple tool drops out instead of being granted under a stale name, and
  a brand-new Apple tool is never granted until a human sanctions it. A literal
  hardcoded list can do neither.
- **Deny list, per call:** `XcodeWrite`/`XcodeUpdate`/`XcodeRM`/`XcodeMV`/
  `XcodeMakeDir` (the verify agent judges code, it never edits it) and
  `BuildProject`/`RunProject`/`RunAllTests`/`RunSomeTests`/`ExecuteSnippet`/
  `RenderPreview`/`DeviceInteraction*` (§3).
- **Not through agent frontmatter.** `bundledAgentParser.ts:59-62` filters
  `tools:` through the closed `CLI_TOOLS` allowlist with **no error and no
  warning**, so an `mcp__*` name written there is silently dropped. The grant
  travels entirely through the runner's computed tool list plus the query's
  `mcpServers` map. Prompt files are updated for **truth**, never as the grant
  mechanism.
- **Codex runtime:** `codexVerificationAgentQuery` attaches no thread config at
  all. A mobile request resolved to Codex is **refused before deployment** with
  an honest reason rather than deployed grant-less. Note what this does *not*
  cost: the mobile **engine** is Bash + Apple CLIs, so it runs on Codex
  unchanged. Only the optional grant is Claude-only.

### 11.1 The auto-approve trap — closed in Stage 1, while it is inert

`verificationAgentQuery.ts:436` sets `tools: [...allowedTools]` (a hard
*availability* whitelist) and `:441` sets
`allowedTools: allowedTools.filter((t) => t !== 'Bash')` — the SDK's
**auto-approve** list. Any `mcp__*` name would be auto-approved without ever
consulting `canUseTool`, whose `:384` is a bare
`if (toolName !== 'Bash') return { behavior: 'allow', … }`. **Both halves** are
fixed:

```ts
allowedTools: allowedTools.filter((t) => t !== 'Bash' && !t.startsWith('mcp__'))
```

plus an `mcp__` arm in `canUseTool` that logs every call and denies by the
explicit deny list above.

This lands in **Stage 1**, as a standalone commit where it is **provably inert**
(no `mcp__` name reaches that array today, so today's four-tool ceiling produces
byte-identical options), so a later grant physically cannot come down on the
broken filter. It is pinned by a test about the **property**, not the current
list: *for every modality and grant state, no member of the auto-approve list
may start with `mcp__` while the availability list may.*

---

## 12. The enforcement locus — where isolation assertions must live

Judge 2 found the most consequential correction in the set, and it changes where
code goes rather than what it does. `apple-native-engine` put its mobile
isolation assertions (must reference the DerivedData lever and
`-destination id=$<simUdidEnv>`, must carry `CODE_SIGNING_ALLOWED=NO`, must not
contain a literal UDID or absolute path) in `runbookDraftValidation.ts`.

**`validateDraftedRunbook` has exactly one caller:**
`runbookBootstrapRunner.ts:813` — the *lane* bootstrap. The verify-setup flow —
the primary, and in v1 the **only**, mobile authoring path — registers through
`cyboflow_register_verify_runbook` → `runbookStore.registerDraft` →
`parseVerifyRunbookV1`, which validates **shape only** and inspects no commands.
So those assertions would never have run on the path that matters.

They therefore land in `parseModalityEntry` / the `registerDraft` path — the one
chokepoint the MCP tool, the verify-setup flow and the lane bootstrap all funnel
through. A new `'unisolated-command'` rejection kind, enforced for every mobile
entry regardless of who authored it. The attestation (§9) remains the runtime
backstop, so a violation is a `verified:false`, never a false pass — but the
guarantee is now a mechanism at authoring time too.

---

## 13. What is NOT built

- **The Xcode MCP as a build, run or drive path.** §3. Hard per-call deny list.
- **Lane auto-derive for mobile** (grafted from `minimal-diff-staged`). The
  bootstrap gates (`runbookBootstrapRunner.ts:589-594`, `:1078-1083`) are
  generic over `isVerifyRunbookModality` and would "open for free" — which is
  precisely why they are deliberately **re-closed** with a new
  `auto-derive-unsupported` `BootstrapDeclineReason`
  (`bootstrapEligibility.ts:52`). The drafting machinery is entirely npm-shaped:
  `runbookDraftPrompt`'s Rule 1 demands a `package.json` script,
  `runbookDraftValidation` rejects a missing manifest outright, `rung1Operations`
  has only JS/npm-literal operation kinds, and `READ_ONLY_HEADS`
  (`readOnlyCommandGuard.ts:55-93`) has no `xcrun`/`xcodebuild`. Letting mobile
  through would produce confident nonsense. Mobile runbooks come from the
  verify-setup flow. This defers roughly a third of the original plan —
  including opening an `xcrun` escape hatch in an allowlist whose whole
  rationale is that it is an allowlist — without losing a shippable tier.
- **Android.** `mobile` means iOS Simulator. No emulator, no adb, no
  cross-platform abstraction, and no type shaped to leave room for one.
- **Physical iOS devices.** `CODE_SIGNING_ALLOWED=NO` is load-bearing and only
  works for simulator destinations.
- **A CocoaPods / SwiftPM dependency preparer.** `depPreparer` stays npm-family;
  `snapshotProvisioner.ts:201-226` discovers only `node_modules`. `pod install`
  is **forbidden** (§14), so a CocoaPods project must vendor `Pods/` or is
  unsupported in v1. A real scope limit, stated rather than hidden.
- **Warm DerivedData.** Every mobile build is cold by construction, because the
  per-request root is exactly what makes concurrent lanes safe.
- **XCUITest as the drive path.** Authoring test targets into the deliverable is
  something a judging agent must never do, and `.xcresult` attachments are not
  structured data mcpbridge exposes anyway.
- **AXe / idb rungs.** Neither is installed (probed). The drive rung is a seam
  that admits a second implementation; v1 resolves Maestro or nothing.
- **A new `VisualBackendId`.** The inert legacy `'maestro'` id,
  `BACKEND_CAPABILITIES`, `FALLBACK_CHAINS` and `verifySimLease`'s legacy branch
  are left exactly as they are — unreachable on the default chain and not this
  change's business. Only the misleading comments are corrected.
- **A `bumpHostGeneration` caller.** Mobile inherits the existing "you installed
  the thing, still suppressed for 24 h" gap. Migration 139 handles the upgrade
  moment; the general fix is one line that would retroactively fix
  `native-screen` too, which is why it belongs in its own change (§15).
- **Multi-viewport mobile capture.** `viewports` on a mobile entry is accepted
  and ignored: on iOS the meaningful axis is device type, and two device types
  means two simulators and two builds.
- **Simulator video recording.** `simctl io recordVideo` exists, unwired.
- **Playwright e2e for mobile.** The floor is unit tests over injected exec
  seams plus the fake-toolchain itest (§16 T14) plus the live smoke (T16).

---

## 14. Every `mustFixBeforeBuild`, resolved

| # | Judge finding | Resolution |
|---|---|---|
| 1 | **File-size ratchet blocker** — `fileSizeRatchet.test.ts:32-38` caps `verificationScheduler.ts` at 5702, `index.ts` at 7338, `mcpQueryHandler.ts` at 5717; `wc -l` says all three are **exactly** at cap, CI-enforced, with a second assertion blocking shrink-then-grow. No design mentioned it | **Task 0**, before anything else. Extract the mobile gate arm + slot pool + lease block into `verify/mobileGates.ts`; extract the mobile composition (probe construction, binary resolution, three-way dep injection) into `services/visualVerify/mobileComposition.ts`. Lower both caps to the post-extraction sizes in the same commit. The MCP tool edit (§16 T9) touches only its own handler block and must not grow `mcpQueryHandler.ts` |
| 2 | **`simctl install` byte-preservation unproven** | **Proven by experiment**, §9.1. Both executable and Info.plist hash identically. Hash the executable only |
| 3 | **`serve.attach: 'ios-sim'` is a leaky abstraction** | Deleted. First-class `app` block, no `serve` for mobile. §6.2 |
| 4 | **`preflight.ts:303` port-free check would still run** | Dissolved by #3: with no `serve`, the check skips itself by its existing condition. The chromium exemption at `:286-288` still gains `&& modality !== 'mobile'` |
| 5 | **`RECORD_PROBE_ORDER` must keep mobile last** | `['cdp-app','web','mobile']`, with a pinned regression test for a project holding **both** proven records. §7 |
| 6 | **`isNoModalityDeclineReason` silently stops matching** | Verified: `verificationPosture.ts:125-133` matches only `'unsupported modality'` / `'verification runbook'` / `'modality is deferred'`. Today's `MOBILE_DEFERRED_REASON` matches via the third; a native-shaped mirror (`:103-113`) matches **none**. Resolution: word every `mobileRunbookReason` sentence to contain **"verification runbook"** (e.g. *"…the project has no proven mobile verification runbook — run verification setup"*), and pin it with a test that feeds the real production strings through the classifier |
| 7 | **DerivedData never reclaimed** | Removed in the `finally`, **before** `snapshot.dispose()`, with a unit test that the removal runs when the query **throws**. §8.1 |
| 8 | **`resolveTaskModality`'s `Pick` must widen** | `Pick<VerificationTaskV1,'serve'\|'app'>`, **12** verified call sites, swept mechanically with zero behaviour change. §6.2 |
| 9 | **Auto-approve trap, both halves** | Fixed in Stage 1 while inert, pinned by a property test. §11.1 |
| 10 | **Cold-build deadline is unmeasured** | T16's smoke **measures** a real cold `xcodebuild` against `BOOTSTRAP_PROOF_AWAIT_MS` (15 min) and the scheduler's 20-minute ceiling, and sets the mobile deadline floor **once** from that number. Also measured live: creating + first-booting an iPhone-11/iOS-26.2 device took **>2 minutes**, and `simctl get_app_container` against a still-settling device exceeded 120 s twice — so boot must complete via `simctl bootstatus -b` before the attestation, and the attestation probe needs a real deadline plus the existing 3× retry |
| 11 | **Fake-toolchain integration test** | T14, first-class and blocking. Shell shims for `xcodebuild`/`xcrun`/`maestro` on the harness `PATH`; three arms |
| 12 | **Migration number collision risk** | Single-file task (T10), re-checked immediately before committing. Verified no CHECK is widened |
| 13 | **Isolation assertions on an unreachable seam** | Moved to `parseModalityEntry`/`registerDraft`. §12 |
| 14 | **Teardown must precede `snapshot.dispose()`** | §8.1, asserted by test |
| 15 | **Both cleanup layers or neither** | `finally` + boot sweep of `cyboflow-verify-*`. §8.1 |
| 16 | **State the attestation residual on the verdict** | §9.2, the `window-identity` precedent |
| 17 | **Agent-written nonce as provenance** | Rejected as primary; kept as an optional second predicate. §9.2 |
| 18 | **Re-dump mcpbridge before writing a tool contract; grant default off** | §11; both, plus `discovered ∩ allowlist` so a stale name cannot be granted |
| 19 | **Drive: Maestro (present), not AXe (absent)** | §5.4, with the path resolved once as `VERIFY_MAESTRO_BIN` |
| 20 | **`Info.plist` in the hash adds a failure mode** | Executable only, §9.1 |

---

## 15. Decisions for Krishna

| # | Decision | Recommendation |
|---|---|---|
| 1 | **Upgrade this host to Xcode 26.3/27 to get the mcpbridge grant?** | **No — not as a prerequisite, and not soon.** §3 establishes the grant buys diagnostics, never capability, and the whole tier is live-smokable on 26.2 today. Upgrading also costs: 26.3's bridge reportedly omits the MCP-spec `structuredContent` field (which broke at least one client), and the user must additionally flip Settings → Intelligence → External Agent Access by hand. Ship on 26.2; treat the grant as explicitly **unsmoked** in the release notes; revisit when there is a concrete diagnostic pain the build log does not answer |
| 2 | **Drive layer: Maestro, AXe, idb, or observe-only v1?** | **Maestro, probe-gated.** It is the only one installed (2.3.0 at `~/.maestro/bin/maestro`, `--udid` verified present, Java 17.0.18 present), so both arms of the tier are smokable today with zero installs. AXe's capability list is arguably a better fit (address by accessibility id, dump the hierarchy) and it needs no JVM — but it is absent, and choosing it means the drive half ships unexercised. The rung is a seam: adding AXe later is a second probe, not a redesign. If you would rather ship observe-only in v1 and defer drive entirely, that is coherent and cheap — it removes T6's drive half and one probe |
| 3 | **Bundle or `npx` a third-party simulator MCP (XcodeBuildMCP, mobile-mcp, ios-simulator-mcp, `maestro mcp`)?** | **Neither.** Not `npx`: that is a network fetch at runtime inside a hermetic, possibly-offline packaged app, `@latest` cannot be pinned or attested, and this repo already carries the landmine that a PATH-resolved stdio command fails to exec under a Finder launch. Not bundling our own either — `mcp-first` proposed a first-party `sim` server and its isolation reasoning is right, but `driverCore.ts`'s own module doc calls itself "the auditable replacement for a Playwright MCP server the agent would otherwise need", and the same confinement is expressible as `DriverCommand` variants with no new subprocess, no second esbuild entry and no new protocol surface. **Graft `mcp-first`'s invariants as driver tests instead** (§16 T6): an install path must resolve under the request's DerivedData *after realpath* (symlink escape), a screenshot name containing a path separator is refused, and no generated argv can carry a UDID the test did not lease |
| 4 | **v1 scope** | **Observe + probe-gated Maestro drive, no lane auto-derive, grant default off.** Concretely: runbooks come from the verify-setup flow; the drafting agent, `depPreparer`, `snapshotProvisioner`, `rung1Operations` and `readOnlyCommandGuard` are untouched; the Xcode MCP composes on no host until someone turns it on. This is roughly two-thirds of `apple-native-engine`'s original plan and loses nothing a first ship needs |
| 5 | **`mobileSimSlots` default** | **1**, clamped to [1,4]. A booted simulator plus a live `xcodebuild` is the heaviest thing this scheduler starts, and DerivedData is 1–5 GB per slot. The knob exists so it can be raised deliberately |
| 6 | **Simulator: create per request, or lease the developer's?** | **Create.** Hermetic by construction — no inherited settings, keychain, permissions or other apps. `mobileSimTemplate` is the opt-in clone for a project that genuinely needs pre-seeded state (a signed-in account) |
| 7 | **Surface `visualVerify.defaultType` in Settings?** | **Optional, and I now recommend *no*.** After §7 the type stamp is not required to reach mobile; it is a pure override with one producer (a hand-edited `.cyboflow/verify.json`). Adding a run-level type picker would re-introduce a rung the composer already answers better. `apple-native-engine` recommended yes; the `app`-block graft removes its reason |
| 8 | **Grant the Xcode MCP to iOS *implement* lanes too?** | **Not in this change.** Different mechanism entirely (the agent-identity `enabledMcps` / `enabled_mcps_json` axis, with its own validation and single-writer guard), different agent, and **write** tools available. Worth doing; deserves its own review |
| 9 | **First target: pure-native Xcode, or React Native / Expo?** | **Pure native.** It is the strictly harder case (no `package.json` at all), so RN/Expo works as a subset — and RN/Expo is exactly why §7 orders mobile **last** in the record probe. If your real first user is RN, say so: T7's validation work shrinks considerably |
| 10 | **Give `bumpHostGeneration` its first caller here?** | **Split it out.** One line (bump when the toolchain probe observes a changed Xcode version) that would retroactively fix the same "green install, still skipped for a day" gap for `native-screen` and chromium — which is exactly why it should not ride this change |

---

## 16. Staged plan

**Stage 1 — the tier, live-smokable on this host today (everything below).**
Xcode 26.2 ships every command the engine uses; Maestro 2.3.0 is installed; the
iOS 26.2 runtime has 13+ available devices. Both arms — observe and drive — are
exercisable now, with zero installs and no mcpbridge.

**Stage 2 — a second drive backend (AXe or idb), if Maestro's JVM startup
(~3–5 s per invocation) proves painful.** Additive, its own probe, nothing in
Stage 1 is rewritten. `mobile-flow <yaml>` (one invocation, many steps) is the
Stage-1 mitigation.

**Stage 3 — the Xcode MCP, unscheduled.** Blocked on an Xcode ≥26.3 host (for
the read-only diagnostic grant) or an Xcode 27 host (for the `DeviceInteraction*`
engine alternative, §3). Its first step is re-dumping `tools/list` against
whatever build is installed. Default off until it has run against a real bridge.

**Stage 4 — lane auto-derive for mobile, if wanted.** Its own change: the
drafting prompt's Xcode branch, a scheme surveyor, the modality-conditional
validator arm, and `xcrun`/`xcodebuild` heads in `READ_ONLY_HEADS` with
per-subcommand allowlists on the `git` precedent.

---

## 17. Implementation tasks

Sizes: **S** ≤ ~100 lines, **M** ~100–350, **L** > 350 or a new module.
Files are partitioned: **no file appears in two tasks**, so every group below
can run in parallel in one worktree. Per the repo's lane rule, each task runs
only `npx vitest run <its own paths>` from inside `main/` or `frontend/` —
never the full suite — and `pnpm typecheck && pnpm lint && pnpm test:unit` runs
**once**, at T15, over the settled tree.

### Group 0 — must land first, alone

**T0 · Ratchet headroom (M)** — `main/src/__tests__/fileSizeRatchet.test.ts`,
`main/src/orchestrator/verify/mobileGates.ts` (new),
`main/src/services/visualVerify/mobileComposition.ts` (new), plus the extracted
regions of `verificationScheduler.ts` and `index.ts`.
*Acceptance:* `verificationScheduler.ts` and `index.ts` each drop by at least
120 lines through pure extraction with **zero** behaviour change; both caps in
`FROZEN_LINE_CAPS` are lowered to the new sizes in the same commit; the
"no cap more than 2% above the file" assertion passes. `mobileGates.ts` exports
the gate-1 mobile arm, the slot-pool name builder and the lease helper as
injectable functions; `mobileComposition.ts` exports one factory returning the
probe + simulator-session factory + resolved binary paths.
*Tests:* `cd main && npx vitest run src/__tests__/fileSizeRatchet.test.ts src/orchestrator/verify/__tests__/verificationScheduler*.test.ts`

### Group A — contracts (T1 first, then A2/A3 in parallel)

**T1 · Widen the two shared contracts (L)** — `shared/types/verifyRunbook.ts`,
`shared/types/visualVerification.ts`, plus their two schema suites.
*Acceptance:* `VerifyRunbookModality`'s `Extract`, `VERIFY_RUNBOOK_MODALITIES`
and `isVerifyRunbookModality` all include `'mobile'` and stay mutually
consistent. `app?: { platform:'ios-simulator'; bundleId; scheme; productGlob? }`
on **both** `VerificationTaskV1` and `VerifyRunbookModalityEntry`, validated
field-by-field by both hand-rolled parsers with path-named errors. **`serve.attach`
is untouched in both parsers.** `resolveTaskModality`'s param is
`Pick<…,'serve'|'app'>` and it returns `'mobile'` for an `app`-shaped task,
below the two type rules and above the attach rule; all **12** call sites swept
mechanically. `AttestationSpec` gains `bundle-identity` with `isAttestationKind`
and `isAttestationSpec`'s no-default switch widened, and a `mobile` row in the
kind→modality doc table naming its strength **and its residual**. `levers` gains
`simUdidEnv`/`derivedDataEnv`, **including** in `parseVerifyRunbookV1`'s
string-check field loop (`:394`). `VisualVerifyConfig` /
`ResolvedVisualVerifyConfig` / `VISUAL_VERIFY_DEFAULTS` gain `mobileSimSlots`
(1), `mobileSimDeviceType`, `mobileSimRuntime`, `mobileSimTemplate`,
`mobileXcodeMcpGrant` (false); `simulatorDevices`'s doc is marked
legacy-engine-only. `VerifyProbeId` gains `'mobile-simulator'`. Every "deferred
— pending Xcode MCP" sentence in these two files is rewritten. **The rest of the
repo is expected to be red at the end of this task — that is the `Extract`
doing its job.**
*Tests:* `cd main && npx vitest run src/orchestrator/verify/__tests__/runbookHash.test.ts src/orchestrator/verify/__tests__/verificationTaskSchemas.test.ts src/orchestrator/__tests__/visualVerificationTypes.test.ts`

**T2 · Host probe + simulator session (L)** —
`main/src/services/visualVerify/xcodeToolchainBackend.ts` (new),
`main/src/orchestrator/verify/mobileSimulatorSession.ts` (new) + their suites.
*Depends on:* T1.
*Acceptance:* `healthCheck()` **never throws** and is true only when
`xcodebuild` answers, ≥1 **available** iOS runtime exists and ≥1 compatible
device type exists; memoized ~60 s; false on every non-darwin platform.
`probeDetail()` returns the ok/absent/inconclusive shape carrying the Xcode
version, newest runtime, resolved Maestro **absolute** path (or null) and
mcpbridge presence. `resolveMaestroBin()` returns one absolute path, never a
bare name, and is the single source the probe and driver share.
`mcpbridgePresent()` is a **separate** method. `MobileSimulatorSession.acquire()`
resolves identifiers from `simctl list -j` and **intersects the device type
against that runtime's `supportedDeviceTypes`** (a naive newest-first pick
yields `iPhone-6s-Plus`, which `simctl create` rejects against iOS 26.2 with
`Incompatible device`); creates/clones; boots via `bootstatus -b` with a
deadline; applies the status-bar and appearance overrides; provisions an empty
DerivedData dir; returns a handle whose `dispose()` is best-effort and never
throws. `sweepStaleSimulators()` deletes **only** `cyboflow-verify-*` devices.
Both modules take an injected exec dep and import no electron/better-sqlite3.
*Tests:* `cd main && npx vitest run src/services/visualVerify/__tests__/xcodeToolchainBackend.test.ts src/orchestrator/verify/__tests__/mobileSimulatorSession.test.ts`

### Group B — gates and plumbing (parallel after T1; T3 also needs T0)

**T3 · Gates + slot pool (L)** — `main/src/orchestrator/verify/verificationScheduler.ts`,
`main/src/orchestrator/verify/mobileGates.ts`,
`main/src/orchestrator/verify/verificationPosture.ts` + three suites.
*Depends on:* T0, T1.
*Acceptance:* `unsupportedModalityDetail`'s mobile arm: no probe ⇒ the table
detail **byte-for-byte**; true ⇒ null; false **or throwing** ⇒
`MOBILE_TOOLCHAIN_UNAVAILABLE_DETAIL` with the same warn log. Still pre-lease,
still writes `markUnsupported`. A mobile row acquires one `verify:mobile:<i>`
slot from a pool clamped ≥1, in the screen-lease position, releasing the agent
slot on a miss and leaving the row **queued**; the handle is threaded through
`runAgentChosen` and released in its `finally` on **every** exit path.
`resolveVerificationPosture` probes `runbookStatus(projectId,'mobile',worktree)`
instead of short-circuiting; fail-open on throw/null; `MOBILE_DEFERRED_REASON`
is gone. **Every `mobileRunbookReason` sentence contains the literal
"verification runbook"** so `isNoModalityDeclineReason` keeps classifying — with
a test that feeds the real production strings through the classifier.
*Tests:* `cd main && npx vitest run src/orchestrator/verify/__tests__/verificationSchedulerConcurrency.test.ts src/orchestrator/verify/__tests__/verificationSchedulerAgent.test.ts src/orchestrator/verify/__tests__/verificationPosture.test.ts src/orchestrator/verify/__tests__/capabilityStore.test.ts`

**T4 · Preflight (M)** — `main/src/orchestrator/verify/preflight.ts` + suite.
*Depends on:* T1.
*Acceptance:* `PreflightCheckResult.id` gains `'mobile-toolchain'` and
`'mobile-simulator'`. `checkMobileToolchain` runs only for modality `'mobile'`
with a wired probe, fails on an affirmative false, **fail-open** on a throw.
`checkMobileSimulator` runs only when `prepareSimulator` is wired and a **throw
is AFFIRMATIVE failure** (the `checkDataDir` rule at `:205-215`). The chromium
check no longer runs for mobile (`:286-288`). `failureClassifier` is **not**
modified; a failed mobile check classifies `env` through its existing generic
preflight loop. Assert explicitly that **no `port-free` check appears** for a
mobile task (it has no `serve`).
*Tests:* `cd main && npx vitest run src/orchestrator/verify/__tests__/preflight.test.ts src/orchestrator/verify/__tests__/failureClassifier.test.ts`

**T5 · Runner + query + attestation (L)** —
`main/src/orchestrator/verify/verificationAgentRunner.ts`,
`main/src/orchestrator/verify/verificationAgentQuery.ts`,
`main/src/orchestrator/verify/harnessAttestation.ts`,
`main/src/orchestrator/verify/runbookLevers.ts` + four suites.
*Depends on:* T1, T2.
*Acceptance:* A mobile request exports `VERIFY_SIM_UDID` / `VERIFY_SIM_NAME` /
`VERIFY_SIM_RUNTIME` / `VERIFY_DERIVED_DATA` / `VERIFY_MOBILE_DRIVE` /
`VERIFY_MAESTRO_BIN` and binds the two new levers; a non-mobile request exports
**none** of them. The simulator is acquired through the preflight
`prepareSimulator` closure so a boot failure becomes env evidence, and is
terminated + shut down + deleted + its DerivedData removed in the `finally` on
**every** exit path including a throw, **after** the attestation probe and
**before** `await snapshot.dispose()`. `probeOnce` handles `bundle-identity` by
comparing two **executable** sha256s (never `Info.plist`), verified only on
equality, with both paths in the detail and the residual recorded; a missing
built `.app` yields the "did not come from this snapshot" detail. The contract
head carries a MOBILE block documenting both drive arms keyed on
`VERIFY_MOBILE_DRIVE`, and that `simctl openurl` is **navigation, not driving**.
`coerceDriveUnsupportedBehaviors` gains an optional 4th param defaulting to
`modality === 'native-screen'` so the existing test stays green, and the runner
passes the real value. **`mcpServers` is `{}` for every request in Stage 1**;
`settingSources: []` and `strictMcpConfig: true` unchanged. The auto-approve
filter becomes `t !== 'Bash' && !t.startsWith('mcp__')` plus the `canUseTool`
`mcp__` deny arm — **as its own commit**, provably inert.
*Tests:* `cd main && npx vitest run src/orchestrator/verify/__tests__/verificationAgentRunner.test.ts src/orchestrator/verify/__tests__/verificationAgentQuery.test.ts src/orchestrator/verify/__tests__/harnessAttestation.test.ts src/orchestrator/verify/__tests__/runbookLevers.test.ts`
*Highest-value single test in the change:* the property assertion that for every
modality and grant state, **no member of the auto-approve list starts with
`mcp__`** while the availability list may.

**T6 · Driver CLI (L)** — `main/src/orchestrator/verify/driver/driverCore.ts` +
suite.
*Depends on:* T1.
*Acceptance:* `parseArgv` accepts `mobile-screenshot`, `mobile-openurl`,
`mobile-tap`, `mobile-type`, `mobile-swipe`, `mobile-press`, `mobile-flow` and
`attest bundle`; `USAGE` lists them. Under `VERIFY_MODALITY=mobile` the CDP
commands are **refused** with a message pointing at the mobile family, mirroring
`:696-706`. Observe commands work with `VERIFY_MOBILE_DRIVE` unset; every drive
command exits non-zero with a named refusal when it is not `maestro`. The
pinning flag is resolved once from `maestro --help` (prefer `--udid`, fall back
to `--device`, **refuse to drive** if neither). Grafted path confinement: an
install path must resolve under `$VERIFY_DERIVED_DATA` **after `realpath`**
(symlink escape), and a screenshot name containing a path separator is refused.
`ATTEST_KIND_BY_CHANNEL` maps `bundle → bundle-identity`.
*Tests:* `cd main && npx vitest run src/orchestrator/verify/driver/__tests__/driverCore.test.ts`
*Load-bearing case:* no generated simctl or Maestro argv may contain a UDID
other than `VERIFY_SIM_UDID` — an unpinned Maestro run is the one failure that
could drive the user's own simulator.

**T7 · Registration-path isolation guard + dependency guard (M)** —
`main/src/orchestrator/verify/runbookStore.ts`,
`main/src/orchestrator/verify/dependencyCommandGuard.ts` + two suites.
*Depends on:* T1.
*Acceptance:* A new `'unisolated-command'` rejection fires at the
`registerDraft` chokepoint (§12) — **not** in `runbookDraftValidation.ts` —
when a mobile `build[]` step omits the DerivedData lever or
`-destination "id=$<simUdidEnv>"`, omits `CODE_SIGNING_ALLOWED=NO`, or contains
a literal 8-4-4-4-12 UDID or an absolute `-derivedDataPath`.
`FORBIDDEN_DEP_COMMAND_PATTERN` (`dependencyCommandGuard.ts:96-107`) gains
`pod (install|update|repo update)`, `swift package (resolve|update)` and
`xcodebuild … -resolvePackageDependencies`, with a doc paragraph stating why an
ordinary `xcodebuild build` is **not** among them (it resolves into the
request's own clone dir and mutates nothing shared). Widening this one pattern
widens both the enqueue-time and execution-time seams, per the module's own
contract at `:71-74`. `runbookStore`'s two stale "mobile simply misses" comments
are corrected.
*Tests:* `cd main && npx vitest run src/orchestrator/verify/__tests__/runbookStore.test.ts src/orchestrator/verify/__tests__/dependencyCommandGuard.test.ts`

**T8 · Enqueue reachability (M)** —
`main/src/orchestrator/verify/enqueueFromTask.ts` + suite.
*Depends on:* T1.
*Acceptance:* `declaredWebModality` returns `'mobile'` for a task that declares
it **and** expresses it, and for a bare `app.platform === 'ios-simulator'`.
`RECORD_PROBE_ORDER` is `['cdp-app','web','mobile']`. `mergeRunbookIntoTask`
carries `entry.app` with REPLACE semantics. The stamp-consistency guard
(`:537`) **passes** for a record-resolved mobile lane.
*Tests:* `cd main && npx vitest run src/orchestrator/verify/__tests__/enqueueFromTask.test.ts`
*Required regression:* a project with **both** a proven web record and a proven
mobile record still resolves `web` when nothing is declared.

**T9 · MCP tool surface (S)** —
`main/src/orchestrator/mcpServer/toolRegistry/runScopeTools.ts`,
`main/src/orchestrator/mcpServer/mcpQueryHandler.ts` + two suites.
*Depends on:* T1.
*Acceptance:* the `z.enum` at `runScopeTools.ts:644` is **spread from**
`VERIFY_RUNBOOK_MODALITIES` (not re-listed), so this class of drift cannot
recur; its description states mobile's real precondition. The
`invalid_modality` literal at `mcpQueryHandler.ts:4367-4376` is joined from the
same const and the "deliberately NOT accepted" comment is deleted. **Only that
handler block is touched — `mcpQueryHandler.ts` sits at its ratchet cap
(5717/5717); it must not grow.**
*Tests:* `cd main && npx vitest run src/orchestrator/mcpServer/__tests__/cyboflowMcpServer.test.ts src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts src/__tests__/fileSizeRatchet.test.ts`

**T10 · Migration 139 (S)** —
`main/src/database/migrations/139_verify_mobile_capability_reset.sql` only.
*Depends on:* nothing.
*Acceptance:* one idempotent `DELETE`, header comment explaining that
"unsupported" marks never self-clear. No column altered, no CHECK touched, no
`schema.sql` sync. **Re-run `ls main/src/database/migrations/*.sql | sort -V |
tail` immediately before committing** and renumber in isolation if 139 is taken.
*Tests:* `cd main && npx vitest run src/orchestrator/verify/__tests__/capabilityStore.test.ts` then `pnpm run verify:schema`

**T11 · Bootstrap decline (S)** —
`main/src/orchestrator/verify/bootstrapEligibility.ts`,
`main/src/orchestrator/verify/runbookBootstrapRunner.ts` + suite.
*Depends on:* T1.
*Acceptance:* `BootstrapDeclineReason` gains `'auto-derive-unsupported'`. Both
gates (`:589-594` derive, `:1078-1083` reprove) split: an unknown modality still
declines `'undeclarable-modality'`; `'mobile'` declines the new reason naming
the verify-setup flow, spending zero drafts and writing no stamp.
`runbookDraftPrompt.ts`, `runbookDraftValidation.ts`, `rung1Operations.ts`,
`readOnlyCommandGuard.ts`, `depPreparer.ts` and `snapshotProvisioner.ts` are
**untouched** — assert by `git diff --stat`.
*Tests:* `cd main && npx vitest run src/orchestrator/verify/__tests__/runbookBootstrapRunner.test.ts src/orchestrator/verify/__tests__/runbookDraft.test.ts`

### Group C — prompts and docs (parallel with everything; no code deps)

**T12 · Flow prompts, all ten files (M)** — the three sprint/ship agent pairs
(`visual-verify.md`, `task-verify.md`, `runbook-bootstrap.md`), `sprint.md`,
`ship.md`, `verify-setup.md`, `verify-setup/agents/verify-setup.md`.
*Depends on:* nothing.
*Acceptance:* `visual-verify.md` finally supplies the mobile notes its `:22-27`
paragraph has promised since it shipped. `task-verify.md` gains the fourth
modality bullet (the `app` block, **no serve**, accessibility-label targeting,
honest `requiresDrive`). `runbook-bootstrap.md` says mobile is declarable but
**not auto-derivable** by that agent. Both `verify-setup` copies drop "ONLY
these three" / "never declare mobile", say **six** attestation kinds, and
document `bundle-identity` and the two new levers. `sprint.md`/`ship.md` reword
the deferred-mobile sentence. **No `tools:` frontmatter line gains an `mcp__`
name anywhere** (`bundledAgentParser.ts:59-62` drops them silently).
*Tests:* `cd main && npx vitest run src/orchestrator/workflows/__tests__/workflowBundle.builtins.test.ts` **plus** `for f in visual-verify task-verify runbook-bootstrap; do diff -q main/src/orchestrator/workflows/{sprint,ship}/agents/$f.md; done` — must be silent (verified byte-identical today, no shared source).

**T13 · Docs, settings copy, stale comments (M)** —
`docs/proposals/verification-setup-flow.md`,
`docs/proposals/verification-agent-redesign.md`,
`docs/proposals/visual-verification-brittleness-fixes.md`,
`docs/VISUAL-VERIFICATION-SETUP.md`,
`main/src/services/visualVerify/peekabooBackend.ts`,
`frontend/src/components/settings/FeatureControlsSettings.tsx`,
`frontend/src/components/cyboflow/verifyHealthModel.ts`,
`frontend/src/components/cyboflow/workflowEditorOptions.ts`.
*Depends on:* T1 (for `PROBE_LABEL`, which is a compile error until the member
exists).
*Acceptance:* §4's roster row is filled (§4 above is the text); §7.1's channel
table gains `bundle-identity` with its strength **and residual**;
`verification-agent-redesign.md:594-598`'s doubly-stale sentence is fixed;
`visual-verification-brittleness-fixes.md`'s five-rung precedence spec gains the
`app`-shape rung (that doc, not `enqueueFromTask.ts`, is where the precedence is
specified); `VISUAL-VERIFICATION-SETUP.md` gains **one sentence** separating
"cyboflow verifying itself" from the product's mobile modality **without
changing** its still-true claim; `peekabooBackend.ts:44-46` keeps its
`@cyboflow-hidden` marker and loses only the false "mobile-flow remains out of
scope for the agent engine" clause. `PROBE_LABEL` gains
`'mobile-simulator': 'iOS simulator control'`. Settings copy names the
simulator. `MCP_OPTIONS`'s stale `'maestro'` row is left alone for now
(Decision 3) with a corrected comment.
*Tests:* `cd frontend && npx vitest run src/components/cyboflow/__tests__/verifyHealthModel.test.ts`

### Group D — integration, wiring, smoke (serial, at the end)

**T14 · Fake-toolchain integration test (L)** —
`main/src/orchestrator/__tests__/integration/mobileVerification.itest.ts` +
`fixtures/fakeAppleToolchain/`.
*Depends on:* T5, T6.
*Acceptance:* shell shims for `xcodebuild`, `xcrun` and `maestro` on the harness
`PATH`; drives enqueue → gate 1 → preflight → simulator acquire → a mocked agent
session that "builds" and "installs" → `bundle-identity` over two equal hashes →
`passed` → teardown that deletes the fake device **and** its DerivedData.
**Four arms:** (a) happy path; (b) maestro shim removed ⇒ still passes
observe-only with `requiresDrive` coerced to `not_testable`; (c) boot failure ⇒
`skipped` + `failure_class='env'` + the evidence row, never a FAIL; (d) **the
negative attestation case** (grafted from `mcp-first`): the shim installs a
binary built into a *different* DerivedData ⇒ `verified:false` with the "did not
come from this snapshot" detail. Arm (d) is what turns the snapshot-identity
guarantee from a policy into a demonstrated mechanism.
*Tests:* `cd main && npx vitest run src/orchestrator/__tests__/integration/mobileVerification.itest.ts`

**T15 · Composition root (M)** — `main/src/index.ts`,
`main/src/services/visualVerify/mobileComposition.ts`,
`main/src/services/configManager.ts`,
`main/src/orchestrator/trpc/context.ts`,
`main/src/orchestrator/trpc/routers/verificationRequests.ts` + two suites.
*Depends on:* T0, T2, T3, T4, T5.
*Acceptance:* `getVisualVerifyConfig` (`configManager.ts:824-845`) materializes
all five new knobs against `VISUAL_VERIFY_DEFAULTS` — a knob not resolved here
never reaches the scheduler however carefully Settings preserves it. The
toolchain backend and simulator-session factory are constructed **once**,
darwin-gated, from `mobileComposition.ts`; the Maestro path is resolved **once**
and the same value reaches the probe and `VERIFY_MAESTRO_BIN`; the **same probe
instance** is injected into the scheduler deps, the runner's preflight deps and
the tRPC host-probe surface. `runHostProbes` splices one `'mobile-simulator'`
row following `grantRows`' fail-open discipline (unwired or thrown ⇒
`inconclusive`, never `missing`; `fix: null` — cyboflow can install neither
Xcode nor Maestro), whose detail names the Xcode version, the newest runtime,
whether Maestro resolved, and whether mcpbridge is present. `sweepStaleSimulators()`
runs once at boot. Nothing off darwin constructs a simulator or spawns `xcrun`.
Then the **settled-tree gate, run once:**
`pnpm typecheck && pnpm lint && pnpm test:unit`.
*Tests:* `cd main && npx vitest run src/services/__tests__/configManager.test.ts src/orchestrator/trpc/routers/__tests__/verificationRequests.test.ts`

**T16 · Live smoke on this host (M, manual)** — no source files.
*Depends on:* T14, T15.
*Acceptance,* against a scratch SwiftUI app **outside this repo**, with a
throwaway `CYBOFLOW_DIR`, on Xcode 26.2 with no mcpbridge:
1. the health panel shows `mobile-simulator = ok` with the Xcode version, the
   runtime, "Maestro 2.3.0" and "mcpbridge not found";
2. the verify-setup flow authors, registers and **proves** a mobile runbook —
   real `xcodebuild` into `VERIFY_DERIVED_DATA`, create+boot, install, launch,
   screenshots in the artifacts dir, `bundle-identity` verified;
3. a sprint lane whose task-verify declares `modality: 'mobile'` with an `app`
   block enqueues a row stamped `modality='mobile'`, **pinned** to that runbook
   hash, and reaches a verdict with **no hand-edited JSON anywhere**;
4. **the negative attestation case** — install a same-bundle-id app built into a
   different DerivedData ⇒ `verified:false`;
5. run it **twice**: once with Maestro on `PATH` and once with it hidden — the
   observe-only degradation is the arm that will actually ship to most hosts;
6. **the negative host case** — hide the iOS runtime from the probe: the lane
   must **skip with an actionable reason and a `markUnsupported` ledger row**,
   and must **not hang queued**;
7. teardown leaves no `cyboflow-verify-*` device and no DerivedData outside the
   request dir;
8. **record the cold `xcodebuild` wall time** and set the mobile deadline floor
   and `BOOTSTRAP_PROOF_AWAIT_MS` from that number, once (§14 #10).

No `cyboflow_*` MCP tool is called at any point in T0–T16 — per CLAUDE.md's
two-layers rule, those write to the user's real backlog.

### Parallelism groups

```
T0  ───────────────────────────────────────────►  (alone; ratchet headroom)
        T1  ─────────────────────────────────────►  (alone; leaves the tree red)
             ┌── T2 ──┐
             ├── T3 ──┤   (T3 also needs T0)
             ├── T4 ──┤
             ├── T5 ──┤   (needs T2)
             ├── T6 ──┤
             ├── T7 ──┤
             ├── T8 ──┤
             ├── T9 ──┤
             └── T11 ─┘
  T10 (migration) and T12/T13 (prompts+docs) run from the start, in parallel
  with everything — T13 only needs T1's VerifyProbeId member.
             ┌── T14 ─┐   (needs T5, T6)
             └── T15 ─┘   (needs T0,T2,T3,T4,T5) → settled-tree gate
                  T16      (manual live smoke)
```

---

## 18. Tests that flip

From the tests-inventory map, re-checked against the final design. "FLIP" = an
existing assertion becomes false; "EXTEND" = still true, needs new siblings.

| File:line | Today | Change | Task |
|---|---|---|---|
| `verificationSchedulerConcurrency.test.ts:524` | "mobile stays unconditionally unsupported even on a capable host"; asserts the probe is never invoked and `error_message` contains "Xcode MCP" | **FLIP** → the four native-screen shapes at `:415-491`: no probe / capable / incapable+ledger / throwing⇒fail-closed. Plus slot-exhaustion and clamp cases | T3 |
| `verificationSchedulerConcurrency.test.ts:507` | native-desktop "no probe wired ⇒ byte-for-byte skip" | **UNAFFECTED** — it is the template for case (1) | T3 |
| `verificationSchedulerAgent.test.ts:909` | mobile-flow skips with "deferred — pending Xcode MCP"; no probe wired | **EXTEND** — the unprobed baseline still skips, but the literal substring must be re-verified against the new reason, and a capable-probe sibling added | T3 |
| `verificationPosture.test.ts:56` | `unavailable` for mobile-flow with **zero** probe calls | **FLIP** → the native-desktop-shaped set: proven ⇒ available; absent/drifted/unobservable ⇒ unavailable-with-reason; throwing ⇒ available; and the probe **is** called | T3 |
| `verificationPosture.test.ts:161` | `isNoModalityDeclineReason` over sample strings | **EXTEND** — feed the **real** `mobileRunbookReason` outputs through it, because a native-shaped mirror would match none of the three substrings (§14 #6) | T3 |
| `capabilityStore.test.ts:185` | `markUnsupported(1,'mobile','deferred — pending Xcode MCP')` | **UNAFFECTED** mechanically; swap the stale illustrative literal. Add the migration-139 case | T3 / T10 |
| `runbookHash.test.ts:45` | pins the 3-member `VERIFY_RUNBOOK_MODALITIES` and `isVerifyRunbookModality('mobile') === false` | **FLIP** → 4 members, `true` | T1 |
| `runbookHash.test.ts:94` | error literal `'modalities: expected at least one of web\|cdp-app\|native-screen'`; mobile-only map ⇒ `ok:false` | **FLIP both halves** → the literal gains `\|mobile` (free — it is joined off the const), and the mobile-only map parses `ok:true` given an `app` block + a `bundle-identity` attestation | T1 |
| `runbookDraft.test.ts:83` | `parseRunbookDraftResult(draft({modality:'mobile'})).ok === false` | **FLIP** → `true` for a well-shaped draft, plus a genuinely-invalid-modality negative control | T11 |
| `runbookBootstrapRunner.test.ts:271` | derive path declines mobile `'undeclarable-modality'`, zero drafts | **FLIP** → declines `'auto-derive-unsupported'`, same zero-drafts/no-stamp assertions (§13) | T11 |
| `runbookBootstrapRunner.test.ts:1055` | reprove twin of the above | **FLIP**, same rewrite | T11 |
| `runbookStore.test.ts:815` | "refuses a modality the runbook never declared — including the §4-deferred mobile" | **EXTEND** — the negative half stays true (the fixture declares no mobile); reword the stale comment; add a fixture that **does** declare mobile and registers successfully, plus the new `'unisolated-command'` rejections | T7 |
| `verificationAgentRunner.test.ts:1158` | `coerceDriveUnsupportedBehaviors` "is a no-op on every modality but native-screen", parametrized over `['web','cdp-app','mobile']` | **FLIP** — drop `'mobile'` from the no-op list; add a case asserting a `requiresDrive` behavior **is** coerced under mobile when the drive rung is absent, and is **not** when present. (Vacuous today: no mobile request has ever reached the runner) | T5 |
| `verificationAgentRunner.test.ts:1066` | "NEVER logs a mismatch for native-screen/mobile — structurally underivable from a task" | **FLIP the rationale, keep the assertion** — mobile becomes derivable from the `app` shape, so the carve-out is now deliberate rather than structural; reword and keep green | T5 |
| `preflight.test.ts:206` | `'native-capture'` runs only for native-screen, absent for `['web','cdp-app','mobile']` | **UNAFFECTED**; **EXTEND** with sibling describes for `'mobile-toolchain'` and `'mobile-simulator'`, plus an explicit "no `chromium` and no `port-free` check for a mobile task" | T4 |
| `verificationTaskSchemas.test.ts:186` | round-trips every `VerificationModality` including `'mobile'` | **UNAFFECTED**; **EXTEND** with `app`-block round-trip and a bad-`platform` rejection | T1 |
| `cyboflowMcpServer.test.ts:884` | modality enum deep-equals `['web','cdp-app','native-screen']`, title "three declarable modalities" | **FLIP** → four, title updated | T9 |
| `cyboflowMcpServer.test.ts:919` | `callTool(..., {modality:'mobile'})` ⇒ `invalid_arguments` | **FLIP** → swap for a genuinely invalid string (`'android'`); add a positive mobile case | T9 |
| `mcpQueryHandler.test.ts:7266` | `{modality:'mobile'}` rejected before any file read | **FLIP** → swap the sample; add a case proving a mobile registration reaches the file read | T9 |
| `enqueueFromTask.test.ts:1092` | `{ 'mobile-flow' → mobile' }` in the precedence table | **UNAFFECTED**; **EXTEND** with the `app`-shape rows and the both-records regression | T8 |
| `visualVerificationResolver.test.ts:322` | title claims mobile but the loop omits `'mobile-flow'` | **EXTEND** — add it; pre-existing gap worth closing here | T13 |
| `visualVerificationTypes.test.ts:26/63/113` | legacy `'maestro'` `VisualBackendId`, `BACKEND_CAPABILITIES`, `FALLBACK_CHAINS` | **UNAFFECTED** — the legacy waterfall is deliberately untouched (§13) | — |
| `workflowController.verificationPosture.test.ts:189/264` | fixture reason strings mentioning mobile | **UNAFFECTED** — generic collapsing over any `unavailable` reason; stale flavor text only | — |
| `fileSizeRatchet.test.ts:32-38` | caps at 5702 / 7338 / 5717, all **exactly** at file size | **FLIP** — lower `verificationScheduler.ts` and `index.ts` to their post-extraction sizes | T0 |

---

## 19. Risks

| Risk | Mitigation |
|---|---|
| **A cold Xcode build blows the deadline.** Default agent deadline 10 min, scheduler ceiling 20 min, `BOOTSTRAP_PROOF_AWAIT_MS` 15 min. A proof that times out is indistinguishable from a runbook that does not work | Cheapest-real-build flags (Debug, iphonesimulator, `CODE_SIGNING_ALLOWED=NO`, skip-package-plugin/macro validation); a mobile-specific **deadline floor** rather than trusting the composer's `timeoutMs` (the F2/RC5 lesson); and T16 **measures** the real number on this host and sets it once rather than guessing twice |
| **Cold simulator boot is slow.** Measured live: creating + first-booting an iPhone-11/iOS-26.2 device took **>2 min**, and `simctl get_app_container` against a still-settling device exceeded 120 s twice while the on-disk path resolved instantly | `bootstatus -b` with an explicit deadline completes **before** the agent session; the attestation probe gets a real timeout plus `harnessAttestation`'s existing 3× retry; a boot that exceeds the deadline is a preflight `env` skip, never a FAIL |
| **Device-type / runtime identifier drift.** "iPhone 17 Pro" is not a stable string; a naive newest-first pick fails with `Incompatible device` (observed) | Nothing hardcoded. Identifiers resolved from `simctl list -j` and **intersected with the runtime's own `supportedDeviceTypes`**. A host where no pair resolves fails the **probe** — a clean pre-lease gate-1 skip with an actionable reason, not a failure discovered after a lease and ten minutes |
| **Maestro flag drift.** 2.4.0 overhauled device selection | The driver parses `maestro --help` once, prefers `--udid`, falls back to `--device`, and **refuses to drive** if neither exists (observe-only, not unpinned). Pinned by a test that no generated argv can carry another UDID |
| **Maestro's JVM startup** (~3–5 s per invocation) inside a strained deadline | `mobile-flow <yaml>` runs a multi-step flow in **one** invocation and the contract tells the agent to prefer it. Java absent ⇒ the probe reports no drive rung and mobile degrades to observe-only rather than failing |
| **Simulator and disk leak on SIGKILL** | Two layers: the `finally` for the normal path, `sweepStaleSimulators()` at boot for the hard kill. DerivedData lives under the request's own artifacts root, so the recursive remove is bounded to a harness-composed path |
| **`bundle-identity`'s residual** — proves what is installed, not that the screenshots were of its foreground | Recorded on the verdict, the `window-identity` precedent. Materially narrower than `window-identity`'s because the device was created seconds earlier for this request alone. Optional `markerPath` and `xcactivitylog` predicates raise the floor |
| **The mcpbridge grant ships unsmoked** | Structurally uncoupled: the engine has zero dependency, the grant sits behind its own probe **and** a config flag defaulting to false, its allowlist is `discovered ∩ sanctioned` so a nonexistent name resolves to nothing, and its tests use a fake stdio server. Re-dump `tools/list` before flipping the default |
| **The auto-approve trap re-opens in a year** | Fixed at the root and pinned by a **property** test, not a list test |
| **Migration 139 collides on rebase** | Single-file task, re-checked immediately before committing |
| **A composer declares mobile on a project that is not one** | It cannot produce a pass. Gate 3 binds (`taskDerivesEnvironment` is true off `build[]`), finds no proven mobile runbook, and skips with a setup CTA. The prompt conditions the declaration on repository evidence |
| **T1 leaves the tree red and nine tasks fan out from it** | Deliberate — the `Extract` exists so widening is a compile error, not a silent divergence. T1 carries no behaviour change, so each downstream lane's targeted `npx vitest run <its own paths>` is still readable |
