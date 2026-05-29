---
id: IDEA-013
type: FEATURE
status: materialized
created: 2026-05-14T00:00:00Z
materialized: 2026-05-29T00:00:00Z
materialized_as: plans
task_ids: [TASK-805, TASK-806, TASK-807, TASK-808, TASK-809, TASK-810, TASK-811, TASK-812]
source: design_workflow_wf_05d6e827-319_2026-05-29
slices:
  - title: "S0 — Probe-first kill-criteria gate (investigation, no production code)"
    description: "Run BEFORE any code; the SDK substrate keeps shipping so this is zero-cost-to-block. Output is a one-page decision record (`docs/probes/IDEA-013-probe-findings.md`) resolving Q1-Q4 and naming the fallback each later slice must take. Probes: A (interactive PreToolUse shell hook fires + blocks synchronously for minutes + inherits CYBOFLOW_ORCH_SOCKET — gates whether a GATED interactive substrate ships AT ALL); A2 (subagent hook scope + AskUserQuestion has no answer-injection channel — ship-gating); B (encodeCwd vs live dir, session-uuid is filename-only #44607, DISCOVERY_TIMEOUT_MS, early top-level `cwd` line); C re-scoped (a no-`-p` interactive `claude` is a REPL that does NOT exit and writes NO `result` line — confirm the turn-end signal); D (Shannon bridge still Planned + Bun/tmux cost); E HARD GATE (already run in planning: 45%+ of transcript lines drop to __unknown__ -> normalizer mandatory); F (interactive MCP load + a prompt-body-prepended instruction actually fires cyboflow_report_step); G (socket round-trip incl. multi-minute human-decision window); H (NEW ship-gating business risk: N>=4 parallel interactive sessions on a real Pro/Max plan — rate-limit/ToS/concurrency — escalate to the user for explicit sign-off)."
    value_statement: "De-risks every downstream slice for ~3 hours of throwaway work; three probes (A, A2, H) can collapse the gating story or the entire value prop before any production code is written."
  - title: "S1 — Substrate selection seam (migration + types + resolver + factory dispatch), SDK path byte-identical"
    description: "Add dual-substrate plumbing with ZERO runtime behavior change (default resolves to 'sdk'). Migration 013 adds `workflow_runs.substrate TEXT NOT NULL DEFAULT 'sdk' CHECK (substrate IN ('sdk','interactive'))`. New `shared/types/substrate.ts` exports `CliSubstrate='sdk'|'interactive'` + `DEFAULT_SUBSTRATE='sdk'`. `substrateResolver.ts` implements the override ladder (workflow frontmatter > project config > ConfigManager.defaultSubstrate > CYBOFLOW_SUBSTRATE env > 'sdk'); WorkflowRegistry.createRun STAMPS the resolved value at launch (immutable for the run). CliManagerFactory.registerBuiltInTools registers a second built-in tool id 'claude-interactive' backed by a STUB InteractiveClaudeManager so the factory wiring is testable before the manager body lands."
    value_statement: "Establishes the single resolution point + persistence for the substrate choice with proven-zero impact on existing runs; unblocks manager + dispatch work and makes the factory branch testable before any PTY code exists."
  - title: "S2 — TranscriptSource boundary + TranscriptTailSource + encodeCwd + transcript->stream-json NORMALIZER (RISKIEST)"
    description: "Build the structured-data recovery path behind a clean, Shannon-swappable seam with NO PTY dependency (fully unit-testable). The on-disk transcript is a DISTINCT schema from the stream-json wire schema in `streamParser/schemas.ts` — empirically 45%+ of lines drop to __unknown__ (unmodeled top-level types last-prompt/mode/permission-mode/bridge-session/attachment/ai-title/file-history-snapshot/queue-operation and system subtypes stop_hook_summary/turn_duration/local_command/bridge_status/api_error; string-content user lines fail userEventSchema; session id is camelCase top-level `sessionId`; system/init never appears interactively). A MANDATORY normalizer maps the panel-critical assistant/user/tool_use/tool_result/thinking subset into the envelopes narrow() accepts and DROPS the noise types before narrow() so raw_events is not bloated. TranscriptTailSource discovers the new *.jsonl (basename = session UUID, bounded by DISCOVERY_TIMEOUT_MS), tails it inode+offset line-buffered (fail-soft JSON.parse), disambiguates encodeCwd collisions by matching the first transcript line bearing top-level `cwd` against the worktree abs path, and surfaces turn-end markers via onTurnEnd. Unit tests use REAL fixtures from a live no-`-p` run."
    value_statement: "Recovers full structured-panel fidelity on the interactive substrate (Q3) by absorbing the proven schema divergence in ONE normalizer, and validates the single riskiest production component (discovery race + distinct-schema parse + collision) with zero PTY coupling."
  - title: "S3 — InteractiveClaudeManager sibling: PTY spawn via inherited base machinery + tail->normalize->identical output + turn-end-driven completion"
    description: "Implement the InteractiveClaudeManager body extending AbstractCliManager, overriding ONLY the abstract hooks (getCliToolName, testCliAvailability against the REAL `claude` binary, getCliExecutablePath, buildCommandArgs with NO -p / --output-format, initialize/getCliEnvironment injecting CYBOFLOW_RUN_ID/CYBOFLOW_ORCH_SOCKET, cleanupCliResources). It INHERITS spawnPtyProcess/setupProcessHandlers/killProcessTree verbatim. Owns its OWN per-run EventRouter+RawEventsSink keyed on runId (bridge keeps skipPersistence:true — no double-INSERT). After the inherited spawn, starts a TranscriptTailSource whose onLine = (already-normalized) narrow -> router.emitForRun(runId) -> emit('output',{panelId,sessionId,type:'json',data,timestamp}) byte-identical to the SDK manager; writes the initial prompt to PTY stdin. COMPLETION: a no-`-p` REPL does NOT self-exit and writes NO `result` line, so on the onTurnEnd signal the manager writes EOF/`/exit` to PTY stdin; the resulting inherited onExit + a short transcript-drain settle window resolves the spawn promise so RunExecutor fires 'drained' -> restAwaitingReview UNCHANGED. PTY exit is the teardown CONSEQUENCE, not the trigger; exit code discriminates failed vs awaiting_review. Includes a per-option parity table (model auto/default, strictMcpConfig, permissionMode==='ignore' hook-skip, settingSources decision, resume = fresh-session-only v1)."
    value_statement: "Delivers a runnable interactive substrate that drives a real subscription-billed `claude`, emits the byte-identical structured envelope the existing panel consumes, and terminates deterministically — the core engine the epic exists to build."
  - title: "S4 — Substrate-aware spawner dispatch at the index.ts boot seam via a FACADE EventEmitter source"
    description: "depends-on-MERGE of IDEA-029 TASK-799 (which OWNS index.ts) — branch off the merged tree, do NOT co-edit. Construct BOTH managers at boot (createManager('claude',...) + createManager('claude-interactive',...)) and replace the single spawnerAdapter with a substrate-aware adapter that resolves run.substrate (runId->substrate via WorkflowRegistry.getRunById) and dispatches spawn/abort to the matching manager. Because RunExecutor binds a SINGLE `source` EventEmitter for its lifetime (runExecutor.ts:167), introduce a FACADE EventEmitter at the boot seam that subscribes to BOTH managers' 'output'/'exit' events and re-emits keyed by panelId, passed as RunExecutor's source — preserving the panelId===runId===sessionId invariant and the skipPersistence:true bridge contract WITHOUT touching runExecutor.ts (standalone-typecheck invariant). Call setOrchSocketPath on BOTH managers at boot."
    value_statement: "Routes each run to the correct substrate and guarantees the structured panel lights up on the interactive path (the silent panel-goes-dark trap) by giving the bridge a facade that forwards both managers' events — without touching the standalone-typecheck-invariant RunExecutor."
  - title: "S5 — Interactive permission gating via a NET-NEW async-deferred socket handler + .claude/settings.json shell hook"
    description: "BRANCH ON PROBE A. depends-on-MERGE of TASK-798 (OrchSocketServer), TASK-799 (setOrchSocketPath), TASK-800 (CYBOFLOW_RUN_ID=workflow_runs.id), TASK-802 (which OWNS mcpQueryHandler.ts). PRIMARY (Probe A passed): a standalone ASAR-unpacked `preToolUseShellHook.ts` posts {type:'shell-approval-request',...} over CYBOFLOW_ORCH_SOCKET and blocks for the FULL human-decision window via a heartbeat (Claude hook `timeout` set HIGH, NOT 5-10s), failing CLOSED only on socket disconnect/orchestrator-down (by socket liveness, not a timer); the orchestrator side is the FIRST async-deferred McpQueryHandler branch that does NOT writeResponse synchronously — it applies isToolAllowed(loadMergedPermissionRules(worktree)) first (short-circuit allow, no approval row), rejects runId==='orchestrator', then awaits ApprovalRouter.requestApproval and replies via socketReply on the held-open socket. A cancel/teardown contract proactively denies+closes in-flight approval sockets so a canceled run never hangs the PTY. interactiveSettingsWriter.ts writes a MERGE-SAFE PreToolUse '*' entry (skips when permission mode is dontAsk/ignore). AskUserQuestion has NO shell-hook updatedInput channel -> native-TUI-only v1 limit. Subagent gating handled per Probe A2. FALLBACK (Probe A failed): no roll-our-own gating; native TUI prompts behind a prominent 'approval routing unavailable' banner; SDK substrate keeps full gating."
    value_statement: "Preserves cyboflow's review-queue differentiator on the only substrate that survives the billing change — routing interactive tool calls through the SAME ApprovalRouter as the SDK path — while honestly carving out the AskUserQuestion + subagent gaps so they cannot silently degrade security."
  - title: "S6 — Workflow step tracking on the interactive substrate via cyboflow_report_step + prompt-body-prepend instruction delivery"
    description: "depends-on-MERGE of TASK-799/800 (CYBOFLOW_RUN_ID + boot), TASK-801 (stepId validation), TASK-802 (report_step tool/handler), TASK-803 (prompt assets). Tracking comes from the cyboflow_report_step MCP tool, NOT from parsing the transcript stream (scope decision #3): the MAIN interactive session calls cyboflow_report_step -> OrchSocketServer -> handleReportStep -> buildStepTransitionEvent -> stepTransitionEvents.emit -> onStepTransition -> mergeTransition, advancing the Workflow Progress panel with ZERO frontend changes (the same path IDEA-029 relies on). Interactive-specific work: (a) assert CYBOFLOW_RUN_ID=workflow_runs.id reaches the PTY env (not the Claude session UUID); (b) RESOLVE step-instruction delivery — interactive `claude` has no SDK systemPrompt.append, so TASK-803's instructions are delivered via PROMPT-BODY PREPEND at the S3 spawn path's concatenation point. Documents the v1 main-session-only granularity limit (Agent-tool subagents inherit neither mcpServers nor the parent hook scope)."
    value_statement: "Lights up the Workflow Progress panel on interactive runs through the identical MCP-driven path the SDK substrate uses, by solving the one real gap (instruction delivery without an SDK append channel) in the plan rather than at execution time."
  - title: "S7 — Renderer substrate surfacing + dual-substrate parity integration test + docs"
    description: "Add a per-run/per-workflow substrate selector + a global default in settings (default 'sdk'), reading/writing substrate via the existing tRPC surface using AppRouter-inferred types (no local mirror, per CLAUDE.md). The picker MUST prominently surface the interactive caveats (approval routing unavailable if Probe A failed; AskUserQuestion native-TUI-only; subagent gating limit; coarser turn-level streaming). The structured Claude panel is PRESERVED (consumes the unchanged cyboflow:stream:<runId> envelope from the S2 normalizer); a raw-PTY xterm view is secondary. Add a dual-substrate integration test (gated in pnpm test:unit) running the SAME workflow on BOTH substrates and asserting equivalent structured output, raw_events persistence, and step transitions; a messageProjection cardinality test that feeds full-content single-message.id transcript assistant lines through the commit-1a4ee6a coalescing path; and a rollback test (flip substrate back to 'sdk' with no history loss). Documents the dual-substrate architecture, IDEA-029 dependency, v1 limits, encodeCwd caveat, the ToS/concurrency UNCONFIRMED assumption, and the CLAUDE.md note that the base PTY methods are LIVE/load-bearing."
    value_statement: "Lets users actually choose and trust the interactive substrate (with honest caveats), proves both substrates behave equivalently, and writes down the architecture + limits + rollback so the dual-substrate system is maintainable and reversible."
