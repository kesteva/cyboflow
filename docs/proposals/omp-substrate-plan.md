# Cyboflow → OMP-aware → OMP-capable: implementation plan

Status: **ready to begin the rebuild, NOT ready to claim capability.**
The four read-adapter files exist and are verified but are untracked and unwired.
This plan sequences the work so every phase is independently reviewable and
shippable, with the authority model settled before any command is implemented.

## Ground truth (verified against the live tree)

- OMP producer (`OMP-fleet-management`) has a merged versioned registry
  contract; `parseRegistrySnapshot` returns `ok | unsupported-version | malformed`
  and the producer sanctions consumer copies.
- Cyboflow has four untracked files: `shared/types/omp.ts`,
  `main/src/orchestrator/omp/registryContract.ts`,
  `main/src/orchestrator/omp/fleetRegistryReader.ts`,
  `main/src/orchestrator/omp/fleetRegistryReader.test.ts`.
- Seams:
  - `main/src/orchestrator/types.ts` → `OrchestratorDeps` (narrow, constructor-injected).
  - `main/src/orchestrator/trpc/trpc.ts` → `router`, `publicProcedure`,
    `protectedProcedure` (asserts `ctx.userId`).
  - `main/src/orchestrator/trpc/context.ts` → `createContext(deps)`; every dep is
    an optional narrow `*Like` interface or closure, injected from
    `main/src/index.ts` (the composition root) to preserve the standalone invariant.
  - `main/src/orchestrator/trpc/router.ts` → `appRouter` combines sub-routers
    under `cyboflow.*`; sub-routers live in `routers/*.ts` and import only
    `../trpc`, pure functions, and `shared/types`.
  - `main/src/ipc/types.ts` → `AppServices` bag.
  - `shared/types/agentRuntime.ts` → `AgentProvider = 'claude' | 'codex'` (do NOT widen).
  - `main/src/services/panels/cli/AbstractCliManager.ts` → process-stream seam (do NOT widen).
- Standalone invariant (`docs/ARCHITECTURE.md:73-75`): `main/src/orchestrator/**`
  must not value-import `electron`, `better-sqlite3`, or `services/*`.
  `node:fs` is allowed (precedent: `verify/depPreparer.ts`, `verify/snapshotProvisioner.ts`,
  `verify/verdictDelivery.ts`, `design/designHandoffService.ts`).

## Non-negotiable constraints

1. **Authority model** (from the OMP producer): workers are submit-only;
   `spawn`/`kill`/`verify`/`apply` are privileged, supervisor-only, with
   authenticated identity + audit. Cyboflow-as-substrate is a supervisor.
2. **No `AgentProvider` widening, no `AbstractCliManager` widening** until a
   separate lifecycle/capability interface exists. It coexists beside, never
   stretches, the transcript seam.
3. **Read surfaces** use `publicProcedure`/`protectedProcedure`; **command
   surfaces** use `protectedProcedure` + explicit identity/audit and are never
   reachable from a worker path.
4. Auxiliary read sources (Shepherd, proofs, observability, beads, reverie) are
   later optional increments, not a gate before capability work.

---

## Phase 0 — commit the read adapter (unblocks everything)

Goal: get the four verified files out of "untracked" and onto a branch.

- `git add shared/types/omp.ts main/src/orchestrator/omp/`
- `git commit -m "feat(omp): add read-only fleet-registry adapter"`
- Verify: `npx tsc --noEmit` (main), `npx vitest run src/orchestrator/omp` (16/16).

Acceptance: a commit exists; the four files are tracked; scoped gates green.
Riskiest thing here is only hygiene (the files are already double-reviewed).

## Phase 1 — wire the reader (finish "aware", read-only)

Goal: instantiate `FleetRegistryReader` as a service and expose one read-only
tRPC procedure so the renderer can display a fleet snapshot.

New files:
- `main/src/orchestrator/omp/ompService.ts` — thin `OmpService` that owns the
  `OmpControlPlaneAdapter` instance and caches the last snapshot (optional:
  plain pass-through first, caching later).
- `main/src/orchestrator/trpc/routers/omp.ts` — `ompRouter`.

`ompRouter` (sketch):
```ts
import { router, protectedProcedure } from '../trpc';
import type { OmpSnapshotResult } from '../../../../../shared/types/omp';

export const ompRouter = router({
  fleetSnapshot: protectedProcedure.query(async ({ ctx }): Promise<OmpSnapshotResult> => {
    const omp = ctx.omp; // narrow OmpControlPlaneAdapter | undefined
    if (!omp) {
      return { ok: false, error: 'unavailable', detail: 'OMP adapter not configured' };
    }
    return omp.getFleetSnapshot();
  }),
});
```

