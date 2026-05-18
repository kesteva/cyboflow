---
id: IDEA-018
type: FEATURE
status: draft
created: 2026-05-18T20:15:00Z
source: user_braindump
roadmap_epic: "orchestrator-and-trpc-router"
slices:
  - title: "Spawn Claude from RunLauncher after the worktree + DB row are ready"
    description: "RunLauncher.launch today creates the worktree, writes per-run .mcp.json, updates workflow_runs to 'starting', publishes a synthetic run_started event, then returns. The function never invokes Claude — even the in-code comment (runLauncher.ts:129-130) flags this as deferred: 'Richer events will come from the SDK pipeline once it is integrated (epic 7+).' This slice wires the actual spawn so a Start Run click reaches Claude execution end-to-end."
    value_statement: "Closes the headline gap between cyboflow's UI surface and its product story — a user clicking Start Run goes from 'sees one synthetic event' to 'watches Claude actually do the workflow.'"
  - title: "Construct the initial prompt + system prompt from the workflow's source"
    description: "The workflows table has both workflow_path (.md file path) and spec_json (TEXT NOT NULL DEFAULT '{}'). Pick the canonical source: read the .md file's body as the user-facing prompt and its frontmatter for system-prompt append text, OR move to a structured spec_json contract. Whichever is chosen must produce SystemPrompt + initial user message values that the SDK's query() accepts. The existing claudeCodeManager.composeSystemPromptAppend() and composeSystemPromptPreset patterns are the right template."
    value_statement: "Without this, RunLauncher knows how to start a run but has no payload to give Claude. Without a payload, Claude either errors at query() or sits idle."
  - title: "Pipe SDK message stream through StreamEventPublisher to the renderer"
    description: "ClaudeCodeManager (or whatever orchestrator-side spawn path is chosen — see slice 8) receives messages from the SDK's async iterator. For each message, publish a typed StreamEvent over the existing cyboflow:stream:<runId> channel via the StreamEventPublisher interface already wired in slice 1's caller. The typed-stream-event-schema epic owns the message shape; this slice owns the connection between SDK emission and publisher.publish() call."
    value_statement: "Turns RunView from 'shows one run_started event then goes quiet' into the live stream of Claude's actual work — the load-bearing read-side of the cyboflow product story."
  - title: "Persist every SDK message to raw_events for replay / observability"
    description: "The 006 migration created raw_events as an append-only log per run for SDK messages, tool calls, and status changes. Today nothing writes to it because the SDK isn't running. Wire INSERTs from the same iterator that drives slice 3, gated through a single helper so the StreamEvent → raw_events row mapping has one source of truth."
    value_statement: "Enables run replay on reload, debugging of past runs, and the future observability epic. Required by stuck-detection-and-observability."
  - title: "Wire workflow.permission_mode → SDK PreToolUse hook → ApprovalRouter"
    description: "The workflows table's permission_mode column (default 'default') is currently never consumed at spawn time. It needs to flow into ClaudeCodeManager.buildSdkOptions's PreToolUse hook setup so 'default'-mode workflows route tool uses through ApprovalRouter (which already exists per TASK-302). 'acceptEdits' and 'dontAsk' modes get handled per the workflow-spec contract. The existing PreToolUse hook in claudeCodeManager.ts:389-395 is the integration point."
    value_statement: "Makes the workflow's policy actually enforceable. Without this, every run runs in whatever the SDK's default is regardless of what the .md frontmatter said."
  - title: "Route the spawn through RunQueueRegistry's per-run PQueue"
    description: "TASK-252 built a per-run PQueue keyed by runId precisely to serialize work for a single run. The spawn (and any subsequent per-run operations like cancel, kill, restart) should be enqueued through that registry instead of called directly. Keeps the single-writer-per-run invariant that day-3-gate verification depends on."
    value_statement: "Prevents race conditions in multi-run scenarios; gives cancel/kill a single chokepoint to apply policy."
  - title: "Lifecycle: status transitions starting → running → completed / failed / canceled"
    description: "Today workflow_runs.status only ever advances to 'starting' (set by RunLauncher.launch) then stays there forever because nothing else updates it. The SDK driver needs to: (1) flip to 'running' when the first SDK message arrives, (2) flip to 'completed' on the SDK iterator's normal terminate, (3) flip to 'failed' with error_message on a thrown error, (4) flip to 'canceled' when an external cancel arrives. The 8-state machine declared in 006 (queued/starting/running/awaiting_review/stuck/completed/failed/canceled) is mostly unused; this slice activates the operational subset."
    value_statement: "Makes the runs table actually reflect run state. Required by the review-queue-ui (which surfaces awaiting_review) and stuck-detection-and-observability epics."
  - title: "Decide: extend ClaudeCodeManager, adapt it, or build a new RunExecutor"
    description: "ClaudeCodeManager is Crystal-shaped — panelId/sessionId-keyed, designed around the legacy 'session has multiple Claude panels' model. Workflow runs are runId-keyed with no session/panel concept. Three options: (a) extend ClaudeCodeManager to accept runId as an alternate keying axis; (b) adapt — write a thin RunExecutor wrapper that translates runId ↔ ephemeral synthetic panelId/sessionId so it can reuse ClaudeCodeManager's well-tested SDK substrate; (c) build a new RunExecutor that calls the SDK directly without going through ClaudeCodeManager. (b) is the lowest-risk path — reuses TASK-302's ApprovalRouter wiring through PreToolUse and the SDK's already-tested option-building. (c) is the cleanest but requires duplicating SDK option assembly. (a) is invasive across the legacy-still-used Claude panel code."
    value_statement: "Pinning this design choice up front avoids the 'we'll figure it out as we go' refactoring tax. The choice cascades into every other slice's implementation."