open_questions:
  - "Probe H (ship-gating business risk): does Anthropic's plan ToS / rate-limiting permit driving N>=4 parallel interactive `claude` sessions on a Pro/Max subscription? The primary support article (support.claude.com/articles/15036540) blesses interactive terminal/IDE use but is SILENT on automated/parallel/headless driving. Requires explicit USER sign-off before investing in S1-S7; if it fails, the '8 parallel agents on your subscription' value prop is invalid (the SDK substrate keeps shipping regardless)."
  - "Richer step states beyond running|done on the interactive substrate — inherits IDEA-029's open question; deferred."
assumptions:
  - "This epic is ADDITIVE: the SDK ClaudeCodeManager stays production-ready indefinitely for API-key / Agent-SDK-credit users. Every legacy run/config resolves substrate='sdk' and is byte-identical."
  - "IDEA-013 HARD-DEPENDS ON and CONSUMES IDEA-029 (TASK-798/799/800/801/802/803) for gating + step tracking; it re-implements NONE of it. Cross-epic file touches (index.ts, mcpQueryHandler.ts, claudeCodeManager.ts, runExecutor.ts) are strict depends-on-MERGE edges, never concurrent co-edits."
  - "AbstractCliManager.spawnPtyProcess/setupProcessHandlers/killProcessTree are LIVE and load-bearing for the interactive sibling — they must not be pruned (CLAUDE.md note added in S7)."
  - "Roll-our-own node-pty + transcript-tail is chosen NOW behind a Shannon-swappable TranscriptSource boundary; Shannon's bidirectional bridge is still 'Planned' and it requires Bun+tmux, which the 2026-06-15 deadline cannot absorb."
