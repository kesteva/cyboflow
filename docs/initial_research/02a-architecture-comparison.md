# Architecture Comparison Part 1: Trade-offs, Effort, and Day-1 Plans

Path A (fork Crystal) vs Path B (greenfield Electron). This part covers the comparison framing, summary table, Day-1 task lists, and recommendations. See `02b-primitives-detail.md` for per-primitive technical detail.

## TL;DR

- **Fork Crystal (Path A) is the right call for the 2-week MVP.** Crystal already implements 6 of the 8 primitives Cyboflow needs (PTY-based concurrent Claude sessions, stream-json parsing, SQLite persistence, git worktree lifecycle, signed/notarized macOS packaging, and a typed IPC layer with a Unix-socket MCP permission bridge). Greenfield (Path B) re-implements ~30k lines of working MIT code to chase a slightly cleaner architecture; that's a 3–4 week diversion before the differentiator (the cross-workflow review queue) gets a single line of code.
- **The load-bearing differentiator — the cross-workflow review queue and the structured-event extraction that feeds it — must be designed greenfield in *both* paths.** Crystal renders tool-use events inline per-panel; it does not have a workspace-scoped "concentrated attention" queue. So Path A is really *Crystal-as-substrate + a new `ReviewQueue` slice + a new `WorkflowOrchestrator` service*. The leverage is that the substrate already works.
- **Make two Day-1 commitments before writing any code (both paths):** (1) freeze the typed event schema for stream-json (the seven event variants in `02b-primitives-detail.md`), and (2) decide that the orchestrator is a separate process-internal module with its own IPC namespace, so it can be lifted into a backend service for the team tier without rewriting the renderer.

## Key Findings

