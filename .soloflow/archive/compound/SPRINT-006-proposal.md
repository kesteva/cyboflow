---
sprints: [SPRINT-006]
span_label: SPRINT-006
created: 2026-05-14T00:00:00.000Z
counters_start:
  ideas: 0
summary:
  cleanups: 6
  backlog_tasks: 10
  claude_md: 1
  soloflow_improvements: 0
---

# Compound Proposal — SPRINT-006

SPRINT-006 spanned two epics: `orchestrator-and-trpc-router` (TASK-251–255) and
`approval-router-and-permission-fix` (TASK-301–302). The sprint wired the orchestrator,
the tRPC IPC surface, and the new `ApprovalRouter` replacing Crystal's legacy
`PermissionManager`. The sprint-code-reviewer surfaced 11 cross-task findings
(FIND-14 through FIND-24) that individual per-task reviewers could not see. Findings
are triaged below into three buckets.

---

## A. Clean-up items (execute now)

### A1. Remove dead write in Orchestrator.test.ts drain test
- **Summary:** The drain test assigns `taskFinished = false` inside the task body immediately before assigning `true`, making the first assignment unreachable — delete the dead line.
- **Source-Sprint:** SPRINT-006
- **Rationale:** The outer `let taskFinished = false;` already provides the pre-condition. The dead write plus its `// initially false` comment mislead future readers about when the gate is evaluated.
- **Blast radius:** `main/src/orchestrator/__tests__/Orchestrator.test.ts` (1 line), no risk.
- **Source:** FIND-SPRINT-006-3 (TASK-253 code-reviewer), TASK-253 done report open observations.
- **Proposed change:**
  ```diff
  // main/src/orchestrator/__tests__/Orchestrator.test.ts:132-136
  -      taskFinished = false; // initially false
       taskFinished = true;
  ```
  (Remove the `taskFinished = false; // initially false` line; the `taskFinished = true;` line
  that follows is the only body the task needs.)

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Verified at `main/src/orchestrator/__tests__/Orchestrator.test.ts:164` (outer `let taskFinished = false`) and `:169` (dead re-assignment inside the task body before `:170` true-write); single-line delete in test file with zero blast radius.

---

