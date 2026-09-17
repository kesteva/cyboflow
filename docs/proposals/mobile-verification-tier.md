# Mobile verification tier — iOS Simulator on Apple's own toolchain

Status: PROPOSED (2026-09-17), revised after Codex adversarial review round 1
(§20). Follow-up to `verification-setup-flow.md` §4, which deferred `mobile`
with the note "Maestro/mobile deferred — Xcode has a new MCP coming". That note
is now answerable, and the answer is not the one the note expected: **Apple's
Xcode MCP cannot be the mobile tier, on any host, today.** This proposal ships
the tier on `xcodebuild` + `xcrun simctl`, which are present on the owner's
machine right now. **Stage 1 ships no Xcode MCP grant of any kind** — not a
flag, not a probe, not a tool map. The MCP cannot create, boot, install, launch,
screenshot or drive a simulator (§3), so a grant would be dead plumbing with no
capability behind it.

Synthesized from three competing designs (`apple-native-engine`, `mcp-first`,
`minimal-diff-staged`) and three adversarial judgments (architecture-fit,
hermeticity/security, cost-to-ship). The engine is `apple-native-engine`'s. The
task *shape* is `mcp-first`'s. The v1 *scope cut* is `minimal-diff-staged`'s.
Every `mustFixBeforeBuild` item the judges raised is resolved in §14; every
Codex round-1 finding is dispositioned in §20.

One thing was settled by experiment rather than by argument during this design
pass, and it is the keystone: see §9.1. One thing the review corrected and this
document now states plainly: what §9 proves is **staged-artifact identity**, not
build provenance (§9, B1).

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
producers repo-wide — the field is declared at `workflowRegistry.ts:1388` and
consumed at `:2079`, and the zero-producer half rests on a repo-wide grep for
the identifier, not on those two lines alone; `inferTypeFromDeliverable`
explicitly refuses to infer it (`visualVerificationResolver.ts:247-252`, which
supports "not inferred here" and nothing wider); the `type_override` path is fenced
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
launches the staged `.app` on a **per-request created iOS Simulator** that the
harness makes and destroys, through two **harness-owned driver commands**
(`mobile-install`, `mobile-launch`) rather than agent-authored shell, so the
confinement rules and the readiness wait are mechanism and not prose; waits for
a bounded first-frame readiness condition before any capture; observes with
`xcrun simctl io … screenshot`, which the existing report path already
understands; and is attested by a new sixth `AttestationSpec` kind,
`bundle-identity`, which the **harness** proves for itself by sha256-comparing
the executable staged under this request's private DerivedData against the
executable actually installed on the leased device. Driving is a probe-gated
rung on Maestro; absent it, `requiresDrive` behaviors are coerced to
`not_testable (drive-unsupported)`, byte-for-byte the `native-screen`
precedent. No MCP server is granted to a mobile request: `mcpServers` stays
`{}`, exactly as it is for every other modality today.

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

Three reasons this design ships on the CLI engine and defers the Xcode 27 path
to **Stage 3 as a separate engine adapter** (M8): (1) this host runs Xcode 26.2
and has no `mcpbridge`, so nothing MCP-shaped can be smoked here today, while
every CLI command the engine uses is present; (2) the headless semantics, the
`Synthesize` command grammar, and RC-vs-GA tool parity are each attested by a
single non-Apple source; (3) `InstallAndRun` builds through Xcode's own
DerivedData with no `-derivedDataPath` lever.

