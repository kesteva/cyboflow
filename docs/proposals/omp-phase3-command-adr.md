# ADR: OMP Phase 3 — transport reality check, supervisor identity, and the apply go/no-go

Status: **NO-GO for Phase 3 command implementation.** The transport prerequisite
does not exist in the producer today. This ADR records the decision, the
falsification test that would re-open it, and the identity + gating rules that
apply once it re-opens.

It settles the three prerequisites `docs/proposals/omp-substrate-plan.md`
§Phase 3 names as blocking — transport, supervisor identity, PASS-bound apply —
and corrects two errors in that section (a speculative transport surface that
does not exist, and an apply/discard gating asymmetry).

---

## 1. Verified ground truth (producer repo, read this session)

| Surface | Reality (verified against `OMP-fleet-management`) |
|---|---|
| `fleet_*` tools (`fleet_spawn`, `fleet_proposal_*`, `fleet_verification_*`) | **In-session only.** Production `extensions/fleet/index.ts:712+` calls `pi.registerTool({ name, parameters, execute })` to register each tool into the OMP session's ExtensionAPI; tests merely supply mock `ExtensionAPI`s to invoke them. The narrow, provable claim from this repo: **Fleet itself implements no external listener, framing, handshake, or auth transport** — no MCP server, no `@modelcontextprotocol`/fastmcp integration, no HTTP tool endpoint, no Unix-socket RPC exposing the Fleet controller. Whether the OMP **core** re-exposes these in-session tools over an external transport is unverified from this side. |
| herdr Unix-socket JSON-RPC (`extensions/fleet/socket-client.ts`) | **Pane lifecycle only** (split/read/focus/pane spawn). Never reaches proposal apply, discard, or verification proof. Not a supervisor transport. |
| one-shot `omp -p` (`extensions/fleet/client.ts:180`) | **Prompt-mediated spawn.** No apply/discard/verify. Nondeterministic framing for a privileged mutation. |
| `omp --mode rpc` host-tools / `set_subagent_subscription` | **Does not exist.** Speculative text in the plan doc; no such surface in the producer. |
| Observability HTTP server (`extensions/observability/dashboard.ts`) | Localhost-only, **no auth**, read-only dashboard. Not a control-plane transport. |

**Conclusion of §1:** there is **no externally-callable, authenticated,
structured control-plane transport** in the producer. The `fleet_*` tools exist
only inside an OMP session, reachable by that session's agent — not by a
separate process such as Cyboflow's main.

If such an endpoint exists in the OMP **core** (a separate repo, not
`OMP-fleet-management`), it is unverified and undocumented from this side, which
is equivalent to "does not exist" for planning a consumer. We do not build
against an assumed surface.

---

## 2. Non-negotiables (carried from producer, unchanged)

1. Workers never write the host repo. `May[GitRepo, ReadWrite]` on the host
   belongs only to the apply controller.
2. Apply is privileged and separate from spawn/kill/verify.
3. A signed, unexpired PASS binds the exact proposal, worker, run, trace, base
   revision, normalized changed paths, Shepherd `candidate_head`, policy,
   profile, and verifier version. The builder cannot mint its own PASS
   (`ARCH.md:11`).
4. `proposal_ready` ≠ done.
5. **Discard never requires PASS** — unsafe work must always remain discardable
   (`ARCH.md:13`).
6. **Shadow is not enforcement** — shadow may allow apply for rollout
   compatibility with an explicit warning, never silent authorization
   (`ARCH.md:14`).
7. Callers pass only `proposal_id` (plus `reason` for apply/discard). Cyboflow
   never supplies gate argv or proof blobs; the producer resolves and binds both.
8. Audit fail-closed: no sink → refuse; every attempt records redacted
   attempted + completed (including forbidden and thrown), one `operationId`
   throughout.

---

## 3. Decision 1 — transport: NO-GO

**Decision:** Phase 3 command implementation does **not** proceed. Cyboflow
does **not** invent a control-plane transport.

**Why.** Every command surface that matters (`spawn`, `kill`,
`fleet_proposal_apply`, `fleet_proposal_discard`, `fleet_verification_*`) is
producer-side. §1 shows none is externally callable today. Any of the apparent
options collapses on inspection:

- **In-session `fleet_*` tools** — not reachable by an external process; there is
  no listener, framing, handshake, or auth to consume.
- **herdr socket** — wrong layer (pane lifecycle, bypasses the Fleet controller's
  scope/authority logic entirely).
- **`omp -p`** — prompt-mediated and nondeterministic; and it never reaches
  apply/discard/verify at all.
- **Build our own endpoint in Cyboflow** — would fork the producer's authority
  model and give the machine-local app worker-equivalent authority, the exact
  collapse the producer forbids.

