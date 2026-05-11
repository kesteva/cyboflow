---
epic: stream-parser-to-main
created: 2026-05-11T00:00:00Z
status: active
originating_ideas: [IDEA-005]
---

# Stream Parser to Main

## Objective

Move Crystal's renderer-side Claude stream-json parser into the main process as `ClaudeStreamParser`, wire a four-stage pipeline (LineBufferer → JSONParser → TypedEventNarrowing → EventRouter), and add the mandatory triple-gate completion detector for Anthropic's permanent `result`-event regression. After this epic lands, the renderer never sees raw JSONL — it consumes already-projected `UnifiedMessage[]` from main, eliminating the renderer-vs-orchestrator drift the design doc §6.2 names as a day-1 discipline. Every parsed event is also persisted to `raw_events` as an append-only audit log, enabling projection replay if reducer logic changes. The Crystal `--dangerously-skip-permissions` default is flipped to `approve` so every Cyboflow run flows through the permission socket.

## Scope

- In scope:
  - Create `main/src/services/streamParser/` with the four pipeline modules (LineBufferer, JSONParser, TypedEventNarrowing, EventRouter) plus an orchestrating `ClaudeStreamParser` class
  - Implement `CompletionDetector` with the triple-gate (`childExited AND stdoutEof AND parserDrained`) and 30s watchdog — never trusts the Claude `result` event as a gate-opener
  - Implement `RawEventsSink` that appends every parsed event (including unknown variants) to the `raw_events` table created by IDEA-004's migration
  - Move the renderer-side `ClaudeMessageTransformer` projection logic to a main-process `MessageProjection` reducer; reduce the renderer file to an identity stub
  - Move the `UnifiedMessage` contract to `shared/types/` so both main and renderer import from one source
  - Flip `defaultPermissionMode` from `'ignore'` to `'approve'` and replace all four `--dangerously-skip-permissions` code paths in `claudeCodeManager.ts` with hard errors

- Out of scope:
  - The Zod schema and TypeScript discriminated union (`shared/types/claudeStream.ts`, `main/src/services/streamParser/schemas.ts`) — those are owned by the `typed-stream-event-schema` epic (IDEA-003)
  - The `raw_events` table DDL itself — owned by the `cyboflow-schema-migration` epic (IDEA-004)
  - tRPC v11 + `trpc-electron` installation and the subscription router — that is a separate epic. This epic uses Crystal's existing IPC channel as the renderer transport with a clean swap path to tRPC later.
  - The `ApprovalRouter` (replacement for `PermissionManager`) that adds the 60-minute timeout — flagged repeatedly across the research as a day-1 critical task but architecturally distinct (the queue + review UI epic owns it).
  - The orchestrator-side wiring that connects `claudeCodeManager`'s `output` event stream to a per-run `ClaudeStreamParser` instance — owned by a follow-up orchestrator task (the parser pipeline is built here; integration is the next epic).

## Success Signal

A real Claude Code run streams typed events end-to-end: `claudeCodeManager` PTY stdout → `LineBufferer` → `JSONParser` → `TypedEventNarrowing` → `EventRouter` → both `RawEventsSink` (audit log) and `MessageProjection` (UI). The renderer displays sessions correctly without any JSON parsing on its side. A run with a missing `result` event still transitions to `failed` via the watchdog within 30 seconds of child exit. The renderer-side `ClaudeMessageTransformer.ts` is either deleted or reduced to <= 30 lines of stub code. Every Cyboflow-spawned Claude process is invoked with `--permission-prompt-tool` and never `--dangerously-skip-permissions`. The grep gate (`git grep --dangerously-skip-permissions main/src/services/panels/claude/`) returns at most one match, inside a clearly-marked Cyboflow-bypass guard (or zero matches if no bypass is desired).