That third point is not a detail to be patched later — it is why the Xcode 27
path is a **different engine, not a different transport for this one**. A
`DeviceInteraction` engine would need its own build-artifact identity (Xcode
manages the DerivedData, so `$VERIFY_DERIVED_DATA/<productGlob>` does not exist
and §9's comparison has nothing to stand on), its own session lease and
lifetime (a `StartWorkspaceSession`/`EndSession` pair against a long-lived
Xcode process is nothing like a disposable `simctl` device), its own readiness
signal, its own cleanup, and its own attestation kind. The `app` block as
specified here also carries no project/workspace path, configuration,
destination, session identity or engine selector, so it does not describe an
Xcode-driven run. What a Stage 3 adapter **would** reuse is narrow and worth
naming: the `app` block's *naming of the deliverable* (bundle id, scheme), the
three gates, the `verify:mobile:<i>` slot pool, and migration 139. Everything
else it would bring itself. This document does not claim engine-agnostic
contracts and does not design that adapter.

**Additionally, this host cannot test any of it.** Probed live 2026-09-17:
Xcode **26.2 (17C52)**, `xcrun --find mcpbridge` → *unable to find utility*.
Even after an upgrade the user must flip Settings → Intelligence → "Allow
external agents to use Xcode tools", which cyboflow cannot do for them. Since
Stage 1 grants no MCP at all, none of that is on the ship path.

**Honest summary:** Apple's own *command-line* toolchain does the work, and
Apple's *MCP* does none of it in Stage 1. The most of the owner's intent that
reality permits is a working tier built on the tools Apple ships on the command
line, plus §11's design record for the day an Xcode 27 host makes a second
engine worth writing. The design says so rather than dressing up a tool grant
as a capability.

---

## 4. The roster row

Filling `verification-setup-flow.md` §4's empty `mobile` row:

| | mobile (iOS Simulator) |
|---|---|
| **Build** | `xcodebuild` in the snapshot worktree, into a per-request `-derivedDataPath`. One `build[]` step, run by the agent through Bash exactly as every other modality's build is |
| **Stand up** | The harness-owned driver commands `mobile-install` and `mobile-launch` (§5.1.1), the second of which waits for first-frame readiness (§5.5). **No `serve`**, no port, nothing long-running |
| **Observe** | `xcrun simctl io <udid> screenshot` → flat PNG basenames in `$VERIFY_ARTIFACTS_DIR`; `simctl openurl` is *navigation*, not driving |
| **Drive** | Probe-gated. Maestro present ⇒ tap/type/swipe/press/flow. Absent ⇒ observe-only, `requiresDrive` ⇒ `not_testable (drive-unsupported)` |
| **Host grants** | Xcode command-line tools + ≥1 available iOS runtime + ≥1 compatible device type. **No TCC grant** (contrast `native-screen`). **No MCP grant** |
| **Ports** | **None.** Mobile takes no port lease at all: `verifyPort` and `verifyDriverPort` are both null and both preflight port checks are skipped (§8, M1) |
| **Concurrency** | Bounded `verify:mobile:<i>` pool, `mobileSimSlots` default **1**, clamped to [1,4] |
| **Isolation** | Simulator **created fresh** per request — never leased from a persisted list, never cloned from a template; per-request DerivedData; SwiftPM checkouts pinned inside it; `CODE_SIGNING_ALLOWED=NO` |
| **Attestation** | `bundle-identity` — harness-computed byte identity between the **staged** and installed executable, plus bundle-id and realpath-confinement checks (§9) |
| **Cost** | A booted simulator (~2 GB) + a cold `xcodebuild` + 1–5 GB of DerivedData per request. Reclaimed in teardown *and* swept at boot |

Non-darwin hosts: every probe answers false and the health row is omitted
entirely, matching the existing TCC-row choice.

---

## 5. Engine

### 5.1 Build — agent Bash, harness-exported levers

The runbook's `build[]` steps run through the agent's Bash inside the
provisioned snapshot, unchanged contract — the same channel every web modality
uses (`visual-verify.md:75`, "Run the task's `build` steps in order"). For
mobile, `build[]` is **exactly one line**:

```
xcodebuild build -scheme <declared> -configuration Debug -sdk iphonesimulator \
  -destination "id=$VERIFY_SIM_UDID" \
  -derivedDataPath "$VERIFY_DERIVED_DATA" \
  -clonedSourcePackagesDirPath "$VERIFY_DERIVED_DATA/SourcePackages" \
  -skipPackagePluginValidation -skipMacroValidation \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO
```

Install and launch are deliberately **not** in `build[]` any more. They moved
into two harness-owned driver commands (§5.1.1) because every invariant worth
having about them — exactly one product, no symlink escape, the bundle id
actually matches, the first frame has rendered — is a mechanism the harness can
enforce and a prose instruction the agent can quietly not follow.

An explicit `-derivedDataPath` does **not** get Xcode's per-workspace path
hashing, so two concurrent lanes sharing one DerivedData corrupt each other —
this is XcodeBuildMCP issue #340, and the per-request root avoids it by
construction. Every mobile build is therefore **cold** by design; warm reuse is
out of scope (§13).

### 5.1.1 Install and launch — harness-owned driver commands

Both are `$VERIFY_DRIVER` subcommands (T6), agent-triggered but
harness-implemented. The agent runs them; it does not compose their argv.

**`mobile-install`**, in order, refusing loudly at the first failure:

1. Glob `$VERIFY_DERIVED_DATA/<productGlob>` and require **exactly one** match.
   Zero or more than one ⇒ non-zero exit with a named refusal. An ambiguous
   product is how the harness ends up hashing the wrong executable (M11).
2. `realpath` the match and require it to resolve **under**
   `$VERIFY_DERIVED_DATA`. A symlink or `..` escape is refused — this is the
   path by which a prebuilt app outside the request dir would otherwise be
   reachable.
3. Read `Info.plist` via `plutil -convert json -o -`. `CFBundleIdentifier` must
   equal `VERIFY_APP_BUNDLE_ID`; `CFBundleExecutable` names the binary to hash.
4. sha256 that executable.
5. `xcrun simctl install "$VERIFY_SIM_UDID" <app>`.
6. `xcrun simctl get_app_container "$VERIFY_SIM_UDID" <bundleId> app` → sha256
   the installed executable.
7. Write `$VERIFY_ARTIFACTS_DIR/mobile-install.json`:
   `{ builtPath, installedPath, builtSha256, installedSha256, bundleId }`.

The command **refuses to install anything not under DerivedData**. That refusal
is the confinement, and it is testable (T6).

**`mobile-launch`**: `xcrun simctl launch "$VERIFY_SIM_UDID"
"$VERIFY_APP_BUNDLE_ID"` → a pid, then the readiness phase of §5.5.

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

### 5.5 Readiness — the missing contract, now harness-owned

`readyWhen`'s only implemented predicate is HTTP, and mobile has no port, so
there is nothing for the existing readiness machinery to bind to. The existing
prose contract is worse than nothing here: `visual-verify.md:79` tells the agent
readiness "is still your call", based on `serve.readyWhen`. A mobile agent
reading that has no predicate to poll and will either capture immediately or
invent a `sleep`. The design pass's own probe caught the failure mode directly:
a screenshot taken three seconds after `simctl launch` was still blank.

`mobile-launch` therefore owns readiness. After the launch returns a pid, it
polls every **500 ms** until both hold:

- the pid is still alive (`process.kill(pid, 0)` does not throw); and
- two **consecutive** `simctl io screenshot` frames are byte-identical **and**
  the frame is not a uniform single-colour image.

The non-uniformity check is deliberately cheap — sample a grid of pixels through
the existing PNG decode path, or compare against a solid-frame heuristic; the
implementer picks, and unit-tests it against fixture PNGs (T6). The whole phase
is bounded by `VERIFY_MOBILE_READY_TIMEOUT_MS`, default **90 000**.

On timeout: exit code **3**, a structured `readiness-timeout` line on stderr,
and the last frame kept as `readiness-last-frame.png` in the artifacts dir so
the timeout is diagnosable rather than merely reported. The harness contract's
MOBILE block tells the agent that a readiness timeout is reported as
`not_testable (readiness-timeout)` on **every** behavior — never as a fail. A
harness that cannot tell "the app did not render" from "the app rendered the
wrong thing" must not spend the user's trust guessing.

The known false-positive is a legitimately white first screen, which the
stable-frame half of the predicate does not distinguish from a not-yet-rendered
one. That is why the pid-alive check is a conjunct, why the bound is 90 s rather
than 10, and why the timeout is `not_testable` rather than a failure. §19 keeps
the row.

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
2. `driverCore.ts`'s `serveCommand` — the `:924-960` region, detached spawn plus
   pid record — spawns a shell and pid-tracks the leader; `reapServe` (`verificationAgentRunner.ts:2763-2769`)
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
- **But serve-less is not automatically port-less** (M1), and this was the
  review's sharpest catch. Three sites take a port regardless of shape: the
  scheduler's lease at `verificationScheduler.ts:3254-3256` is unconditional,
  it then sets `verifyDriverPort: leasedPort + 1` at `:3506` whatever
  `servesPort` says, and preflight's `driver-port-free` check at
  `preflight.ts:309` is outside every conditional. Left alone, a port-exhausted
  host would leave mobile **queued** with a free simulator slot. So mobile takes
  **no port lease at all**: `verifyPort` and `verifyDriverPort` are both null,
  `VerificationAgentRequest.verifyDriverPort` widens to `number | null`, the
  runner omits `VERIFY_DRIVER_PORT` from the agent env when null, the
  `leasedPort: req.verifyPort ?? req.verifyDriverPort - 1` derivation at
  `verificationAgentRunner.ts:2127` becomes null-safe, `serveBindingTarget`
  takes `driverPort: number | null`, and preflight skips **both** port checks
  when `driverPort === null`.
- `bundle-identity` is deliberately **not** in `PORT_MEDIATED_CHANNELS`
  (`verificationAgentRunner.ts:1153-1157`), so `serveBindingTarget` (`:1187`)
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
        "xcodebuild build -scheme Acme -configuration Debug -sdk iphonesimulator -destination \"id=$VERIFY_SIM_UDID\" -derivedDataPath \"$VERIFY_DERIVED_DATA\" -clonedSourcePackagesDirPath \"$VERIFY_DERIVED_DATA/SourcePackages\" -skipPackagePluginValidation -skipMacroValidation CODE_SIGNING_ALLOWED=NO"
      ],
      "app": {
        "platform": "ios-simulator",
        "bundleId": "com.acme.ios",
        "scheme": "Acme",
        "productGlob": "Build/Products/Debug-iphonesimulator/Acme.app"
      },
      "attestation": { "kind": "bundle-identity", "bundleId": "com.acme.ios" },
      "notes": "No serve: the app runs inside the leased simulator; there is no port and nothing to attach to. Install and launch are NOT build steps — run `\"$VERIFY_DRIVER\" mobile-install` then `\"$VERIFY_DRIVER\" mobile-launch`; the driver enforces the single-product, realpath-confinement and bundle-id checks and waits for first-frame readiness. Scheme and product path derived from `xcodebuild -list -json` and `-showBuildSettings -json` (BUILT_PRODUCTS_DIR / FULL_PRODUCT_NAME). Observe with `\"$VERIFY_DRIVER\" mobile-screenshot <name>`."
    }
  }
}
```

### 6.5 Cross-field invariants — enforced at registration, re-checked at runtime

`app.bundleId`, `app.productGlob` and `attestation.bundleId` are three fields
that can disagree, and a disagreement is how the harness ends up hashing the
wrong executable. They are pinned in both places (M11).

**At registration** (`parseModalityEntry`, the `registerDraft` chokepoint of
§12 — so the MCP tool, the verify-setup flow and the lane bootstrap all get it):

- a `mobile` entry **must** have `app`, **must not** have `serve`, and **must**
  have `attestation.kind === 'bundle-identity'`;
- when both `app` and a `bundle-identity` attestation are present,
  `app.bundleId === attestation.bundleId` or reject with a path-named error;
- `productGlob` must be **relative**: no leading `/`, no `~`, no `..` segment.

**At runtime**, `mobile-install` re-derives what it can rather than trusting the
declaration: exactly one glob match, realpath confinement under
`$VERIFY_DERIVED_DATA`, and `CFBundleIdentifier === VERIFY_APP_BUNDLE_ID` read
from the staged `Info.plist` before anything is installed (§5.1.1). All four
identities — declared `app.bundleId`, declared `attestation.bundleId`, the
staged bundle's own identifier, and the installed container's identifier — must
agree, and the attestation (§9) checks the last of them again post-session.

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
| **Simulator** | `simctl create cyboflow-verify-<requestId>` per request, **always fresh**; destroyed in teardown. No template clone in Stage 1 | A leased developer device inherits settings, keychain, granted permissions and other apps — "a verification that inherits state is a verification whose failures are unreproducible". A *clone* inherits exactly the same things by design, so `mobileSimTemplate` is dropped (M12): it would be a weakened-isolation mode with no validation and no provenance, sold under the isolation claim. A validated template mode is a possible later addition. Fresh create also closes the empty-candidate-list deadlock *structurally*: there is no persisted UDID list to be empty |
| **Device type / runtime** | Resolved from `simctl list runtimes -j`, **intersected with that runtime's `supportedDeviceTypes`** | Probed live: naively taking the newest `devicetypes` entry yields `iPhone-6s-Plus`, which `simctl create` rejects against iOS 26.2 with `Incompatible device` (code 403). Nothing is hardcoded — "iPhone 17 Pro" is not a stable string |
| **DerivedData** | Fresh empty dir per request at `<dataDir>/verify-mobile/<requestId>/DerivedData`, exported as `VERIFY_DERIVED_DATA`, **removed in teardown** | An explicit `-derivedDataPath` gets no per-workspace hashing; sharing one corrupts concurrent lanes (XcodeBuildMCP #340). 1–5 GB per request, so removal is mandatory, not tidy. The per-request parent dir is also where the ownership marker lives (§8.2) |
| **Acquisition point** | **Inside** the runner's existing `try`, after runbook-pin validation and provider resolution, immediately before the agent query — **not** in preflight | `verificationAgentRunner.ts:2161` calls preflight *before* pin validation, provider resolution, controller creation and the outer `try`, which only begins at `:2299`, and several early returns sit between them. A simulator acquired in preflight leaks on every one of them: pin mismatch, unresolved agent, provider refusal, setup exception (B2). Preflight is therefore **allocation-free** |
| **Ports** | **No lease.** `verifyPort` and `verifyDriverPort` both null; both preflight port checks skipped | §6.2, M1. A port-exhausted host must not queue a mobile row that needs no port |
| **SwiftPM** | `-clonedSourcePackagesDirPath "$VERIFY_DERIVED_DATA/SourcePackages"` | Package resolution mutates nothing shared |
| **Signing** | `CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO` | Removes the keychain/provisioning dependency entirely for simulator destinations |
| **Persisted state** | **None.** The UDID rides only the in-memory `VerificationAgentRequest` and the agent env | `bindings_json`'s existing HOST-STABLE-only contract already forbids it |
| **Concurrency** | New bounded `verify:mobile:<i>` pool, `mobileSimSlots` default 1, clamped to [1,4] | N simulators genuinely run in parallel (unlike the one physical display behind `VERIFY_SCREEN_LEASE`); the bound is host RAM. Acquired in `processAgentRow` in the screen-lease position (`verificationScheduler.ts:3238-3253`), released on every later miss, threaded through `runAgentChosen`, released in its `finally`. The slot bounds *cyboflow's own* simulators; it says nothing about host-global CoreSimulator or `xcodebuild` contention (§15 #5) |
| **Not reused** | `config.simulatorDevices` + `verifySimLease` stay on the legacy path (`verificationScheduler.ts:4352-4362`) | `VISUAL_VERIFY_DEFAULTS.simulatorDevices` is `[]` (`visualVerification.ts:1400`) with no floor; feeding the agent path from it queues every mobile request until the age ceiling terminalizes it — a silent whole-feature outage |

### 8.1 Teardown — in the right order, each step independently caught

```
// inside the runner's existing try, AFTER pin validation + provider resolution:
let sim: MobileSimulatorSession | null = null;
try {
  if (modality === 'mobile') sim = await acquireMobileSession(req);   // rolls itself back on throw
  …agent session…; attestation probe…
} catch (err) { /* an acquire() throw becomes a skipped/env result — see §10 */ }
finally {
  …stopDriver / reapBrowser / reapServe (existing, each already caught)…
  try { simctl terminate <udid> <bundleId> } catch {}
  try { simctl shutdown  <udid> }            catch {}
  try { simctl delete    <udid> }            catch {}
  try { rm -rf <dataDir>/verify-mobile/<requestId> } catch {}   // marker + DerivedData
  if (snapshot) await snapshot.dispose();    // LAST — it is unwrapped
}
```

Three properties are load-bearing. (a) All of it runs **after** the attestation
probe — `verificationAgentRunner.ts:2735-2745`'s own comment says moving any
teardown earlier "would make every declared channel unprovable and every honest
pass a FAIL". (b) All of it runs **before** `await snapshot.dispose()`, which is
the block's unwrapped last statement at `verificationAgentRunner.ts:2770-2772`:
anything appended after it is skipped if dispose throws. (c) **Each mobile step
is independently try/caught**, so a `simctl` that hangs or errors cannot mask
the next step and cannot suppress `snapshot.dispose()` — and, symmetrically, a
throwing dispose cannot be blamed on mobile cleanup that already ran.

`acquire()` is responsible for its own partial state: if it throws after
`simctl create` but before returning a handle, it deletes the device and the
request dir itself. The runner never sees a handle it did not get, so there is
no window where a created device has no owner.

### 8.2 The boot sweep — ownership by marker, not by name

A `finally` does not run on SIGKILL, an Electron crash or a power loss, so a
boot-time sweep is still needed. Sweeping every `cyboflow-verify-*` device, as
the first draft proposed, is **unsafe** (B6): two cyboflow processes share the
host-wide CoreSimulator service, so a dev instance starting while a packaged
instance is mid-verification would delete the live device out from under it.
The same applies across upgrades and across data dirs.

Ownership is therefore proven by a marker, not inferred from the name. Before
`simctl create`, the session writes
`<dataDir>/verify-mobile/<requestId>/owner.json`:

```json
{ "pid": 4711, "pidStartedAt": "Wed Sep 17 09:12:03 2026",
  "simName": "cyboflow-verify-<requestId>", "simUdid": null,
  "requestId": "<requestId>", "createdAt": "2026-09-17T09:12:03.114Z" }
