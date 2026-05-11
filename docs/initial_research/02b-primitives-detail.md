# Architecture Comparison Part 2: Per-Primitive Technical Detail

Implementation detail for each of the 8 primitives. Path A (fork Crystal) vs Path B (greenfield). Has ASCII architecture diagrams, TypeScript schemas, SQL DDL, state machines, and per-primitive failure modes. Use as reference when implementing any specific primitive.

## Conventions

- `═══` is a process boundary (separate OS process)
- `───` is a module boundary inside a process
- `══►` is IPC; `──►` is in-process call; `~~►` is a stream/event flow

---

## Primitive 1 — Concurrent PTY Sessions

```
                    ┌────────── Electron MAIN process ──────────┐
PATH A              │                                            │
(Crystal fork)      │  SessionManager ──► TaskQueue (SimpleQueue)│
                    │   - SQLite state    - session-creation:5  │
                    │   - EventEmitter    - session-input:10    │
                    │         │           - (1 on Linux)         │
                    │         ▼                                   │
                    │  CliManagerFactory                          │
                    │   ├─► ClaudeCodeManager ══► node-pty #1 ═►claude│
                    │   ├─► ClaudeCodeManager ══► node-pty #2 ═►claude│
                    │   └─► (extends AbstractCliManager)         │
                    │       lifecycle, zombie detection           │
                    └────────────────────────────────────────────┘

                    ┌────────── Electron MAIN process ──────────┐
PATH B              │                                            │
(greenfield)        │  Orchestrator (root)                       │
                    │   ├─ WorkflowEngine                        │
                    │   ├─ ApprovalRouter   ──► SessionPool      │
                    │   └─ StreamRouter        - p-limit(5) mac  │
                    │            │              - 1 PTY per run  │
                    │            ▼                                │
                    │  ClaudeRunner (1 per run)                  │
                    │   owns: PTY, buffer, parser, watchdog      │
                    │      ══► node-pty (cwd=worktreePath)       │
                    │          claude -p --output-format stream- │
                    │          json --verbose                    │
                    │          --include-partial-messages        │
                    └────────────────────────────────────────────┘
```

**Narrative.** Both paths spawn Claude Code as a child attached to a pty (`node-pty`), one PTY per concurrent agent. Crystal's empirical concurrency cap is 5 on macOS / 1 on Linux — production-tuned numbers from `taskQueue.ts`. Both paths should adopt the same caps.

**Path A** lifecycle is owned by `AbstractCliManager` (extended by `ClaudeCodeManager`). Each panel-instance spawns its own PTY; zombie processes are detected at app startup via `zombie-processes-detected` events. Cyboflow inherits all of this for free. The per-panel concurrency model is heavier than needed (Crystal allows multiple agent panels per session; Cyboflow has one agent per workflow run), so collapse "session" and "panel" into "workflow run" but keep `AbstractCliManager`'s PTY/process plumbing.

**Path B** `ClaudeRunner` is a smaller, single-purpose object: it owns the PTY, the line buffer, the parser, and a watchdog timer. The watchdog matters because of claude-code#1920: the `result` event sometimes never arrives after tool execution. Use `(child exited) AND (stdout EOF) AND (stream parse drained)` as the completion gate, with a 30s grace period after `child exited` before forcing the run into `failed`.

**Both — error handling.** Wrap PTY spawn in try/catch — on macOS, `EAGAIN` from `forkpty(3)` happens around 256 PTYs; cap at 8 concurrent runs product-level regardless of OS. Detect `api_retry` system events and surface as "throttled" rather than hang. On `SIGCHLD` with non-zero exit, write a final synthesized `result`-style event so downstream consumers always see a terminal event.

**Path A inherits — keep:** `AbstractCliManager`, `CliManagerFactory`, `SimpleQueue` (delete Bull import), `zombie-processes-detected` flow, platform-specific concurrency caps.
**Path A inherits — change:** Collapse "panel" → "workflow run" or use panel internally but never expose multi-agent-per-session in UI; rip out `Codex*` managers.
**Path B Day-1 decisions:** Pick `node-pty` vs `@homebridge/node-pty-prebuilt-multiarch` (Crystal uses the latter — fewer build problems on universal macOS); decide completion-gate semantics; pick concurrency primitive (`p-limit` is fine, Redis-free).

**Failure modes:**
- **A:** Crystal's panel model permits multiple agents per session — easy to accidentally expose and confuse the 1:1 product story. *Fix: hide multi-panel UI.*
- **A:** Bull import in `CLAUDE.md` is misleading. *Fix: rip on Day 1.*
- **B:** Forgetting `--include-partial-messages` → no token streaming → stale UI. *Fix: lock spawn args in a single function.*
- **Both:** PTY zombies if `child.kill()` is called without cleanup; macOS PTY exhaustion at ~256 open. *Fix: cap concurrency at 8; on app shutdown, iterate runs and SIGTERM-then-SIGKILL with timeout.*

---

## Primitive 2 — Structured Extraction (LOAD-BEARING)

### Layer A: Parsing pipeline (both paths)

