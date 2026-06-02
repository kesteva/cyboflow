---
id: TASK-812
idea: IDEA-013
status: ready
created: 2026-05-29T00:00:00Z
source: IDEA-013
epic: dual-substrate-claude
files_owned:
  - frontend/src/components/cyboflow/WorkflowPicker.tsx
  - frontend/src/components/cyboflow/RunRightRail.tsx
  - frontend/src/components/cyboflow/CyboflowRoot.tsx
  - main/src/orchestrator/trpc/routers/runs.ts
  - main/src/__tests__/dualSubstrateIntegration.test.ts
  - main/src/services/streamParser/__tests__/messageProjection.substrate.test.ts
  - frontend/src/components/cyboflow/__tests__/WorkflowPicker.test.tsx
  - frontend/src/components/cyboflow/__tests__/RunRightRail.test.tsx
  - main/src/services/__tests__/configManagerSubstrate.test.ts
  - docs/ARCHITECTURE.md
  - CLAUDE.md
files_readonly:
  - main/src/services/configManager.ts
  - shared/types/substrate.ts
  - shared/types/workflows.ts
  - main/src/orchestrator/substrateResolver.ts
  - main/src/orchestrator/workflowRegistry.ts
  - main/src/orchestrator/trpc/routers/workflows.ts
  - main/src/services/panels/claude/interactiveClaudeManager.ts
  - main/src/services/panels/claude/claudeCodeManager.ts
  - main/src/services/panels/claude/transcript/transcriptNormalizer.ts
  - main/src/services/streamParser/messageProjection.ts
  - main/src/services/streamParser/index.ts
  - main/src/services/streamParser/schemas.ts
  - frontend/src/trpc/client.ts
  - frontend/src/stores/cyboflowStore.ts
  - frontend/src/hooks/useWorkflowPhaseState.ts