open_questions:
  - question: "Adapter vs. extend vs. new — which path for invoking the SDK from RunLauncher? See slice 8."
    candidates:
      - "Adapter (Recommended) — thin RunExecutor wraps ClaudeCodeManager with synthetic panelId/sessionId derived from runId; reuses SDK substrate + ApprovalRouter + PreToolUse hook unchanged"
      - "Extend ClaudeCodeManager — add runId as a first-class key alongside panelId/sessionId; invasive but unifies the call sites"
      - "New RunExecutor — calls SDK directly without going through ClaudeCodeManager; cleanest but duplicates option-building, MCP server composition, and approval wiring"
  - question: "Prompt source — workflow_path .md or spec_json or both?"
    candidates:
      - "Read .md body as user prompt; .md frontmatter drives system prompt append + permission_mode (already extracted) — matches the SoloFlow workflow file convention"
      - "spec_json is authoritative — workflow_path is just metadata; UI lets the user author spec_json directly"
      - "Both — .md is read at seed time into spec_json; future edits go through spec_json; workflow_path becomes the original-source pointer"
  - question: "Cancel semantics — kill mid-stream, defer to next checkpoint, or refuse if past first tool use?"
    candidates:
      - "Hard cancel — terminate SDK iterator immediately, mark canceled, leave worktree intact for inspection"
      - "Soft cancel — set a cancellation flag, let the current tool call finish, then mark canceled"
      - "Defer to v2 — accept that v1 runs are uncancelable; the review-queue's reject-all-in-run is the workaround"
  - question: "Where do raw_events writes live in the pipeline — same iterator step as publish, separate worker, or batch?"
    candidates:
      - "Same step (Recommended) — for each SDK message: INSERT raw_events row, then call publisher.publish. Synchronous, ordered, simple."
      - "Separate worker — enqueue to a per-run write queue; lets the publisher fire faster but risks reordering"
      - "Batch — collect N messages, INSERT in transaction; throughput win, latency loss on the renderer"
  - question: "Initial prompt arrival — is the run already 'running' when the first SDK message arrives, or does 'running' fire on iterator-start before the model emits?"
    candidates:
      - "Running on iterator-start — flip immediately after query() returns the AsyncIterator, before first message. Lets the UI show 'running' during initial model latency."
      - "Running on first message — flip only when the model's first chunk lands. Lower-precision timing but a stronger guarantee that 'running' means 'producing output.'"