```
   PTY stdout (bytes)
        │
        ▼  ── chunks split arbitrarily ──
   LineBufferer        buf += chunk; while ('\n' in buf) emit line
   (carry partial line)
        │ NDJSON lines
        ▼
   JSONParser          try { JSON.parse(line) } catch → DROP + log
   (never throws into event loop)
        │ unknown JSON objects (with .type)
        ▼
   TypedEventNarrowing discriminate on .type / .subtype
   (Zod with .passthrough() or hand-rolled)
        │ ClaudeStreamEvent (typed)
        ▼
   EventRouter         per-runId fanout to:
                         1) raw-message log (DB)
                         2) message reducer
                         3) review-queue extractor
                         4) usage/cost accumulator
                         5) workflow state machine
```

### Layer B: Extraction-to-UI flow

```
PATH A (Crystal as-is — wrong process boundary)
PTY ─► AbstractCliManager (line buffer)
    ─► ClaudeMessageTransformer (RENDERER side!)
    ─► panel_outputs / panel_messages tables (raw JSONL)
    ─► IPC 'session:output' event (raw bytes payload)
    ─► useClaudePanel hook on renderer
    ─► RichOutputWithSidebar (per-panel, inline tool-use cards)
    ✗ NO cross-session queue. Approvals route via Unix-socket → in-panel modal.

PATH B (clean separation — also Path A target after Day-2 refactor)
PTY ─► LineBufferer ─► JSONParser ─► TypedEventNarrowing ─► EventRouter
    ─► writes raw_events table (audit; one row per parsed event)
    ─► dispatches typed event to:
         (a) sessionSlice.appendMessage()      — conversation panel
         (b) reviewQueueSlice.maybeEnqueue()   — cross-workflow queue
         (c) usageSlice.accumulate()           — cost meter
         (d) workflowSlice.advance()           — state machine
    ─► tRPC subscription pushes same typed events to renderer
    ─► Renderer selectors derive: ConversationView, PendingApprovalCard,
       UsageBadge, WorkflowProgress
```

### Typed event schema (lock this Day 1 in both paths)

```ts
// shared/types/claudeStream.ts
export type ClaudeStreamEvent =
  | SystemInitEvent | SystemRetryEvent | SystemCompactEvent
  | AssistantMessageEvent | UserMessageEvent
  | StreamDeltaEvent | ResultEvent | ErrorEvent;

export interface BaseEvent {
  runId: RunId; sessionId: string; ts: number; raw: string;
}

export interface SystemInitEvent extends BaseEvent {
  kind: "system.init";
  tools: string[];
  mcp_servers: { name: string; status: "connected" | "failed" }[];
  cwd: string; model: string;
  permissionMode: "default" | "acceptEdits" | "plan"
                | "bypassPermissions" | "dontAsk";
}

export interface SystemRetryEvent extends BaseEvent {
  kind: "system.retry";
  attempt: number; maxRetries: number; retryDelayMs: number;
  errorStatus: number;
  error: "rate_limit" | "server_error" | "authentication_failed"
       | "billing_error" | "invalid_request" | "max_output_tokens" | "unknown";
}

export interface SystemCompactEvent extends BaseEvent {
  kind: "system.compact_boundary";
}

export interface AssistantMessageEvent extends BaseEvent {
  kind: "assistant.message";
  messageId: string;
  blocks: ContentBlock[];           // text | tool_use | thinking
  usage?: TokenUsage;
}

export interface UserMessageEvent extends BaseEvent {
  kind: "user.message";
  messageId: string;
  blocks: (TextBlock | ToolResultBlock)[];
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string;
      content: string | TextBlock[]; is_error?: boolean };

export interface StreamDeltaEvent extends BaseEvent {
  // only with --include-partial-messages
  kind: "stream.delta";
  index: number;
  delta:
    | { type: "text_delta"; text: string }
    | { type: "input_json_delta"; partial_json: string }
    | { type: "thinking_delta"; thinking: string };
}

export interface ResultEvent extends BaseEvent {
  kind: "result";
  subtype: "success" | "error";
  totalCostUsd: number; durationMs: number; numTurns: number;
  result: string;
  permissionDenials?: {
    tool_name: string; tool_use_id: string; tool_input: unknown
  }[];
}

export interface ErrorEvent extends BaseEvent {
  kind: "error"; reason: string; recoverable: boolean;
}
```

### Zustand store shape (suggested)

```ts
// stores/index.ts — vanilla zustand; combine slices via spread
type AppStore = SessionSlice & WorkflowSlice
              & ReviewQueueSlice & UsageSlice & UISlice;

interface SessionSlice {
  runs: Record<RunId, RunState>;
  messagesByRun: Record<RunId, NormalizedMessage[]>;
  appendEvent(runId: RunId, ev: ClaudeStreamEvent): void;
}

interface RunState {
  id: RunId; workflowId: WorkflowId; worktreePath: string;
  status: "queued" | "starting" | "running" | "awaiting_review"
        | "completed" | "failed" | "canceled";
  ptyPid?: number;
  sessionId?: string;             // claude session_id from system.init
  startedAt: number; endedAt?: number;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  lastError?: string;
}

// THE DIFFERENTIATOR
interface ReviewQueueSlice {
  queue: PendingReview[];                // sorted: oldest first, urgent first
  maybeEnqueue(runId: RunId, ev: ClaudeStreamEvent): void;
  approve(reviewId: string, comment?: string): Promise<void>;
  reject(reviewId: string, reason: string): Promise<void>;
}

interface PendingReview {
  id: string;                            // uuid
  runId: RunId; workflowId: WorkflowId; workflowName: string;
  kind: "tool_use" | "checkpoint" | "ask_user";
  toolName?: string;                     // e.g. "Bash", "Edit"
  toolUseId?: string;                    // Claude's tool_use.id
  payload: unknown;                      // tool input
  rationale?: string;                    // Claude's preceding text block
  createdAt: number; ageMs: number;
  blocking: boolean;                     // true ⇒ run is paused on this
}
```