research_recommendation: not_needed
research_rationale: "A 16-agent design workflow (wf_05d6e827-319, 2026-05-29) ran parallel external research (interactive-mode hook/MCP semantics, transcript JSONL format, Shannon status, billing change) + internal code grounding, produced 3 independent architectures, merged + adversarially reviewed them (4 lenses), and synthesized this file-level plan. Critically, the agents empirically inspected REAL transcript files, which DISPROVED the naive plan's two load-bearing assumptions (transcript==stream-json schema; PTY-exit==completion) and reshaped the slices. Remaining validation is the empirical Probe gate (S0), not ecosystem research."
---

# IDEA-013 — Dual-Substrate Claude: add a per-run-selectable interactive-PTY substrate alongside the SDK substrate

## Context

On 2026-06-15 Anthropic moves `claude -p` + the Claude Agent SDK out of the
regular Claude plan chat allowance into a separate metered Agent-SDK credit
bucket; interactive `claude` keeps riding the chat allowance (see memory note
`anthropic_sdk_billing_change_june_2026.md`). cyboflow's "run 8 parallel agents
on your existing subscription" value prop only survives on interactive `claude`.

This epic ADDS a second, per-run-selectable substrate — interactive `claude`
driven through the node-pty machinery already live in `AbstractCliManager` —
ALONGSIDE the existing in-process SDK substrate (which stays production-ready
indefinitely for API-key / Agent-SDK-credit users). It is purely additive.