acceptance_criteria:
  - criterion: "A per-run/per-workflow substrate selector AND a global default exist; both default to 'sdk', persist the choice, and use AppRouter-inferred tRPC types (no local mirror of the input/output shape). The per-run selector lives in WorkflowPicker and threads the chosen substrate into trpc.cyboflow.runs.start.mutate; the global default lives in ConfigManager.defaultSubstrate."
    verification: "grep -n 'substrate' frontend/src/components/cyboflow/WorkflowPicker.tsx shows a selector bound to the start mutation input; grep -n 'defaultSubstrate' main/src/services/configManager.ts shows the getter/default; grep -n 'substrate' main/src/orchestrator/trpc/routers/runs.ts shows the start input accepting CliSubstrate. WorkflowPicker.test.tsx asserts the default is 'sdk' and that picking 'interactive' is sent in the mutate payload."
  - criterion: "Selecting 'interactive' causes the run to be created with workflow_runs.substrate='interactive' (the start mutation forwards substrate to runLauncher.launch which stamps it via the S1 resolver) and the run spawns via InteractiveClaudeManager; 'sdk'/legacy-default runs still spawn via ClaudeCodeManager."
    verification: "grep -n 'substrate' main/src/orchestrator/trpc/routers/runs.ts shows substrate forwarded to launch(); covered end-to-end by dualSubstrateIntegration.test.ts which drives a run on each substrate and asserts the dispatched manager class (mirrors S4 substrateDispatchFacade behavior)."
  - criterion: "The substrate picker PROMINENTLY surfaces the interactive-substrate v1 caveats: approval-routing-unavailable (only when Probe A failed / fallback branch), AskUserQuestion native-TUI-only, subagent gating limit, and coarser turn-level streaming granularity."
    verification: "grep -inE 'native[- ]?TUI|AskUserQuestion|subagent|turn-level|approval routing' frontend/src/components/cyboflow/WorkflowPicker.tsx returns >=1 match per caveat; WorkflowPicker.test.tsx asserts the caveat text renders when 'interactive' is selected."
  - criterion: "The structured Claude panel renders interactive-substrate runs WITHOUT modification — a frontend test asserts the renderer consumes a tail+normalized envelope identically to an SDK-sourced one (Q3), i.e. RunRightRail / WorkflowProgressTimeline behave identically given the same cyboflow:stream:<runId> envelope shape regardless of substrate."
    verification: "RunRightRail.test.tsx feeds an interactive-substrate-shaped envelope (the normalized {panelId,sessionId,type:'json',data,timestamp} produced by transcriptNormalizer) and an SDK-shaped one and asserts identical rendered output; no production change to WorkflowProgressTimeline.tsx or useWorkflowPhaseState.ts is required (git diff --stat shows 0 lines on those files)."
  - criterion: "A messageProjection cardinality test feeds REAL per-turn transcript `assistant` lines (full content, single message.id) through MessageProjection and asserts the commit-1a4ee6a coalescing logic (emittedAssistantMessages keyed by message.id, messageProjection.ts:255-290) produces a correct SINGLE rendered message with no duplication/drop — distinct from the SDK delta-stream path."
    verification: "main/src/services/streamParser/__tests__/messageProjection.substrate.test.ts feeds two assistant events sharing one message.id (full-content, transcript-shaped) and asserts project() yields exactly one UnifiedMessage with the merged content (no duplicate, no drop); contrasts with the SDK partial-delta case already covered in messageProjection.test.ts."
  - criterion: "A dual-substrate integration test runs the SAME multi-step workflow on BOTH substrates against the same project code and asserts equivalent structured panel output, raw_events persistence, and step transitions (timestamps/order may differ; a major event-sequence divergence is the regression signal). Gated in pnpm test:unit, NOT pnpm test:e2e."
    verification: "test -f main/src/__tests__/dualSubstrateIntegration.test.ts; it asserts the cyboflow:stream:<runId> envelope shape and raw_events row count match across substrates and that step transitions advance current_step_id identically; runs under pnpm test:unit (vitest run), never test:e2e."
  - criterion: "Rollback is verified: flipping substrate back to 'sdk' on a NEW run preserves prior workflow_runs / raw_events history (substrate-agnostic schema — substrate is per-run-immutable, history is not migrated)."
    verification: "dualSubstrateIntegration.test.ts (or a sibling case) creates an interactive run, then a subsequent 'sdk' run for the same workflow, and asserts the earlier run's workflow_runs row + its raw_events rows are still readable unchanged after the switch."
  - criterion: "docs/ARCHITECTURE.md documents the dual-substrate seam + InteractiveClaudeManager/TranscriptSource/normalizer components + the IDEA-029 dependency + the v1 limits (resume fresh-session-only, main-session-only step reporting, AskUserQuestion native-TUI-only, subagent gating per S5, coarser turn-level vs token-level streaming, transcript-vs-wire schema divergence absorbed by the normalizer, the ToS/concurrency UNCONFIRMED assumption from Probe H) + the encodeCwd collision caveat + the rollback path."
    verification: "grep -inE 'dual-substrate|InteractiveClaudeManager|TranscriptSource|normalizer|encodeCwd|unconfirmed|rollback' docs/ARCHITECTURE.md returns matches covering each topic; grep -in 'IDEA-029' docs/ARCHITECTURE.md returns >=1 match for the dependency."
  - criterion: "CLAUDE.md notes that substrate resolves ONCE at the CliManagerFactory seam, is threaded via run.substrate + the S4 facade source, and that AbstractCliManager.spawnPtyProcess/setupProcessHandlers/killProcessTree are LIVE and load-bearing for the interactive sibling (do NOT prune / do NOT mark @cyboflow-hidden)."
    verification: "grep -inE 'substrate|spawnPtyProcess|setupProcessHandlers|killProcessTree|InteractiveClaudeManager' CLAUDE.md returns matches stating the factory-seam resolution, the facade source, and the LIVE base PTY methods."
  - criterion: "tRPC subscription/query payloads in the touched renderer code use AppRouter inference — no local mirror interface and no `(evt: unknown)` + runtime shape guard (CLAUDE.md onData/AppRouter-inference rule)."
    verification: "grep -rnE 'onData: \\(evt: unknown\\)|interface .*Substrate.*Event' frontend/src/components/cyboflow/WorkflowPicker.tsx frontend/src/components/cyboflow/RunRightRail.tsx frontend/src/components/cyboflow/CyboflowRoot.tsx returns 0 production matches; substrate types are imported from shared/types/substrate.ts or inferred from AppRouter, never re-declared in the renderer."
  - criterion: "Any IPCResponse<T> / tRPC caller touched passes an explicit T (no reliance on the default unknown), per CLAUDE.md."
    verification: "grep -rnE 'IPCResponse[^<A-Za-z]' frontend/src/components/cyboflow/WorkflowPicker.tsx frontend/src/components/cyboflow/CyboflowRoot.tsx returns 0 untyped sites."
  - criterion: "No use of the `any` type in any file this task owns."
    verification: "grep -nE ':\\s*any(\\b|\\[)|<any>|as any' frontend/src/components/cyboflow/WorkflowPicker.tsx frontend/src/components/cyboflow/RunRightRail.tsx frontend/src/components/cyboflow/CyboflowRoot.tsx main/src/orchestrator/trpc/routers/runs.ts main/src/__tests__/dualSubstrateIntegration.test.ts main/src/services/streamParser/__tests__/messageProjection.substrate.test.ts frontend/src/components/cyboflow/__tests__/WorkflowPicker.test.tsx frontend/src/components/cyboflow/__tests__/RunRightRail.test.tsx main/src/services/__tests__/configManagerSubstrate.test.ts returns 0 matches"
  - criterion: "pnpm test:unit passes (one-shot vitest run; not test:e2e)."
    verification: "Run pnpm test:unit; exit code 0 with dualSubstrateIntegration.test.ts, messageProjection.substrate.test.ts, WorkflowPicker.test.tsx, RunRightRail.test.tsx, and configManagerSubstrate.test.ts included."
  - criterion: "The touched code type-checks and lints clean."
    verification: "pnpm typecheck && pnpm lint exit 0"