1. **Crystal's architecture maps almost 1:1 to Cyboflow's primitives 1, 3, 4, 5, 6, 8.** `CliManagerFactory`/`AbstractCliManager` spawns Claude Code via node-pty, parses JSONL on stdout, persists to SQLite (`better-sqlite3`), creates per-session worktrees via `WorktreeManager`, ships a signed universal macOS DMG via electron-builder, runs a Unix-socket `PermissionIpcServer` for MCP-style approvals, and exposes a typed IPC surface in namespaces (`sessions`, `panels`, `claudePanels`, `events`).
2. **Crystal's weakness is exactly the differentiator.** Its review/approval surface is a *per-panel* stream of inline tool-use renders + a Unix-socket permission bridge that prompts in-panel — not a cross-session queue. No first-class workflow object (no `WorkflowRun`, no `Checkpoint`, no `Approval` — only `Session`, `ToolPanel`, `PromptMarker`, `ExecutionDiff`). You add these tables, state machine, and UI in either path.
3. **The stream-json schema is well-documented and stable enough.** Each line is a JSON envelope with `type` (`system`, `assistant`, `user`, `result`, `stream_event`), optional `subtype` (`init`, `api_retry`, `success`, `error`, `compact_boundary`), a `session_id`, and a payload. With `--include-partial-messages` you also get `content_block_start` / `content_block_delta` / `content_block_stop` / `message_delta` / `message_stop` deltas.
4. **Crystal already burns the gotchas a greenfield build would re-discover.** Documented in their CHANGELOG: 40%+ CPU reduction by tuning git status polling, 2800ms frame drops fixed by adaptive terminal-write debouncing, EventEmitter leak fixes in session list, mutex/transaction hardening for cross-session race conditions, platform-specific PTY concurrency limits (1 on Linux, 5 on macOS — encoded in `TaskQueue`). Greenfield will re-encounter every one.
5. **Bull-the-Redis-queue is a red herring.** Crystal's `CLAUDE.md` mentions Bull for historical reasons but production uses `SimpleQueue`, a Redis-free in-process concurrency limiter — `session-creation` at 5, `session-input`/`session-continue` at 10. **No Redis needed for the MVP.**
6. **Crystal violates orchestrator/UI separation.** Hand-rolled IPC over `ipcMain.handle` with discriminated string channels, validated ad-hoc per handler. No clean RPC boundary to drop a tRPC router into without refactoring. If team-tier extraction matters, plan to wrap or replace this layer either way.
7. **`--output-format stream-json` requires `--verbose --include-partial-messages` for token-level events.** This trio also triggers the silent-hang bug (Issue #1920: `result` event sometimes never emitted after tool execution). Both paths need a watchdog reconciling "process exited" with "stream parse complete" rather than relying on `result` alone.

## Summary Table — Path A vs Path B across the 8 primitives

| # | Primitive | Path A effort | Path B effort | Inherited complexity (A) | Flexibility (B) | Long-term-vision alignment |
|---|---|---|---|---|---|---|
| 1 | Concurrent PTY sessions | 0.5 days (config) | 3 days | High — multi-tool, panel system, codex code | High | A:✅ B:✅ same shape |
| 2 | **Stream-json extraction** | 2 days (move parser, type events, add router) | 4 days | Medium — transformer in renderer is wrong place | High | A:⚠️ retrofit B:✅ |
| 3 | Task state mgmt + state machine | 2 days (add 4 tables; new `WorkflowEngine`) | 3 days (full schema + engine fresh) | Medium — `sessions`/`tool_panels` legacy stays | High in B | A:⚠️ legacy carry B:✅ |
| 4 | Worktree lifecycle | 0.5 days (config + naming) | 2 days | Low — `WorktreeManager` is clean | Equal | A:✅ B:✅ |
| 5 | macOS wrapper | 0.5 days (rename + cert swap) | 2 days (incl. Apple cert dance) | Low — turnkey | Equal | A:✅ B:✅ |
| 6 | MCP server lifecycle | 2 days (build CyboflowMcpServer; reuse spawn pattern) | 3 days (build fresh) | Low — only permission bridge exists today | High in B | A:✅ B:✅ |
| 7 | **Human review queue** | 3 days (reuse permission bridge; new queue UI/store) | 4 days (build pause mechanism + queue fresh) | Medium — UI must replace per-panel modal | High both | A:✅ pause-via-bridge B:✅ |
| 8 | IPC / orchestrator-UI boundary | 1 day (add tRPC for new routes; leave Crystal IPC) | 2 days (full tRPC router) | High — Crystal IPC hand-rolled, not extractable | **Higher in B** | A:⚠️ unless tRPC layered B:✅ |
| **Totals** |  | **~11.5 days** | **~23 days** | A inherits ~30k LOC of working infra | B has cleaner seams | |

**Verdict:** Path A wins on calendar time by ~2× for the MVP. The only primitive where Path B is meaningfully better long-term is #8 (IPC), and that gap can be partially closed in Path A by layering tRPC for new routes.

## Day-1 Task List

### Path A — Day 1 (8–12 hours)

1. **(15 min) Fork the repo.** `gh repo fork stravu/crystal --fork-name cyboflow`. Do not enable upstream merging.
2. **(30 min) Rename surface area.** `appId` → `com.cyboflow.app`, product name, app icon (placeholder PNG → `png-to-icns` later), data dir `~/.crystal` → `~/.cyboflow` (search-and-replace), DB file name.
3. **(45 min) Cert + notarize once, locally.** `xcrun notarytool store-credentials AC_PASSWORD --apple-id … --team-id … --password <app-specific>`. Run `pnpm build:mac:arm64` end-to-end. Verify the `.dmg` opens and launches. *If this fails, stop everything and fix it; you cannot ship without this working.*
4. **(30 min) Rip out Bull and Codex.** Delete the `bull` import path; verify `SimpleQueue` is the live code path (it is). Delete `frontend/src/components/panels/codex/*` and `main/src/services/panels/cli/CodexCliManager.ts` for smaller surface.
5. **(2 hr) Move parser to main process.** Create `main/src/services/streamParser.ts` with `LineBufferer` class and `parseClaudeStreamEvent(line: string): ClaudeStreamEvent`. Define `shared/types/claudeStream.ts` with the union from `02b-primitives-detail.md`. Have `AbstractCliManager` instantiate the parser and emit typed events; keep emitting raw `session:output` IPC for backwards compat. **This is the load-bearing change.**
6. **(1 hr) Add Cyboflow tables.** Migration creates `workflow_runs`, `approvals`, `checkpoints`, `raw_events`, `workflows`. Don't touch existing Crystal tables. Add `WorkflowRunsRepo` facade in `main/src/database/`.
7. **(1 hr) Wire `ApprovalRouter` skeleton.** Class in main that listens to typed events, applies stub policy (`always require approval for Bash`), writes an `approvals` row, emits `approval:created` on new IPC channel. No UI yet.
8. **(2 hr) Build minimal `<ReviewQueue />` view.** New React component, new Zustand slice (`reviewQueueSlice`), wire to new IPC channel. List pending approvals with workflow name, tool name, payload preview, Approve/Reject buttons calling back via stubs.
9. **(1 hr) Hook `PermissionIpcServer` into `ApprovalRouter`.** When Crystal's permission socket asks "can Claude use this tool?", instead of routing to the per-panel modal, route to `ApprovalRouter.requestApproval(runId, tool_use_id, payload)` and block the socket reply until the user decides. **At end of Day 1 you have a real, working pause-resume loop.**
10. **(1 hr) Verify end-to-end with one workflow.** Drop `soloflow.md` in a test repo, start a run, watch the queue catch a Bash approval, click Approve, see Claude proceed. **If this works, the differentiator is de-risked.**
11. **(1 hr buffer) Documentation + commit.** README explaining what changed; tag `v0.1.0-cyboflow-day1`.

**Day-1 deliverable:** A signed, notarized Cyboflow.app that spawns a Claude Code run in a worktree and pauses on Bash approvals, surfaced in a workspace-scoped queue.

### Path B — Day 1 (8–12 hours)

1. **(30 min) Repo init.** Vite + React + TS template, Electron Forge or electron-builder bootstrap. pnpm workspace with `main/`, `frontend/`, `shared/`. ESLint with no-`any` rule.
2. **(45 min) Apple cert dance, end-to-end.** Same as Path A step 3.
3. **(45 min) Native modules.** `pnpm add better-sqlite3 @homebridge/node-pty-prebuilt-multiarch`. Add `@electron/rebuild` postinstall. Configure `asarUnpack`. Verify both modules load in a packaged build.
4. **(1 hr) Define the schema (TS + SQL).** `shared/types/claudeStream.ts` with discriminated union. `main/src/db/schema.sql` with `workflow_runs`, `approvals`, `messages`, `raw_events`, `projects`, `workflows`. Hand-rolled migration runner (~50 lines).
5. **(2 hr) tRPC scaffolding.** `shared/router.ts` with `runs`, `approvals`, `workflows` namespaces (stubs returning empty arrays). Wire `electron-trpc`/`trpc-electron` in main + preload + renderer. Verify `trpc.runs.list.useQuery()` round-trips.
6. **(2 hr) `ClaudeRunner` minimum viable.** Spawns `claude -p --output-format stream-json --verbose --include-partial-messages` via node-pty in fixed cwd. `LineBufferer` + `parseEvent` + `EventRouter`. Writes raw events to `raw_events`. Console-logs typed events. *Do not build the worktree manager yet — hardcode cwd to a test directory.*
7. **(1 hr) Worktree manager.** `git worktree add -b cyboflow/test/<runId8> <path> main`; `git worktree remove --force` on cleanup. Wire into run start.
8. **(1.5 hr) `ApprovalRouter` + permission socket bridge.** Lift Crystal's permission-socket pattern (MIT-licensed; cite it). Run starts → spawn Claude with `MCP_PERMISSION_SOCKET=…`. Socket request → write `approvals` row → emit tRPC subscription event. tRPC mutation `approve`/`reject` → reply on socket.
9. **(1 hr) Minimal `<ReviewQueue />` UI.** tRPC subscription `events.onApprovalCreated`; queue slice; approve/reject buttons. Same scope as Path A step 8.
10. **(1 hr buffer) End-to-end smoke test + commit.**

**Day-1 deliverable:** Same as Path A — signed app pausing on tool approvals — but ~600 lines of fresh code instead of inheriting ~30k. ~25-30% of where Path A is at end of Day 1.

## Recommendations

### Stage 1 — Days 1–3: Pick path, de-risk differentiator

**Take Path A.** Do the Day-1 task list. Day 2: replace Crystal's per-panel modal with the queue view fully (delete modal mount). Day 3: implement workflow-aware policy parsing (read frontmatter from your 5 markdown files). **Benchmark: by end of Day 3, two runs in different workflows must each be pausable on the queue, with approval possible in any order.** If this isn't working, stop and reconsider — the differentiator is not viable in either path.

### Stage 2 — Days 4–8: Workflow orchestration + MCP

Days 4–5: workflow orchestration logic. Parse the 5 SoloFlow markdown files at app start, expose in UI, "Start workflow" → creates `workflow_run` → spawns Claude with the workflow's prompt as initial input. Days 6–7: `CyboflowMcpServer` with three tools (`list_pending_approvals`, `get_run`, `submit_checkpoint`). Wire `.mcp.json` into worktree creation. Day 8: dock badge, native notifications, basic styling pass. **Benchmark: a fresh user installs the DMG, points at a repo, clicks "Run sprint workflow", sees Claude pause for review.**

### Stage 3 — Days 9–12: Polish, dogfood, ship

Day 9: cost/usage UI; replay-from-raw-events for debugging. Day 10: `electron-trpc` migration of new Cyboflow routes if not done in Stage 1; layer alongside Crystal IPC. Days 11–12: dogfood on real work, fix the top 5 bugs, write landing page copy. **Benchmark: you've used Cyboflow to ship something real, end-to-end, without falling back to terminal-Claude.**

### Threshold to switch to Path B

If at end of Day 3, the Crystal substrate is fighting the differentiator (e.g. per-panel architecture so deeply baked that the queue view requires touching 20+ files, or IPC layer can't subscribe to typed stream events without parser duplication), reconsider. Signal: "I've spent 1 day refactoring Crystal and it's still not where 1-day greenfield would have been." If true, Path A's leverage has evaporated.

If at end of Day 8 the "team-tier extraction" is becoming concrete (e.g. a paying-design-partner conversation), prioritize the tRPC layering even at the cost of one workflow feature; without it, the team-tier rewrite cost is substantially higher.

### Don't bother with in v1 (either path)

Auto-update (`electron-updater`); Codex/OpenAI integration; Linux/Windows builds; AI-driven worktree naming; Crystal's rebase/squash UI; multi-panel-per-session; cross-machine sync. Pure tax. Ship without them.

## Caveats

- **Crystal is officially deprecated** as of Feb 2026 in favor of Nimbalyst. Forking a deprecated MIT codebase is fine — code is stable, license doesn't expire — but no upstream bug fixes. Pin to known-good commit and own all future maintenance. **Mitigation:** rename aggressively on Day 1; market as "built on Crystal's foundation, MIT-licensed."
- **Crystal's CLAUDE.md mentions Bull queue with optional Redis support.** Production code uses in-process `SimpleQueue`. Double-check installed-build logs match if forking from recent commit.
- **Stream-json schema is not formally versioned by Anthropic.** Field names like `permission_denials`, `compact_boundary`, `api_retry`, exact `subtype` enums documented in third-party materials and Agent SDK docs. Anthropic ships changes without SemVer. **Mitigation:** Zod `.passthrough()` + default `unknown` variant; never crash on unrecognized event; integration test against actual `claude` binary on every Cyboflow release (pin a Claude Code version in CI).
- **Pause-via-permission-socket relies on `--permission-prompt-tool` being honored.** It is today. Anthropic could change this. Safer long-term: Anthropic's official PreToolUse hook (documented in SDK). Both paths should migrate in v2.
- **Effort estimates assume TypeScript/React comfortable, Rust uncomfortable.** Heavy reliance on Claude Code as a code-writing tool can compress these 30–50% but also creates a load-bearing dependency on Claude understanding the architecture from this document — why the report errs toward concreteness.
- **"Extract orchestrator to backend" team-tier story is partially aspirational.** electron-trpc gives clean *call-site* boundary but orchestrator mutates SQLite directly via `better-sqlite3`. Backend extraction also requires swapping that for a network DB or wrapping in node-IPC pattern over same tRPC. Budget ~1 week for this in team-tier rewrite — preserved as option, not free.
- **Native-module code-signing on universal macOS binaries** — `better-sqlite3.node` has been a source of "valid for use in process" errors on M1/x64 universal builds. Crystal has solved this; greenfield will spend 0.5–1 day re-solving.
- **All "days" are calendar days at 6–8 productive hours.** Real time for a solo founder with admin/marketing duties is closer to 4–5 hours/day; multiply by 1.5–2× for realistic delivery. Path A's 11.5-day estimate becomes ~3 weeks; Path B's 23-day becomes ~6 weeks. **MVP-in-2-weeks is achievable on Path A, doubtful on Path B.**