Touched existing files:
- `context.ts`: add `omp?: OmpControlPlaneAdapterLike` to `ContextDeps` and
  `createContext` (narrow interface: `{ getFleetSnapshot(): Promise<OmpSnapshotResult> }`).
- `router.ts`: add `omp: ompRouter` under `cyboflow`.
- `main/src/index.ts` (composition root): construct `new FleetRegistryReader()`
  and pass it into `createContext({ omp })`.
- `shared/types/trpc.ts` (or the inferred `AppRouter`): picks up the new
  procedure automatically; add the renderer query hook type.

Acceptance: renderer can call `cyboflow.omp.fleetSnapshot` and receive the
discriminated result; missing file → `unavailable`, not a crash.
Verify: `pnpm typecheck`, `npx vitest run src/orchestrator/omp src/orchestrator/trpc`.

Note: `getFleetSnapshot` is the ONLY surface exposed. No mutation. This is the
end of "OMP-aware" for the registry.

## Phase 2 — the capability/lifecycle interface (declared, authoritative, STUBBED)

Goal: declare the privileged command surface as TYPES that mirror the
producer's ACTUAL tool surface, with a real per-caller principal + capability
check and redacted audit. This is a declared contract, NOT capability —
reworded: a stub makes the contract type-checkable; it does not make Cyboflow
"capable."

### Producer command inventory (verified — this is the contract Cyboflow mirrors)

Lifecycle (read + lifecycle, lower privilege):
- `fleet_spawn` — { model, task, label?, target?, workspace?, cwd?, timeout?,
  execution_mode?, intent?, scope? } → worker id
- `fleet_list` / `fleet_state` / `fleet_read` / `fleet_wait` / `fleet_kill` —
  read/observe/terminate workers

Proposal (the privileged surface, supervisor-only):
- `fleet_proposal_list` / `fleet_proposal_read` / `fleet_proposal_diff` (read)
- `fleet_proposal_apply` — { proposal_id, reason } — canonical-authority + scope
  + CAS + candidate-bound proof checked by the producer
- `fleet_proposal_discard` — { proposal_id, reason } — first-class unprivileged
  mutation; unsafe work is always discardable

Verification (candidate-bound; the builder cannot mint its own PASS):
- `fleet_verification_candidate` → canonical candidate digest
- `fleet_verification_run` → signed PASS/FAIL/BLOCKED (argv from host policy only)
- `fleet_verification_status` / `fleet_verification_proof`

There is NO `fleet_verify` or `fleet_apply` tool. Verify is
`fleet_verification_*`; apply is `fleet_proposal_apply`. Callers pass only
`proposal_id` (plus a `reason` for apply/discard); the producer resolves and
binds the candidate digest/proof — Cyboflow never passes arbitrary gate argv
or proof blobs.

### Identity — the unfalsifiable-authority fix

`ctx.userId` is hardcoded `'local'` today (`trpc.ts`/`context.ts`). A
`protectedProcedure` + `ctx.supervisor` presence check would therefore authorize
every local caller — the exact collapse the producer forbids. Phase 2 must add
an immutable principal + capability, not rely on presence:

```ts
// shared/types/ompCommand.ts
export interface OmpPrincipal {
  readonly userId: string;                 // immutable per request
  readonly capabilities: ReadonlySet<string>;
}
export function hasSupervise(p: OmpPrincipal): boolean {
  return p.capabilities.has('omp:supervise');
}
```

`createContext` gains `principal?: OmpPrincipal`; the command router asserts
`hasSupervise(ctx.principal)` and throws `FORBIDDEN` otherwise — independent of
`ctx.userId === 'local'`. In v1 this is gated behind a config flag (supervise
capability off by default); v2 populates it from a real session token.

### Command contract (typed against the real surface)

```ts
export interface OmpCommandAdapter {
  readonly authority: 'supervise';
  // lifecycle
  spawn(req: OmpSpawnRequest): Promise<OmpCommandResult>;
  kill(req: OmpKillRequest): Promise<OmpCommandResult>;
  // proposal (privileged)
  apply(req: OmpApplyRequest): Promise<OmpCommandResult>;   // { proposalId, reason }
  discard(req: OmpDiscardRequest): Promise<OmpCommandResult>;
  // verification (candidate-bound)
  verifyRun(req: OmpVerifyRequest): Promise<OmpCommandResult>; // { proposalId }
}

export type OmpCommandResult =
  | { ok: true; operationId: string; detail: string }
  | { ok: false; error: 'unavailable' | 'forbidden' | 'conflict' | 'blocked' | 'shadow'; detail: string };
```