**Narrative — why Layer A is the spine.** The parser is the hinge between an opaque text stream and everything downstream. If wrong, every UI component lies. Three rules: (1) line buffer **must** carry partial chunks across `data` events — #1 naive-consumer bug; (2) parse errors logged and dropped, never thrown — schema drifts between Claude Code releases; (3) every event lands in `raw_events` *before* it's interpreted, so history is replayable if a downstream reducer turns out wrong.

**Narrative — why Layer B is the differentiator.** A `tool_use` block in an `assistant.message` is the single event that decides whether Cyboflow does its job. The reducer's job: when an assistant message contains a `tool_use` block whose `name` matches a workflow's checkpoint policy *or* whose `input` triggers a "needs human" rule, it must (a) write a row to the `approvals` table, (b) push a `PendingReview` into `reviewQueueSlice`, (c) emit a system notification, and (d) park the run in `awaiting_review`. The renderer's `PendingApprovalCard` is then a pure projection — no fetching, no joins, no per-card subscriptions.

**Path A — what to keep, what to change.** Crystal's `ClaudeMessageTransformer` lives in the *renderer* and operates on raw JSONL strings sent over IPC. Wrong process boundary for Cyboflow: the orchestrator needs typed events too. **Move the transformer into `main/`, behind a `ClaudeStreamParser` class, and emit typed events on both an internal `EventEmitter` and the renderer IPC channel.** Most important refactor in a Path-A fork. Keep `panel_messages` as the raw audit table but rename to `raw_events` and add a `parsed_kind` column.

**Path B Day-1 decisions.** (1) Lock the `ClaudeStreamEvent` discriminated union before writing the parser. (2) Decide raw events are immutable and append-only. (3) Use Zod for runtime validation at the boundary only — trust types inside. (4) Use a single `EventRouter` with explicit consumer registration.

