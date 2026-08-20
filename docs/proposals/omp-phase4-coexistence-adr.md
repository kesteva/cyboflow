# ADR: OMP Phase 4 — coexistence: OMP as a remote runtime beside the process seam

Status: **GO for v1 (quick-session scope).** OMP becomes a first-class runtime in the
quick-session agent-runtime picker, backed by a separate `OmpSessionManager` that sits
**beside** the `AbstractCliManager` family and is **fail-closed** on the Phase-3 bridge
config. Workflow-step execution on OMP is a named follow-up increment, not v1.

This is the coexistence decision `omp-substrate-plan.md` §Phase 4 gates: whether
`AgentProvider`/`AbstractCliManager` can be extended so a Cyboflow session *runs on OMP
as a substrate*. It follows the Phase-3 ADR and does not re-open its transport decision —
it records that the Phase-3 gate has now cleared on the consumer side.

---

## 1. Transport reality (the Phase-3 gate has cleared, consumer-side)

The Phase-3 ADR (`omp-phase3-command-adr.md` §3) declared **NO-GO** because the producer
exposed no externally-callable, authenticated, structured control-plane transport. That
premise has changed: the **OMP Prime bridge** now ships exactly the surface the ADR asked
for — an externally-callable, bearer-token-authenticated, structured MCP endpoint
(`POST /mcp/v1/sessions/<sessionId>`), already implemented and verified in this repo:

- `main/src/orchestrator/omp/ompBridgeClient.ts` — `OmpBridgeHttpClient.callTool`
  (JSON-RPC 2.0 `tools/call`, bearer auth, loopback-only URL, structured content out).
- `main/src/orchestrator/omp/ompBridgeConfig.ts` — `resolveOmpBridgeCommandConfig`
  (loopback URL + 0600 token file + session id; `undefined` when any piece is missing).
- `main/src/orchestrator/omp/ompBridgeCommandAdapter.ts` — already maps
  `spawn → fleet_spawn`, `kill → fleet_kill` (plus apply/discard/verify) with the
  snake_case↔camelCase translation owned here, never by callers.

**Consequence:** the "no transport" blocker is gone. The remaining Phase-3
non-negotiables are unchanged and still hold: `omp:supervise` is granted **only** when
`CYBOFLOW_OMP_SUPERVISE` is truthy (`ompPrincipal.ts`); audit is fail-closed; a BLOCKED
candidate is not a PASS; shadow is not enforcement; Cyboflow never passes gate argv or
proof blobs.

## 2. Non-negotiables (carried, unchanged)

1. **Do NOT widen `AbstractCliManager`.** It is the process-stream seam for *local*
   child processes (PTY/SDK). An OMP session is a **remote** OMP worker; Cyboflow
   supervises it over the bridge — it has no local child process, no PTY, no
   stdout stream. Winding it through the 1220-line `AbstractCliManager` base would
   force a fake `CliProcess` stub and mis-model the lifecycle. OMP sits **beside** it.
2. **Workers submit-only; spawn/kill/verify/apply are privileged, supervisor-only**,
   with identity + audit. Cyboflow-as-substrate is a supervisor. Every OMP runtime call
   goes through the `OmpCommandAdapter` behind the `hasSupervise` capability, never a
   worker-reachable path.
3. **Fail-closed availability.** When `resolveOmpBridgeCommandConfig()` is `undefined`
   (no bridge / token / session id) **or** the `omp` provider access toggle is off, the
   OMP runtime is **hidden** from the picker and any attempt to launch it returns a
   clear `unavailable` — never a silent no-op, never a fallback to a local provider.
4. **No `AgentProvider` widening until this ADR exists.** This document is that gate.
   The `agentRuntime.ts` changes land *with* this ADR as increment 1.

## 3. Decision — OMP as a runtime, beside the process seam