```

`simUdid` is filled in immediately after the create returns. `pidStartedAt`
comes from `ps -o lstart= -p <pid>` (or the process's own start time for self),
which is what makes the marker survive pid reuse.

`sweepStaleSimulators()` at boot iterates `<dataDir>/verify-mobile/*/owner.json`
and treats an owner as **dead** iff `process.kill(pid, 0)` throws `ESRCH`, **or**
the live pid's start time differs from `pidStartedAt`. Only then does it
`simctl shutdown`/`delete` that udid (falling back to the name when `simUdid` is
still null) and `rm -rf` the request dir — so it reclaims **DerivedData as well
as devices**, which a device-only sweep would leak by the gigabyte.

A `cyboflow-verify-*` device with **no visible marker** is **logged and left
alone**. It may belong to a live instance running against a different data dir,
and this sweep cannot see that instance's markers. Leaking a device the user can
delete is strictly better than deleting a device a running verification needs.

---

## 9. Attestation — `bundle-identity`, and exactly what it proves

**The guarantee, stated precisely.** A verified `bundle-identity` says: *the app
installed on the leased simulator is byte-identical to the exactly-one product
staged under this request's private DerivedData; that product's
`CFBundleIdentifier` equals the declared `bundleId`; and the product path
realpath-resolves under `$VERIFY_DERIVED_DATA` with no symlink escape.*

**It does not prove the product was compiled from the snapshot.** The agent runs
`build[]` through Bash — exactly as it does for every web modality
(`visual-verify.md:75`) — so an agent whose build failed could in principle
stage a prebuilt `.app` into the DerivedData root and have both hashes agree.
This channel therefore sits at the **same trust level as `http-endpoint` and
`dom-marker`**: the harness verifies the identity of what was staged, not who
compiled it. Codex B1 is right that the first draft's "provenance" wording
overstated it, and `markerPath` and the `.xcactivitylog` predicate are both
dropped (§9.2) because an agent that holds the nonce and has Bash can forge
either.

What would close it is a **harness-executed build**: the harness spawns
`xcodebuild` itself, observes its exit status, constrains `-derivedDataPath`,
and identifies the produced bundle from its own trusted output. That is named as
the Stage 2 upgrade (§16) rather than smuggled into Stage 1, because it changes
who runs `build[]` for one modality and that is a contract change worth its own
review.

`AttestationSpec` is a closed 5-member union (`visualVerification.ts:508-513`),
`attestation` is **required** on every runbook entry, and
`harnessAttestation.ts:134-202`'s `probeOnce` switches with **no default arm**.
A sixth kind is therefore compile-forced across every co-site — which is exactly
what makes this safe to add. The member is exactly:

```ts
| { kind: 'bundle-identity'; bundleId: string }
```

The harness proves it for itself, after the agent's session ends and before
teardown, with **no source cooperation** and without trusting the driver's own
recorded hashes:

1. Read `$VERIFY_ARTIFACTS_DIR/mobile-install.json` (written by `mobile-install`,
   §5.1.1). Missing ⇒ `verified:false`, detail: *"nothing was installed through
   the driver — `mobile-install` never ran."*
2. Require `builtPath` to realpath-resolve **under** `$VERIFY_DERIVED_DATA` and
   to still be present.
3. `simctl get_app_container <leasedUdid> <bundleId> app` → the installed path;
   require its bundle identifier to equal the declared one.
4. **Re-hash the installed container executable itself.** The recorded
   `installedSha256` is never trusted; it is only cross-checked.
5. `verified:true` iff recorded `builtSha256` === live installed sha ===
   recorded `installedSha256`.

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
| `bundle-identity` (staged vs installed hash, plus bundle-id and confinement) | **Chosen.** Harness-computed on both sides, on a device created for this request alone. Proves **staged-artifact identity**: the installed app is the one product staged under this request's private DerivedData |
| Agent-written nonce in the `.app` (`minimal-diff-staged`'s `app-container-marker`) | **Rejected.** The agent already holds `VERIFY_ATTEST_NONCE` (`visual-verify.md:29-31`) and writes it with a shell `printf` into a path *it* chose. It proves nothing an agent cannot manufacture |
| `INFOPLIST_KEY_*` nonce | **Rejected.** Needs `GENERATE_INFOPLIST_FILE=YES` (most real projects ship a checked-in plist) and a read-back path the harness cannot reach without driving |
| `markerPath` data-container nonce | **Dropped** (was "optional second predicate"). Same forgery as the row above: the agent knows the nonce and has Bash. Not in the `AttestationSpec` member |
| `$VERIFY_DERIVED_DATA/Logs/Build/*.xcactivitylog` existence | **Dropped** (was "a cheap second predicate"). It proves a file of that shape exists, and the agent can copy one. It binds the log to no process, source tree, command, exit status or product |
| Harness-executed build | **Stage 2.** The only candidate that would actually prove compilation provenance. §16 |

**Strength, recorded on the verdict** the way `window-identity` records "weakest
channel": stronger than `window-identity` against *accidental* mis-targeting —
byte identity rather than a spoofable title match, on a device created seconds
earlier for this request alone, where "a stale process" and "the user's own
running app" cannot exist. **Residual, stated plainly, in two parts:** (a) it
does not prove the staged product was compiled from this snapshot — a
sufficiently determined agent could stage a prebuilt bundle (§9, B1); and (b) it
proves what is installed, not that the screenshots were of its foreground. Both
go on the verdict. Neither is dressed up.

`bundle-identity` is deliberately **not** in `PORT_MEDIATED_CHANNELS`, so
`serveBindingTarget` returns null and the §7.1 port binding does not apply.

---

## 10. Failure classes and the two gates

| Condition | Where | Outcome | Class |
|---|---|---|---|
| No mobile probe wired (phase-0 posture) | `verificationScheduler.ts:3022-3038` | `skipped`, the static table detail **byte-for-byte** | `env` |
| Probe says incapable | same | `skipped`, `MOBILE_TOOLCHAIN_UNAVAILABLE_DETAIL` naming the three separable facts (Xcode CLT / an available iOS runtime / a usable device type) | `env` |
| Probe **throws** | same | `skipped`, same detail, same warn log — **fail-closed**; a broken probe must never open onto a 2 GB simulator boot | `env` |
| Project has no proven mobile runbook | gate 3 (§3.2 degrade gate); `verificationPosture.ts` for a `mobile-flow`-stamped run | `skipped` + setup CTA, carrying `declineCode: 'no-verification-runbook'` | `env` |
| Simulator create/boot fails | `acquireMobileSession()` **inside the runner's `try`** (§8), after pin/provider validation | the throw is caught there and returned as `status:'skipped', deployed:false`, carrying a **synthetic** `PreflightCheckResult { id:'mobile-simulator', ok:false, detail }` in `preflight.checks` so the existing classifier reaches `env` with no classifier change | `env` |
| Toolchain probe throws at **preflight** | `preflight.ts` `mobile-toolchain` check — the **only** mobile preflight check | `ok:true`, inconclusive — **fail-open**, the `checkNativeCapture` rule | — |
| Readiness never reached | `mobile-launch`, bounded by `VERIFY_MOBILE_READY_TIMEOUT_MS` (90 s) | exit 3 + `readiness-last-frame.png`; every behavior reported `not_testable (readiness-timeout)` ⇒ verdict caps at `low_confidence`. **Never a fail** | — |
| Drive rung absent, behavior `requiresDrive` | `coerceDriveUnsupportedBehaviors` | `not_testable (drive-unsupported)` ⇒ verdict caps at `low_confidence` | — |
| `mobile-install.json` missing, staged product gone, bundle ids disagree, or hashes differ | `harnessAttestation` `bundle-identity` arm | `verified:false` ⇒ never `passed` | `deliverable` |

There is deliberately **no `mobile-simulator` preflight check**. Preflight is
allocation-free (B2), and the only thing left for it to answer — "can this host
do mobile at all" — is `mobile-toolchain`'s job. The `'mobile-simulator'`
`VerifyProbeId` still exists, for the health panel and for the synthetic check
row above.

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
-- 139_verify_mobile_capability_reset.sql
DELETE FROM verify_capability_state
 WHERE modality = 'mobile' AND status = 'unsupported' AND reason LIKE '%Xcode MCP%';
```

**The reason filter is not decoration** (M7). `capabilityStore.ts:267-284` uses
the same `'unsupported'` status for two different things: the legacy static
"deferred" mark, and an affirmative *this host cannot do it* finding written by
the new probe. An unfiltered `WHERE modality='mobile' AND status='unsupported'`
would delete the second along with the first every time it is reapplied or
renumbered, throwing away legitimate current-host evidence. The legacy reason
literal is exactly `'deferred — pending Xcode MCP'`
(`verificationScheduler.ts:161`), so the `LIKE '%Xcode MCP%'` filter matches it
and nothing the new probe will ever write. The migration header says this.

Verified safe: `095_verify_failure_classes.sql:105-107` declares
`modality TEXT NOT NULL` with the only CHECK on `status`; **no CHECK is
widened**. `138_agent_proposal_create_workflow_kind.sql` is the highest prefix
today, so 139 is free — re-check immediately before committing (this repo has a
documented history of rebase collisions), which is why it is a single-file task.

---

## 11. Stage 3 design notes — the Xcode MCP grant, NOT built in Stage 1

**Nothing in this section ships.** Stage 1 contains no `mobileXcodeMcpGrant`
config knob, no `mcpbridgePresent()` probe method, no health-panel mcpbridge
detail, and no MCP server entry: `mcpServers` is `{}` for every request,
unchanged from today (M2). A flag plus a `xcrun --find` probe with no client
lifecycle behind them is dead plumbing, and "discovered ∩ sanctioned" cannot be
evaluated from `xcrun --find` alone. The section is kept as a **design record**
of what a grant would have to specify, so whoever builds it does not re-derive
it — and so the deny-list reasoning in §3 has somewhere to live.

Whoever builds it owes, at minimum: initializing the bridge, fetching
`tools/list`, mapping raw tool names to SDK names, intersecting and caching by
Xcode build, passing only that map to the query, denying every undeclared MCP
tool, and shutting the process down. None of that is designed here.

The sketch, for the record:

- **Gating:** `xcrun --find mcpbridge` succeeding, **and** an explicit config
  opt-in defaulting to false.
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
  all, so a grant would be Claude-only. That is a Stage 3 concern and nothing
  more. **Codex is never refused a mobile request in Stage 1** — the mobile
  engine is Bash plus Apple CLIs, so it runs on Codex unchanged, and there is no
  grant whose absence could justify a refusal (open question 7).

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

This is the one part of §11 that **does** land in Stage 1 — as a standalone
commit where it is **provably inert**
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

- **Any Xcode MCP grant at all.** Not as a build/run/drive path (§3), and not as
  a read-only diagnostic one either. No config knob, no `mcpbridge` probe, no
  server entry, no allowlist — `mcpServers` is `{}` for every Stage 1 request.
  §11 is a design record, not a plan.
- **Template / cloned simulators.** `mobileSimTemplate` is dropped (M12). A
  clone inherits installed apps, settings, credentials and caches by design,
  which is the opposite of what the isolation claim says. A validated,
  explicitly-weakened template mode is a possible later addition with its own
  provenance checks; it is not Stage 1.
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
| 1 | **File-size ratchet blocker** — `fileSizeRatchet.test.ts:32-38` caps `verificationScheduler.ts` at 5702, `index.ts` at 7338, `mcpQueryHandler.ts` at 5717; `wc -l` says all three are **exactly** at cap, CI-enforced, with a second assertion blocking shrink-then-grow. No design mentioned it | **Task 0**, before anything else — but it cannot extract *mobile* behaviour, because none exists yet (M4). T0 is two named **pure** extractions of existing generic code: the `8353a3a0a` verify/eval composition port for `index.ts`, and the scheduler's module-level pure free functions into `schedulerHelpers.ts`. Lower both caps in the same commits. `mobileGates.ts` and `mobileComposition.ts` are created by T3 and T15. The MCP tool edit (T9) touches only its own handler block and must preserve `mcpQueryHandler.ts`'s exact line count |
| 2 | **`simctl install` byte-preservation unproven** | **Proven by experiment**, §9.1. Both executable and Info.plist hash identically. Hash the executable only. Note what this does and does not license: it makes the install channel a sound *identity* comparison, which is all §9 now claims (B1) — it says nothing about who compiled the staged bundle |
| 3 | **`serve.attach: 'ios-sim'` is a leaky abstraction** | Deleted. First-class `app` block, no `serve` for mobile. §6.2 |
| 4 | **`preflight.ts:303` port-free check would still run** | Half-dissolved by #3, and the other half caught by M1: `port-free` does skip itself with no `serve`, but `driver-port-free` at `:309` is unconditional and the scheduler leases a port anyway. Mobile now takes **no port lease**, `driverPort` is null, and preflight skips **both** checks on null. The chromium exemption at `:286-288` still gains `&& modality !== 'mobile'` |
| 5 | **`RECORD_PROBE_ORDER` must keep mobile last** | `['cdp-app','web','mobile']`, with a pinned regression test for a project holding **both** proven records. §7 |
| 6 | **`isNoModalityDeclineReason` silently stops matching** | Verified: `verificationPosture.ts:126-131` matches only `'unsupported modality'` / `'verification runbook'` / `'modality is deferred'`. Today's `MOBILE_DEFERRED_REASON` matches via the third; a native-shaped mirror (`:103-113`) matches **none**. Pinning the prose would have preserved the brittleness (M6), so the classification is now **structured**: a new `VerificationDeclineCode` rides alongside the reason and `isNoModalityDeclineReason` checks the code when present, falling back to the three substrings only for legacy string callers. Reasons still contain "verification runbook" as belt and braces; the test pins the **code** |
| 7 | **DerivedData never reclaimed** | Removed in the `finally`, **before** `snapshot.dispose()`, with a unit test that the removal runs when the query **throws**. §8.1 |
| 8 | **`resolveTaskModality`'s `Pick` must widen** | `Pick<VerificationTaskV1,'serve'\|'app'>`, **12** verified call sites, swept mechanically with zero behaviour change. §6.2 |
| 9 | **Auto-approve trap, both halves** | Fixed in Stage 1 while inert, pinned by a property test. §11.1 |
| 10 | **Cold-build deadline is unmeasured** | A manual post-gate task cannot change source constants (M9), so the floor is a **config knob set in advance**: `mobileDeadlineFloorMs`, default 15 × 60 000, with the scheduler's `agentDeadlineMs` (`verificationScheduler.ts:3362`) taking `max(existing, floor)` for mobile. `BOOTSTRAP_PROOF_AWAIT_MS` (`runbookBootstrapRunner.ts:106`) is untouched. **T16 only measures** and records the number in a follow-up doc note. Two boot numbers were measured live on this host and **both are real**: the first-ever iPhone-11/iOS-26.2 create+boot exceeded **2 minutes** (cold runtime, first boot on this machine), while a later fresh-device create+boot took **57 s**. Budget for the worse case. Separately, `simctl get_app_container` against a still-settling device exceeded 120 s twice — so boot must complete via `simctl bootstatus -b` before the attestation, and the attestation probe needs a real deadline plus the existing 3× retry |
| 11 | **Fake-toolchain integration test** | T14, first-class and blocking. Shell shims for `xcodebuild`/`xcrun`/`maestro` on the harness `PATH`; three arms |
| 12 | **Migration number collision risk** | Single-file task (T10), re-checked immediately before committing. Verified no CHECK is widened |
| 13 | **Isolation assertions on an unreachable seam** | Moved to `parseModalityEntry`/`registerDraft`. §12 |
| 14 | **Teardown must precede `snapshot.dispose()`** | §8.1, asserted by test |
| 15 | **Both cleanup layers or neither** | `finally` + boot sweep of `cyboflow-verify-*`. §8.1 |
| 16 | **State the attestation residual on the verdict** | §9.2, the `window-identity` precedent — and the residual is now **two** clauses, not one: it proves neither compilation provenance (B1) nor that the screenshots were of the app's foreground |
| 17 | **Agent-written nonce as provenance** | Rejected outright, not "kept as an optional second predicate". The agent holds the nonce and has Bash, so `markerPath` is forgeable and is **dropped from the `AttestationSpec` member**; the `.xcactivitylog` predicate is dropped for the same reason. §9.2 |
| 18 | **Re-dump mcpbridge before writing a tool contract; grant default off** | Superseded by M2: Stage 1 ships **no grant**, so there is no default to set and no tool contract to write. §11 keeps the deny-list reasoning as a design record; re-dumping `tools/list` is the first step of whoever builds Stage 3 |
| 19 | **Drive: Maestro (present), not AXe (absent)** | §5.4, with the path resolved once as `VERIFY_MAESTRO_BIN` |
| 20 | **`Info.plist` in the hash adds a failure mode** | Executable only, §9.1 |

---

## 15. Decisions for Krishna

| # | Decision | Recommendation |
|---|---|---|
| 1 | **Upgrade this host to Xcode 26.3/27?** | **Irrelevant to Stage 1 — so, no.** Stage 1 ships no MCP grant (M2), so an upgrade buys the tier nothing at all: every command the engine uses is present on 26.2 and both arms are smokable today. Upgrading also costs — 26.3's bridge reportedly omits the MCP-spec `structuredContent` field (which broke at least one client), and the user must flip Settings → Intelligence → External Agent Access by hand. The only reason to upgrade is to start **Stage 3**, which is a separate engine adapter (§3, M8) and not scheduled. Nothing in the release notes needs to mention mcpbridge, because nothing ships that touches it |
| 2 | **Drive layer: Maestro, AXe, idb, or observe-only v1?** | **Maestro, probe-gated.** It is the only one installed (2.3.0 at `~/.maestro/bin/maestro`, `--udid` verified present, Java 17.0.18 present), so both arms of the tier are smokable today with zero installs. AXe's capability list is arguably a better fit (address by accessibility id, dump the hierarchy) and it needs no JVM — but it is absent, and choosing it means the drive half ships unexercised. The rung is a seam: adding AXe later is a second probe, not a redesign. If you would rather ship observe-only in v1 and defer drive entirely, that is coherent and cheap — it removes T6's drive half and one probe |
| 3 | **Bundle or `npx` a third-party simulator MCP (XcodeBuildMCP, mobile-mcp, ios-simulator-mcp, `maestro mcp`)?** | **Neither.** Not `npx`: that is a network fetch at runtime inside a hermetic, possibly-offline packaged app, `@latest` cannot be pinned or attested, and this repo already carries the landmine that a PATH-resolved stdio command fails to exec under a Finder launch. Not bundling our own either — `mcp-first` proposed a first-party `sim` server and its isolation reasoning is right, but `driverCore.ts`'s own module doc calls itself "the auditable replacement for a Playwright MCP server the agent would otherwise need", and the same confinement is expressible as `DriverCommand` variants with no new subprocess, no second esbuild entry and no new protocol surface. **Graft `mcp-first`'s invariants as driver tests instead** (§16 T6): an install path must resolve under the request's DerivedData *after realpath* (symlink escape), a screenshot name containing a path separator is refused, and no generated argv can carry a UDID the test did not lease |
| 4 | **v1 scope** | **Observe + probe-gated Maestro drive, no lane auto-derive, no MCP grant.** Concretely: runbooks come from the verify-setup flow; the drafting agent, `depPreparer`, `snapshotProvisioner`, `rung1Operations` and `readOnlyCommandGuard` are untouched; no MCP server is composed for any request on any host. This is roughly two-thirds of `apple-native-engine`'s original plan and loses nothing a first ship needs |
| 5 | **`mobileSimSlots` default** | **1**, clamped to [1,4]. A booted simulator plus a live `xcodebuild` is the heaviest thing this scheduler starts, and DerivedData is 1–5 GB per slot. The knob exists so it can be raised deliberately — but be clear what raising it does **not** buy: per-request DerivedData prevents product collision, and nothing more. Concurrent `xcodebuild`, SwiftPM and CoreSimulator activity contends on host-global state the slot count cannot see, so a max of 4 is a permission, not a reliability claim |
| 6 | **Simulator: create per request, or lease the developer's?** | **Create, fresh, every time.** Hermetic by construction — no inherited settings, keychain, permissions or other apps. The earlier `mobileSimTemplate` clone escape hatch is **dropped** (M12): a clone inherits exactly the state the isolation claim promises is absent, with no template validation and no provenance. A project needing a signed-in account should get a validated weakened-isolation mode later, named as such |
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

**Stage 2 — the harness-executed build, and/or a second drive backend.** Two
independent additions, either orderable first:

- *Harness-executed build (closes the provenance gap).* The harness spawns
  `xcodebuild` itself rather than the agent running it through Bash, observes
  its exit status, constrains `-derivedDataPath`, and identifies the produced
  bundle from its own trusted output. That is what would let §9 claim the app
  was **compiled from this snapshot** instead of merely staged under it (B1).
  It changes who executes `build[]` for one modality, so it wants its own
  review rather than a late graft onto Stage 1.
- *A second drive backend (AXe or idb)*, if Maestro's JVM startup (~3–5 s per
  invocation) proves painful. Additive, its own probe, nothing in Stage 1 is
  rewritten. `mobile-flow <yaml>` (one invocation, many steps) is the Stage-1
  mitigation.

**Stage 3 — an Xcode 27 `DeviceInteraction` engine adapter, unscheduled and
undesigned.** Not "the same contracts on a different transport" (M8): a separate
engine with its own build-artifact identity, its own session lease and lifetime,
its own readiness signal, its own cleanup and its own attestation kind. It would
reuse the `app` block's naming of the deliverable, the three gates, the slot
pool and migration 139, and bring everything else itself. Blocked on an Xcode 27
host; its first step is re-dumping `tools/list` against whatever build is
installed. §11 holds the design notes for the read-only grant, which Stage 1
does not ship in any form.

**Stage 4 — lane auto-derive for mobile, if wanted.** Its own change: the
drafting prompt's Xcode branch, a scheme surveyor, the modality-conditional
validator arm, and `xcrun`/`xcodebuild` heads in `READ_ONLY_HEADS` with
per-subcommand allowlists on the `git` precedent.

---

## 17. Implementation tasks

Sizes: **S** ≤ ~100 lines, **M** ~100–350, **L** > 350 or a new module.

**How this runs.** The first draft claimed the tasks were file-partitioned and
could fan out across parallel worktrees. They are not (M5): `verificationScheduler.ts`,
`index.ts`, `runbookBootstrapRunner.ts` and `capabilityStore.test.ts` each appear
in more than one task. So this is an **ordered dependency graph executed serially
in one worktree**. Each task lists the files it owns, and every overlap with
another task is declared below rather than wished away. Per the repo's lane rule,
each task runs only `npx vitest run <its own paths>` from inside `main/` or
`frontend/` — never the full suite — and `pnpm typecheck && pnpm lint &&
pnpm test:unit` runs **once**, at T15, over the settled tree.

**Declared file overlaps** (each is a later task extending a file an earlier one
touched, never two tasks editing it concurrently):

| File | Tasks | Ordering |
|---|---|---|
| `verificationScheduler.ts` | T0, T3 | T0 extracts pure helpers out; T3 then adds the mobile gate arm and slot pool |
| `index.ts` | T0, T15 | T0 ports the composition extraction; T15 wires the mobile composition into what remains |
| `runbookBootstrapRunner.ts` | T11, T12 | T11 adds the defensive mobile decline arm; T12 then edits `composeBootstrapProofTask` to copy `app` |
| `capabilityStore.test.ts` | T3, T10 | T3 rewrites the stale literal; T10 appends the migration case |
| `fileSizeRatchet.test.ts` | T0, T9 | T0 lowers two caps; T9 only asserts `mcpQueryHandler.ts` did not move |

---

**T0 · Ratchet headroom — two pure extractions, no mobile code (M)**

The caps are real and CI-enforced (`fileSizeRatchet.test.ts:32-38`: 5702 / 7338 /
5717, all exactly at file size, plus a second assertion forbidding more than 2%
cap slack). But there is no *mobile* behaviour to extract yet — today's mobile
"gate" is a single static map entry. T0 therefore extracts **existing generic
code**, and creates no mobile module:

- **(a) Port `8353a3a0a` from branch `godfile-split-20260915` onto HEAD.** That
  commit splits `index.ts`'s verify and eval composition into siblings
  `main/src/verifyComposition.ts` (877 lines) and `main/src/evalComposition.ts`
  (290 lines). It conflicts with HEAD's `6ab7c2d77` (the §5.3 drift-probe
  extraction) and with `fileSizeRatchet.test.ts`. Resolve by hand; verify the
  port is behaviour-preserving by a **normalized line-multiset diff** of the
  before/after sources, not by eyeball.
- **(b) `verificationScheduler.ts` → `main/src/orchestrator/verify/schedulerHelpers.ts`.**
  Move the module-level pure constants and free functions in the `:916-1430`
  region — `parseVerdictFeedback` and its `this`-free neighbours — and re-export
  them from the scheduler so **no import anywhere else changes**. ≥120 lines out.

*Owns:* `main/src/index.ts`, `main/src/verifyComposition.ts` (new),
`main/src/evalComposition.ts` (new),
`main/src/orchestrator/verify/verificationScheduler.ts`,
`main/src/orchestrator/verify/schedulerHelpers.ts` (new),
`main/src/__tests__/fileSizeRatchet.test.ts`.
*Depends on:* nothing.
*Acceptance:* both caps lowered to the post-extraction sizes **in the same
commits**; the 2% assertion passes; zero behaviour change; **no file named
`mobileGates.ts` or `mobileComposition.ts` exists at the end of T0** — those are
created by T3 and T15 respectively.
*Tests:* `cd main && npx vitest run src/__tests__/fileSizeRatchet.test.ts src/orchestrator/verify/__tests__/verificationScheduler*.test.ts`

---

**T1 · Widen the two shared contracts (L)**

*Owns:* `shared/types/verifyRunbook.ts`, `shared/types/visualVerification.ts`,
plus their two schema suites.
*Depends on:* nothing.
*Acceptance:*

- `VerifyRunbookModality`'s `Extract`, `VERIFY_RUNBOOK_MODALITIES` and
  `isVerifyRunbookModality` all include `'mobile'` and stay mutually consistent.
- `app?: { platform:'ios-simulator'; bundleId; scheme; productGlob? }` on **both**
  `VerificationTaskV1` and `VerifyRunbookModalityEntry`, validated field-by-field
  by both hand-rolled parsers with path-named errors. **`serve.attach` is
  untouched in both parsers.**
- **The §6.5 cross-field invariants, in `parseModalityEntry`:** a mobile entry
  MUST have `app`, MUST NOT have `serve`, and MUST have
  `attestation.kind === 'bundle-identity'`; when both are present
  `app.bundleId === attestation.bundleId`; `productGlob` is relative with no
  leading `/`, no `~` and no `..` segment. Each rejection names its path.
- `resolveTaskModality`'s param is `Pick<…,'serve'|'app'>` and it returns
  `'mobile'` for an `app`-shaped task, below the two type rules and above the
  attach rule; all **12** call sites swept mechanically.
- `AttestationSpec` gains **exactly** `{ kind: 'bundle-identity'; bundleId: string }`
  — **no `markerPath` member** — with `isAttestationKind` and
  `isAttestationSpec`'s no-default switch widened, and a `mobile` row in the
  kind→modality doc table naming its strength **and both residual clauses** (§9.2).
- `levers` gains `simUdidEnv`/`derivedDataEnv`, **including** in
  `parseVerifyRunbookV1`'s string-check field loop (`:394`).
- `VisualVerifyConfig` / `ResolvedVisualVerifyConfig` / `VISUAL_VERIFY_DEFAULTS`
  gain **exactly four** knobs: `mobileSimSlots` (1, clamped [1,4]),
  `mobileSimDeviceType` (`''`), `mobileSimRuntime` (`''`), `mobileDeadlineFloorMs`
  (900 000). **No `mobileSimTemplate`, no `mobileXcodeMcpGrant`** — both removed
  from the plan (M12, M2). `simulatorDevices`'s doc is marked legacy-engine-only.
- `VerifyProbeId` gains `'mobile-simulator'` (health panel + the synthetic check
  row of §10; there is no mobile-simulator *preflight* check).
- Every "deferred — pending Xcode MCP" sentence in these two files is rewritten.
- **The rest of the repo is expected to be red at the end of this task — that is
  the `Extract` doing its job.**

*Tests:* `cd main && npx vitest run src/orchestrator/verify/__tests__/runbookHash.test.ts src/orchestrator/verify/__tests__/verificationTaskSchemas.test.ts src/orchestrator/__tests__/visualVerificationTypes.test.ts`

---

**T2 · Host probe + simulator session (L)**

*Owns:* `main/src/services/visualVerify/xcodeToolchainBackend.ts` (new),
`main/src/orchestrator/verify/mobileSimulatorSession.ts` (new) + their suites.
*Depends on:* T1.
*Acceptance:* `healthCheck()` **never throws** and is true only when `xcodebuild`
answers, ≥1 **available** iOS runtime exists and ≥1 compatible device type
exists; memoized ~60 s; false on every non-darwin platform. `probeDetail()`
returns the ok/absent/inconclusive shape carrying the Xcode version, newest
runtime and resolved Maestro **absolute** path (or null). **There is no
`mcpbridgePresent()` method** (M2). `resolveMaestroBin()` returns one absolute
path, never a bare name, and is the single source the probe and driver share.

`MobileSimulatorSession.acquire()` resolves identifiers from `simctl list -j` and
**intersects the device type against that runtime's `supportedDeviceTypes`** (a
naive newest-first pick yields `iPhone-6s-Plus`, which `simctl create` rejects
against iOS 26.2 with `Incompatible device`); writes
`<dataDir>/verify-mobile/<requestId>/owner.json` **before** `simctl create` and
fills in `simUdid` after; creates **fresh** (never clones); boots via
`bootstatus -b` with a deadline; applies the status-bar and appearance
overrides; provisions an empty DerivedData dir under the same request dir;
returns a handle whose `dispose()` is best-effort, per-step try/caught and never
throws. **`acquire()` rolls itself back** — a throw after `simctl create` deletes
the device and the request dir before propagating.

`sweepStaleSimulators()` iterates `<dataDir>/verify-mobile/*/owner.json`, treats
an owner as dead **only** when `process.kill(pid,0)` throws `ESRCH` or the live
pid's start time differs from `pidStartedAt`, and then removes both the device
and the request dir. An unmarked `cyboflow-verify-*` device is **logged and left
alone**. Both modules take an injected exec dep and import no
electron/better-sqlite3.
*Tests:* `cd main && npx vitest run src/services/visualVerify/__tests__/xcodeToolchainBackend.test.ts src/orchestrator/verify/__tests__/mobileSimulatorSession.test.ts`

---

**T3 · Gates, slot pool, posture decline code, deadline floor (L)**

*Owns:* `main/src/orchestrator/verify/verificationScheduler.ts`,
`main/src/orchestrator/verify/mobileGates.ts` (**new, created here**),
`main/src/orchestrator/verify/verificationPosture.ts` + three suites, plus the
stale literal in `capabilityStore.test.ts`.
*Depends on:* T0, T1.
*Acceptance:*

- `unsupportedModalityDetail`'s mobile arm: no probe ⇒ the table detail
  **byte-for-byte**; true ⇒ null; false **or throwing** ⇒
  `MOBILE_TOOLCHAIN_UNAVAILABLE_DETAIL` with the same warn log. Still pre-lease,
  still writes `markUnsupported`.
- A mobile row acquires one `verify:mobile:<i>` slot from a pool clamped to
  [1,4], in the screen-lease position, releasing the agent slot on a miss and
  leaving the row **queued**; the handle threads through `runAgentChosen` and is
  released in its `finally` on **every** exit path.
- **No port lease for mobile** (M1). The scheduler's pooled-port lease
  (`tryAcquireOneOf` over `devServerPorts`) is skipped when
  `modality === 'mobile'`; the request is built with `verifyPort: null` **and**
  `verifyDriverPort: null` (today the request builder sets
  `verifyDriverPort: leasedPort + 1` unconditionally, whatever `servesPort`
  says); `VerificationAgentRequest.verifyDriverPort` widens to `number | null`. Assert a port-exhausted pool still runs a mobile row.
- **`declineCode` (M6).** `export type VerificationDeclineCode =
  'unsupported-modality' | 'no-verification-runbook' | 'modality-deferred'` in
  `verificationPosture.ts`; the posture result and the enqueue-time decline carry
  it alongside `reason`; `isNoModalityDeclineReason` checks the code when present
  and falls back to the three substrings (`:126-131`) only for legacy string
  callers. Reasons still contain "verification runbook" as belt and braces, but
  **the test pins the code**.
- `resolveVerificationPosture` probes `runbookStatus(projectId,'mobile',worktree)`
  instead of short-circuiting; fail-open on throw/null; `MOBILE_DEFERRED_REASON`
  is gone.
- **`mobileDeadlineFloorMs`** (M9): the scheduler's `agentDeadlineMs(task)`
  returns `max(existing, floor)` for mobile and is unchanged for every other
  modality. `BOOTSTRAP_PROOF_AWAIT_MS` (`runbookBootstrapRunner.ts:106`) is
  **not** touched.

*Tests:* `cd main && npx vitest run src/orchestrator/verify/__tests__/verificationSchedulerConcurrency.test.ts src/orchestrator/verify/__tests__/verificationSchedulerAgent.test.ts src/orchestrator/verify/__tests__/verificationPosture.test.ts src/orchestrator/verify/__tests__/capabilityStore.test.ts`

---

**T4 · Preflight (M)**

*Owns:* `main/src/orchestrator/verify/preflight.ts` + suite.
*Depends on:* T1.
*Acceptance:* `PreflightCheckResult.id` gains **`'mobile-toolchain'` only** —
there is **no `mobile-simulator` preflight check and no `prepareSimulator`
closure** (B2); preflight is allocation-free. `checkMobileToolchain` runs only
for modality `'mobile'` with a wired probe, fails on an affirmative false, and is
**fail-open** on a throw (the `checkNativeCapture` rule). **Both** port checks are
skipped when `driverPort === null`: `port-free` (`:303`, already conditional on
`serve`) and `driver-port-free` (`:309`, unconditional today). The chromium check
no longer runs for mobile (`:286-288`). `failureClassifier` is **not** modified; a
failed mobile check classifies `env` through its existing generic preflight loop.
*Tests:* `cd main && npx vitest run src/orchestrator/verify/__tests__/preflight.test.ts src/orchestrator/verify/__tests__/failureClassifier.test.ts`

---

**T5 · Runner + query + attestation (L)**

*Owns:* `main/src/orchestrator/verify/verificationAgentRunner.ts`,
`main/src/orchestrator/verify/verificationAgentQuery.ts`,
`main/src/orchestrator/verify/harnessAttestation.ts`,
`main/src/orchestrator/verify/runbookLevers.ts` + four suites.
*Depends on:* T1, T2.
*Acceptance:*

- **Acquisition inside the `try`.** `acquireMobileSession()` is called **after**
  runbook-pin validation and provider resolution, immediately before the agent
  query, inside the block that begins at `verificationAgentRunner.ts:2299` — not
  from preflight at `:2168`, which sits before every early return. A throw from
  `acquire()` is caught there and returned as `status:'skipped', deployed:false`
  carrying a **synthetic** `PreflightCheckResult { id:'mobile-simulator',
  ok:false, detail }` in `preflight.checks`, so the existing classifier answers
  `env` with no classifier change. Assert the leak cases explicitly: a pin
  mismatch and a provider refusal must each leave **no** device created.
- **Env, exactly.** A mobile request exports `VERIFY_SIM_UDID`, `VERIFY_SIM_NAME`,
  `VERIFY_SIM_RUNTIME`, `VERIFY_DERIVED_DATA`, `VERIFY_APP_BUNDLE_ID`,
  `VERIFY_APP_PRODUCT_GLOB`, `VERIFY_MOBILE_DRIVE`, `VERIFY_MAESTRO_BIN` (only
  when resolved) and `VERIFY_MOBILE_READY_TIMEOUT_MS`, and binds the two new
  levers. It exports **no `VERIFY_PORT` and no `VERIFY_DRIVER_PORT`**. A
  non-mobile request exports none of the mobile names.
- **Null-safe ports** (M1): `leasedPort: req.verifyPort ?? req.verifyDriverPort - 1`
  (`:2127`) stops assuming a number; `serveBindingTarget` (`:1187`) takes
  `driverPort: number | null`.
- **Pin fingerprint covers `app`** (B5): `executableFingerprint`
  (`verificationAgentRunner.ts:919`) includes `app` alongside `build`, `serve`
  and `attestation` on **both** sides of the comparison at `:1013-1014`, and the
  mismatch diagnostics name `app`. Assert that changing `bundleId`, `scheme`,
  `platform` or `productGlob` trips `RUNBOOK_MISMATCH_PREFIX`.
- **Query schema covers the new kind** (B5): the attestation `kind` enum at
  `verificationAgentQuery.ts:101-112` gains `'bundle-identity'` as a sixth
  member.
- **Attestation.** `probeOnce` handles `bundle-identity` per §9: read
  `mobile-install.json`; missing ⇒ `verified:false` with the "nothing was
  installed through the driver" detail; require `builtPath` realpath-confined
  under `$VERIFY_DERIVED_DATA` and still present; `get_app_container` bundle id
  equals the declared one; **re-hash the installed executable itself** and
  require recorded-built === live-installed === recorded-installed. Never
  `Info.plist`. Both paths in the detail, both residual clauses recorded.
- **Teardown.** Terminate, shut down, delete, and remove the request dir in the
  `finally` on **every** exit path including a throw, **after** the attestation
  probe and **before** `await snapshot.dispose()` (`:2770-2772`, the block's unwrapped
  last statement), with **each
  step independently try/caught** so none can mask the next or mask dispose.
- The contract head carries a MOBILE block documenting `mobile-install` /
  `mobile-launch`, both drive arms keyed on `VERIFY_MOBILE_DRIVE`, that
  `simctl openurl` is **navigation, not driving**, and that a readiness timeout
  is reported as `not_testable (readiness-timeout)`, never a fail.
- `coerceDriveUnsupportedBehaviors` gains an optional 4th param defaulting to
  `modality === 'native-screen'` so the existing test stays green, and the runner
  passes the real value.
- **`mcpServers` is `{}` for every request**; `settingSources: []` and
  `strictMcpConfig: true` unchanged. The auto-approve filter becomes
  `t !== 'Bash' && !t.startsWith('mcp__')` plus the `canUseTool` `mcp__` deny arm
  — **as its own commit**, provably inert.

*Tests:* `cd main && npx vitest run src/orchestrator/verify/__tests__/verificationAgentRunner.test.ts src/orchestrator/verify/__tests__/verificationAgentQuery.test.ts src/orchestrator/verify/__tests__/harnessAttestation.test.ts src/orchestrator/verify/__tests__/runbookLevers.test.ts`
*Highest-value single test in the change:* the property assertion that for every
modality, **no member of the auto-approve list starts with `mcp__`** while the
availability list may.

---

**T6 · Driver CLI — including install, launch and readiness (L)**

*Owns:* `main/src/orchestrator/verify/driver/driverCore.ts` + suite + fixture PNGs.
*Depends on:* T1.
*Acceptance:* `parseArgv` accepts `mobile-install`, `mobile-launch`,
`mobile-screenshot`, `mobile-openurl`, `mobile-tap`, `mobile-type`,
`mobile-swipe`, `mobile-press`, `mobile-flow` and `attest bundle`; `USAGE` lists
them.

- **`mobile-install`** implements §5.1.1 in order and exits non-zero with a
  **named** refusal at the first failure: zero or >1 glob matches; a `realpath`
  outside `$VERIFY_DERIVED_DATA` (symlink or `..` escape); an `Info.plist`
  `CFBundleIdentifier` that is not `VERIFY_APP_BUNDLE_ID`. On success it writes
  `mobile-install.json` with the five recorded fields. It **refuses to install
  anything not under DerivedData** — that is the confinement, and it has its own
  test.
- **`mobile-launch`** implements §5.5: launch, then poll every 500 ms for
  pid-alive **and** two consecutive byte-identical, non-uniform frames, bounded
  by `VERIFY_MOBILE_READY_TIMEOUT_MS` (default 90 000). On timeout: **exit code
  3**, a structured `readiness-timeout` line, and `readiness-last-frame.png`
  kept in the artifacts dir. The uniform-frame heuristic is unit-tested against
  **fixture PNGs** — at least a solid-white frame, a solid-black frame and a
  rendered frame.
- Under `VERIFY_MODALITY=mobile` the CDP commands are **refused** with a message
  pointing at the mobile family, mirroring `:696-706`. Observe commands work with
  `VERIFY_MOBILE_DRIVE` unset; every drive command exits non-zero with a named
  refusal when it is not `maestro`. The pinning flag is resolved once from
  `maestro --help` (prefer `--udid`, fall back to `--device`, **refuse to drive**
  if neither). A screenshot name containing a path separator is refused.
  `ATTEST_KIND_BY_CHANNEL` maps `bundle → bundle-identity`.

*Tests:* `cd main && npx vitest run src/orchestrator/verify/driver/__tests__/driverCore.test.ts`
*Load-bearing case:* no generated `simctl` or Maestro argv may contain a UDID
other than `VERIFY_SIM_UDID` — an unpinned Maestro run is the one failure that
could drive the user's own simulator.

---

**T7 · Registration-path isolation guard + dependency guard (M)**

*Owns:* `main/src/orchestrator/verify/runbookStore.ts`,
`main/src/orchestrator/verify/dependencyCommandGuard.ts` + two suites.
*Depends on:* T1.
*Acceptance:* a new `'unisolated-command'` rejection fires at the `registerDraft`
chokepoint (§12) — **not** in `runbookDraftValidation.ts` — when a mobile
`build[]` step omits the DerivedData lever or `-destination "id=$<simUdidEnv>"`,
omits `CODE_SIGNING_ALLOWED=NO`, or contains a literal 8-4-4-4-12 UDID or an
absolute `-derivedDataPath`. Because install and launch are no longer `build[]`
steps (§5.1), a mobile `build[]` carrying an `xcrun simctl install` or `launch`
line is **also** rejected here, naming the driver commands.
`FORBIDDEN_DEP_COMMAND_PATTERN` (`dependencyCommandGuard.ts:96-107`) gains
`pod (install|update|repo update)`, `swift package (resolve|update)` and
`xcodebuild … -resolvePackageDependencies`, with a doc paragraph stating why an
ordinary `xcodebuild build` is **not** among them (it resolves into the request's
own clone dir and mutates nothing shared). Widening this one pattern widens both
the enqueue-time and execution-time seams, per the module's own contract at
`:71-74`. `runbookStore`'s two stale "mobile simply misses" comments are
corrected.
*Tests:* `cd main && npx vitest run src/orchestrator/verify/__tests__/runbookStore.test.ts src/orchestrator/verify/__tests__/dependencyCommandGuard.test.ts`

---

**T8 · Enqueue reachability + the resolver test (M)**

*Owns:* `main/src/orchestrator/verify/enqueueFromTask.ts` + suite, and
`main/src/orchestrator/__tests__/visualVerificationResolver.test.ts` (moved here
from T13 — it is enqueue territory, M10).
*Depends on:* T1.
*Acceptance:* `declaredWebModality` returns `'mobile'` for a task that declares it
**and** expresses it, and for a bare `app.platform === 'ios-simulator'`.
`RECORD_PROBE_ORDER` is `['cdp-app','web','mobile']`. `mergeRunbookIntoTask`
carries `entry.app` with REPLACE semantics. The stamp-consistency guard (`:537`)
**passes** for a record-resolved mobile lane. `visualVerificationResolver.test.ts`'s
modality loop gains the explicit `'mobile-flow'` entry its title already claims.
*Tests:* `cd main && npx vitest run src/orchestrator/verify/__tests__/enqueueFromTask.test.ts src/orchestrator/__tests__/visualVerificationResolver.test.ts`
*Required regression:* a project with **both** a proven web record and a proven
mobile record still resolves `web` when nothing is declared.

---

**T9 · MCP tool surface (S)**

*Owns:* `main/src/orchestrator/mcpServer/toolRegistry/runScopeTools.ts`,
`main/src/orchestrator/mcpServer/mcpQueryHandler.ts` + two suites.
*Depends on:* T1.
*Acceptance:* the `z.enum` at `runScopeTools.ts:644` is **spread from**
`VERIFY_RUNBOOK_MODALITIES` (not re-listed), so this class of drift cannot recur;
its description states mobile's real precondition. The `invalid_modality` literal
at `mcpQueryHandler.ts:4367-4376` is joined from the same const and the
"deliberately NOT accepted" comment is deleted. **`mcpQueryHandler.ts` sits
exactly at its ratchet cap (5717/5717), so the edit must preserve the file's
exact line count** — replace the literal with the spread across the same number
of lines; avoiding "significant growth" is not enough.
*Tests:* `cd main && npx vitest run src/orchestrator/mcpServer/__tests__/cyboflowMcpServer.test.ts src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts src/__tests__/fileSizeRatchet.test.ts`

---

**T10 · Migration 139 (S)**

*Owns:* `main/src/database/migrations/139_verify_mobile_capability_reset.sql`,
plus the migration case appended to `capabilityStore.test.ts`.
*Depends on:* T3 (for the test file's earlier literal rewrite).
*Acceptance:* one idempotent `DELETE`, **reason-filtered**
(`AND reason LIKE '%Xcode MCP%'`, §10.1) so reapplying it cannot delete
affirmative current-host `unsupported` evidence. Header comment explains both
why "unsupported" marks never self-clear and why the reason filter is there. No
column altered, no CHECK touched, no `schema.sql` sync. **Re-run
`ls main/src/database/migrations/*.sql | sort -V | tail` immediately before
committing** and renumber in isolation if 139 is taken.
*Tests:* `cd main && npx vitest run src/orchestrator/verify/__tests__/capabilityStore.test.ts` then `pnpm run verify:schema`

---

**T11 · Bootstrap decline — in the eligibility layer (S)**

*Owns:* `main/src/orchestrator/verify/bootstrapEligibility.ts`,
`main/src/orchestrator/verify/runbookBootstrapPreflight.ts`,
`main/src/orchestrator/verify/runbookBootstrapRunner.ts` + suite.
*Depends on:* T1.
*Acceptance:* the policy lives where the decline type does (M3).
`BootstrapDeclineReason` (`bootstrapEligibility.ts:52`) gains
`'auto-derive-unsupported'`; `decideRunbookBootstrap` declines a `mobile`
candidate with it, naming the verify-setup flow, so `runbookBootstrapPreflight`
declines **before any controller starts** — spending zero drafts and writing no
stamp. The runner's own guards (`:589-594` derive, `:1078-1083` reprove) return
`BootstrapDeclineKind` (`runbookBootstrapRunner.ts:110-115`), a **different**
type: they keep `'undeclarable-modality'` for genuinely unknown strings and gain
a defensive mobile arm mapped into the runner's kind.
`runbookDraftPrompt.ts`, `runbookDraftValidation.ts`, `rung1Operations.ts`,
`readOnlyCommandGuard.ts`, `depPreparer.ts` and `snapshotProvisioner.ts` are
**untouched** — assert by `git diff --stat`.
*Tests:* `cd main && npx vitest run src/orchestrator/verify/__tests__/runbookBootstrapRunner.test.ts src/orchestrator/verify/__tests__/runbookDraft.test.ts`

---

**T12 · Prompts, and the two proof-task composers (M)**

*Owns:* the three sprint/ship agent pairs (`visual-verify.md`, `task-verify.md`,
`runbook-bootstrap.md`), `sprint.md`, `ship.md`, `verify-setup.md`,
`verify-setup/agents/verify-setup.md`, **`main/src/orchestrator/programmatic/stepPrompt.ts`**
and its test, **`composeBootstrapProofTask` in
`main/src/orchestrator/verify/runbookBootstrapRunner.ts`**, plus an
`mcpQueryHandler` test.
*Depends on:* T1, and **T11 for `runbookBootstrapRunner.ts`** — declared overlap:
T11 edits that file's decline guards, T12 edits `composeBootstrapProofTask` at
`:353-365`. T12 runs second.
*Acceptance:* the proof route, which is the **only** way a mobile runbook becomes
proven, must carry the new discriminant (B4):

- `stepPrompt.ts`'s verify-setup prove contract — the dynamically appended
  `proveContract` block, whose step-3 sentence is the load-bearing one — lists "its build steps, its serve form **OR its `app` block**,
  its attestation, verbatim". A proof task composed without `app` resolves to a
  web modality at `mcpQueryHandler.ts:3911` and returns
  `setup_proof_requires_pin`, so the mobile record could never become proven.
- `composeBootstrapProofTask` (`runbookBootstrapRunner.ts:353`) copies `app`
  alongside `build`/`serve`/`attestation`, even though mobile auto-derive stays
  disabled — a proof composer that silently drops a field is a trap for whoever
  enables it later.
- An `mcpQueryHandler` test asserts setup-proof authorization resolves modality
  `'mobile'` from an `app`-shaped task and finds the **registered mobile hash**.
- `visual-verify.md` finally supplies the mobile notes its `:22-27` paragraph has
  promised since it shipped, including the `mobile-install`/`mobile-launch`
  commands and the readiness-timeout reporting rule.
- `task-verify.md` gains the fourth modality bullet (the `app` block, **no
  serve**, accessibility-label targeting, honest `requiresDrive`).
  `runbook-bootstrap.md` says mobile is declarable but **not auto-derivable** by
  that agent. Both `verify-setup` copies drop "ONLY these three" / "never declare
  mobile", say **six** attestation kinds, and document `bundle-identity` and the
  two new levers. `sprint.md`/`ship.md` reword the deferred-mobile sentence.
- **No `tools:` frontmatter line gains an `mcp__` name anywhere**
  (`bundledAgentParser.ts:59-62` drops them silently).

*Tests:* `cd main && npx vitest run src/orchestrator/workflows/__tests__/workflowBundle.builtins.test.ts src/orchestrator/programmatic/__tests__/stepPrompt.test.ts src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts` **plus**
`for f in visual-verify task-verify runbook-bootstrap; do diff -q main/src/orchestrator/workflows/{sprint,ship}/agents/$f.md; done` — must be silent (verified byte-identical today, no shared source).

---

**T13 · Docs, settings copy, stale comments (M)**

*Owns:* `docs/proposals/verification-setup-flow.md`,
`docs/proposals/verification-agent-redesign.md`,
`docs/proposals/visual-verification-brittleness-fixes.md`,
`docs/VISUAL-VERIFICATION-SETUP.md`,
`main/src/services/visualVerify/peekabooBackend.ts`,
`frontend/src/components/settings/FeatureControlsSettings.tsx`,
`frontend/src/components/cyboflow/verifyHealthModel.ts`,
`frontend/src/components/cyboflow/workflowEditorOptions.ts`.
*Depends on:* T1 (for `PROBE_LABEL`, a compile error until the member exists).
*Acceptance:* §4's roster row is filled (§4 above is the text); §7.1's channel
table gains `bundle-identity` with its strength **and both residual clauses**;
`verification-agent-redesign.md:594-598`'s doubly-stale sentence is fixed;
`visual-verification-brittleness-fixes.md`'s five-rung precedence spec gains the
`app`-shape rung (that doc, not `enqueueFromTask.ts`, is where the precedence is
specified); `VISUAL-VERIFICATION-SETUP.md` gains **one sentence** separating
"cyboflow verifying itself" from the product's mobile modality **without
changing** its still-true claim; `peekabooBackend.ts:44-46` keeps its
`@cyboflow-hidden` marker and loses only the false "mobile-flow remains out of
scope for the agent engine" clause. `PROBE_LABEL` gains
`'mobile-simulator': 'iOS simulator control'`. **This task is settings *copy*
only: it adds no controls for the four new knobs, which stay hand-edited
configuration.** The health-panel detail names the Xcode version, the newest
runtime and whether Maestro resolved — **not** mcpbridge, which no longer has a
probe. `MCP_OPTIONS`'s stale `'maestro'` row is left alone (Decision 3) with a
corrected comment.
*Tests:* `cd frontend && npx vitest run src/components/cyboflow/__tests__/verifyHealthModel.test.ts`

---

**T14 · Fake-toolchain integration test (L)**

*Owns:* `main/src/orchestrator/__tests__/integration/mobileVerification.itest.ts`
+ `fixtures/fakeAppleToolchain/`.
*Depends on:* T5, T6.
*Acceptance:* shell shims for `xcodebuild`, `xcrun` and `maestro` on the harness
`PATH`; drives enqueue → gate 1 → preflight → in-`try` simulator acquire → a
mocked agent session that "builds", then `mobile-install` and `mobile-launch` →
`bundle-identity` over two equal hashes → `passed` → teardown that deletes the
fake device **and** its request dir. **Five arms:** (a) happy path; (b) maestro
shim removed ⇒ still passes observe-only with `requiresDrive` coerced to
`not_testable`; (c) boot failure ⇒ `skipped` + `failure_class='env'` + the
synthetic `mobile-simulator` evidence row, never a FAIL; (d) **the negative
attestation case** — the shim stages a *different* bundle than the one installed
⇒ `verified:false`. State arm (d) honestly: it proves that **two different
staged bundles hash differently**, i.e. that the identity comparison works. It
does **not** prove the passing artifact was compiled from the snapshot, which
`bundle-identity` does not claim (§9, B1). (e) readiness never reached ⇒ every
behavior `not_testable (readiness-timeout)`, `readiness-last-frame.png` written,
verdict `low_confidence`, never a FAIL.
*Tests:* `cd main && npx vitest run src/orchestrator/__tests__/integration/mobileVerification.itest.ts`

---

**T15 · Composition root (M)**

*Owns:* `main/src/index.ts`,
`main/src/services/visualVerify/mobileComposition.ts` (**new, created here**),
`main/src/services/configManager.ts`, `main/src/orchestrator/trpc/context.ts`,
`main/src/orchestrator/trpc/routers/verificationRequests.ts` + two suites.
*Depends on:* T0, T2, T3, T4, T5. Declared overlap: T0 owns `index.ts` first
(the composition port); T15 wires into what remains.
*Acceptance:* `getVisualVerifyConfig` (`configManager.ts:824-844`) materializes
all **four** new knobs against `VISUAL_VERIFY_DEFAULTS` — a knob not resolved
here never reaches the scheduler however carefully Settings preserves it. The
toolchain backend and simulator-session factory are constructed **once**,
darwin-gated, from `mobileComposition.ts`; the Maestro path is resolved **once**
and the same value reaches the probe and `VERIFY_MAESTRO_BIN`; the **same probe
instance** is injected into the scheduler deps, the runner's preflight deps and
the tRPC host-probe surface. `runHostProbes` splices one `'mobile-simulator'` row
following `grantRows`' fail-open discipline (unwired or thrown ⇒ `inconclusive`,
never `missing`; `fix: null` — cyboflow can install neither Xcode nor Maestro),
whose detail names the Xcode version, the newest runtime and whether Maestro
resolved. **Nothing mentions mcpbridge.** `sweepStaleSimulators()` runs once at
boot, **marker-driven** per §8.2: proven-dead owners only, request dirs as well
as devices, unmarked devices logged and left. Nothing off darwin constructs a
simulator or spawns `xcrun`. Then the **settled-tree gate, run once:**
`pnpm typecheck && pnpm lint && pnpm test:unit`.
*Tests:* `cd main && npx vitest run src/services/__tests__/configManager.test.ts src/orchestrator/trpc/routers/__tests__/verificationRequests.test.ts`

---

**T16 · Live smoke on this host — measures only (M, manual)**

*Owns:* no source files, and **changes none** (M9). The deadline floor is already
a config knob set in T1/T3; T16 records the measured number in a follow-up doc
note so a future change can revise the default on evidence.
*Depends on:* T14, T15.
*Acceptance,* against a scratch SwiftUI app **outside this repo**, with a
throwaway `CYBOFLOW_DIR`, on Xcode 26.2:

1. the health panel shows `mobile-simulator = ok` with the Xcode version, the
   runtime and "Maestro 2.3.0" — and **no mcpbridge line**;
2. the verify-setup flow authors, registers and **proves** a mobile runbook —
   real `xcodebuild` into `VERIFY_DERIVED_DATA`, create+boot, `mobile-install`,
   `mobile-launch` reaching readiness, screenshots in the artifacts dir,
   `bundle-identity` verified;
3. a sprint lane whose task-verify declares `modality: 'mobile'` with an `app`
   block enqueues a row stamped `modality='mobile'`, **pinned** to that runbook
   hash, and reaches a verdict with **no hand-edited JSON anywhere**;
4. **the negative attestation case** — stage a same-bundle-id app built into a
   different DerivedData ⇒ `verified:false`;
5. run it **twice**: once with Maestro on `PATH` and once with it hidden — the
   observe-only degradation is the arm that will actually ship to most hosts;
6. **the negative host case** — hide the iOS runtime from the probe: the lane
   must **skip with an actionable reason and a `markUnsupported` ledger row**,
   and must **not hang queued**;
7. teardown leaves no `cyboflow-verify-*` device and no `verify-mobile/<requestId>`
   dir; a second instance started mid-verification leaves the first's device
   **alone** (§8.2);
8. **record** the cold `xcodebuild` wall time and the create+boot time, and note
   them against `mobileDeadlineFloorMs`'s 15-minute default. Recording only — no
   source constant moves in this task.

No `cyboflow_*` MCP tool is called at any point in T0–T16 — per CLAUDE.md's
two-layers rule, those write to the user's real backlog.

### Execution order

Serial, one worktree. An arrow is "must land first".

```
T0  → T3 (scheduler), T15 (index.ts)
T1  → everything below it (the Extract leaves the tree red until they land)
T2  → T5, T15
T3  → T10 (capabilityStore.test.ts), T15
T4  → T15
T5  → T14, T15
T6  → T14
T11 → T12 (runbookBootstrapRunner.ts)

Order that satisfies all of the above:
  T0 · T1 · T2 · T3 · T4 · T5 · T6 · T7 · T8 · T9 · T10 · T11 · T12 · T13
     · T14 · T15 (settled-tree gate) · T16 (manual smoke)
```

T7, T8, T9 and T13 depend only on T1 and may be reordered among themselves.
Nothing here is parallel-safe across worktrees, and the plan no longer pretends
otherwise.

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
| `verificationPosture.test.ts:161` | `isNoModalityDeclineReason` over sample strings | **EXTEND** — add cases that pin the new `declineCode` (M6), not the prose: a decline carrying `'no-verification-runbook'` classifies true regardless of wording, and the three legacy substrings still classify a bare string. Feeding only the real `mobileRunbookReason` prose through it would have preserved the brittleness the finding is about | T3 |
| `capabilityStore.test.ts:185` | `markUnsupported(1,'mobile','deferred — pending Xcode MCP')` | **UNAFFECTED** mechanically; swap the stale illustrative literal. Add the migration-139 case | T3 / T10 |
| `runbookHash.test.ts:45` | pins the 3-member `VERIFY_RUNBOOK_MODALITIES` and `isVerifyRunbookModality('mobile') === false` | **FLIP** → 4 members, `true` | T1 |
| `runbookHash.test.ts:94` | error literal `'modalities: expected at least one of web\|cdp-app\|native-screen'`; mobile-only map ⇒ `ok:false` | **FLIP both halves** → the literal gains `\|mobile` (free — it is joined off the const), and the mobile-only map parses `ok:true` given an `app` block + a `bundle-identity` attestation | T1 |
| `runbookDraft.test.ts:83` | `parseRunbookDraftResult(draft({modality:'mobile'})).ok === false` | **FLIP** → `true` for a well-shaped draft, plus a genuinely-invalid-modality negative control | T11 |
| `runbookBootstrapRunner.test.ts:271` | derive path declines mobile `'undeclarable-modality'`, zero drafts | **FLIP** → the decline now happens **earlier**, in `decideRunbookBootstrap`/`runbookBootstrapPreflight` with `BootstrapDeclineReason` `'auto-derive-unsupported'`, so no controller starts at all; the runner's own guard keeps `'undeclarable-modality'` for unknown strings and gains a defensive mobile arm (M3). Same zero-drafts/no-stamp assertions | T11 |
| `runbookBootstrapRunner.test.ts:1055` | reprove twin of the above | **FLIP**, same rewrite | T11 |
| `runbookStore.test.ts:815` | "refuses a modality the runbook never declared — including the §4-deferred mobile" | **EXTEND** — the negative half stays true (the fixture declares no mobile); reword the stale comment; add a fixture that **does** declare mobile and registers successfully, plus the new `'unisolated-command'` rejections | T7 |
| `verificationAgentQuery.test.ts` (attestation schema) | `kind` enum pins five members | **FLIP** — six, with `'bundle-identity'` (B5) | T5 |
| `verificationAgentRunner.test.ts` (pin fingerprint) | `executableFingerprint` covers `build`/`serve`/`attestation` | **EXTEND** — `app` joins them on both sides; changing `bundleId`/`scheme`/`platform`/`productGlob` must trip `RUNBOOK_MISMATCH_PREFIX` (B5) | T5 |
| `verificationAgentRunner.test.ts:1158` | `coerceDriveUnsupportedBehaviors` "is a no-op on every modality but native-screen", parametrized over `['web','cdp-app','mobile']` | **FLIP** — drop `'mobile'` from the no-op list; add a case asserting a `requiresDrive` behavior **is** coerced under mobile when the drive rung is absent, and is **not** when present. (Vacuous today: no mobile request has ever reached the runner) | T5 |
| `verificationAgentRunner.test.ts:1066` | "NEVER logs a mismatch for native-screen/mobile — structurally underivable from a task" | **FLIP the rationale, keep the assertion** — mobile becomes derivable from the `app` shape, so the carve-out is now deliberate rather than structural; reword and keep green | T5 |
| `preflight.test.ts:206` | `'native-capture'` runs only for native-screen, absent for `['web','cdp-app','mobile']` | **UNAFFECTED**; **EXTEND** with **one** new sibling describe for `'mobile-toolchain'` — there is deliberately **no `mobile-simulator` describe**, because preflight is allocation-free (B2) and that check no longer exists — plus an explicit "no `chromium`, no `port-free` **and no `driver-port-free`** check for a mobile task" | T4 |
| `verificationTaskSchemas.test.ts:186` | round-trips every `VerificationModality` including `'mobile'` | **UNAFFECTED**; **EXTEND** with `app`-block round-trip and a bad-`platform` rejection | T1 |
| `cyboflowMcpServer.test.ts:884` | modality enum deep-equals `['web','cdp-app','native-screen']`, title "three declarable modalities" | **FLIP** → four, title updated | T9 |
| `cyboflowMcpServer.test.ts:919` | `callTool(..., {modality:'mobile'})` ⇒ `invalid_arguments` | **FLIP** → swap for a genuinely invalid string (`'android'`); add a positive mobile case | T9 |
| `mcpQueryHandler.test.ts:7266` | `{modality:'mobile'}` rejected before any file read | **FLIP** → swap the sample; add a case proving a mobile registration reaches the file read | T9 |
| `enqueueFromTask.test.ts:1092` | `{ 'mobile-flow' → mobile' }` in the precedence table | **UNAFFECTED**; **EXTEND** with the `app`-shape rows and the both-records regression | T8 |
| `visualVerificationResolver.test.ts:322` | title claims mobile but the loop omits `'mobile-flow'` | **EXTEND** — add it; pre-existing gap worth closing here. **Owned by T8, not T13** (M10): it is enqueue territory, and T13's file list and test command never included it | T8 |
| `visualVerificationTypes.test.ts:26/63/113` | legacy `'maestro'` `VisualBackendId`, `BACKEND_CAPABILITIES`, `FALLBACK_CHAINS` | **UNAFFECTED** — the legacy waterfall is deliberately untouched (§13) | — |
| `workflowController.verificationPosture.test.ts:189/264` | fixture reason strings mentioning mobile | **UNAFFECTED** — generic collapsing over any `unavailable` reason; stale flavor text only | — |
| `fileSizeRatchet.test.ts:32-38` | caps at 5702 / 7338 / 5717, all **exactly** at file size | **FLIP** — lower `verificationScheduler.ts` and `index.ts` to their post-extraction sizes. `mcpQueryHandler.ts`'s cap does **not** move: T9 must preserve that file's exact line count | T0 |

---

## 19. Risks

| Risk | Mitigation |
|---|---|
| **A cold Xcode build blows the deadline.** Default agent deadline 10 min, scheduler ceiling 20 min, `BOOTSTRAP_PROOF_AWAIT_MS` 15 min. A proof that times out is indistinguishable from a runbook that does not work | Cheapest-real-build flags (Debug, iphonesimulator, `CODE_SIGNING_ALLOWED=NO`, skip-package-plugin/macro validation); a mobile-specific **deadline floor** rather than trusting the composer's `timeoutMs` (the F2/RC5 lesson); and T16 **measures** the real number on this host and sets it once rather than guessing twice |
| **Cold simulator boot is slow.** Two numbers were measured live on this host and **both are real**: the first-ever iPhone-11/iOS-26.2 create+boot exceeded **2 min** (cold runtime, first boot on this machine), and a later fresh-device create+boot took **57 s**. `simctl get_app_container` against a still-settling device also exceeded 120 s twice, while the on-disk path resolved instantly | `bootstatus -b` with an explicit deadline completes **before** the agent session; the attestation probe gets a real timeout plus `harnessAttestation`'s existing 3× retry; a boot that exceeds the deadline is a preflight `env` skip, never a FAIL |
| **Device-type / runtime identifier drift.** "iPhone 17 Pro" is not a stable string; a naive newest-first pick fails with `Incompatible device` (observed) | Nothing hardcoded. Identifiers resolved from `simctl list -j` and **intersected with the runtime's own `supportedDeviceTypes`**. A host where no pair resolves fails the **probe** — a clean pre-lease gate-1 skip with an actionable reason, not a failure discovered after a lease and ten minutes |
| **Maestro flag drift.** 2.4.0 overhauled device selection | The driver parses `maestro --help` once, prefers `--udid`, falls back to `--device`, and **refuses to drive** if neither exists (observe-only, not unpinned). Pinned by a test that no generated argv can carry another UDID |
| **Maestro's JVM startup** (~3–5 s per invocation) inside a strained deadline | `mobile-flow <yaml>` runs a multi-step flow in **one** invocation and the contract tells the agent to prefer it. Java absent ⇒ the probe reports no drive rung and mobile degrades to observe-only rather than failing |
| **Simulator and disk leak on SIGKILL** | Two layers: the `finally` for the normal path, `sweepStaleSimulators()` at boot for the hard kill. DerivedData lives under the request's own artifacts root, so the recursive remove is bounded to a harness-composed path |
| **`bundle-identity`'s residual, in two parts** — it proves neither that the staged product was compiled from the snapshot (B1) nor that the screenshots were of the app's foreground | Both clauses recorded on the verdict, the `window-identity` precedent, and the guarantee is worded as **staged-artifact identity** throughout so nothing reads as provenance. The foreground half is materially narrower than `window-identity`'s because the device was created seconds earlier for this request alone. The compilation half is closed only by Stage 2's harness-executed build — `markerPath` and the `xcactivitylog` predicate were **dropped**, not kept, because an agent holding the nonce and Bash can forge either |
| **An agent stages a foreign `.app` rather than building one.** `build[]` runs through the agent's Bash, so a failed build could in principle be papered over by copying a prebuilt bundle into `$VERIFY_DERIVED_DATA` | Not eliminated in Stage 1 — **stated** instead of denied (B1). Three things narrow it: `mobile-install` refuses anything whose realpath is not under this request's DerivedData, refuses an ambiguous glob, and refuses a bundle whose `CFBundleIdentifier` disagrees with the declaration; the DerivedData root is created empty by the harness seconds earlier; and the verdict carries the residual in words. The actual fix is Stage 2's harness-executed build (§16), named as such |
| **Readiness heuristic false-positive on a legitimately white first screen.** The stable-frame predicate cannot distinguish "rendered, and it is white" from "not yet rendered" | Three mitigations, none of which pretends to solve it: pid-alive is a conjunct, so a crashed launch never reads as ready; the bound is 90 s rather than a guess-sized few seconds; and a timeout is reported as `not_testable (readiness-timeout)` with `readiness-last-frame.png` kept — **never a fail**. A white-screen app therefore costs a `low_confidence` verdict and a diagnosable frame, not a false failure |
| **The auto-approve trap re-opens in a year** | Fixed at the root and pinned by a **property** test, not a list test |
| **Migration 139 collides on rebase** | Single-file task, re-checked immediately before committing |
| **A composer declares mobile on a project that is not one** | It cannot produce a pass. Gate 3 binds (`taskDerivesEnvironment` is true off `build[]`), finds no proven mobile runbook, and skips with a setup CTA. The prompt conditions the declaration on repository evidence |
| **T1 leaves the tree red and every later task depends on it** | Deliberate — the `Extract` exists so widening is a compile error, not a silent divergence. T1 carries no behaviour change, so each later task's targeted `npx vitest run <its own paths>` is still readable. The tasks run **serially in one worktree** (§17), so "red" is a state one task passes through, not a state several lanes share |

---

## 20. Codex review round 1 — dispositions

An adversarial review by Codex against this document's first draft returned six
blocking findings, twelve major ones, eleven minor/doc-accuracy notes, a
citation audit of 35 claims, and fourteen open questions. **Every finding is
accepted**; two are accepted with a narrowed scope, marked below. The verdict
was "redesign §§8–9 before T1", and §§8–9 are the two sections that changed
most.

| # | Finding | Disposition | Landed in |
|---|---|---|---|
| B1 | `bundle-identity` proves staging identity, not snapshot-build provenance | **Accept** | §9 (guarantee reworded), §9.2 (`markerPath` and the `.xcactivitylog` predicate dropped), §16 Stage 2, §19, T1, T5, T14 arm (d) |
| B2 | Simulator allocation happens outside the runner's cleanup scope | **Accept** | §8 (acquisition row), §8.1, §10 (synthetic check row), T4 (preflight allocation-free), T5 |
| B3 | There is no first-frame readiness contract | **Accept** | §5.1.1, §5.5, §10 (readiness row), §19, T6, T14 arm (e) |
| B4 | The only supported proof route omits the new `app` discriminant | **Accept** | §17 T12 (`stepPrompt.ts` prove contract, `composeBootstrapProofTask`, the `mcpQueryHandler` authorization test) |
| B5 | The runbook pin does not bind `app`; the query schema omits `bundle-identity` | **Accept** | T5 acceptance criteria; §18 gains two rows |
| B6 | The boot sweep can delete another live instance's simulator | **Accept** | §8.2 (owner marker, proven-dead sweep, unmarked devices left alone), T2, T15, T16 #7 |
| M1 | Serve-less does not mean port-less in the current scheduler | **Accept** | §4 (Ports row), §6.2, §8, §14 #4, T3, T4, T5 |
| M2 | The proposal advertises an optional Xcode MCP grant but implements no grant | **Accept** | Title, §1, §2, §3, §4, §11 (retitled "Stage 3 design notes — NOT built"), §13, §14 #18, §15 #1/#4, §16, T1, T2, T13, T15, T16 #1. §11.1's auto-approve hardening **stays** in Stage 1 as an inert commit |
| M3 | T11 changes the wrong decline type | **Accept** | T11 (policy in `decideRunbookBootstrap`/`runbookBootstrapPreflight`; the runner keeps its own `BootstrapDeclineKind`), §18 |
| M4 | T0 cannot extract nonexistent mobile behavior with zero behavior change | **Accept** | T0 (two named pure extractions), §14 #1 |
| M5 | The 17-task plan is not file-partitioned | **Accept** | §17 preamble (ordered serial graph, declared-overlap table, execution order), §19 |
| M6 | Posture classification remains coupled to English text | **Accept (scoped)** — a `VerificationDeclineCode` is added and pinned by test, but the three legacy substrings stay as a fallback for string-only callers, and the prose keeps "verification runbook" as belt and braces | §14 #6, T3, §18 |
| M7 | The capability reset migration is repeatable but semantically overbroad | **Accept** | §10.1 (reason-filtered `DELETE`), T10 |
| M8 | The Xcode 27 engine is not interchangeable with the proposed contract | **Accept** | §3 (closing paragraphs rewritten; "engine-agnostic" claim deleted), §16 Stage 3 |
| M9 | T16 cannot "set" production deadlines without reopening source tasks | **Accept** | `mobileDeadlineFloorMs` knob in T1/T3; §14 #10; T16 measures only |
| M10 | Prompt coverage and roster tests are incomplete | **Accept** (with B4) | T12 (`stepPrompt.ts` + test), T8 (`visualVerificationResolver.test.ts` moved from T13), §18 |
| M11 | The new duplicated fields lack cross-field invariants | **Accept** | §6.5 (registration-time and runtime halves), T1, T6 |
| M12 | The clone-template option weakens the isolation claim | **Accept** | §4, §8 (Simulator row), §13, §15 #6, T1 (knob removed) |
| minors | Eleven doc-accuracy notes: the boot-time measurement, the `driverCore.ts` citation range, T4 naming both port checks, independently-caught cleanup steps, `configManager.ts:824-844`, the `requestedVerifyType` zero-producer claim, T13 settings-copy scope, T9's exact line count, T14 arm (d) wording, and the slot-max reliability claim | **Accept**, all | §1, §5.3, §8.1, §10.1, §14 #10, §15 #5, §19, T4, T9, T13, T14, T15 |

The citation audit found **one** stale citation (`driverCore.ts:924-951`, whose
range ends before the PID-recording sequence it was cited for) and two
imprecisions (`configManager.ts:824-845` where the getter ends at `:844`, and
`visualVerificationResolver.ts:247-252` supporting "not inferred here" but not
the stronger repo-wide zero-producer claim, which the `requestedVerifyType` grep
supports separately). Every other cited range was verified correct.

### The fourteen open questions, answered

1. **Which security claim?** Staged-artifact identity (B1). A trusted build
   executor is Stage 2, and it is the only thing that would make the stronger
   claim true.
2. **What readiness predicate?** Pid alive **and** two identical consecutive
   non-uniform frames, polled every 500 ms, bounded at 90 s by default. Timeout
   ⇒ exit 3, last frame kept, reported `not_testable (readiness-timeout)`.
3. **Where does allocation move?** Inside the runner's existing `try`, after pin
   and provider validation.
4. **How are stale resources told from live ones?** An owner marker per request
   dir carrying pid plus process start time. Only proven-dead owners are swept;
   unmarked `cyboflow-verify-*` devices are logged and left alone.
5. **Is Stage 1 shipping an Xcode MCP grant?** No. The flag, the probe and every
   grant claim are removed.
6. **How would the grant's tool discovery work?** Deferred to Stage 3 and not
   designed here beyond §11's notes.
7. **Codex and mobile?** Codex runs mobile unchanged and is never refused. The
   engine is Bash plus Apple CLIs.
8. **Truly portless?** Yes — no port lease for mobile, both ports null, both
   preflight port checks skipped.
9. **Which regions move in T0?** The `8353a3a0a` verify/eval composition port for
   `index.ts`, and the scheduler's `this`-free module-level constants and free
   functions into `schedulerHelpers.ts`. No mobile code.
10. **Which layer owns `auto-derive-unsupported`?** The eligibility layer —
    `decideRunbookBootstrap` plus `runbookBootstrapPreflight`.
11. **Must all four bundle identities agree?** Yes: the parser, `mobile-install`
    and the attestation each check their half, and §6.5 states the invariant.
12. **Template simulators?** Dropped. Fresh devices only.
13. **Is Xcode 27 a separate engine contract?** Yes. §3 is reworded; Stage 3 is
    deferred, not described as already engine-agnostic.
14. **Does T16 set deadlines?** No. It validates and records. The floor is a
    config knob set in T1/T3.