**Failure modes:**
- **Both — partial-line bug:** Line buffer must carry partial bytes across `data` events. *Fix: 30-line LineBufferer with unit test splitting a known stream at every byte boundary.*
- **Both — schema drift:** Anthropic adds event types regularly. *Fix: Zod `.passthrough()` + default `unknown` variant; log unknown kinds at WARN.*
- **Both — `result` event missing (#1920):** *Fix: completion gate `(child exited) AND (stdout drained) AND (parse queue empty)`, with 30s timer after child exit.*
- **Both — `input_json_delta` accumulation:** Tool inputs stream as partial JSON; parsing too early throws. *Fix: only `JSON.parse` on `content_block_stop`; until then, accumulate per content-block index.*
- **A — parser on renderer side:** Orchestrator needs typed events too. *Fix: move `ClaudeMessageTransformer` to main — Day 2 task.*
- **B — over-typing:** Modeling every variant as Zod upfront is tempting. *Fix: parse once at IPC edge, then trust TS types inside.*

---

## Primitive 3 — Task State Management

### Crystal's existing schema (Path A starting point)

```
projects(id, name, path, system_prompt, commit_mode, run_script,
         worktree_folder, …)
  └─CASCADE→ sessions(id, project_id, name, worktree_name, worktree_path,
                      tool_type, status, archived, initial_prompt, …)
                └─CASCADE→ tool_panels(id, session_id, type, title,
                                       state JSON, metadata JSON, settings JSON)
                             └─CASCADE→ panel_outputs(id, panel_id, type,
                                                      content, ts)
                             └─CASCADE→ panel_messages(id, panel_id,
                                                       message_type, content)
                └─CASCADE→ prompt_markers(id, session_id, panel_id,
                                          prompt_text, ts, completed_ts)
                └─CASCADE→ execution_diffs(id, session_id, git_diff,
                                           stats_additions, …)
  └─CASCADE→ folders(id TEXT, project_id, parent_folder_id, name,
                     display_order)
                                     ↓ SET NULL on sessions.folder_id

sessions.status ∈ {initializing, running, waiting, stopped, error}
```

### Cyboflow target schema (Path B; Path A migrates additively)

```sql
-- Existing-style entities (Path A keeps these; Path B creates fresh)
CREATE TABLE projects (
  id TEXT PRIMARY KEY, name TEXT, path TEXT, /* … */
);

CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,   -- 'soloflow'|'planner'|'sprint'|'compound'|'prune'
  markdown_path TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);

-- The new core
CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT REFERENCES workflows(id),
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  parent_run_id TEXT REFERENCES workflow_runs(id),  -- compound/sub-runs
  worktree_path TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  status TEXT NOT NULL,                             -- state machine
  status_changed_at INTEGER NOT NULL,
  claude_session_id TEXT,
  pty_pid INTEGER,
  initial_prompt TEXT NOT NULL,
  total_cost_usd REAL DEFAULT 0,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  ended_at INTEGER,
  last_error TEXT
);
CREATE INDEX idx_runs_status ON workflow_runs(status);
CREATE INDEX idx_runs_project ON workflow_runs(project_id, status);

-- Append-only audit log
CREATE TABLE raw_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT REFERENCES workflow_runs(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  parsed_kind TEXT NOT NULL,                        -- ClaudeStreamEvent.kind
  raw_json TEXT NOT NULL
);
CREATE INDEX idx_raw_events_run ON raw_events(run_id, id);

-- Normalized messages, derived from raw_events but cheaper to read
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES workflow_runs(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                               -- 'system'|'user'|'assistant'
  ord INTEGER NOT NULL,                             -- monotonic per-run
  blocks_json TEXT NOT NULL,                        -- ContentBlock[]
  ts INTEGER NOT NULL
);

-- THE DIFFERENTIATOR
CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES workflow_runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                               -- 'tool_use'|'checkpoint'|'ask_user'
  tool_name TEXT,
  tool_use_id TEXT,
  payload_json TEXT NOT NULL,
  rationale TEXT,
  state TEXT NOT NULL,                              -- 'pending'|'approved'|'rejected'|'expired'
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT,                                  -- 'user' (always, in v1)
  decision_comment TEXT,
  UNIQUE(run_id, tool_use_id)                       -- defend against double-enqueue
);
CREATE INDEX idx_approvals_pending ON approvals(state, created_at)
  WHERE state = 'pending';

-- Optional MVP+1: explicit checkpoints between phases
CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES workflow_runs(id) ON DELETE CASCADE,
  phase TEXT NOT NULL,
  summary TEXT, plan TEXT,
  created_at INTEGER NOT NULL
);
```

### State machine (workflow_runs.status)

```
   queued ──► starting ──► running ─┬──► awaiting_review ──► running (loop)
                  │                 │
                  │                 ├──► completed
                  │                 ├──► failed
                  │                 └──► canceled
                  │
                  └──► failed (start error)
```

**Transitions gated by the orchestrator, written via `BEGIN IMMEDIATE` SQLite transactions.** Any transition into `awaiting_review` is co-written with an `approvals` row in the same transaction. Any transition out of `awaiting_review` is co-written with the `decided_at`/`state` update. No reducer in the renderer ever writes the DB directly — all state changes go through the orchestrator's typed mutation surface.

**Concurrent updates.** `better-sqlite3` is synchronous and single-threaded, so DB-level conflicts are impossible from inside the main process. The real concurrency hazard is Claude-side races: a user clicks Approve while a `result` event arrives concurrently — both want to mutate the run. Use the orchestrator's per-run `Mutex` (one `p-queue({concurrency:1})` per run id) to serialize all mutations for that run id. Crystal added these mutexes after a real cross-session-leak bug.

**Path A — what Crystal already gives:**
- *Keep:* `DatabaseService` with `better-sqlite3`, WAL mode, migration system; rename `~/.crystal` location pattern to `~/.cyboflow`
- *Keep:* archived/soft-delete pattern, display_order pattern
- *Add:* the four new tables (`workflows`, `workflow_runs`, `approvals`, `checkpoints`). Do **not** drop `sessions`/`tool_panels` — write a façade
- *Change:* Crystal's `sessions.status` enum doesn't include `awaiting_review`. Add it; both schemas coexist

**Path B Day-1 decisions:**
1. Store messages denormalized AND normalized — raw for audit, messages for cheap reads
2. Checkpoints as a label on an `approval` in v1; separate table in v2
3. MCP reads go through orchestrator methods, not direct DB access (caching/auth surface later)
4. Hand-roll migrations like Crystal — don't reach for an ORM

**Failure modes:**
- **A — schema drift from Crystal:** 20+ migrations; merging future Crystal updates after fork is painful. *Fix: pin to a commit; Crystal is deprecated anyway.*
- **B — too-clever ORM:** Drizzle/Prisma is overkill for a 2-week MVP. *Fix: hand-rolled SQL on `better-sqlite3`.*
- **Both — concurrent run mutations:** Two events in same tick for same run, both want to mutate. *Fix: per-run `p-queue({concurrency:1})`.*
- **Both — WAL recovery:** Killing app mid-write leaves `-wal`/`-shm` files; SQLite recovers but back up DB before any schema change. *Fix: `db:backup` IPC command for users.*

---

## Primitive 4 — Worktree Lifecycle

```
PATH A (Crystal's WorktreeManager — keep almost verbatim)
on session.create:
  1. resolve worktreeDir = project.worktree_folder
                       ?? `${projectPath}/worktrees`
  2. ensureUniqueNames(humanName) → kebabName, suffix '-1','-2' on collision
  3. exec: git worktree add -b <kebabName> <worktreeDir>/<kebabName>
                                            <baseBranch>
  4. capture {worktreePath, baseCommit, baseBranch} → write sessions row
on session.archive:
  1. mark sessions.archived = 1, emit session:deleted (UI removes)
  2. enqueue ArchiveProgressManager job (background):
       exec: git worktree remove <path> --force
       handle ENOENT (already gone), EBUSY (file locked) gracefully
project_paths cache: in-memory Map<projectId, {worktreesDir, …}>

PATH B (greenfield, simpler)
on workflow_run.start:
  1. worktreeDir = path.join(project.path, '.cyboflow', 'worktrees')
  2. branchName  = `cyboflow/<workflow>/<runId8>`     -- deterministic
  3. exec: git worktree add -b <branchName>
                            <worktreeDir>/<runId8> <baseBranch>
  4. write base_commit, branch_name, worktree_path on workflow_runs row
on workflow_run.end (terminal state):
  - completed: keep worktree until user merges/archives
  - canceled/failed: optionally auto-remove after N days (default: never)
  - cleanup: git worktree remove --force, then git branch -D if not merged
  - SAFETY: refuse to remove if git status --porcelain non-empty
            AND user hasn't confirmed
periodic: git worktree prune (weekly)
```

**Narrative.** Crystal's `WorktreeManager` is solid and battle-tested. `git worktree add -b <new-branch> <path> <base>` is the canonical pattern; `--force` on remove with try/catch on `ENOENT`/`EBUSY` matters because users delete worktree directories manually. Kebab-case derivation, `-1`/`-2` collision suffixing, and the project-paths cache all worth lifting wholesale.

**The one divergence: naming.** Crystal's AI-name-generation step (calls Claude to pick a name from the prompt) adds an API hop, can fail offline, and produces non-deterministic names. For Cyboflow, use deterministic: `cyboflow/<workflow-name>/<runId8>` (e.g. `cyboflow/sprint/a3f2b1c0`). Greppable, sortable, namespaced — `git branch -D 'cyboflow/*'` scrubs everything cleanly.

**Branching strategy.** Each run branches off whatever `baseBranch` the project specifies (default `main`). Crystal supports rebase-into-worktree and squash-and-rebase-to-main; both useful for v2 but skippable in v1. The only branch operation Cyboflow needs is `git worktree add -b`; merge happens in user's normal git tooling.

**Path A inherits — keep:** `WorktreeManager` class, `getProjectPaths` cache, `ensureUniqueNames`, `ArchiveProgressManager`-style background cleanup.
**Path A inherits — change:** Replace `WorktreeNameGenerator` (AI-naming) with deterministic scheme; gut rebase/merge IPC handlers in v1 (`main/src/ipc/git.ts`, ~1,400 lines — keep file, hide UI entry points).
**Path B Day-1 decisions:** (1) Worktree parent dir — recommend hidden `.cyboflow/worktrees/` *inside* the repo path; (2) auto-cleanup — "never auto, manual archive" for v1.

**Failure modes:**
- **Both — uncommitted changes lost on remove:** `git worktree remove --force` discards local changes. *Fix: refuse without explicit `--also-discard-changes` opt-in; show diff first.*
- **Both — branch already exists:** *Fix: deterministic naming with run-id suffix avoids collisions; never reuse names.*
- **A — name-generation race:** AI naming + two simultaneous creates could pick same name. *Fix: replace with deterministic.*
- **Both — orphan worktrees:** User manually `rm -rf` a worktree dir. *Fix: weekly `git worktree prune`; don't crash on ENOENT.*

---

## Primitive 5 — macOS Wrapper

```
Build pipeline (both paths — Path A inherits the full setup)

  pnpm  ───►  build:frontend (Vite → dist/)
        ───►  build:main     (tsc → main/dist/)
        ───►  electron-builder
                ├─ electron@latest LTS (Crystal pins 37.6.0)
                ├─ universal: x64+arm64 single .dmg
                ├─ asar: true
                ├─ asarUnpack:
                │   - **/node_modules/better-sqlite3/**
                │   - **/node_modules/@homebridge/node-pty-prebuilt-multiarch/**
                ├─ osxSign:
                │   - Developer ID Application cert (Xcode keychain)
                │   - entitlements: build/entitlements.plist
                │   - entitlementsInherit: build/entitlements.plist
                │   - hardenedRuntime: true
                └─ osxNotarize:
                    - tool: notarytool
                    - appleId, appleIdPassword: '@keychain:AC_PASSWORD'
                    - teamId

  npm postinstall: @electron/rebuild → rebuilds better-sqlite3
                                       + node-pty for Electron ABI
```

**App lifecycle.** `BrowserWindow` with `titleBarStyle: 'hiddenInset'`, `contextIsolation: true`, `nodeIntegration: false`. Single-instance lock (`app.requestSingleInstanceLock`) so a second launch focuses the existing window. **Dock badge wired to `reviewQueueSlice.queue.length`** — this is the "concentrate attention" affordance. `app.setLoginItemSettings({ openAtLogin: false })` by default; expose as a setting.

**Auto-update.** Crystal uses `electron-updater` with a Squirrel feed. For 2-week MVP, ship with auto-update *off* + manual "check for updates" link to GitHub Releases; turn on in v1.1.

**The native-module gotcha.** `better-sqlite3` and `node-pty` compile against Electron's Node ABI, not Node. You need: (1) `@electron/rebuild` in `postinstall`, (2) those modules in `asarUnpack`, (3) universal-binary build runs `--arch=universal` (electron-builder handles via `mergeASARs`). Crystal already has all three configured.

**Path A inherits — keep:** `package.json` build config, `osxSign`/`osxNotarize` setup, `asarUnpack`, universal-binary recipe, `@electron/rebuild` post-install hook.
**Path A inherits — change:** `appId` (`com.stravu.crystal` → `com.cyboflow.app`), regenerate icon, swap signing identity.
**Path B Day-1 decisions:** Apple Developer Program ($99/yr); cert setup in Xcode → Settings → Accounts (everyone wastes a day on this — do it Day-1); DMG over PKG.

**Failure modes:**
- **Both — notarization auth:** Apple ID password fails; need *app-specific password* or notarytool keychain profile. *Fix: store via `xcrun notarytool store-credentials AC_PASSWORD` once.*
- **Both — universal binary breakage:** Native module not rebuilt for both arches SIGKILLs on wrong arch. *Fix: `npmRebuild: true` in electron-builder config; verify with `lipo -info` on `.node` files in built app.*
- **Both — asar + sqlite:** `.node` loading from asar fails silently. *Fix: `asarUnpack` patterns.*
- **A — Crystal's GTK-3 hack:** Linux-only; remove for macOS-only Cyboflow.

---

## Primitive 6 — MCP Server Lifecycle

```
PATH A (Crystal today: a Unix-socket permission bridge, NOT a workflow MCP)

Crystal main process:
  PermissionIpcServer (Unix socket at
                       ~/.crystal/sockets/crystal-permissions-<pid>.sock)
       ▲
       │  approval req/resp over socket
       │
  Claude Code child:
    spawned with env MCP_PERMISSION_SOCKET=<path>
    --permission-prompt-tool routes to socket

What's missing: no MCP server exposing task state to OTHER Claude sessions.

PATH A as it needs to evolve:
  Electron main:
    Orchestrator (workflow state) ◄══► CyboflowMcpServer
                                       (stdio subprocess at app boot)
                                          │ stdio
                                          ▼
    Claude Code child sessions get .mcp.json injected (or env override)
    pointing at CyboflowMcpServer for tools like:
      - cyboflow_list_pending_approvals
      - cyboflow_get_run
      - cyboflow_submit_checkpoint

PATH B (same shape, designed in from v1)

  Orchestrator ──spawns──► CyboflowMcpServer (separate Node process via stdio)
                            │ tool impls call back to orchestrator over private socket
                            ▼
                       uses @modelcontextprotocol/sdk

  For each Claude run, write per-worktree .mcp.json BEFORE spawning claude:
  {
    "mcpServers": {
      "cyboflow": {
        "type": "stdio",
        "command": "node",
        "args": ["<appResources>/mcp/server.js"],
        "env": {
          "CYBOFLOW_RUN_ID": "<runId>",
          "CYBOFLOW_ORCH_SOCKET": "<path>"
        }
      }
    }
  }

  Scope: per-session env (CYBOFLOW_RUN_ID) keys requests to the right run
```

**Narrative — what Crystal has.** Crystal ships `@modelcontextprotocol/sdk` and runs a Unix-socket-based permission bridge — but for *inbound* tool-permission decisions, not for *outbound* MCP tools Cyboflow exposes to its sessions. The architectural pieces (subprocess spawn, stdio config, env-variable handoff) are there as proof-of-concept; you'll repurpose them.

**Narrative — what you want.** A `CyboflowMcpServer` that exposes tools like `getApprovalQueue`, `submitCheckpoint`, `readPlan` to Claude Code sessions. Spawn once per app, as a stdio subprocess. Inject its config per-Claude-session via a `.mcp.json` written into the worktree before `claude -p` is invoked. Per-session scoping via `CYBOFLOW_RUN_ID` env var; the MCP server talks back to the orchestrator over a private Unix socket.

**Path A inherits — keep:** `@modelcontextprotocol/sdk` dep, `permissionIpcServer.ts` module structure as a template, env-variable injection pattern in `ClaudeCodeManager`.
**Path A inherits — change:** Add brand-new module (`main/src/mcp/cyboflowMcpServer.ts`); add `.mcp.json` write step in worktree creation. Net-new code, not modification.
**Path B Day-1 decisions:**
1. Transport: stdio (no port collisions, works offline)
2. V1 tool surface: `cyboflow_list_pending_approvals`, `cyboflow_get_run`, `cyboflow_submit_checkpoint`. Resist adding write-state tools until v2
3. Scope: per-session (env-keyed) for security

**Failure modes:**
- **Both — env-var leak on respawn:** `CYBOFLOW_RUN_ID` per-spawn; forget to set on restart and MCP server claims auth as wrong run. *Fix: spawn-then-read-back handshake to verify scope.*
- **Both — stdio buffering:** MCP servers are JSON-RPC over stdio; line buffering matters. *Fix: same LineBufferer pattern as the Claude parser.*
- **A — socket name collisions:** Crystal's `~/.crystal/sockets/crystal-permissions-<pid>.sock` is fine, but two Cyboflow instances bind to same name. *Fix: include random suffix; clean up sock files on app shutdown.*

---

## Primitive 7 — Human Review Queue (LOAD-BEARING DIFFERENTIATOR)

```
Both paths — end-to-end flow

   Run 1 PTY  ────► Parser ──┐
   Run 2 PTY  ────► Parser ──┤    EventRouter (main-process orchestrator)
   Run 3 PTY  ────► Parser ──┘         │
                                       │ for ev where ev.kind=='assistant.message'
                                       │   AND ev.blocks.some(b=>b.type=='tool_use')
                                       │   AND policy.requiresApproval(b)
                                       ▼
                              ApprovalRouter
                               1. write approvals row   ── BEGIN IMMEDIATE
                                  (state='pending')        INSERT approvals
                                                           UPDATE workflow_runs
                                                             SET status='awaiting_review'
                                                           COMMIT
                               2. signal Claude to PAUSE (mechanism below)
                               3. push event to renderer
                                       │  IPC event 'approval:created' { PendingReview }
                                       ▼
   ┌──────────── Renderer ─────────────────────────────────────┐
   │ reviewQueueSlice.maybeEnqueue(ev)                          │
   │              │                                              │
   │              ▼                                              │
   │ <ReviewQueueView />                                        │
   │   ▸ <PendingApprovalCard /> per item, sorted               │
   │     ▸ Approve  ──► api.approvals.approve({id, comment})    │
   │     ▸ Reject   ──► api.approvals.reject({id, reason})      │
   │     ▸ Open run ──► focuses RunDetailView                    │
   │ Dock badge bound to queue.length                            │
   └─────────────────────────────┬──────────────────────────────┘
                                 │  approve()/reject() IPC
                                 ▼
                       ApprovalRouter
                         BEGIN IMMEDIATE
                           UPDATE approvals SET state=…, decided_at
                           UPDATE workflow_runs SET status='running'
                         COMMIT
                         SIGNAL the run to RESUME
                                 │  resume mechanism (paths diverge)
                                 ▼

PATH A (Crystal-aware): use Crystal's PermissionIpcServer Unix socket.
   Pause point is Claude's --permission-prompt-tool. When approval needed,
   Claude BLOCKS awaiting socket response. ApprovalRouter writes approval,
   queue surfaces it, on user decision the socket replies allow/deny,
   Claude resumes.
   ⇒ Pause/resume is FREE because Crystal already implements it.

PATH B (greenfield): two viable mechanisms
   (a) Use the same Unix-socket permission bridge pattern (steal from Crystal)
   (b) Use Claude's PreToolUse hook with a small script reading state
       from CyboflowMcpServer / orchestrator. Hook exits 0 or 2.
   Recommend (a) for v1; (b) is the "right" long-term answer
   when CyboflowMcpServer is mature.
```

**Narrative.** This is the differentiator and the highest-risk piece. Three things must be true:

1. **The queue is workspace-scoped, not panel-scoped.** UI: a single `<ReviewQueueView />` is the app's left rail; it lists pending approvals across *all* running workflows. Crystal-style per-panel inline approvals are the wrong shape and must be replaced.
2. **The pause mechanism is reliable.** Approvals are useless if the run finishes before the user sees the card. Two mechanisms: (a) intercept via `--permission-prompt-tool` (synchronous, blocks the agent loop; Crystal's `PermissionIpcServer` does this); (b) intercept via PreToolUse hook (also synchronous via exit code). Both work; (a) is what Crystal provides on Path A. **The run must actually be paused, not "told to pause."** Post-hoc inspection of stream events is not acceptable.
3. **The decision propagates back atomically.** Approve/reject must (i) update the DB row, (ii) update the run row, (iii) reply on the socket / hook, in one transactional unit. Use the per-run mutex.

**Policy — when is an approval required?** v1 policy is per-workflow, in markdown frontmatter:
- `soloflow.md` and `prune.md` → `permission_mode: "default"` (everything prompts)
- `sprint.md` → `acceptEdits` (file edits auto-allow, bash prompts)
- `compound.md` → `dontAsk` with explicit allowlist

Policy parsed at run-start, stored on the `workflow_runs` row.

**Path A — reuse:** `PermissionIpcServer` and its socket plumbing are **gold**. Take them as-is, rename, wire the *outbound* end into your `ApprovalRouter`/`reviewQueueSlice` instead of the in-panel modal. **Single biggest reason to fork.**
**Path A — change:** Crystal's per-panel modal UI for permission prompts must be replaced with the queue view; delete the modal component.
**Path B Day-1 decisions:** Pick mechanism (a) for v1. Decide policy frontmatter schema. Decide queue UI's sort order (recommend: oldest-pending first, pinned to top until decided).

**Failure modes (load-bearing — ALL must be handled):**
- **Pause not enforced:** Policy says approve, run already executed it before user saw card → differentiator broken. *Fix: only intercept via synchronous permission-prompt-tool; never post-hoc.*
- **Race: user approves while run dies.** *Fix: in `ApprovalRouter.approve`, check run status under mutex; if `failed`/`canceled`, mark approval `expired` and surface toast.*
- **Race: two approvals queued for same `tool_use_id`.** *Fix: `UNIQUE(run_id, tool_use_id)` constraint on `approvals` table.*
- **Stuck pause:** Socket reply path deadlocks if `ApprovalRouter` crashes between writing row and replying. *Fix: 60-min timeout — if no decision, auto-reject AND reply on socket with deny.*
- **Notification fatigue:** 5 runs all hit `Bash` approvals simultaneously → user buried. *v1 fix: collapse into "5 pending in run X" summary card. v2: AI-assisted auto-approval for safe-pattern bash.*
- **UI freeze during pending storm:** 30 simultaneous approvals lock renderer if each is a separate React subscription. *Fix: virtualized list; subscribe to slice once.*
- **Wrong run displayed after approval:** Approve in queue → focus run → run shows old state because event hasn't propagated. *Fix: optimistic update in slice; reconcile on next event.*
- **Silent self-deadlock:** Run A approval needs Run B's MCP tool which is also paused. *Fix: detect cycles in `awaiting_review` graph; flag `stuck` after 5 min.*
- **A — Crystal's modal pollutes:** Per-panel approval modal fires on top of queue UI if not disabled. *Fix: comment out modal mount in `ClaudePanel.tsx`.*

---

## Primitive 8 — IPC Layer

```
PATH A (Crystal's hand-rolled typed IPC)
preload.ts:
  contextBridge.exposeInMainWorld('electronAPI', {
     sessions:  { create, getAll, delete, input, continue, … },
     panels:    { create, sendInput, getOutput, … },
     claudePanels: { getModel, setModel, … },
     events:    { onSessionOutput, onPanelUpdated, … },
     …
  })

main:
  ipcMain.handle('sessions:create', validate, async (_, req) => {
     try { return { success:true, data: await sessionMgr.create(req) } }
     catch (e) { return { success:false, error:{code,message,details} } }
  })

events: mainWindow.webContents.send('session:output', payload)

frontend: const API = { sessions: { create: (r) =>
                          window.electronAPI.sessions.create(r), … } }

Type contract: frontend/src/types/electron.d.ts (~360 lines, hand-maintained)

PATH B (typed RPC with extraction-ready boundary)
shared/router.ts (tRPC v11):
  export const appRouter = t.router({
    runs: t.router({
      list: q.query(...).output(z.array(RunSchema)),
      start: q.input(StartRunInput).mutation(...),
      cancel: q.input(z.object({runId: z.string()})).mutation(...),
    }),
    approvals: t.router({
      listPending: q.query(...).output(z.array(PendingReviewSchema)),
      approve: q.input(...).mutation(...),
      reject: q.input(...).mutation(...),
    }),
    workflows: t.router({...}),
    events: t.router({
      onStreamEvent: q.subscription(...),  // Observable per runId
    }),
  });

main:    createIPCHandler({ router: appRouter, windows: [win] })
preload: process.once('loaded', exposeElectronTRPC)
renderer:
  const trpc = createTRPCClient<AppRouter>({ links: [ipcLink()] })
  trpc.approvals.listPending.useQuery()        // React-Query bindings
  trpc.events.onStreamEvent.useSubscription({runId}, { onData: … })

Future: swap ipcLink for httpLink + wsLink → orchestrator becomes backend
        service without touching renderer call sites.
```

**Narrative — why Path B's clean boundary matters.** The team-tier scaling motion will require extracting the orchestrator into a backend service. This is the cheapest insurance to buy on Day-1. With tRPC + electron-trpc, every renderer call goes through `trpc.something.something.query()`, identical whether transport is IPC, HTTP, or WebSocket. When team-tier comes, swap the link, ship the orchestrator as a Node service, point the desktop app at it. **The renderer doesn't change.**

Crystal's IPC works fine and is type-safe in a pragmatic sense, but it's hand-maintained: every new method requires editing four files (preload.ts, ipc/*.ts, electron.d.ts, frontend/api.ts). It also tightly couples to Electron — no plausible "extract to backend" without rewriting the API surface. For a 2-week MVP the cost is low; for a "we will extract this in 6 months" promise, it's a tax.

**Recommendation.** Even on Path A, **introduce tRPC for Cyboflow-specific routes from Day-1** while leaving Crystal's existing IPC alone. Two namespaces: `electronAPI` (Crystal's, for inherited functionality) and a separate tRPC client for `cyboflow.runs`, `cyboflow.approvals`, `cyboflow.workflows`. New code goes through tRPC; old code stays. Half-day investment; preserves the extractability story.

**Path A — keep:** Crystal's IPC for everything Crystal already does (worktree mgmt, git ops, file ops). **Don't refactor.**
**Path A — change:** Add `electron-trpc` and a `cyboflow.*` tRPC router for new functionality.
**Path B Day-1 decisions:**
1. tRPC v11 + `trpc-electron`/`electron-trpc` — pick one; the v11 fork (`mat-sz/trpc-electron`) is current
2. `superjson` transformer for Date / BigInt
3. tRPC subscriptions over IPC are Observables — exactly what stream events need
4. Auth principal in context from Day-1 (even just `{userId: 'local'}`) so real auth is a swap not a refactor

**Failure modes:**
- **Both — superjson serialization mismatch:** Date/Map/BigInt loses fidelity without superjson on both ends. *Fix: configure transformer at router-create time.*
- **Both — IPC backpressure on stream events:** Run emitting 1000 deltas/sec saturates IPC. *Fix: throttle stream-event broadcast at 60Hz; full fidelity in `raw_events` table.*
- **A — duplicate API surfaces:** Old Crystal IPC + new Cyboflow tRPC means two ways to do the same thing. *Fix: name the tRPC router `cyboflow.*`; document the boundary.*
- **B — extracted-server auth:** When you move orchestrator to backend, `ipcLink` had implicit trust; HTTP doesn't. *Fix: design tRPC context to take an auth principal from Day-1.*