assumptions:
  - "ClaudeCodeManager + ApprovalRouter together already cover the SDK-driven Claude execution path end-to-end (verified by the day-3 gate test passing with real Claude per TASK-355). The work in this idea is connecting that path to RunLauncher / workflow_runs, NOT building a new SDK substrate."
  - "RunQueueRegistry (TASK-252) and Orchestrator class (TASK-253) provide the right serialization primitives; spawn enqueues into a per-run PQueue rather than running detached."
  - "The typed-stream-event-schema discriminated union (.soloflow/active/plans/typed-stream-event-schema/TASK-101..103, all done) is the canonical StreamEvent shape and is already importable from shared/types/claudeStream.ts."
  - "raw_events table schema (project_id, run_id, event_type, payload_json, created_at) is correct per 006 migration — no schema changes needed for this idea, just usage."
research_recommendation: not_needed
research_rationale: "No external research needed — every piece this idea connects (RunLauncher, ClaudeCodeManager, ApprovalRouter, StreamEventPublisher, raw_events, RunQueueRegistry) already exists in the codebase and has documented integration points. The remaining work is design-resolution (5 open_questions[], all with pre-enumerated candidates) and implementation. Even the candidate recommendations are mostly clear from the existing patterns."
---

# Wire RunLauncher to Spawn Claude and Publish Real SDK Events

## Context

`RunLauncher.launch` (`main/src/orchestrator/runLauncher.ts:84-144`) is currently a half-finished launch sequence. It does the orchestration plumbing — worktree creation, per-run .mcp.json, `workflow_runs` row insert, status transition to 'starting' — and then **returns without invoking Claude**. The in-code comment at line 129-130 even flags it: "Richer events will come from the SDK pipeline once it is integrated (epic 7+)."

Meanwhile every adjacent piece exists:
- `ClaudeCodeManager` runs the SDK in-process via `query()` (`main/src/services/panels/claude/claudeCodeManager.ts:203+`)
- `ApprovalRouter` is implemented and tested (TASK-302 archived)
- `RunQueueRegistry` provides per-run PQueue serialization (TASK-252 archived)
- `Orchestrator` class wires start/stop without Electron imports (TASK-253 archived)
- `StreamEventPublisher` interface is wired through RunLauncher's ctor + emits synthetic `run_started` (TASK-602 archived)
- `raw_events` table exists from migration 006
- `workflow_runs.status` 8-state machine declared in migration 006

The gap is purely the connection between these pieces. A user clicking Start Run today gets a worktree, a DB row, and one synthetic event. Wiring this idea makes that same click run the workflow end-to-end and stream the SDK output back to `RunView`.

This is the **load-bearing missing link** between cyboflow's UI surfaces and its product story.

## Raw Input

Discovered during post-SPRINT-016 interactive testing on 2026-05-18:
1. User asked "what can I actually test here?"
2. Manual exercise revealed that Start Run completed instantly with one synthetic event and then went quiet
3. Code survey confirmed RunLauncher.launch doesn't invoke Claude
4. Adjacent epics' active plans are mostly polish, not the spawn wiring — so this missing link isn't planned anywhere as a ready task
5. User asked to file it as an idea ("yes, file that idea")

## Grounding

**RunLauncher today** (`main/src/orchestrator/runLauncher.ts:84-144`):
```
1. ensureGitignoreEntry(projectPath)
2. workflow = workflowRegistry.getById(workflowId)
3. { runId, permissionMode } = workflowRegistry.createRun(workflowId)
4. { worktreePath, branchName } = worktreeManager.createDeterministicWorktree(...)
5. mcpConfigWriter.writeForRun(...) — if all 4 MCP collaborators injected
6. UPDATE workflow_runs SET worktree_path, branch_name, status='starting'
7. publisher.publish(runId, { type: 'run_started', payload: {...}, timestamp })
8. return { runId, worktreePath, branchName, permissionMode }
```