depends_on: [TASK-810, TASK-811]
estimated_complexity: high
test_strategy:
  needed: true
  justification: "This slice closes the dual-substrate contract with both renderer surfacing and the cross-substrate equivalence guarantee. The parity (both substrates produce the same structured envelope / raw_events / step transitions), the rollback invariant, the Q3 panel-preservation claim, and the messageProjection cardinality difference (the partial-message must-fix) are all correctness claims that MUST be locked by tests, not just documented. The selector + caveats are user-facing and frontend-testable. Existing sibling tests (RunRightRail.test.tsx, WorkflowPicker.test.tsx, messageProjection.test.ts) anchor the new cases."
  targets:
    - behavior: "WorkflowPicker exposes a substrate selector defaulting to 'sdk', forwards the chosen value to runs.start.mutate, and surfaces the interactive v1 caveats when 'interactive' is selected."
      test_file: "frontend/src/components/cyboflow/__tests__/WorkflowPicker.test.tsx"
      type: unit
    - behavior: "The structured panel (RunRightRail/WorkflowProgressTimeline) renders a tail+normalized interactive-substrate envelope identically to an SDK-sourced one (Q3 panel preservation)."
      test_file: "frontend/src/components/cyboflow/__tests__/RunRightRail.test.tsx"
      type: unit
    - behavior: "MessageProjection coalesces full-content single-message.id transcript assistant lines into exactly one UnifiedMessage (no duplication/drop), distinct from the SDK partial-delta path."
      test_file: "main/src/services/streamParser/__tests__/messageProjection.substrate.test.ts"
      type: unit
    - behavior: "The same workflow on both substrates yields equivalent structured output, equal raw_events persistence, and identical step transitions; gated in pnpm test:unit."
      test_file: "main/src/__tests__/dualSubstrateIntegration.test.ts"
      type: integration
    - behavior: "Flipping substrate back to 'sdk' on a new run preserves prior workflow_runs/raw_events history."
      test_file: "main/src/__tests__/dualSubstrateIntegration.test.ts"
      type: integration
    - behavior: "ConfigManager.defaultSubstrate defaults to 'sdk', persists across updateConfig, and round-trips through initialize()."
      test_file: "main/src/services/__tests__/configManagerSubstrate.test.ts"
      type: unit
---

# Renderer substrate surfacing + dual-substrate parity integration test + docs

## Objective

