# Merge plan: kesteva/main → main (OMP fleet coexistence)

Worktree: /Users/ahpramesi/repos/cyboflow (branch `main`, merge in progress, MERGE_HEAD=8f14327d)
OURS = local `main` (f2160088, "Merge OMP fleet substrate" — fleet runtime ADR work)
THEIRS = kesteva/main (8f14327d, "Codex/OMP provider+transport split" — v0.2.3 era)

## Design intent (HEAD/ours, from fleet ADR + prior merge resolution)
- `omp-fleet` = first-class citizen BEFORE the PTY-lane machinery: fleet sessions early-return
  from the panel input path (`routeOmpFleetTurn`) and are created WITHOUT spawning a PTY panel
  (early return before the codex-pty/interactive branches in `sessions:create-quick`).
- Fleet substrate = 'sdk' (structured), never 'interactive'. The interactive REPl eager-spawn
  must NOT fire for fleet.
- `omp-sdk`/`omp-pty` lanes (upstream) are separate from `omp-fleet` (ours). Both coexist.

## Upstream (theirs) changes being merged in
1. Per-provider transport axis: `PanelLane` = 8 values (claude-sdk, claude-interactive,
   codex-sdk, codex-pty, omp-sdk, omp-pty). `quickPtyLanes` = {claude-interactive, codex-pty, omp-pty}.
2. `QUICK_PROVIDER_SDK_RUNTIME` (in createQuickSessionCore.ts:304): provider→structured runtime.
   ⚠️ Mapped `omp: 'omp-sdk'` upstream — for quick-sessions WITHOUT a migration-027 runtime
   request. Fleet picker requests agent_runtime='omp-fleet' explicitly (stamp path), so the
   provider default 'omp-sdk' only affects bare provider picks. ACCEPT 'omp-sdk' default
   (matches theirs); fleet sessions always pass an explicit runtime.
3. Structured-lanes dispatch: `relayOrSpawnPtyPanel` (ptyPanelDispatch.ts),
   `resolvePanelLane`/`laneForPanel` (panelLane.ts), dispatch facade lane-based routing.
4. `SessionAgentRuntime` widened by 'omp-sdk' (upstream) + 'omp-fleet' (ours) = 7 values.
   `PanelLane` stays 6 (no omp-fleet) — fleet is not a panel lane.

## Conflict resolutions
### panelLane.ts — ADOPT THEIRS + one addition
- Take theirs' 8-lane/6-PanelLane version wholesale.
- ADD after `isPtyLane`:
```ts
/**
 * True when the runtime is interactive BY CONSTRUCTION (a PTY lane whose
 * provider carries no substrate axis of its own): `codex-pty`, `omp-pty`.
 * `omp-fleet` is deliberately absent — a fleet session's substrate is decided
 * by the usual ladder, not pinned to a terminal.
 */
const IMPLICITLY_INTERACTIVE_RUNTIMES = new Set<string>([
  'codex-pty',
  'omp-pty',
]);

export function isImplicitlyInteractiveRuntime(runtime: SessionAgentRuntime): boolean {
  return IMPLICITLY_INTERACTIVE_RUNTIMES.has(runtime);
}
```
- Update panelLane.test.ts: keep theirs' tests, ADD `expect(isImplicitlyInteractiveRuntime('codex-pty')).toBe(true)`,
  same for 'omp-pty', and `toBe(false)` for 'omp-fleet', 'omp-sdk', 'codex-sdk'.

### session.ts (14 conflicts) — adopt THEIRS structure, keep OURS fleet branches
- C1 (372-418 explicitProvider label): adopt theirs (`AGENT_PROVIDER_LABELS[explicitProvider]`).
- C2 (1203-1207 quickProvider runtime): adopt theirs (`QUICK_PROVIDER_SDK_RUNTIME[quickProvider]`).
- C3 (1224-1257 resolved-runtime design): adopt theirs.
- C4 (1283-1361 structured-lanes): adopt theirs. Fleet branch at ~1385
  `} else if (useOmpFleet) {` auto-merged and MUST be kept (creates panel without PTY spawn).