**Re-opening gate (what must become true):** the producer ships a documented,
authenticated, structured external control-plane endpoint (MCP server or RPC)
that exposes `fleet_*` with per-caller identity, and states its auth model.
Until that lands, "OMP-capable" remains honestly unclaimed. The renderer stays
read-only (`cyboflow.omp.fleetSnapshot`), and the command router stays stubbed.

---

## 4. Decision 2 — supervisor identity (design intent, deferred until transport exists)

**Decision:** when transport exists, the `omp:supervise` capability is granted
**only** to an out-of-process supervisor child; Electron main never holds it,
main is a proxy.

**Why.** Cyboflow's main process is itself a worker substrate — it runs workflow
agents, and its renderer is worker-reachable. If main held the supervisor
credential, any renderer escalation lands on supervisor authority. The
producer's model ("workers submit-only; spawn/kill/verify/apply supervisor-only")
demands the authority live where a worker cannot escalate into it.

**Shape (for when it re-opens, not now):** a small `omp-supervisor` child owns
the OMP session/credential; main talks to it over a local authenticated Unix
socket with per-connection auth and a pinned process; the child enforces
capability. `hasSupervise(ctx.principal)` in `trpc/routers/ompCommand.ts` stays
the renderer-facing gate, but its v1 source of truth becomes "the supervisor
child accepted the principal", not `ctx.userId === 'local'`. v1 default remains
**supervise off**.

**Rejected:** granting `omp:supervise` to Electron main directly (collapses
"local app = worker authority"); to the renderer (immediate no).

This decision is recorded now so the transport choice is *not* revisited in a
way that silently grants main the credential; it is not executed until §3's
gate clears.

---

## 5. Decision 3 — apply vs discard vs lifecycle/verification

Once transport exists (§3 gate), the surfaces gate **differently**. The plan doc
and the prior stub lumped them together; that was wrong.

| Surface | Gate (after transport exists) |
|---|---|
| `spawn`, `kill` | Supervisor-authorized + audited + idempotent. Proceed. |
| `fleet_verification_candidate` / `run` / `status` / `proof` | Supervisor-authorized + audited. Candidate-bound (Cyboflow passes `proposal_id` only). Proceed. |
| `fleet_proposal_discard` | Supervisor-authorized + audited + idempotent. **No PASS required, no enforce-mode requirement** — `ARCH.md:13`. Proceed once transport exists, else Cyboflow can create retained proposals it cannot clean up. |
| `fleet_proposal_apply` | **Hard-disabled** until *all* of: (1) transport exists; (2) producer reports **enforce** mode active (not `off`, not `shadow`) — `ARCH.md:10` denies enforce outright until Shepherd supplies an expected-candidate-head settlement guard; (3) an exact candidate-bound PASS is the only path to settlement. |

**Never treat shadow success as authorization** (`ARCH.md:14`). A shadow "apply"
is a disclosed proof gap, not a green light; Cyboflow's apply stays unavailable
until enforce is real, at which point a real adapter may surface a producer
`blocked`/`shadow` verification outcome verbatim.

**Rejected:** shipping apply behind shadow; a Cyboflow-side proof check
substituted for the producer's candidate-bound re-inspection (inverts the trust
boundary); gating discard on PASS (violates `ARCH.md:13` and strands retained
proposals).

---

## 6. Consequences

- **Now:** no Phase 3 command code. The `ompCommand` router remains stubbed, and
  the stub keeps returning `unavailable` for **every** method while no transport
  exists. `blocked`/`shadow` are producer verification outcomes
  (`shared/types/ompCommand.ts:88-92`: "a BLOCKED candidate is not a PASS"), not
  transport states, so a stub returning `blocked` for "transport absent" would
  misreport producer policy. A real adapter may surface `blocked` only after an
  actual enforce/PASS gate denial. The read-only visibility surface
  (§Phase 0–1) is unchanged and already shipped.
- **The deliverable from this ADR is the go/no-go, not code.** The next action
  is producer-side: identify or build the authenticated external control-plane
  endpoint. Cyboflow-side work resumes only after §3's gate is demonstrated.
- **Riskiest assumption, restated:** that a machine-local Electron app can reach
  the OMP control plane as a supervisor without granting worker-equivalent
  authority. It is currently **unfalsifiable** because the transport to test it
  does not exist; the ADR refuses to proceed on assumption.

## 7. Out of scope (later ADRs)

- The coexistence decision (whether a workflow run executes *on OMP as a
  substrate* — `AgentProvider`/`AbstractCliManager` widening). Follows this ADR,
  never precedes it.
- Auxiliary read sources (Shepherd traces, proofs, observability, beads,
  reverie) — separate interfaces, Phase 4.