**Decision:** add `AgentProvider = 'omp'` and `AgentRuntime = 'omp-fleet'`, driven by a
new `OmpSessionManager` (a **sibling**, not a subclass, of the four
`AbstractCliManager` managers). It implements the narrow chat surface the IPC layer
consumes — `spawn`, `sendInput`, `stop`, `isPanelRunning`, and `output`/`exit` events —
by mapping onto the fleet lifecycle, with **no** child process:

| Chat lifecycle (IPC surface) | Fleet tool | Notes |
|---|---|---|
| `spawn(panelId, …, prompt)` | `fleet_spawn` { task: prompt, workspace, model, execution_mode } | returns worker id; stored on the panel |
| `sendInput(panelId, text)` | `fleet_send` { worker_id, message } | follow-up turns steer the same worker |
| `output` (poll) | `fleet_read` { worker_id } | new output since last read, emitted as `output` events |
| liveness / exit detection | `fleet_state` { worker_id } | leaves `running` ⇒ emit `exit` (terminal) |
| `stop(panelId)` | `fleet_kill` { worker_id } | deliberate termination |

One panel ≙ one OMP worker. The first message spawns; subsequent `sendInput` calls steer
the same worker; the panel emits the same `output`/`exit` event shapes the UI already
consumes for the other runtimes.

**Rejected:**
- **`OmpCliManager extends AbstractCliManager`** — forces a fake `CliProcess` and models
  a remote worker as a local process; the ADR forbids widening the process seam.
- **A 5th `PanelLane` (provider × substrate)** — OMP is not a substrate axis; it is a
  whole different transport. A dedicated manager + dispatch branch is the honest shape.
- **Routing OMP through the existing 4 managers** — none of them has a bridge transport;
  inventing one inside a manager would fork the Phase-3 authority model.

## 4. Scope — v1 is quick-session only

**v1:** the **quick-session** runtime picker (`SubstrateSelector.RUNTIME_OPTIONS` and
`SessionAgentRuntime`) offers **OMP Fleet**, gated by availability (§2.3). That is the
surface in the user's screenshot ("agent runtime dropdown got no omp") and the minimal
real, verifiable slice.

**Named follow-up increment (NOT v1):** the **workflow-step** runtime picker
(`WorkflowAgentRuntime` / step inspector / global Agents editor) and `spawnStepRunner`
dispatch. Workflow steps carry richer lifecycle needs (step-scoped reporting, handoff,
deterministic run bookends) that a separate increment must design; shipping them in v1
would enlarge the highest-risk change (the dispatch file) without the design work.
`AgentRuntime` therefore keeps `'omp-fleet'` as a session runtime; workflow inclusion is
the documented next step.

## 5. Availability + gating (concrete)

- **Aria mode is the grant + the flavor switch.** `AppConfig.ariaMode`
  (Settings → Advanced Options → OMP Runtime) answers both "does this install
  supervise a REMOTE fleet or run OMP locally" and "is Cyboflow authorized to
  drive it". `omp-fleet` and `omp-sdk`/`omp-pty` are ALTERNATIVES — a panel is
  either a local OMP process or a supervised remote worker — so the picker
  offers one flavor or the other, never both. `CYBOFLOW_OMP_SUPERVISE` remains
  an override for headless/CI hosts with no Settings UI; the two are OR-ed.
  Requiring a shell variable to switch on a desktop feature was a real usability
  failure, not a security property: reachability of the bridge and authorization
  to drive it stay separate questions, but the operator answers the second one
  by clicking, not by exporting.
- **Fail-closed config:** `OmpSessionManager` is constructed **only** when
  `resolveOmpBridgeCommandConfig()` resolves **and** the boot principal holds
  `omp:supervise`. Either one missing ⇒ no manager instance ⇒ dispatch returns
  `unavailable` and the picker omits the entry. A half-configured bridge must never
  silently authorize a session, and a *fully* configured one must not either: config
  says the fleet is REACHABLE, the capability says this operator authorized Cyboflow to
  drive it. Those are different questions and both have to answer yes.