The pivot is unblocked by **IDEA-029**: cyboflow's workflow tracking comes from
the `cyboflow_report_step` MCP tool, NOT from parsing the SDK's typed stream, so
tracking transfers to the interactive substrate unchanged. The structured Claude
panel is preserved by **tailing the on-disk transcript JSONL** through a
normalizer into the existing `narrow() -> EventRouter -> RawEventsSink ->
cyboflow:stream:<runId>` pipeline. "Agents emit structured schema" is a
COMPLEMENT (report_step), not the sole source.

### Two empirical findings that reshaped the naive plan

The design workflow inspected real transcripts and disproved two load-bearing
assumptions:

1. **The on-disk transcript is a DISTINCT schema** from the stream-json wire
   schema in `streamParser/schemas.ts` — 45%+ of lines drop to `__unknown__`. A
   normalizer + noise-filter is **mandatory** before `narrow()` (slice S2), not
   optional drift-patching.
2. **Interactive `claude` is a REPL that does NOT exit after a turn and writes
   NO terminal `result` line.** Completion must be driven by a deterministic
   turn-end signal (Stop hook PRIMARY; `stop_hook_summary`/`turn_duration`
   markers SECONDARY) that then writes EOF/`/exit` to PTY stdin; PTY exit is the
   teardown CONSEQUENCE, not the trigger (slice S3, re-scoped Probe C).