### A2. Drop unused re-exports from Orchestrator.ts
- **Summary:** `Orchestrator.ts` re-exports `EventEmitter` and `RunQueueRegistry` as speculative caller conveniences, but no call site currently imports either symbol from this file — remove them.
- **Source-Sprint:** SPRINT-006
- **Rationale:** There are zero imports of `EventEmitter` or `RunQueueRegistry` from `'./orchestrator/Orchestrator'` across `main/src/` (verified by grep in the code-reviewer's report). Keeping them adds two extra public surface symbols that callers can already import from their canonical modules. The `OrchestratorDeps` type re-export earns its keep (it lives next to its consumer) and should stay.
- **Blast radius:** `main/src/orchestrator/Orchestrator.ts` (1 line), trivial.
- **Source:** FIND-SPRINT-006-2 (TASK-253 code-reviewer), TASK-253 done report open observations.
- **Proposed change:**
  ```diff
  // main/src/orchestrator/Orchestrator.ts — bottom of file
  -// Re-export RunQueueRegistry so callers building OrchestratorDeps can import
  -// from a single location when convenient.
   export type { OrchestratorDeps };
  -export { RunQueueRegistry, EventEmitter };
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Grep across `main/src` and `frontend/src` confirms zero importers of `EventEmitter`/`RunQueueRegistry` from `'./orchestrator/Orchestrator'` (only `Orchestrator.ts:75` declares the re-export, only the class is imported in `index.ts:32` and the test); one-line delete clears speculative public surface.

---

### A3. Replace silent mainWindow null-guard with a loud throw in index.ts
- **Summary:** Replace the `if (mainWindow)` guard that silently skips `attachOrchestratorTrpc` with an assertion that throws at startup — so a half-wired app is impossible to reach without a visible error.
- **Source-Sprint:** SPRINT-006
- **Rationale:** `createWindow()` is awaited immediately above the guard, so `mainWindow` should never be null at that point. The guard hides a logically impossible state and, if it ever fires, produces an app where every renderer `trpc.*` call fails with a cryptic "Could not find `electronTRPC` global" error. A startup throw is strictly better than silent failure.
- **Blast radius:** `main/src/index.ts` (~4 lines replaced), low risk.
- **Source:** FIND-SPRINT-006-9 (TASK-255 code-reviewer), TASK-255 done report open observations.
- **Proposed change:**
  ```diff
  // main/src/index.ts — orchestrator wiring block (approx. line 707)
  -    if (mainWindow) {
  -      attachOrchestratorTrpc({ window: mainWindow, router: appRouter, createContext });
  -    }
  +    if (!mainWindow) {
  +      throw new Error(
  +        'mainWindow is null after createWindow — cannot attach orchestrator tRPC bridge'
  +      );
  +    }
  +    attachOrchestratorTrpc({ window: mainWindow, router: appRouter, createContext });
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed at `main/src/index.ts:707-709` — the `if (mainWindow)` guard sits one line below `await createWindow()` (line 682), so a silent skip leaves the orchestrator running with no tRPC bridge wired and every renderer `trpc.*` call fails cryptically; a throw is strictly safer and ~4 lines.

---

### A4. Replace `${Date.now()}-${Math.random()}` IDs with `randomUUID()` in bridge and IPC server
- **Summary:** Both sides of the permission socket generate request/client IDs via `${Date.now()}-${Math.random()}` — replace both with `randomUUID()` from `node:crypto`, which is already used by `approvalRouter.ts` in the same sprint.
- **Source-Sprint:** SPRINT-006
- **Rationale:** `Math.random()` is not a UUID source and the pattern is inconsistent with the rest of the codebase. The sprint introduced `randomUUID` in `approvalRouter.ts:30` but the two ID-allocation sites in different tasks each copied Crystal's legacy idiom instead. Two files, two inline replacements — no shared helper needed yet.
- **Blast radius:** `main/src/services/cyboflowPermissionBridge.ts:65` and `main/src/services/cyboflowPermissionIpcServer.ts:45`, low.
- **Source:** FIND-SPRINT-006-24 (sprint-code-reviewer, suspected TASK-301 + TASK-302).
- **Proposed change:**
  ```diff
  // main/src/services/cyboflowPermissionBridge.ts
  +import { randomUUID } from 'node:crypto';
   ...
  -    const requestId = `${Date.now()}-${Math.random()}`;
  +    const requestId = randomUUID();

  // main/src/services/cyboflowPermissionIpcServer.ts
  +import { randomUUID } from 'node:crypto';
   ...
  -        const clientId = `${Date.now()}-${Math.random()}`;
  +        const clientId = randomUUID();
  ```
  (Both files already import `net`, `fs`, `path`, `os` — add `randomUUID` import alongside
  those, or inline as `crypto.randomUUID()` if a named import is less convenient.)

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Verified both sites: `cyboflowPermissionBridge.ts:65` and `cyboflowPermissionIpcServer.ts:45` use `${Date.now()}-${Math.random()}`, while `approvalRouter.ts:29,177` already imports and uses `randomUUID` — two-line consistency fix with no new abstractions.

---

### A5. Replace invalid `NOT_IMPLEMENTED` tRPC error code with `METHOD_NOT_SUPPORTED` and extract a shared helper
- **Summary:** Three stub routers throw `TRPCError({ code: 'NOT_IMPLEMENTED' })` — a string that is not in tRPC v11's valid error code union — replace with `'METHOD_NOT_SUPPORTED'` and extract a shared `throwNotImplemented(epic)` helper so future epic completions can grep for it.
- **Source-Sprint:** SPRINT-006
- **Rationale:** tRPC v11's `TRPC_ERROR_CODE_KEY` union does not include `NOT_IMPLEMENTED`. At runtime tRPC falls back to `INTERNAL_SERVER_ERROR`, and the manual smoke test in the human-review queue (TASK-255) will return the wrong error shape. A grep-friendly `throwNotImplemented` helper consolidates the identical pattern in three files and makes partial-implementation discovery easy across future epics.
- **Blast radius:** `main/src/orchestrator/trpc/trpc.ts` (add 4 lines), `main/src/orchestrator/trpc/routers/runs.ts`, `approvals.ts`, `workflows.ts` (each 2-line change), low.
- **Source:** FIND-SPRINT-006-21 (sprint-code-reviewer, TASK-254).
- **Proposed change:**
  ```diff
  // main/src/orchestrator/trpc/trpc.ts — add after protectedProcedure export
  +/**
  + * Throw a NOT_IMPLEMENTED placeholder. Every stub procedure body calls this
  + * so future epic tasks can grep for `throwNotImplemented` to find remaining stubs.
  + */
  +export function throwNotImplemented(epicName: string): never {
  +  throw new TRPCError({ code: 'METHOD_NOT_SUPPORTED', message: `TODO: implemented in ${epicName} epic` });
  +}

  // main/src/orchestrator/trpc/routers/runs.ts (and approvals.ts, workflows.ts):
  -import { TRPCError } from '@trpc/server';
  +import { throwNotImplemented } from '../trpc';
   ...
  -const NOT_IMPLEMENTED_MSG = 'TODO: implemented in workflow-runs epic';
   ...
  -      throw new TRPCError({ code: 'NOT_IMPLEMENTED', message: NOT_IMPLEMENTED_MSG });
  +      throwNotImplemented('workflow-runs');
  ```
  (Apply the same `throwNotImplemented(epicName)` substitution to every procedure body across
  all three routers. The `TRPCError` import in each router file can be removed once all bodies
  delegate to the helper.)

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed at `main/src/orchestrator/trpc/routers/runs.ts:21,28,35,42` (and same pattern in approvals.ts/workflows.ts) — `'NOT_IMPLEMENTED'` is not in tRPC v11's `TRPC_ERROR_CODE_KEY` union (which includes `METHOD_NOT_SUPPORTED`), and the helper consolidates 12 procedure bodies for future grep at low cost (4 lines added to `trpc.ts`).
- **Counterfactual:** If runtime testing showed tRPC v11 accepts arbitrary string codes without observable harm AND no further epic needed to grep for these stubs, a code-only swap (without the helper) would be the proportional fix.

---

### A6. Fix stale docstring on the `getCyboflowSubdirectory` alias in crystalDirectory.ts
- **Summary:** The JSDoc on the `getCyboflowSubdirectory` alias says the `~/.crystal → ~/.cyboflow` data-directory flip "is handled by the crystal-cuts-and-rebrand epic" — but `getCrystalDirectory()` already returns `.cyboflow` paths, making the docstring wrong.
- **Source-Sprint:** SPRINT-006
- **Rationale:** The underlying `getCrystalDirectory()` function already uses `.cyboflow` everywhere. The alias docstring misleads readers into thinking the directory rebrand is still pending when it has already happened. A two-line doc update prevents confusion without touching any call sites (the full function rename across ~30 import sites belongs in the crystal-cuts-and-rebrand epic, so is not proposed here).
- **Blast radius:** `main/src/utils/crystalDirectory.ts:81-87` (docstring only), trivial.
- **Source:** FIND-SPRINT-006-22 (sprint-code-reviewer, TASK-301).
- **Proposed change:**
  ```diff
  // main/src/utils/crystalDirectory.ts:81-87
  -/**
  - * Alias for getCrystalSubdirectory using Cyboflow naming.
  - * The data-directory flip (~/.crystal → ~/.cyboflow) is handled by the
  - * crystal-cuts-and-rebrand epic; this re-export lets Cyboflow-branded
  - * modules import a consistently-named symbol today.
  - */
  +/**
  + * Alias for getCrystalSubdirectory using Cyboflow naming.
  + * NOTE: getCrystalDirectory() already returns ~/.cyboflow paths — the
  + * data-directory flip is complete. The legacy function name is preserved
  + * for git-history clarity; both will be renamed in the crystal-cuts-and-rebrand
  + * epic when call sites are swept.
  + */
   export const getCyboflowSubdirectory = getCrystalSubdirectory;
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Verified at `main/src/utils/crystalDirectory.ts:45-71` — `getCrystalDirectory()` already returns `.cyboflow`/`.cyboflow_dev` paths in all 5 branches, contradicting the alias docstring at `:81-87` that claims the flip is "handled by the crystal-cuts-and-rebrand epic"; trivial doc-only edit.

---

## B. Backlog tasks (refine into execution-ready plans)

### B1. Delete dead permission-layer files (permissionManager.ts, mcpPermissionServer.ts)
- **Summary:** Two orphaned files from the Crystal permission layer sit in `main/src/services/` with zero live importers — plan and execute their deletion with a typecheck + test gate.
- **Source-Sprint:** SPRINT-006
- **Source:** FIND-SPRINT-006-17 (sprint-code-reviewer, TASK-301 + TASK-302).
- **Problem:** `main/src/services/permissionManager.ts` (class `PermissionManager`) and `main/src/services/mcpPermissionServer.ts` (class `MCPPermissionServer`) have zero importers across `main/src/` and `frontend/src/`. `mcpPermissionServer.ts` still imports `PermissionManager`, so the two files form a dead island. TASK-302's done report acknowledges they remain "dead code; cleanup is owned by `crystal-cuts-and-rebrand`" — but they inflate the lint warning count (229 warnings in TASK-302 baseline), pollute permission-related grep results, and mask the completed PermissionManager→ApprovalRouter transition. TASK-301 even rebranded the socket name inside `mcpPermissionServer.ts`, making stale dead code look freshly maintained.
- **Proposed direction:** Create a task that (1) verifies zero importers via `grep -rn 'permissionManager\|MCPPermissionServer\|PermissionManager' main/src frontend/src` (excluding the files themselves), (2) deletes both files, (3) runs `pnpm typecheck` and `pnpm --filter main lint` to confirm zero new errors/warnings, (4) runs `pnpm --filter main test` to confirm the test count and pass rate are unchanged. The task should also check for any remaining `type PermissionResponse` imports in `cyboflowPermissionBridge.ts` (TASK-302 replaced it with `ApprovalDecision`, but the finding log notes a leftover risk).
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Grep of `main/src` and `frontend/src` for `PermissionManager\b|MCPPermissionServer\b` returns matches only inside the two dead files themselves (no live importers); TASK-302's done report acknowledges cleanup, and no in-flight plan (TASK-562 in crystal-cuts handles `crystalDirectory`, not these files) owns the deletion.

---

### B2. Add newline-delimited message framing to the unix socket (IPC server + bridge)
- **Summary:** Both sides of the permission unix socket parse incoming bytes as one JSON object per `data` event, which is unsafe under TCP coalescing — add a newline-delimited buffer+split idiom on both sides.
- **Source-Sprint:** SPRINT-006
- **Source:** FIND-SPRINT-006-15 (sprint-code-reviewer, TASK-301 + TASK-302).
- **Problem:** `cyboflowPermissionIpcServer.ts:51` does `JSON.parse(data.toString())` and `cyboflowPermissionBridge.ts:41` does the same. Node.js `net` sockets do not preserve message framing: two writes can coalesce into one `data` event, and a large payload can split across chunks. Either scenario throws a `JSON.parse` SyntaxError, silently dropping the message (caught by the outer `catch`). With `ApprovalRouter` now writing DB transactions behind the socket, a dropped response leaves a `workflow_runs` row wedged in `awaiting_review` indefinitely, blocking Claude. The correct framing idiom is already present in `main/build-cyboflow-permission-bridge.js:108` (`SimpleMCPServer.processBuffer`) — it accumulates a string buffer per socket and splits on `\n`. Both sides of the wire need the same treatment, and every `write()` call must append `\n`.
- **Proposed direction:** Implement a shared `LineFramer` class or inline buffer-per-socket pattern in both files. For `cyboflowPermissionIpcServer.ts`, track one buffer string per client socket in the `client.on('data', ...)` handler; split on `\n`; parse only complete lines; discard empty tokens. For `cyboflowPermissionBridge.ts`, apply the same pattern in `ipcClient.on('data', ...)`. Wrap every `client.write(...)` / `ipcClient.write(...)` with `JSON.stringify(msg) + '\n'`. Add unit tests that exercise chunk splitting (first half of a valid JSON message, then the second half) and coalescing (two messages in one `data` call). After the fix, manually verify that the TASK-255 smoke test (DevTools `trpcClient.cyboflow.runs.list.query({})`) still works end-to-end.
- **Scope:** medium

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed both sides parse one JSON-per-`data` event: `cyboflowPermissionIpcServer.ts:51` and `cyboflowPermissionBridge.ts:41` both call `JSON.parse(data.toString())`; with TASK-302 now wedging `workflow_runs.status='awaiting_review'` on a dropped reply (`approvalRouter.ts:199-218`), a coalesced/split chunk leaves the run hung in DB — high-severity bug, no in-flight plan owns it.

---

### B3. Add zod input validation to cyboflowPermissionIpcServer
- **Summary:** The IPC server unpacks incoming socket JSON into `sessionId`, `toolName`, and `input` with no type or boundary checks before feeding them to `ApprovalRouter.requestApproval()` and persisting `input` to the `approvals` table.
- **Source-Sprint:** SPRINT-006
- **Source:** FIND-SPRINT-006-16 (sprint-code-reviewer, TASK-301 + TASK-302).
- **Problem:** `cyboflowPermissionIpcServer.ts:53-89` destructures `const { requestId, sessionId, toolName, input } = message;` with no validation. There is no check that `sessionId` is a non-empty string, `toolName` is a non-empty string, `input` is a plain object, `requestId` is present (needed to send a coherent reply), or `message.type` is an allowlisted value. `input` then flows into `JSON.stringify(input)` → the `tool_input_json` SQLite column. While the socket lives in `~/.cyboflow/sockets/` (single-user scope), any process on the same UID can reach it — and after B2 (framing fix) is applied, malformed payloads no longer crash silently but may still produce bad DB rows. `zod` is already declared as a dependency in `main/package.json:32`.
- **Proposed direction:** Define a zod schema for the message envelope in `cyboflowPermissionIpcServer.ts`: `PermissionRequest = z.object({ type: z.literal('permission-request'), requestId: z.string().min(1), sessionId: z.string().min(1), toolName: z.string().min(1), input: z.record(z.string(), z.unknown()) })`. Parse with `.safeParse(message)`; on failure, write a deny response if `requestId` is recoverable, otherwise log-and-drop. Also gate the raw `data.toString()` call with a size limit (e.g., 1 MB) before passing to `JSON.parse` to mitigate a DoS vector. Add unit tests for schema rejection paths. Plan should note this as a prerequisite or companion to B2 (framing fix) because correct framing is required for the size-gate to be meaningful.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Verified `cyboflowPermissionIpcServer.ts:58` destructures `{ requestId, sessionId, toolName, input }` with no checks and feeds `input` directly into `JSON.stringify(input)` → `approvals.tool_input_json` (`approvalRouter.ts:218`); `zod` is already a `main/package.json:32` dependency, so the schema add is small and pairs naturally with B2.
- **Counterfactual:** If the socket path is hardened to 0o600 via B5 first AND the framing fix from B2 lands, the residual risk becomes minor enough to defer until a real exploit/regression appears.

---

### B4. Fix ApprovalRouter initialization ordering relative to cyboflowPermissionIpcServer.start()
- **Summary:** The IPC server starts listening before `ApprovalRouter.initialize()` runs, creating a window where a permission-request arriving at the socket throws `ApprovalRouter singleton not initialized`.
- **Source-Sprint:** SPRINT-006
- **Source:** FIND-SPRINT-006-14 (sprint-code-reviewer, TASK-301 + TASK-302).
- **Problem:** In `main/src/index.ts`, the startup order is: (1) `initializeServices()` awaited at line 680, which calls `cyboflowPermissionIpcServer.start()` at line 571 inside it — the socket is live and accepting connections here; (2) `createWindow()` awaited at line 682; (3) orchestrator wiring block at lines 686–717, which calls `ApprovalRouter.initialize(...)` at line 715. For the entire window between steps (1) and (3), the socket is listening but `ApprovalRouter.getInstance()` throws on the singleton not yet initialized (`approvalRouter.ts:129`). Any stale file descriptor from a previous unclean shutdown that connects and writes a permission-request during this window causes an unhandled exception path in `cyboflowPermissionIpcServer.ts:72`. The window is short and there is no spawner yet, but the invariant "socket live ⇒ ApprovalRouter ready" is violated by design.
- **Proposed direction:** Move `ApprovalRouter.initialize(db, runQueues.getOrCreate.bind(runQueues))` and the `RunQueueRegistry` instantiation into `initializeServices()`, before `cyboflowPermissionIpcServer.start()`. This preserves the invariant structurally rather than relying on a comment. Alternatively, add a lazy-initialize guard inside `CyboflowPermissionIpcServer.start()` that refuses to bind until `ApprovalRouter` is confirmed initialized — but relocating the init call is simpler. The task plan should include a startup-sequence integration test (or at minimum a manual smoke test with a pre-existing stale socket file) to confirm the ordering holds after the refactor.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed in `main/src/index.ts:571` (socket starts inside `initializeServices`) vs `:715` (ApprovalRouter.initialize after createWindow + orchestrator wiring) — `cyboflowPermissionIpcServer.ts:72` calls `ApprovalRouter.getInstance()` which throws on uninitialized singleton (`approvalRouter.ts:128-134`); window is small today but the invariant is structurally violated.
- **Counterfactual:** If the executor of an upcoming TASK-303/304 epic already plans to relocate ApprovalRouter init into `initializeServices`, this becomes a duplicate.

---

### B5. Chmod unix socket to 0o600 and socket directory to 0o700 after server.listen()
- **Summary:** The permission unix socket is created with default permissions (~0o755), allowing any process on the same machine to send permission-request messages that write to the `approvals` DB table.
- **Source-Sprint:** SPRINT-006
- **Source:** FIND-SPRINT-006-20 (sprint-code-reviewer, TASK-301 + TASK-302).
- **Problem:** `cyboflowPermissionIpcServer.ts` creates the socket at `~/.cyboflow/sockets/cyboflow-permissions-<pid>.sock` with default file permissions (typically 0o755 after umask). The `getCyboflowSubdirectory('sockets')` call creates the parent dir with `fs.mkdirSync(socketDir, { recursive: true })` which also defaults to 0o755. Any other process on the same local UID — or another user account with access to the home directory — can connect and submit a `permission-request` message. With `ApprovalRouter` (TASK-302) now persisting those requests to the `approvals` table and mutating `workflow_runs.status`, the socket is a DB write entry point. TASK-301 carried over Crystal's socket-creation pattern; TASK-302 raised the stakes without adding a chmod.
- **Proposed direction:** After `server.listen(this.socketPath, callback)` succeeds, call `fs.chmodSync(this.socketPath, 0o600)` inside the callback before `resolve()`. Also update the `getCyboflowSubdirectory('sockets')` directory creation to `fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 })`. Document this as the trusted-boundary contract in `docs/cyboflow_system_design.md` under the permission bridge section. Add a test that asserts the socket file stat mode after `server.start()`. Note potential cross-platform behavior on Linux (same fix needed) vs macOS.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Verified `cyboflowPermissionIpcServer.ts:22` creates the dir with no `mode` and `:110` calls `server.listen(this.socketPath, ...)` with no chmod follow-up; with TASK-302 the socket is now a DB-write entry point and a 3-line addition substantially narrows the local-attack surface.
- **Counterfactual:** If a future review confirms the socket dir is always created under 0o700-protected `~/.cyboflow/`, the residual risk could justify deferring chmod to a hardening pass.

---

### B6. Fix asarUnpack paths to match tsc output layout
- **Summary:** The `asarUnpack` entries in `package.json` point at `main/dist/services/…` but TypeScript emits to `main/dist/main/src/services/…`, so the unpack rules match zero files and the bridge scripts remain packed inside the asar at runtime.
- **Source-Sprint:** SPRINT-006
- **Source:** FIND-SPRINT-006-12 (TASK-301 code-reviewer), TASK-301 done report notes.
- **Problem:** `package.json:105-107` declares:
  ```
  "main/dist/services/cyboflowPermissionBridge.js",
  "main/dist/services/cyboflowPermissionBridgeStandalone.js",
  "main/dist/services/**/*.js"
  ```
  But `tsc` emits to `main/dist/main/src/services/…` (the `outDir` is `main/dist`, and the source paths under `main/src/` produce a `main/dist/main/src/` tree). The bridge scripts are therefore never unpacked; they remain inside the asar. Runtime impact is mitigated by the `claudeCodeManager.ts:698` detect-and-extract fallback, but that fallback path is a workaround for this misconfiguration, not intentional design. TASK-301 preserved the pre-existing wrong paths during the rename.
- **Proposed direction:** Verify the actual tsc output paths with `find main/dist -name 'cyboflowPermissionBridge*'` after a clean `pnpm build:main`. Update `package.json` `asarUnpack` to the verified paths. Perform a packaged build (`pnpm build:mac:arm64` or equivalent) and confirm that the bridge script's `__dirname` resolves into `app.asar.unpacked/…` rather than triggering the temp-extraction path. If the correct paths are `main/dist/main/src/services/…`, also evaluate whether the wildcard `main/dist/main/src/services/**/*.js` is overly broad (it would unpack all compiled service JS, not just the bridge). Document the asarUnpack convention in `docs/ARCHITECTURE.md`.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Verified by `find main/dist -name 'cyboflowPermissionBridge*'` — actual emitted paths are `main/dist/main/src/services/cyboflowPermissionBridge.js` (and `cyboflowPermissionBridgeStandalone.js`), while `package.json:105-107` asarUnpack entries reference `main/dist/services/…`; the asarUnpack rules currently match zero files and the temp-extract fallback at `claudeCodeManager.ts:698-722` exists only as a workaround.

---

### B7. Verify electron-store root package.json dep parity (or document why it is not needed)
- **Summary:** `electron-store` is declared in `main/package.json` but missing from root `package.json`, which is what electron-builder reads when assembling the asar — verify whether this causes a missing-module at runtime in packaged builds, and either add it or document why it is safe to omit.
- **Source-Sprint:** SPRINT-006
- **Source:** FIND-SPRINT-006-1 (TASK-251 code-reviewer).
- **Problem:** TASK-251's plan rationale states that "the root list is what electron-builder reads when assembling `node_modules/**/*` into the asar." The same logic applied to `trpc-electron`, `p-queue`, and `superjson` prompted TASK-251 to add all six packages to both `main/package.json` and root `package.json`. But `electron-store` pre-dated TASK-251 and was never added to root. If the TASK-251 parity rationale is correct, packaged builds could fail to resolve `electron-store` at runtime. However, `npmRebuild: true` / `buildDependenciesFromSource: false` in `package.json:99-100` and pnpm workspace hoisting may already pull it — the behavior depends on electron-builder's dep-resolution strategy for pnpm workspaces.
- **Proposed direction:** Build a packaged binary and launch it to confirm `require('electron-store')` resolves. If it resolves: add a comment in `package.json` explaining the parity exception (so TASK-N+1 doesn't repeat the same question), and remove the parity claim from future task plan templates for this project. If it does not resolve: add `"electron-store": "^11.0.0"` to root `dependencies`. Either way, close the finding with a documented decision.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Verified `electron-store@^11.0.0` is at `main/package.json:26` and absent from root `package.json` `dependencies` (which lists trpc-electron, p-queue, superjson but not electron-store); TASK-251's plan rationale explicitly relied on the root-list-for-asar mechanism, so the parity gap is either a real packaging bug or a documentation gap — either way the resolution is short.

---

### B8. Eliminate dual-implementation drift between build-cyboflow-permission-bridge.js and cyboflowPermissionBridge.ts
- **Summary:** The standalone JS build script and the TypeScript source implement two separate MCP bridge variants that can silently diverge; bundle the TS source via esbuild at build time to make them one.
- **Source-Sprint:** SPRINT-006
- **Source:** FIND-SPRINT-006-23 (sprint-code-reviewer, TASK-301).
- **Problem:** `main/build-cyboflow-permission-bridge.js` is a 275-line near-verbatim copy of the pre-rename `build-mcp-bridge.js` that embeds a hand-rolled `SimpleMCPServer` implementing minimal JSON-RPC. `main/src/services/cyboflowPermissionBridge.ts` is the "real" TypeScript implementation using `@modelcontextprotocol/sdk Server`. They handle the same protocol but differ in: (a) the standalone JS correctly buffers and splits on newlines (`SimpleMCPServer.processBuffer:108`), while the TS source does a single `JSON.parse(data.toString())` per data event (the framing bug in B2); (b) protocol negotiation is handled manually in the JS and via `Server.connect(transport)` in the TS. TASK-301 synchronized only identifier names — no task validates behavioral equivalence. Both implementations exist in production and can diverge further with each sprint.
- **Proposed direction:** Add an esbuild (or rollup) bundle step to `main/package.json` that compiles `main/src/services/cyboflowPermissionBridge.ts` into `main/dist/main/src/services/cyboflowPermissionBridge.js` (the same path as the corrected asarUnpack in B6 would expect). The build script `build-cyboflow-permission-bridge.js` would then be retired. `claudeCodeManager.ts` already references the standalone build script path for the `--permission-prompt-tool` MCP server — the path reference just needs to point at the bundled output instead. This also eliminates the `SimpleMCPServer` class, which is a maintenance liability. Dependency: B2 (framing fix) should land in the TS source before this task bundles it, so the standalone output inherits the fix.
- **Scope:** medium

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** low
- **Reasoning:** The dual-implementation has existed since the Crystal fork (`main/build-cyboflow-permission-bridge.js:86 SimpleMCPServer`) with no concrete drift-induced bug across multiple sprints; B2 addresses the one material divergence (framing) and the medium-scope build-system change (esbuild + retire the standalone script + repoint `claudeCodeManager.ts:675`) is disproportionate to a hypothetical future drift.
- **Counterfactual:** If a subsequent sprint surfaces a concrete behavioral mismatch between the standalone and TS bridges (beyond the framing in B2), this becomes worth doing.

---

### B9. Document and gate the transitional sessionId / runId / tool_use_id identity conflation
- **Summary:** The sprint wires three distinct identifier concepts — the bridge's `sessionId` argv, `ApprovalRouter`'s `runId`, and Claude's `tool_use_id` — as if they are the same value, producing synthesized UUIDs in the DB that will misbehave when TASK-304 wires the real `tool_use_id`.
- **Source-Sprint:** SPRINT-006
- **Source:** FIND-SPRINT-006-19 (sprint-code-reviewer, TASK-301 + TASK-302).
- **Problem:** `cyboflowPermissionIpcServer.ts:54-58` has a TODO acknowledging that `sessionId` is passed directly as the `runId` to `ApprovalRouter.requestApproval()`. `approvalRouter.ts:200` uses the freshly-generated `approvalId` for both `approvals.id` (PK) and `approvals.tool_use_id` (intended to hold Claude's real tool_use_id). This means: (1) the DB `approvals.tool_use_id` column holds a synthesized UUID, not Claude's tool_use_id; (2) when TASK-304 wires the real `tool_use_id`, rows inserted during this transitional window will have mismatched `tool_use_id` values; (3) any query that joins `approvals` on `tool_use_id` will misbehave on those rows. The conflation is a known cross-task gap — the issue is that it is not documented anywhere outside the TODO comments themselves, and there is no schema migration plan.
- **Proposed direction:** Before TASK-303/304 land, add a subsection to `docs/ARCHITECTURE.md` §Orchestrator documenting the three identifiers and their current mapping contract ("until TASK-304: bridge passes sessionId as runId; approvals.tool_use_id is synthesized from approvalId"). Add inline invariant comments at `cyboflowPermissionIpcServer.ts:58` and `approvalRouter.ts:200` that reference the ARCHITECTURE.md section. When TASK-304 wires the real tool_use_id, include a migration step that backfills or clears stale rows so synthesized IDs do not cause join mismatches. This is primarily a documentation + migration-planning task rather than a code change.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** low
- **Reasoning:** The transitional invariant is already captured by inline TODOs at `cyboflowPermissionIpcServer.ts:54-57` and `approvalRouter.ts:215-217` (`tool_use_id is NOT NULL... until TASK-304`); TASK-304's plan is already in `.soloflow/active/plans/approval-router-and-permission-fix/` and will own the migration concern at refinement time — adding a parallel ARCHITECTURE.md subsection for a transitional state risks doc drift once TASK-304 lands.
- **Counterfactual:** If TASK-304's plan is revealed to lack a backfill/migration step at refinement time, the migration-planning portion of B9 becomes worth doing as a TASK-304 amendment.

---

### B10. Resolve unused `eventBus` in OrchestratorDeps — wire it or drop it
- **Summary:** `OrchestratorDeps.eventBus: EventEmitter` was added by TASK-253 but no code reads or writes it; TASK-254's events router and TASK-302's ApprovalRouter both bypass it — decide whether to wire it for real or drop it until a real consumer arrives.
- **Source-Sprint:** SPRINT-006
- **Source:** FIND-SPRINT-006-18 (sprint-code-reviewer, TASK-253 + TASK-254 + TASK-302).
- **Problem:** `main/src/orchestrator/types.ts:59` declares `eventBus: EventEmitter` in `OrchestratorDeps`. `main/src/index.ts:705` instantiates `new EventEmitter()` for it. But: `Orchestrator.ts` only uses `deps.logger` and `deps.runQueues` — no `this.deps.eventBus` reference exists. `ApprovalRouter` extends `EventEmitter` itself and emits `approvalCreated` on the router instance, not on the shared eventBus. The `eventsRouter` (TASK-254) uses `makePlaceholderAsyncIterator`, which ignores the eventBus. The eventBus was intended as the cross-component event spine but was wired into `OrchestratorDeps` before any consumer existed. Future maintainers reading the code assume a publish/subscribe system exists when it does not.
- **Proposed direction:** Two valid paths: (a) Wire it now — have `ApprovalRouter.requestApproval()` emit `approvalCreated` on the shared `eventBus` AND have the `eventsRouter.onApprovalCreated` subscription consume from it via an `EventEmitter`-backed async iterator. This completes the design intent and is likely needed in the stream-parser-to-main epic anyway. (b) Drop `eventBus` from `OrchestratorDeps` for now — remove the field from `types.ts`, the constructor in `Orchestrator.ts`, the test harness in `Orchestrator.test.ts`, and the `new EventEmitter()` instantiation in `index.ts`. Whichever path is chosen, document the outcome in `docs/ARCHITECTURE.md` §Orchestrator. The task refiner should confirm which path aligns with the stream-parser-to-main epic's design before writing code.
- **Scope:** small (path b) to medium (path a)

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed zero consumers: `eventBus` lives in `types.ts:59` and is instantiated at `index.ts:705` but no `deps.eventBus` access exists anywhere in `main/src/orchestrator`; `approvalRouter.ts:232` emits `approvalCreated` on the router itself, not the shared bus — the speculative wiring is real and the refinement decision (wire vs drop) genuinely needs to be made before stream-parser-to-main lands.
- **Counterfactual:** If the stream-parser-to-main epic's plan already specifies how `eventBus` will be wired, this task collapses into a "wait for that epic" note.

---

## C. CLAUDE.md / CODE-PATTERNS.md improvements (apply now)

### C1. Add native module rebuild note for better-sqlite3 ABI mismatch to CLAUDE.md
- **Summary:** Add a one-line note to CLAUDE.md's Common Commands pointing at the existing `pnpm electron:rebuild` script for `better-sqlite3 NODE_MODULE_VERSION` mismatch errors — surfaced as a "pre-existing" failure in 4 consecutive task done reports.
- **Source-Sprint:** SPRINT-006
- **Target file:** `CLAUDE.md`
- **Action:** insert-after `pnpm test              # Playwright E2E`
- **Status:** ready
- **source_item:** C1
- **Rationale:** The project already has a `pnpm electron:rebuild` script (`package.json:46`) that runs `electron-rebuild -f -w better-sqlite3 -m ./main` — rebuilding against Electron's Node ABI, which is what's actually needed. The proposal's suggested `pnpm rebuild better-sqlite3` rebuilds against system Node and is wrong here. Agents hit a cryptic `NODE_MODULE_VERSION` binding error after Node/Electron version changes and have no documented recovery path; pointing at the existing script (rather than re-explaining the problem) earns its 2 lines.
- **Diff:**
  ```diff
  // CLAUDE.md — append to the Common Commands code block
   pnpm test              # Playwright E2E
  +pnpm electron:rebuild  # Fix better-sqlite3 NODE_MODULE_VERSION errors after Node/Electron upgrades
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** NODE_MODULE_VERSION recurs across TASK-253/254/255 done reports as "pre-existing" friction blocking 22 tests, and the existing `pnpm electron:rebuild` script (`package.json:46`) is the canonical fix; FIND-SPRINT-006-4's suggested `npm rebuild better-sqlite3` is actively wrong (rebuilds against system Node, not Electron ABI), so a 1-line nudge in Common Commands prevents future agents from copying that suggestion.
- **Counterfactual:** If FIND-SPRINT-006-4 surfaces no further within the next 1-2 sprints (e.g., after a Node/Electron version freeze), the line stops earning its attention cost.

---

## Reconciled Findings (informational)

The following findings had `status: open` in the findings file but are confirmed resolved by
executor commits during SPRINT-006. The sprint-closer's reconciliation step did not patch
these; they are recorded here for audit trail.

- **FIND-SPRINT-006-5** — claimed resolved by TASK-254 commit `6dcf088` (`fix(TASK-254): resolve require-yield ESLint error in makePlaceholderAsyncIterator`). `events.ts:48-58` confirms the function is now a plain `AsyncIterable<T>` return with a scoped `// eslint-disable-next-line require-yield` on the inner generator. The findings file still shows `status: open` and `resolved_by:` empty.
