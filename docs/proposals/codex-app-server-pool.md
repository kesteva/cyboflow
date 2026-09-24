# Codex app-server pool: pool processes, never conversations

Status: **DEFERRED** (2026-09-24). This design was split out of revision 1 of
`codex-workflow-efficiency.md` (§7 there). It is kept so the design work is not lost. It is
**not** scheduled.

## Why it is deferred

- **Blocker: an unsubscribed thread keeps its MCP servers running.** On 0.153.3,
  `thread/unsubscribe` neither unloads the thread nor stops its MCP child processes. They were
  still running 60 seconds later in a live probe that ran no model. There is no `thread/unload`.
  A long-lived pooled process would therefore collect MCP children from every lane it served.
- **The saving is under 1% of lane time.** The local process phase takes p50 0.14s and p95 3.8s,
  against a p50 lane of about 186s (9/16–9/23 audit).
- **Pooling does not save MCP startup.** MCP servers start per thread, not per process.
- **Revision 1's pool key was wrong.** It included the sandbox/permission family and the
  capability policy, but both of those are thread parameters (`ThreadStartParams` and thread
  `config`), not process parameters. The process environment depends only on the run id
  (`buildCodexAppServerEnvironment`), and the lanes of a run share one worktree. The real key is
  therefore the same for every lane in a run, and a `pool_key_distinct_per_run` metric would
  always read 1.
- **Cancellation gets harder.** Today, cancelling a lane stops that lane's process group,
  including its Cyboflow MCP bridge, so no write from the lane can land afterwards. With a pool,
  cancelling can only interrupt the turn. There is no lane-level revocation today: the router
  knows only the run id, token and scope.
- **Crashes would be misclassified.** When a pooled process dies, every attached lane gets the
  same "app-server exited" error. `isSystemicStepError` has no pattern for that error. With 3 or
  more lanes attached, the same-error corroboration rule would park the whole run behind the
  systemic-pause gate. With fewer lanes, they would each simply fail.

## Reopen criteria

Reopen this only if all three hold:

1. Per-phase timing collected after Increment 3 of `codex-workflow-efficiency.md` still shows
   p95 process-phase time above about 5s.
2. There is a way to release a thread's MCP children, such as `thread/archive`. A probe that
   runs no model and only calls thread/start can check this.
3. The Cyboflow MCP router can identify the calling lane from a per-call token, not from process
   environment.

Measure with a 5-lane fixture (`SPRINT_BATCH_CAP`), not 20.

## Design as drafted in revision 1

### Current topology

`CodexSdkManager.spawnTrackedProcess()` marks a lane spawn as single-shot whenever
`spawnKey !== panelId`. For each lane it:

1. builds a cold app-server entry;
2. starts one thread and one turn;
3. stops the client afterwards.

This keeps conversations isolated, but it ties process lifetime to thread lifetime.

### Decision (as drafted)

A `CodexAppServerPool` owns long-lived app-server clients. Each lane still creates its own:

- `CodexTurnSession`;
- thread;
- usage accumulator;
- terminal latch;
- approval and question bridge;
- invocation row.

The pool's scope is **one workflow run**. Cross-run pooling is rejected, because the process
environment carries run-specific values:

- the run id;
- the orchestration bearer token;
- the socket path;
- the sandbox environment;
- test-concurrency settings.

Key the process on run id, executable path and version, client version, a digest of the
environment, and the process cwd. Sandbox, approval policy and capability policy are thread
configuration and must not be part of the key. Model, effort, role instructions and
conversation history are thread or turn inputs. Anything the protocol fixes when the process
starts must be added to the key.

### Lifecycle

1. The first lane acquires the pool entry and starts it.
2. Other lanes that run at the same time acquire references and start their own threads.
3. When a lane completes, it releases only its own thread resources.
4. Cancelling the run interrupts every active turn, then closes the pool.
5. An idle pool closes after a bounded TTL. A terminal run status closes it immediately.
6. If the process fails:
   - every attached turn is rejected once, with the same systemic failure class;
   - there is no silent respawn and no replay of prompts that change state;
   - controller retries are capped and staggered.

### Notification routing requirements

- Route events to exactly one lane session by `threadId`.
- Assign descendant threads to the lane that owns them.
- Persist each raw notification at most once.
- Send approval and question events only to the bridge of the turn that owns them.
- Hold notifications for an unknown thread only for a short, bounded registration window.
- Answer a server request that cannot be routed with an explicit denial. Never drop it.
- Remove a lane's ownership entry before its teardown completes.

### Concurrency and cancellation

- The pool keeps `threadId → LaneContext` and `spawnKey → threadId` maps.
- `killProcess(spawnKey)` interrupts only that lane's turn. `killProcess(runId)` interrupts every
  lane and closes the pool.
- Cancelling a lane first revokes that lane at the Cyboflow MCP router. This rejects any write
  still in flight from it.
- Thread starts are bounded by the existing workflow concurrency controller.
- Transcript, token-usage, terminal, approval and tool events are never dropped. A diagnostic
  raw notification may be dropped only under an explicit policy, and each drop is counted.

### Tests (as drafted)

- Identical fingerprints share a process; any security or config difference does not.
- Many lane threads run through one fake client with no events crossing between them.
- Prompts, usage, result text, approvals and cancellation stay within their own lane.
- A process death rejects every attached lane exactly once.
- Cancelling one lane leaves the other lanes running.
- One notification produces one raw row.
- Direct and delegated steps both work through the pool, including a child whose first
  notification arrives before its owner is registered.