- C5 (ours 2048-2050 / theirs 1952-1982, sessions:input): adopt theirs' structured-lane input
  routing, AND HOIST OURS' fleet early return ABOVE the `if (inputPtyLane)` block:
```ts
      const claudePanel = postCreateClaudePanels[0];
      // Fleet sessions relay to the OMP worker, never into a PTY/SDK panel.
      if (dbSession?.agent_runtime === 'omp-fleet') {
        await routeOmpFleetTurn(services, dbSession, claudePanel.id, finalInput);
        return { success: true };
      }
      const inputLane = resolvePanelLane(dbSession, claudePanel);
      const inputPtyLane = quickPtyLanes.get(inputLane);
      if (inputPtyLane) { ...theirs relay/spawn... return { success: true }; }
```
  (Ours' committed version nested the fleet check INSIDE `if (inputPtyLane)` — never fires for
  fleet because their lane is structured. Hoisting is the merge fix, not a regression.)
- C6 shared call site (1270-1271): replace `isPtyLane(nonClaudeQuickRuntime)` with
  `isImplicitlyInteractiveRuntime(nonClaudeQuickRuntime)` — `omp-fleet` must map to 'sdk'.
  (isPtyLane keeps `PanelLane` signature; its other call sites pass PanelLane.)
- All other conflicts: adopt theirs, EXCEPT where a fleet-only branch was auto-merged
  (grep `omp-fleet` in final file and verify each site compiles + behaves).

### types.ts — theirs' structural imports + OmpSessionManager
```ts
import type { OmpSessionManager } from '../orchestrator/omp/ompSessionManager';
import type {
  CliManagerFactory,
  CodexPtyManagerLike,
  CodexSdkManagerLike,
  OmpPtyManagerLike,
  OmpSdkManagerLike,
} from '../services/cliManagerFactory';
```
AppServices: keep ours' `ompSessionManager` field (index.ts:3618 passes it); adopt theirs'
manager field types (structural Like interfaces).

### ompSessionManager.ts — keep OURS (fleet bridge runtime); theirs' changes are
for the omp-sdk/omp-pty managers (different files). Verify imports still resolve.

### substrateResolver.ts — keep OURS if ours adds fleet mapping; else theirs. (check)

### index.ts — adopt theirs + keep ours' fleet manager block (1559-1573) + AppServices wiring.

### substrateDispatchFacade.ts — adopt theirs (lane-based); fleet never reaches it via a PTY lane.

### createQuickSessionCore.ts — NO conflict. QUICK_PROVIDER_SDK_RUNTIME maps
`omp: 'omp-sdk'`. The stamp (388-414) already resolved via ours: fleet stamps
agent_runtime='omp-fleet', substrate = input.resolvedSubstrate (isPtyLane('omp-fleet')=false
→ stays resolved). ⚠️ createQuickSessionCore:406 calls isPtyLane(resolvedSessionAgentRuntime)
with a SessionAgentRuntime — SAME type error. Fix: use isImplicitlyInteractiveRuntime there too.

### trpc/context.ts, trpc/router.ts, trpc/index.ts — ALREADY RESOLVED (Python, earlier).
### ompRouter.ts, sessionRouter.ts, workflows.ts, appVersion.ts — inspect + resolve (theirs
likely; verify no fleet references lost).

## Verification
- `git diff --check` clean; `grep -c '<<<<<<<'` = 0 in src (dist/ ignored).
- `export PATH="/opt/homebrew/opt/node@22/bin:$PATH" && pnpm typecheck` + `pnpm lint`.
- Scoped: `cd main && npx vitest run src/services/__tests__/panelLane.test.ts src/ipc/...` whatever
  covers session.ts/panelLane.ts.
- Fleet invariant checks (grep final session.ts):
  1. fleet early return in sessions:input sits ABOVE `if (inputPtyLane)`.
  2. fleet branch in create-quick fires BEFORE `resolvedSubstrate === 'interactive'` eager-spawn.
  3. `isImplicitlyInteractiveRuntime` used at both SessionAgentRuntime-typed call sites
     (session.ts:1271, createQuickSessionCore.ts:406).
- Commit: `git commit -m "Merge kesteva/main: OMP/Codex provider+transport split alongside fleet runtime"`