Surface substrate selection in the renderer (a per-run selector in `WorkflowPicker` + a global `defaultSubstrate` in `ConfigManager`), prove that BOTH substrates behave equivalently, and write down the dual-substrate architecture, v1 limits, and rollback path so the system is maintainable and reversible. Per Q3 the structured Claude panel is PRESERVED — it consumes the unchanged `cyboflow:stream:<runId>` envelope produced by the S2 (`transcriptNormalizer.ts`) normalizer — so this task adds a substrate selector and parity/rollback tests but makes ZERO production change to `WorkflowProgressTimeline.tsx`, `useWorkflowPhaseState.ts`, or the panel render path. All selector/output reads use AppRouter-inferred tRPC types (no local mirror) and `CliSubstrate` is imported from the S1 `shared/types/substrate.ts`, never re-declared in the renderer. This task depends on the InteractiveClaudeManager + facade (S3/S4, here delivered by TASK-810) and the shell-hook gating / step-tracking caveats (S5/S6, here delivered by TASK-811) being landed first — it consumes them to wire the selector end-to-end, but introduces NO duplicate of any IDEA-029 or earlier-slice code. It edits no IDEA-029-owned file (`index.ts`, `mcpQueryHandler.ts`, `claudeCodeManager.ts`, `runExecutor.ts`); those were consumed via depends-on-MERGE in the upstream slices and are read-only here.

## Implementation Steps

1. **Consume `defaultSubstrate` on ConfigManager (do NOT re-add it).** TASK-806/S1 already owns `main/src/services/configManager.ts` and ships the `getDefaultSubstrate(): CliSubstrate { return this.config.defaultSubstrate ?? DEFAULT_SUBSTRATE; }` accessor plus `defaultSubstrate?: CliSubstrate` on `AppConfig` + `UpdateConfigRequest` — and deliberately does NOT add `defaultSubstrate` to the constructor defaults object (so existing `config.json` files stay byte-identical, the accessor floors to `'sdk'`). Branch off the merged S1 tree and REUSE that accessor; do NOT re-declare the getter and do NOT add the field to the constructor defaults (that would contradict the S1 zero-rewrite decision). `updateConfig` already shallow-merges top-level keys, so persistence of an explicit `defaultSubstrate: 'interactive'` is automatic; do NOT hand-roll a save path. This task's only configManager work is the `configManagerSubstrate.test.ts` coverage (step 8) proving the floor + round-trip — `configManager.ts` itself is READ-ONLY here (owned by TASK-806/S1, on which this task transitively depends). If S1's accessor is somehow absent on the merged tree, treat that as a TASK-806 regression to fix in S1, NOT a write from this task. No `any`.

2. **Thread `substrate` through the `runs.start` tRPC input.** In `main/src/orchestrator/trpc/routers/runs.ts:200-224`, extend the `start` input `z.object` with an optional `substrate: z.enum(['sdk','interactive']).optional()` (or import a shared zod schema if S1 exported one) and forward it into `startRunDeps.runLauncher.launch(input.workflowId, project.path, input.substrate)`. The actual STAMP of the resolved value onto `workflow_runs.substrate` happens in the S1 resolver inside `runLauncher.launch` / `WorkflowRegistry.createRun` (read-only here) — this task only carries the user's choice down to it. If `launch`'s signature does not yet accept substrate, that is an S1 seam gap; consume the merged S1 surface (this task depends on TASK-810/811 which sit downstream of S1) rather than re-implementing the resolver.

3. **Add the per-run substrate selector to `WorkflowPicker.tsx`.** Add a second `<select>` (or radio group) bound to local state `const [substrate, setSubstrate] = useState<CliSubstrate>('sdk')`, importing `CliSubstrate` + `DEFAULT_SUBSTRATE` from `shared/types/substrate.ts`. Pass `substrate` into the existing `trpc.cyboflow.runs.start.mutate({ workflowId, projectId, substrate })` call at line 77 (the input type is AppRouter-inferred — do not annotate it with a local mirror). When `substrate === 'interactive'`, render a prominent caveats block listing: AskUserQuestion native-TUI-only, subagent gating limit (per S5/TASK-811), coarser turn-level streaming, and — ONLY when the Probe-A-fail / native-TUI fallback branch shipped — approval-routing-unavailable. Source the global default from ConfigManager (initialize the local state from `getDefaultSubstrate()` exposed via the existing config IPC/tRPC surface) so the selector reflects the user's global preference.