## Sequencing & dependencies

```
IDEA-029 (consumed, depends-on-MERGE):
  TASK-798 OrchSocketServer ─┐
  TASK-799 boot/setOrchSocket┤ (owns index.ts)
  TASK-800 CYBOFLOW_RUN_ID   ┤ (owns claudeCodeManager.ts + runExecutor.ts)
  TASK-801 stepId validation ┤
  TASK-802 report_step       ┤ (owns mcpQueryHandler.ts)
  TASK-803 prompt assets     ┘ (owns index.ts)

IDEA-013 slices (this epic):

S0 PROBE (TASK-805) ──┐ (no deps; SDK keeps shipping = zero-cost-to-block)
                      │   A,A2 gate S5/S6 ; B gates S1/S2 ; C gates S3 ; D->Q1 ;
                      │   E gates S2 (normalizer) ; H gates whole epic (ToS/concurrency)
                      ▼
S1 selection seam (TASK-806) ──────────────────┐ startable now, parallel w/ IDEA-029
                      │                         │
                      ▼                         │
S2 TranscriptSource + Tail + NORMALIZER (807) ──┤ startable now, parallel w/ IDEA-029
                      │                         │
                      ▼                         │
S3 InteractiveClaudeManager (TASK-808) ─────────┘ startable now (after S2), parallel w/ IDEA-029
                      │
                      ▼
S4 dispatch + FACADE source (TASK-809) ──── depends-on-MERGE TASK-799
                      │
                      ├──────────────────┐
                      ▼                  ▼
S5 shell-hook gating (810)       S6 step tracking (811)
   depends-on-MERGE                 depends-on-MERGE
   TASK-798/799/800/802             TASK-799/800/801/802/803
                      │                  │
                      └────────┬─────────┘
                               ▼
S7 renderer surfacing + dual-substrate parity test + docs (TASK-812)
```

Slices S0/S1/S2/S3 are independent of IDEA-029 and startable now, in parallel
with that epic (they touch only new files + a migration + factory registration +
the new manager). Slices S4/S5/S6 are strictly depends-on-MERGE of the named
IDEA-029 tasks and must branch off the merged IDEA-029 tree to avoid
concurrent-edit collisions on `index.ts`, `claudeCodeManager.ts`,
`runExecutor.ts`, and `mcpQueryHandler.ts`.

## Open Question Resolutions (the 4 original IDEA-013 questions)

- **Q1 (roll-our-own vs Shannon):** ROLL-OUR-OWN NOW, behind a Shannon-swappable
  `TranscriptSource` boundary. Shannon's bidirectional permission-gating bridge —
  the exact piece cyboflow's review queue needs — is "Planned, not started"
  (GOAL_PROGRESS.md, re-confirmed by Probe D), and Shannon requires Bun + tmux at
  runtime (cyboflow ships neither; only `@homebridge/node-pty-prebuilt-multiarch`),
  which the 2026-06-15 deadline cannot absorb. cyboflow already owns every piece
  roll-our-own needs. THE HEDGE: a future `ShannonTranscriptSource` is a
  one-factory-branch swap (~1 extra file). Note: the on-disk transcript needs a
  normalizer regardless of substrate, so adopting Shannon would NOT have saved
  that work.