Notes: every result carries an `operationId` for idempotency/correlation;
`blocked` and `shadow` are distinct (a BLOCKED candidate is not a PASS; shadow
is not enforcement). `timeout`/cancel live on the request types (spawn/kill)
and are threaded to the producer, not dropped.

### Audit (redacted, attempted + completed)

- `audit('omp.spawn', { principal: ctx.principal.userId, input })` — ATTEMPTED,
  input redacted (task text, scope paths scrubbed).
- `audit('omp.spawn', { principal, operationId, result })` — COMPLETED, result
  detail redacted.

The audit surface must be an existing narrow interface, not a new "TBD" —
locate the concrete service in `main/src/services` during Phase 2; if none
exists, Phase 2 scopes to a local in-memory ring buffer and names the real
surface as a Phase 2.5 dependency, not a silent gap.

New files: `shared/types/ompCommand.ts`, `main/src/orchestrator/omp/ompCommandStub.ts`,
`main/src/orchestrator/trpc/routers/ompCommand.ts`.
Touched: `context.ts` (principal + command adapter + audit), `router.ts`, `index.ts`.

Acceptance: command router is protected by `hasSupervise` (not presence); every
call is audited (attempted + completed, redacted); all methods are stubbed
`unavailable` + `operationId`. NO real command runs.
Verify: `pnpm typecheck`; router unit tests assert (a) a non-supervise principal
is rejected FORBIDDEN, (b) audit records both events, (c) stubs return
`unavailable`.

## Phase 3 — command implementations (SEPARATE ADR; do not start from this doc)

Goal: implement the real command surface behind `OmpCommandAdapter`. This is
deliberately NOT scheduled here — it is its own ADR with its own go/no-go.
That ADR exists: `docs/proposals/omp-phase3-command-adr.md`.

**Current status (from the ADR): NO-GO.** There is no externally-callable,
authenticated, structured control-plane transport in the producer today — the
`fleet_*` tools are in-session only (`pi.registerTool`), the herdr socket is
pane-lifecycle only, and `omp -p` is prompt-mediated spawn. The earlier "one of
(a) MCP fleet_* / (b) `omp --mode rpc` / (c) `omp -p`" framing was wrong:
`omp --mode rpc` and `set_subagent_subscription` do not exist, and neither
herdr nor `omp -p` reaches apply/discard/verify. The ADR records the
re-opening gate (a producer-owned authenticated endpoint) and the identity +
gating rules that apply once it lands.

Non-negotiables carried from the producer (unchanged): workers never write the
host repo; apply is privileged and separate; a PASS is candidate-bound; the
builder cannot mint its own PASS; `proposal_ready` ≠ done; **discard never
requires PASS**; shadow is not enforcement.

## Phase 4 — auxiliary read sources + the coexistence decision

Goal: fill in the remaining read surfaces behind SEPARATE interfaces (not
`OmpControlPlaneAdapter`, which only exposes `getFleetSnapshot`), aggregated by
an OmpAwarenessService. Then decide whether `AgentProvider`/`AbstractCliManager`
coexistence is worth it.

- Each source is its own adapter + its own increment, behind its own narrow
  interface, aggregated by `OmpAwarenessService`:
  - Shepherd project store (traces)
  - verifications proofs (candidate-bound PASS/FAIL/BLOCKED)
  - observability `catalog.db`
  - beads (work state)
  - reverie (compact learnings)
- The coexistence decision: given the `OmpCommandAdapter` (Phase 2) exists
  beside `AbstractCliManager`, decide whether a workflow run can *execute on
  OMP as a substrate*. This is a design decision (an ADR), not a code sprint,
  and it follows the Phase 3 ADR, not precedes it.

Acceptance: each read source lands as its own reviewed, tested increment behind
its own interface; the coexistence decision is written down before any
`AgentProvider` change.

## Riskiest assumption

That the OMP control-plane command surface (`fleet_spawn`/`fleet_kill`/
`fleet_verification_*`/`fleet_proposal_apply`/`fleet_proposal_discard`) can be
invoked from Cyboflow's main process without granting worker-equivalent
authority to a machine-local Electron app. It is first tested in the **Phase 3
ADR** — specifically by proving a non-supervise principal is rejected by the
`hasSupervise` capability check before any apply reaches the producer, and that
apply is candidate-bound (the producer resolves the digest/proof; Cyboflow never
passes gate argv or proof blobs). If that cannot be demonstrated cleanly,
Phases 3-4 stay behind a go/no-go and "capable" remains honestly unclaimed.