4. **Confirm the panel is unchanged (Q3).** Do NOT edit `WorkflowProgressTimeline.tsx`, `useWorkflowPhaseState.ts`, or the `cyboflow:stream:<runId>` consumer path. `RunRightRail.tsx`/`CyboflowRoot.tsx` are listed as owned only because the selector/caveat surfacing may touch them (e.g. a caveat banner in `CyboflowRoot` when an interactive run is active); keep production edits minimal and assert via `git diff --stat` that the timeline/phase-state files show 0 changed lines.

5. **Create the messageProjection cardinality test** `main/src/services/streamParser/__tests__/messageProjection.substrate.test.ts`. Mirror the existing `messageProjection.test.ts` setup. Feed TWO `assistant` events that share one `message.id` with FULL content (the transcript shape — not SDK partial deltas) through `MessageProjection.project()` and assert exactly ONE `UnifiedMessage` is emitted with the merged/last content, exercising the `emittedAssistantMessages` coalescing at `messageProjection.ts:255-290`. Add a contrasting assertion documenting that the SDK partial-delta path (already covered in `messageProjection.test.ts`) takes the same coalescing branch — proving the interactive full-content lines do not duplicate or drop.

6. **Create the dual-substrate integration test** `main/src/__tests__/dualSubstrateIntegration.test.ts`. Reuse the orchestrator test DB fixtures (`main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts`, `dbAdapter.ts`) and the faked-PTY + fake-TranscriptSource harness from the S3 manager tests. Run the SAME small multi-step workflow on each substrate (drive ClaudeCodeManager with SDK fixture lines; drive InteractiveClaudeManager with the equivalent normalized transcript fixtures) and assert: (a) the `cyboflow:stream:<runId>` envelope shape `{panelId,sessionId,type:'json',data,timestamp}` matches field-by-field across substrates; (b) the `raw_events` row count for the run is equal; (c) `workflow_runs.current_step_id` advances through the SAME step sequence (drive `handleReportStep` identically). Timestamps/IDs may differ; assert structural equivalence, not byte-equality. Add the ROLLBACK case: create an interactive run, then a subsequent 'sdk' run for the same workflow, and assert the earlier run's `workflow_runs` row + `raw_events` rows are still readable unchanged (substrate-agnostic schema). Gate under `pnpm test:unit` (vitest run) — NEVER `test:e2e`.

7. **Extend `WorkflowPicker.test.tsx` and `RunRightRail.test.tsx`.** WorkflowPicker: assert the selector defaults to 'sdk', that selecting 'interactive' includes `substrate: 'interactive'` in the `runs.start.mutate` payload (mock `trpc.cyboflow.runs.start.mutate`), and that the interactive caveat text renders. RunRightRail: feed a normalized interactive-substrate envelope and an SDK envelope of identical shape and assert the rendered `WorkflowProgressTimeline` output is identical (Q3 panel preservation) — proving the panel is substrate-agnostic.

8. **Create `configManagerSubstrate.test.ts`** `main/src/services/__tests__/configManagerSubstrate.test.ts`: assert `getDefaultSubstrate()` returns 'sdk' on a fresh config, that `updateConfig({ defaultSubstrate: 'interactive' })` persists and round-trips through a fresh `initialize()`, and that a config file with no `defaultSubstrate` key still reads 'sdk' (back-compat). No `any`.