- **Q2 (interactive PreToolUse hooks fire + block?):** PROVISIONALLY YES, but
  SPECULATIVE until Probe A confirms it (the research is in direct conflict). The
  plan does NOT assume the optimistic reading — Probe A gates whether a GATED
  interactive substrate ships at all. If it fails, the substrate ships UNGATED
  (native TUI), surfaced as a documented PRODUCT-level degradation in the picker.
  AskUserQuestion has no shell-hook answer-injection channel -> native-TUI-only.
- **Q3 (lose the structured panel?):** NO — it is preserved by tailing the
  transcript through the S2 normalizer onto the unchanged `cyboflow:stream` seam,
  but at coarser turn-level (not token-level) granularity. The "replace the panel
  with xterm.js" framing is superseded; the raw terminal view is secondary.
- **Q4 (completion detection?):** A deterministic turn-end signal (Stop hook
  PRIMARY; `stop_hook_summary`+`turn_duration` markers SECONDARY) triggers
  EOF/`/exit` to PTY stdin; the resulting PTY exit + a transcript-drain settle
  window resolves the spawn promise -> `drained` -> `awaiting_review`, unchanged.
  Pure PTY quiescence is rejected as the primary signal (a hung PTY awaiting
  input looks finished).

## Probe Plan (slice S0 — kill-criteria gate)

Each probe has an explicit kill-criterion that redirects a later slice to a named
fallback. Run BEFORE any production code (the SDK substrate keeps shipping).

- **Probe A** — interactive PreToolUse shell hook fires + blocks synchronously for
  MINUTES + inherits CYBOFLOW_ORCH_SOCKET. KILL: S5 takes the native-TUI fallback;
  the picker surfaces "approval routing unavailable".
- **Probe A2** — does the hook fire for Task-SUBAGENT tool calls? AskUserQuestion
  answer-injection channel? KILL: ungated subagent calls are a SHIP BLOCKER for
  subagent-spawning workflows (planner/sprint/compound) — restrict interactive
  selection for them OR force-deny the Task tool. AskUserQuestion -> native-TUI-only.