**What it needs to do additionally** (this idea):
```
9. Construct prompt from workflow.workflow_path (.md file body + frontmatter)
10. Enqueue spawn into RunQueueRegistry.getQueue(runId)
11. ClaudeCodeManager (or RunExecutor — see slice 8) initiates query() with:
    - cwd: worktreePath
    - permissionMode-derived hooks (route to ApprovalRouter for 'default' mode)
    - systemPrompt: workflow-derived
    - resume: false
12. UPDATE workflow_runs SET status='running' (timing per open_question 5)
13. For each SDK message in the AsyncIterator:
    a. INSERT raw_events row
    b. Translate to typed StreamEvent
    c. publisher.publish(runId, event)
14. On normal iterator terminate: UPDATE workflow_runs SET status='completed'
15. On thrown error: UPDATE workflow_runs SET status='failed', error_message
16. On external cancel signal: UPDATE workflow_runs SET status='canceled', terminate iterator
```

**Adjacent code worth reading before planning**:
- `main/src/services/panels/claude/claudeCodeManager.ts:200-410` — SDK option build + spawn pattern
- `main/src/orchestrator/approvalRouter.ts` — PreToolUse target for 'default' permission_mode
- `main/src/orchestrator/RunQueueRegistry.ts` — per-run PQueue contract
- `shared/types/claudeStream.ts` — typed StreamEvent discriminated union
- `main/src/orchestrator/types.ts` — StreamEventPublisher interface

## Slices

See `slices[]` in frontmatter. Eight slices: (1) spawn, (2) prompt construction, (3) per-event publishing, (4) raw_events persistence, (5) permission_mode → PreToolUse, (6) PQueue routing, (7) lifecycle transitions, (8) ClaudeCodeManager adapter-vs-extend-vs-new design call.

## Open Questions

See `open_questions[]` in frontmatter. Five resolution-by-decision questions: adapter vs new RunExecutor, prompt source, cancel semantics, raw_events write placement, 'running' transition timing. All have pre-enumerated candidates with recommended options where one is obviously cleaner — planner pass just needs the user to confirm or deviate.

## Assumptions

See `assumptions[]` in frontmatter. The key one: **the SDK execution path (ClaudeCodeManager + ApprovalRouter + PreToolUse hook + permission_mode mapping) is already proven working** — the day-3 gate test (TASK-355) verifies it end-to-end with real Claude. This idea connects that proven path to RunLauncher / workflow_runs, not building anything from scratch.

## Pre-work / Research needed

None. Every piece this idea connects is already in the codebase. The work is integration plus eight design-resolution calls.

## Sequencing

**Prerequisites** (all done — checked 2026-05-18):
- TASK-251..255 — orchestrator-and-trpc-router foundation
- TASK-302 — ApprovalRouter implementation
- TASK-355 — day-3 gate test (proves the SDK + ApprovalRouter loop end-to-end)
- TASK-602 — StreamEventPublisher interface + synthetic run_started

**Belongs in**: `orchestrator-and-trpc-router` epic (the run-execution domain). Alternative: new epic `run-spawn-wiring` if scope grows during planning — judgment call for the planner.

**Successors**:
- `review-queue-ui` polish tasks (TASK-611..616) become observable for the first time — currently they refine a UI that receives no real data
- `stuck-detection-and-observability` epic becomes runnable — stuck detection needs real `workflow_runs.status` and `raw_events` data to operate on
- IDEA-017 (shell architecture) — the legacy `useLegacyCrystalView` toggle can be retired once cyboflow's run UX is actually functional, which this idea is the gate for

**Phasing within this idea** (one possible task decomposition):
1. Slices 8 + 1 + 2 — the spawn skeleton: pick the design call, wire ClaudeCodeManager (or RunExecutor) into RunLauncher.launch's tail, construct the initial prompt. Single planner pass.
2. Slices 3 + 4 — event publishing + raw_events persistence. Single task (same iterator step per open_question 4).
3. Slices 5 + 6 — permission_mode → PreToolUse and PQueue routing.
4. Slice 7 — lifecycle transitions; depends on 3+4 being live so 'running' has signals to fire on.