9. **Update `docs/ARCHITECTURE.md`.** Add a dual-substrate section under "Major Components / Layers" (near the existing `AbstractCliManager` note ~line 83): document the factory-seam resolution, `InteractiveClaudeManager` / `TranscriptSource` / `transcriptNormalizer` components, the FACADE source (S4), the IDEA-029 dependency, the rollback path (flip back to 'sdk' on a new run, history preserved by the substrate-agnostic schema), and ALL v1 limits — resume fresh-session-only (#44607), main-session-only step reporting, AskUserQuestion native-TUI-only, subagent gating per S5, coarser turn-level vs token-level streaming, the transcript-vs-wire schema divergence absorbed by the normalizer, the encodeCwd collision caveat (#19972), and the Probe-H ToS/concurrency UNCONFIRMED assumption.

10. **Update `CLAUDE.md`.** Add a short note (alongside the existing "Preserved Extension Points" section) stating: substrate resolves ONCE at the `CliManagerFactory` seam and is threaded via `run.substrate` + the boot-seam facade source; `AbstractCliManager.spawnPtyProcess` / `setupProcessHandlers` / `killProcessTree` are LIVE and load-bearing for `InteractiveClaudeManager` (do NOT prune, do NOT mark `@cyboflow-hidden`).

11. Run the no-`any` greps from the ACs, then `pnpm test:unit` (exit 0), then `pnpm typecheck && pnpm lint` (both clean). If `better-sqlite3` NODE_MODULE_VERSION errors appear, run `pnpm rebuild better-sqlite3` per CLAUDE.md before the main vitest run. Record a manual `pnpm dev` walkthrough as a verification NOTE only (not an AC gate, per CLAUDE.md).

## Acceptance Criteria notes

- **Q3 panel preservation is the load-bearing claim:** the panel renders interactive runs with ZERO frontend change because the S2 normalizer makes the interactive envelope byte-identical in shape to the SDK envelope before it reaches `narrow()` and the bridge. The `RunRightRail.test.tsx` parity case is what proves this — if it requires editing the timeline/phase-state to pass, that is a normalizer regression upstream (S2/TASK-810), not a fix to make here.
- **The messageProjection difference is a CORRECTNESS risk, not cosmetic:** the SDK substrate streams partial deltas sharing one `message.id` (coalesced by commit 1a4ee6a); the interactive transcript emits the FULL content in (potentially) one or two lines sharing the same `message.id`. Both must land on the same single rendered message. The new test asserts the full-content path does not produce a duplicate or drop — exercising the same `emittedAssistantMessages` map from a different input cardinality.
- **Caveat surfacing is conditional:** "approval-routing-unavailable" is shown ONLY in the Probe-A-fail / native-TUI fallback branch (TASK-811's S5 fallback). When gating shipped (Probe A passed), do NOT show that caveat. The other three caveats (AskUserQuestion native-TUI-only, subagent gating, turn-level streaming) are unconditional v1 limits.
- **Substrate is per-run-immutable:** rollback is "flip the choice for a NEW run," never mutate an existing run's `substrate`. The rollback test asserts old history survives a substrate switch precisely because the schema is substrate-agnostic and the column is stamped once at launch (S1).
- **All substrate types come from `shared/types/substrate.ts`** (S1) — the renderer imports `CliSubstrate`/`DEFAULT_SUBSTRATE` and lets tRPC infer the `runs.start` input/output from `AppRouter`. A local `interface` re-declaring the substrate union or an `(evt: unknown)` guard in the renderer is a CLAUDE.md violation and fails the inference AC.

## Out of Scope

- Implementing the substrate RESOLVER, the `workflow_runs.substrate` migration, `CliSubstrate`/`DEFAULT_SUBSTRATE`, the factory `claude-interactive` registration, or `WorkflowRegistry.createRun` stamping — all owned by S1 (consumed read-only; this task only carries the user's choice down to the merged S1 surface).
- Editing any IDEA-029-owned file (`main/src/index.ts`, `main/src/orchestrator/mcpServer/mcpQueryHandler.ts`, `main/src/services/panels/claude/claudeCodeManager.ts`, `main/src/orchestrator/runExecutor.ts`). Those were edited only AFTER their named IDEA-029 tasks merged, in the upstream slices (S4/S5/S6 = TASK-810/811), branching off the merged tree — never co-edited concurrently. This task adds NO duplicate of any IDEA-029 code and treats those files as read-only.
- The InteractiveClaudeManager body, TranscriptSource/TranscriptTailSource/normalizer, the shell-hook gating handler, `cyboflow_report_step`, and the prompt-body-prepend step-instruction delivery — all delivered by upstream slices (S2/S3/S5/S6 = TASK-810/811) and consumed here, not re-implemented.
- An xterm.js raw-PTY view — secondary affordance only; the structured panel (via normalizer) is primary and is what this task surfaces/tests.
- Extending `streamParser/schemas.ts` into a transcript-event union — the divergence is absorbed in the S2 normalizer; this task only tests the messageProjection cardinality consequence.
- Modifying `WorkflowProgressTimeline.tsx` or `useWorkflowPhaseState.ts` — they must stay byte-identical (Q3 panel-preservation invariant); the parity test proves no change is needed.
- A `pnpm test:e2e` gate — per CLAUDE.md the dual-substrate integration test is gated in `pnpm test:unit` only.