- **Provider access toggle:** `AGENT_PROVIDERS` gains `'omp'`, so the existing
  `AgentProviderAccess` toggle system works for OMP with zero new gating code. The OMP
  entry is visible **only if** `isAgentProviderEnabled(access, 'omp')` **AND** the bridge
  config resolved.
- **`cyboflow.omp.availability` reports the manager, not the config.** It asks whether
  the boot-built `OmpSessionManager` EXISTS rather than re-deriving
  `resolveOmpBridgeCommandConfig()`. Re-deriving would let the picker offer OMP fleet the
  instant Aria mode is toggled while dispatch still answered "the bridge is not
  configured" until the next launch; asking the manager keeps the picker and the dispatch
  seam telling one story. `ariaMode` rides the same probe and IS live, because the flavor
  split is pure presentation.
- **Capability:** enforcement is **structural, not by convention**. Every adapter handed
  to a caller — the tRPC context's and the session manager's alike — is wrapped in
  `OmpSupervisedAdapter`, which capability-checks all eight verbs and audits the six
  mutating ones (ATTEMPTED + COMPLETED, correlated on `operationId`). The two read-only
  poll verbs are gated but deliberately unaudited: at `OMP_DEFAULT_POLL_MS` per live
  panel they would bury the mutation trail.

  This replaces an earlier arrangement in which only the `ompCommand` router checked
  `hasSupervise`. `OmpSessionManager` drives the SAME privileged surface from the panel
  seams, so a bare adapter put the product's actual path outside the authorization model:
  spawn and kill ran unchecked and unaudited while the router answered FORBIDDEN for the
  same verbs. Wrapping is what makes "workers never receive the supervise surface" a
  property of the type rather than a rule each new seam has to remember.
- **Loopback is checked by parsed hostname**, not string prefix. The config carries a
  bearer token the client sends to whatever host it names, and
  `startsWith('http://127.0.0.1')` accepts `http://127.0.0.1.evil.example/`. The token
  file's owner-only mode is enforced rather than assumed.
- **Teardown is explicit.** OMP workers are REMOTE: nothing about a panel closing, a
  session being dismissed, or the app quitting stops them. Dismiss and `before-quit` both
  call into the fleet manager directly, because `resolvePanelLane` maps these
  `'claude'`-typed panels onto the `omp-sdk` lane whose manager never spawned them.

## 6. Consequences / increments

**Storage:** the `omp-fleet` runtime is admitted on `sessions.agent_runtime` and
`workflow_runs.agent_runtime` by migration **105**, which reuses 103's additive
DROP/re-ADD-column recipe. It is deliberately NOT a table rebuild: the migration ledger
is keyed by filename, so a new file numbered into a gap below an already-released
migration runs LAST on an upgraded DB, and a hardcoded `CREATE TABLE sessions` there
drops every column it fails to list (`status_message`, added imperatively by
`database.ts`, is the live example) and restates 103's CHECK lists from memory —
un-widening `omp-sdk`/`omp-pty` on exactly the installs that use them.

**Status:** increment 1 (types) and increment 2 (adapter `send`/`read`/`state`) are
landed and gate-green. Increments 3-5 are pending.

- **Increment 1 (this ADR + types):** land `agentRuntime.ts` widening (provider `omp`,
  session runtime `omp-fleet`, label, `providerForRuntime`, disabled-pattern) *together*
  with this document. No behavior yet — pure types, so the full gate stays green.
- **Increment 2 (adapter):** extend `OmpCommandAdapter` + `OmpBridgeCommandAdapter` with
  `send`/`read`/`state` (the chat-lifecycle tools), verified against the live bridge
  response shapes.
- **Increment 3 (manager):** `OmpSessionManager` beside the four managers.
- **Increment 4 (wiring + picker):** dispatch lane + quick-session picker entry,
  gated by availability.
- **Increment 5 (tests + full gate).**

## 7. Out of scope

- Workflow-step execution on OMP (named follow-up, §4).
- Auxiliary read sources (Shepherd, proofs, observability, beads, reverie) — separate
  interfaces.
- Granting `omp:supervise` to anything other than the Phase-3 principal model.