- **Probe B** — encodeCwd vs a live `~/.claude/projects/<key>/` entry; session UUID
  is filename-only (#44607); DISCOVERY_TIMEOUT_MS from measured spawn->first-jsonl
  delay; the first cwd-bearing line for collision disambiguation.
- **Probe C (re-scoped)** — confirm a no-`-p` interactive turn does NOT exit the PTY
  and writes NO `result` line; confirm the turn-end mechanism for S3.
- **Probe D** — Shannon bridge still Planned + Bun/tmux cost -> Q1 roll-our-own.
- **Probe E (HARD GATE, already run in planning)** — re-measure the `__unknown__`
  rate on the exact spawn config; the normalizer is mandatory for S2.
- **Probe F** — (gated behind IDEA-029 socket up) interactive MCP load + a
  prompt-body-prepended instruction actually FIRES cyboflow_report_step.
- **Probe G** — (after A passes) socket round-trip incl. a multi-minute
  human-decision window via the heartbeat; `claude` does not kill the hook.
- **Probe H (NEW, ship-gating business risk)** — run N>=4 parallel interactive
  `claude` sessions against a real Pro/Max plan; record rate-limit/throttle/ToS
  behavior. ESCALATE to the user for explicit go/no-go sign-off (see open_questions).

## Shannon decision

ROLL-OUR-OWN, behind a Shannon-swappable `TranscriptSource` boundary (no
node-pty/SDK/narrowing imports). Shannon's transcript-tail architecture is adopted
as a REFERENCE, not a runtime dependency. Not contribute-upstream for v1 (the
deadline forbids it); contributing the bridge upstream is a reasonable post-v1
follow-up if cyboflow's bridge generalizes.

## Overlap with IDEA-029 (consumed via depends-on-MERGE)

- **S4** (TASK-809) edits `index.ts`, which TASK-799 OWNS -> depends-on-MERGE of
  TASK-799; it branches off the merged tree and adds the second manager +
  substrate-aware adapter + facade, never co-editing in parallel.
- **S5** (TASK-810) adds the `shell-approval-request` branch to
  `mcpQueryHandler.ts`, which TASK-802 OWNS -> lands as part of / after TASK-802
  merges. Also depends-on-MERGE of TASK-798 (the socket server) and TASK-800
  (without the real `workflow_runs.id` as CYBOFLOW_RUN_ID every approval binds a
  non-existent row -> guarded UPDATE `changes===0` -> fail-closed deny-everything;
  S5 adds a precondition assertion guarding exactly this).
- **S6** (TASK-811) consumes TASK-801/802/803 and takes CYBOFLOW_RUN_ID as
  already-fixed by TASK-800; it does NOT re-touch `composeMcpServers` env wiring.

## Reviewer must-fixes folded (from the adversarial review)

All folded into the slices: the permission-gating false-premise ("reuse one
handler branch" -> a NET-NEW async-deferred handler); the timeout contradiction
(HIGH heartbeat timeout, fail-closed on socket liveness not a timer); the
run-canceled-mid-approval hung PTY (cancel/teardown contract); subagent gating
bypass (ship-gating, not a footnote); the completion circular/broken assumption
(REPL never exits -> turn-end signal); the schema-parity falsehood (mandatory
normalizer); the collision-mitigation referencing non-existent system/init.cwd
(use the first top-level-cwd line); AskUserQuestion broken on interactive
(first-class v1 limit, no awaiting_input leak); the single-`source` constraint
(facade EventEmitter at the boot seam); per-option seam parity (model/strictMcp/
settingSources/resume); step-instruction delivery (prompt-body prepend); and the
ToS/concurrency business risk (Probe H + user sign-off).

## Out of scope (v1)

- Replacing the SDK substrate (purely additive; SDK stays for API-key users).
- Per-subagent step reporting + per-subagent permission gating (main-session-only;
  inherited IDEA-029 limit).
- Routing AskUserQuestion through QuestionRouter on the interactive substrate
  (no shell-hook updatedInput channel) — native TUI menu only.
- Interactive session resume / `--resume` / `--session-id` continuity (ignored
  interactively, #44607) — fresh-session-only on the interactive substrate.
- Token-level live-typing parity (interactive lines are turn-level/full-content).
- Adopting Shannon / `@dexh/shannon-agent-sdk` / Bun+tmux as a runtime dependency.
- An xterm.js raw-PTY view as the PRIMARY panel (secondary affordance at most).
- Extending `streamParser/schemas.ts` into a full transcript-event union (the
  divergence is absorbed in the normalizer).
- Re-implementing any IDEA-029 slice (consumed via depends-on-MERGE only).
- Richer step states beyond running|done (inherits IDEA-029's open question).

## Raw Input

> IDEA 1 (2026-05-14) — Interactive-mode support to preserve subscription billing.
> Pivot cyboflow's Claude integration off `claude -p --output-format stream-json`
> onto interactive `claude` in a node-pty PTY so users run parallel agents against
> their existing Claude Pro/Max chat allowance instead of the separate Agent SDK
> credit bucket. See Shannon (github.com/dexhorthy/shannon) as prior art.

> User (2026-05-29): "Add support for interactive Claude usage that still supports
> running workflows and workflow tracking (in the cyboflow sense not the claude
> sense). We have flexibility to modify agents so they will emit structured
> schema, but we do not have flexibility in terms of needing to run claude through
> an interactive shell." Confirmed scope: (1) deliverable = grounded epic + tasks;
> (2) ADD interactive as a per-run-selectable substrate, do NOT replace the SDK;
> (3) recover structured data by tailing the transcript JSONL + MCP-tool tracking.
