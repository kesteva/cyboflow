# Permission-Mode Redesign — Implementation Plan

> Status: PROPOSAL (awaiting sign-off). Produced by a multi-agent design pass (4 parallel investigations → synthesis → 3 adversarial critics → reconciliation). Branch: falcon-ristra. Do not implement until the open questions in §9 are signed off.

---

# Implementation Plan: Session-Owned Live Permission Mode + Pure Gate Vehicle + Auto Prompting

## CHANGES FROM DRAFT (what the critiques changed)

1. **ROOT FIX — live mode read no longer keyed on `options.sessionId`.** All three critics' single highest defect: for every SDK flow/programmatic/lane step `sessionId === runId` (verified `runExecutor.ts:597-598`), so `SELECT … FROM sessions WHERE id=<runId>` returns no row and the hook silently falls to global default — defeating #1/#3 for the dominant case and *regressing* flows launched in `acceptEdits`/`dontAsk`. **Fix:** resolve the owning session UUID **once at spawn from the gate `runId` via the `workflow_runs → sessions` join** (immutable), capture it in the closure, and live-read only `agent_permission_mode` per call. One resolver, keyed on the run, used by both substrates.
2. **Chat gate drops the `?? run_id` fallback.** It re-introduced bug #4 (terminal flow → silent deny) and could *hijack a live flow run's gate* (running flow → chat turn flips it to `awaiting_review`). The chat branch now resolves to a guaranteed-minted `__quick__` sentinel only.
3. **`chat_run_id` is mint-on-read at the single gate-resolution chokepoint** (via an injected provider), not lazily at one IPC handler — closes the coverage gap across `startPanel` / `continuePanel` / `restartPanelWithHistory` / reopen (correctness MED-1, risk §5).
4. **`runs.setPermissionMode` re-routed through the shared session-mode chokepoint** (persist + `session-updated` emit + runtime mutate + interactive settings re-prime), and the **terminal-status guard is removed for the session write** so #4's chat-after-terminal-flow can change mode (completeness HIGH/MED, risk §3).
5. **`deriveLaneFromTaskDispatch` moves to the always-firing hook** (observe-only, top), not `canUseTool` — `canUseTool` only fires on a classifier `'ask'`, so lane derivation would still be missed for the common auto-allowed `Task` (correctness MED-2).
6. **New chat-during-active-flow guard** — the clean gate split structurally enables two concurrent `query()`s in one worktree; we reject a chat turn while the session's flow run is non-terminal (correctness/completeness MED-3).
7. **Slice 1 split into 1a (caller-first, permissive signature, gate green) → 1b (throw + signature tighten + ~35 test call-site edits in one commit).** The throw as originally sliced reds the gate (31 session-less calls in `workflowRegistry.test.ts`, plus `runLauncher.test.ts:272,318`) (risk §1).
8. **Token-exclusion query co-ships with the `session_id` stamp** (same commit), resolving the §8-vs-§9 ordering contradiction that would double-count every SDK quick turn (risk §2).
9. **Model-eligibility check moved inside the per-call hook** — live-switch to `auto` on an auto-unsupported model now routes through `ApprovalRouter` (treats like `default`) instead of deferring to a non-existent classifier (completeness LOW/MED).
10. **`AskUserQuestion` routed through `QuestionRouter` in ALL modes (including `dontAsk`)** is now an explicit, tested behavior change (today `dontAsk` uses the native path) (completeness MED).
11. **Per-run picker permanently sets the session mode** — accepted explicitly under #1; UI relabeled "session permission mode," `permission_mode_snapshot` demoted to a ladder-derived audit value that may diverge (completeness MED).
12. **Auto-pin blast radius smoke-tested** — pinning `permissionMode:'auto'` whenever `modelSupportsAutoMode` also affects non-PreToolUse-gated tools in `default`/`acceptEdits`; added a live-smoke case (risk §4).

VERIFIED-SOUND and kept unchanged: `canUseTool` works on the string-prompt path (confirmed in `sdk.mjs` — single-turn stdin closes only after the first result; `canUseTool ⊥ permissionPromptToolName` is the only mutual exclusion; `canUseTool + hooks` coexist); live DB read mid-call is race-free (synchronous better-sqlite3); the `getDbSession`-resolves discriminator is structurally correct on both substrates; Option B over Option A; `permission_mode_snapshot` kept as an audit column.

---

## 1. SUMMARY

Permission mode becomes a single source of truth on `sessions.agent_permission_mode`; `workflow_runs.permission_mode_snapshot` is demoted to a launch-time audit value, no longer read for execution. On the SDK substrate we replace the three spawn-captured `PreToolUse` hook variants with **one always-installed dynamic hook** plus an unconditional `canUseTool` callback. The hook resolves the **owning session once at spawn from the gate `runId`** (`workflow_runs → sessions` join — robust for both chat sentinels and flow runs, since `sessionId===runId` for flows) and **live-reads only `agent_permission_mode` on every tool call**. Because PreToolUse runs first in the CLI permission order, whenever the live mode is `default`/`acceptEdits`/`dontAsk` the hook emits a concrete decision that pre-empts the always-loaded native classifier; whenever it is `auto` the hook defers and the classifier runs, with its `'ask'` verdicts routed through the existing blocking `ApprovalRouter` via `canUseTool` (requirement #5). All four modes thus become live-switchable on the next tool call, inherited by Task sub-agents (requirement #3). The approval gate is decoupled from the overloaded `sessions.run_id` by a persistent, never-clobbered `sessions.chat_run_id` `__quick__` sentinel (Option B), mint-on-read at the gate-resolution chokepoint, giving chat turns a real `'running'` vehicle without resurrecting a finished flow (requirement #4). `createRun` is made to throw when session-less (caller-first then tighten), the SDK quick sentinel gets its `session_id` stamped (with a co-shipped token-scan exclusion to avoid double-counting), and every mode write lands on the session through one chokepoint (requirement #1, #2). The PTY substrate's `default↔acceptEdits` gate is already per-call-live; we repoint its lookup to the session and accept the `auto`/`dontAsk` boundary as next-spawn.

---

## 2. DATA MODEL

Two new migrations. Highest applied on `falcon-ristra` is `037_session_mcp_plugins.sql`. **Renumber landmine:** unmerged `visual-verify` (036/037) and the merged mcp-plugin renumber both churned this range — pick the next-free pair atomically against `main` HEAD at merge time; whoever lands second renumbers. Use `038`/`039` provisionally. **`039` is strictly idempotent** so a post-hoc renumber on a populated dev DB is harmless.

### `038_session_chat_run_id.sql` — the pure gate vehicle

```sql
-- 038_session_chat_run_id.sql
-- Persistent chat-sentinel gate vehicle. Independent of sessions.run_id (which
-- keeps pointing at the latest FLOW run for display/diff/close-out). Chat turns
-- gate on chat_run_id; flow steps gate on the flow run itself.
ALTER TABLE sessions ADD COLUMN chat_run_id TEXT;

-- Backfill: a session whose run_id ALREADY points at a __quick__ sentinel keeps
-- that sentinel as its chat vehicle. Flow-only / legacy sessions get NULL and a
-- sentinel is minted ON READ at the gate-resolution chokepoint on the next chat turn.
UPDATE sessions SET chat_run_id = run_id
  WHERE run_id IN (
    SELECT wr.id FROM workflow_runs wr
    JOIN workflows w ON w.id = wr.workflow_id
    WHERE w.name = '__quick__'
  );
```

(Nullable-`ALTER` precedent: 021/027/031.) Flow-hosted sessions intentionally remain NULL here (their `run_id` was overwritten at `runLauncher.ts:380`) — the mint-on-read path (§6) covers them.

### `039_backfill_run_session_id.sql` — session-invariant history cleanup

```sql
-- 039_backfill_run_session_id.sql
-- Idempotent. Re-run migration 019's recovery for workflow_runs that became NULL
-- after 019 (SDK quick sentinels created post-019 left session_id NULL by design).
-- Hard enforcement of the never-session-less invariant is the createRun throw
-- (slice 1b); this is best-effort history cleanup.
UPDATE workflow_runs
   SET session_id = (SELECT s.id FROM sessions s WHERE s.run_id = workflow_runs.id)
 WHERE session_id IS NULL
   AND EXISTS (SELECT 1 FROM sessions s WHERE s.run_id = workflow_runs.id);
```

Residual orphaned sentinels (session later hosted a flow → `sessions.run_id` overwritten, nothing points back) stay NULL — terminal/historical, excluded from the token scan (§7), inert. Not recovered.

### Column dispositions (no DDL change)

- **`workflow_runs.permission_mode_snapshot`** — **kept** as a launch-time audit value (stamped once from the frontmatter/global ladder at `createRun`, `workflowRegistry.ts:725`). All *execution* readers move off it (§3). **It may diverge from the session's actual mode** once §3e writes the picker's mode to the session — this is acceptable (audit-only; documented). Dropping it would churn `database.ts`, `getRunById`/`listRunsHandler` SELECTs, the row types, and `demoInsightsSeed.ts` for zero execution benefit; a later migration may drop it.
- **`sessions.agent_permission_mode`** (migration 021) — unchanged shape; becomes the sole execution authority.
- **`sessions.run_id`** — unchanged; retains its Role-D "latest flow run for display/diff/close-out" meaning.

---

## 3. MODE RESOLUTION — the single live path

**Source of truth:** `sessions.agent_permission_mode ?? configManager.getDefaultAgentPermissionMode()`.

### 3a. One shared resolver (keyed on the RUN, via the join)

```ts
export function resolveRunAgentPermissionMode(
  db: DatabaseLike,
  runId: string,
  globalDefault: PermissionMode = 'default',
): PermissionMode {
  const row = db.prepare(
    `SELECT s.agent_permission_mode AS m
       FROM workflow_runs r LEFT JOIN sessions s ON s.id = r.session_id
      WHERE r.id = ?`
  ).get(runId) as { m?: unknown } | undefined;
  return isPermissionMode(row?.m) ? row.m : globalDefault;
}
```

Standalone-typecheck-safe (imports only `DatabaseLike` + `isPermissionMode`). Keying on the **run** (not a bare `sessionId`) is correct for **both** entry shapes: chat (gate run = `chat_run_id` sentinel → `session_id` → host session) and flow (gate run = flow run → `session_id` → host session). This is the same join `mcpQueryHandler` adopts in §3c#3.

### 3b. SDK dynamic hook + canUseTool (resolve session once, live-read the mode)

`buildSdkOptions` is already called with the resolved gate `runId` (`claudeCodeManager.ts:551`). At spawn, **resolve the owning session UUID once** (immutable for the life of the run):

```ts
const ownerSessionId = db.prepare(
  'SELECT session_id FROM workflow_runs WHERE id = ?'
).get(gateRunId)?.session_id as string | undefined;
```

Capture `{ ownerSessionId, gateRunId, allowRules }` in the hook + `canUseTool` closures. Add `readLiveSessionMode()` = `SELECT agent_permission_mode FROM sessions WHERE id = <ownerSessionId>` `?? getDefaultAgentPermissionMode()`, called **once per hook invocation** and **once per `canUseTool` invocation**. (Do NOT trust `BaseHookInput.permission_mode`, `sdk.d.ts:127` — it reflects the SDK's own mode, not the session column.) Equivalent: call `resolveRunAgentPermissionMode(db, gateRunId, …)` per call — same result; the once-at-spawn UUID capture is the optimization (one join at spawn, a single-column read per call).

The **model-eligibility check is evaluated per call inside the hook** (not only at spawn): if the live mode is `auto` but `modelSupportsAutoMode` is false, the hook routes through `ApprovalRouter` (treat like `default`) instead of deferring — closing the §4 "degrades to prompt-everything" claim.

### 3c. The three flow-path readers → resolve from the session via the run

1. **`runExecutor.ts:1457`** (`buildOptionsOverrides`, threaded to both substrates): replace `run.permission_mode_snapshot` with `resolveRunAgentPermissionMode(this.db, runId, this.getDefaultAgentPermissionMode())`. Add a `getDefaultAgentPermissionMode?: () => PermissionMode` **thunk** to the constructor (`:475`) (plain function type preserves standalone-typecheck). Re-entered per turn for SDK orchestrated runs; per-*tool-call* freshness comes from the §3b hook.
2. **`defaultProgrammaticRunner.ts:114`**: compute in `RunExecutor.executeProgrammatic`, add `agentPermissionMode: PermissionMode` to `ProgrammaticRunContext` (`runExecutor.ts:183`), read `ctx.agentPermissionMode` at `:114`. `SpawnStepRunner` re-resolves per step rather than capturing at construction (`spawnStepRunner.ts:74`).
3. **`mcpQueryHandler.ts:2145`** (`resolveRunPermissionMode`, interactive shell-approval fast-path, per tool call): join the session, preserving the `null → conservative router gate` contract:
   ```sql
   SELECT s.agent_permission_mode AS m
     FROM workflow_runs r LEFT JOIN sessions s ON s.id = r.session_id
    WHERE r.id = ?
   ```
   `return isPermissionMode(m) ? m : null;`. **Add a test for the join-miss arm** (legacy sentinel whose `session_id` was never backfilled): confirm it cannot strand a `dontAsk`/`acceptEdits` session in prompt-everything beyond the first mint-on-read turn.

### 3d. `cyboflow.runs.setPermissionMode` → write the session through the shared chokepoint

`runs.ts:1041` currently `UPDATE workflow_runs SET permission_mode_snapshot`. **Re-route through the shared session-mode update chokepoint** (the extracted body of `sessions:update-agent-permission-mode`, `ipc/session.ts:1918-1967`) so all three side effects fire: persist, `sessionManager.emit('session-updated')`, runtime `session.agentPermissionMode` mutate, **and the interactive `.claude/settings.json` re-prime**. A raw `UPDATE sessions` would skip the pill refresh (the current `runStatusEvents('changed')` only refetches `runs.list`, not the session store) and the interactive next-spawn re-prime.

**Remove the terminal-status guard for the session write** (`runs.ts:1034`): mode is a session property; a terminal flow run must not block it (this is exactly the #4 chat-after-terminal-flow case). Resolve `session_id` from the run regardless of status; `noOp:'not_found'` only when no session resolves. This also fixes the risk-§3 `changes===0` conflation (NULL `session_id` ≠ terminal).

**Refactor:** extract `updateSessionAgentPermissionMode(deps, sessionId, mode)` as the single chokepoint; both the IPC handler and `runs.setPermissionMode` call it. **Preferred for the chat pill:** `ChatInput` calls `API.sessions.updateAgentPermissionMode` (resolving the session from `activeRun.session_id`) exactly like `QuickSessionComposer`, so the write path is identical for both hosts; `runs.setPermissionMode` remains for programmatic callers, re-pointed through the chokepoint.

### 3e. Launch-time per-run picker → writes the session (explicit semantic change)

In `runLauncher.launch`, when `requestedPermissionMode` is explicitly supplied, write it to the session via the §3d chokepoint before/at `createRun`. When omitted, **leave the session's mode untouched** (do not clobber an explicit session mode with the frontmatter/global ladder). **Accepted under #1:** launching a flow with an explicit mode permanently sets the host session's mode (affecting later chat + later flows in that session). Relabel the picker UI from "per-run permission mode" to "session permission mode." `createRun` still stamps `permission_mode_snapshot` from the ladder (audit-only; may diverge — documented).

---

## 4. LIVE PROPAGATION

**Mechanism (SDK):** `composeHookOptions` (`claudeCodeManager.ts:1157-1176`) is rewritten to **always install one `PreToolUse` hook** (drop the `dontAsk` early-`return {}` at `:1160` and the `auto`/`default` fork at `:1166-1169`). The new `makeDynamicPreToolUseHook` (merging `makePreToolUseHook` `:1238-1275` + `makeAutoModePreToolUseHook` `:1194-1210`) does, per call:

0. **`deriveLaneFromTaskDispatch(gateRunId, …)`** — observe-only, BEFORE the mode branch, so lane derivation fires for `Task` dispatches in **every** mode including auto-defer (it cannot live in `canUseTool`, which only fires on a classifier `'ask'`).
1. `mode = readLiveSessionMode()`.
2. `AskUserQuestion` → `routeAskUserQuestion` (`:1287-1323`) in **all** modes (intentional change — see below).
3. branch on the freshly-read `mode`:
   - `dontAsk` → `{ hookSpecificOutput: { hookEventName:'PreToolUse', permissionDecision:'allow' } }`.
   - `acceptEdits` → edit-tool fast-allow (`:1250-1260`) → allowlist (`:1265-1272`) → `routePreToolUseThroughApprovalRouter`.
   - `default` → allowlist → `routePreToolUseThroughApprovalRouter`.
   - `auto` **and** model supports auto → emit **empty** `PreToolUse` output → defer to the native classifier.
   - `auto` **but** model does NOT support auto → allowlist → `routePreToolUseThroughApprovalRouter` (no classifier exists to defer to).

**Why every direction is live:** PreToolUse hooks run *first* in the CLI permission order (`:1183-1184`). For `default`/`acceptEdits`/`dontAsk` the hook emits a concrete decision that **pre-empts the always-loaded classifier** even though `permissionMode:'auto'` stays pinned. For `auto` the hook defers and the classifier runs. So entering/leaving every mode takes effect on the next tool call with **no re-spawn**. `buildSdkOptions` (`:895-945`) sets `sdkOptions.permissionMode='auto'` **whenever `modelSupportsAutoMode`** (`:54-83`).

**`AskUserQuestion` in all modes (intentional change).** Today `dontAsk` installs no hook, so `AskUserQuestion` uses the SDK's native handler. The always-on hook now routes it through `QuestionRouter` in `dontAsk` too. This is deliberate: `AskUserQuestion` is the agent's *content* question, not a permission prompt — suppressing it would strand the agent. Documented + tested as intentional.

**Sub-agents (requirement #3) — inherited automatically.** `PreToolUseHookInput` extends `BaseHookInput`, which carries `agent_id`/`agent_type` "Present only when the hook fires from within a subagent" (`sdk.d.ts:128-135`). `canUseTool` receives `options.agentID` for sub-agent calls (`sdk.d.ts:195-196`). cyboflow sub-agents are file-based; `renderAgentMarkdown` never emits `permissionMode` (`agentMarkdown.ts:41-47`) and no `agents:` option is passed, so no sub-agent carries a static override the parent's live hook can't pre-empt. Same `query()` ⇒ same `gateRunId`/`ownerSessionId` ⇒ same live mode + same `ApprovalRouter`. (With the §1 root fix, sub-agents now correctly read the host session mode, not global default.)

**Honest residual limits:**
1. **Granularity is "next tool call," not "this tool call."** A tool already awaiting an `ApprovalRouter` verdict is governed by the verdict already requested.
2. **Grandchild OS processes of an approved `Bash` call** are gated once at the `Bash` call, never per-syscall. Unchanged.
3. **SDK `auto` on an auto-unsupported model** can't load the classifier; the hook routes such calls through `ApprovalRouter` (prompt via the gate) — encoded per-call inside the hook (§3b), mirroring `resolveEffectiveSdkMode` (`:1125-1134`).
4. **PTY `auto`/`dontAsk` boundary is next-spawn.** The wildcard hook + `--permission-mode auto` argv are baked into `.claude/settings.json` + argv at launch (`interactiveClaudeManager.ts:471-473`, `:772-773`); `claude` reads them only at spawn. PTY `default↔acceptEdits` is per-call-live once the lookup is repointed (§3c#3). Out of scope for v1; documented.
5. **Interactive orchestrated flows** hold one pending spawn across turns → mode change applies on REPL restart, not mid-turn. Known interactive limitation.
6. **Live `setModel` / native `setPermissionMode`** stay next-spawn (streaming-input, deliberately not adopted).

**Auto-pin blast radius (new, from risk §4).** Pinning `permissionMode:'auto'` whenever `modelSupportsAutoMode` also routes **non-PreToolUse-gated tools** (some MCP/built-ins) through the classifier in `default`/`acceptEdits`, where today they follow the SDK's non-auto default eval. The hook pre-empts only tools that fire PreToolUse. This is a real behavior delta for non-hooked tools — **must be live-smoked** (§10), not just unit-tested.

**Why NOT streaming-input mode:** `query()`'s string-prompt arm (`:682`) forecloses the *send*-side control methods, but cyboflow's permission semantics live in the hook + `ApprovalRouter`, not the SDK's native `permissionMode`. `setPermissionMode` would only toggle the native layer, not route through `ApprovalRouter`. The dynamic hook *is* the gate and runs per call. Reserve streaming-input for a future live-`setModel` requirement only.

---

## 5. AUTO-MODE PROMPTING (requirement #5)

**Confirmed in `sdk.mjs`:** `canUseTool` is host-receiving (invoked from `processControlRequest` on an inbound `can_use_tool` control_request) and is wired into the `Query` constructor in **both** the string and async-iterable prompt paths; the transport is always `--input-format stream-json`, `hasBidirectionalNeeds()` is already true (cyboflow installs `hooks`), and a single-turn query's stdin closes only *after the first result* — after all tool calls. So `canUseTool` works on the **current string-prompt path with zero prompt-delivery refactor**. The only runtime mutual exclusion is `canUseTool ⊥ permissionPromptToolName`; `canUseTool + hooks` coexist.

**Division of labor (keep both).** The hook is the per-call gate for hook-decided modes, the allowlist, lane derivation, and `AskUserQuestion`; `canUseTool` is the terminal `'ask'` sink. SDK precedence (`sdk.d.ts:3199-3200`): static rules → **PreToolUse hook** → permission-mode eval (the **auto classifier**, only when `permissionMode:'auto'`) → if resolved verdict is `'ask'`, SDK issues `can_use_tool` → **`canUseTool`**. So:

- `default`/`acceptEdits`/`dontAsk`: hook returns a concrete decision ⇒ `canUseTool` never reached ⇒ no double-prompt.
- `auto`: hook defers ⇒ classifier runs: `allow` proceeds; `deny` arrives as a `system/permission_denied` message folded **non-blocking** by `maybeFoldAutoDenyVisibility` (`:816-889`, unchanged); **`ask` → `canUseTool` → blocking `ApprovalRouter`** (previously `throw Error("canUseTool callback is not provided.")`).

**Wiring.** Provide `canUseTool` **unconditionally** on every SDK spawn (inert in hook-decided modes). It mirrors `routePreToolUseThroughApprovalRouter` (`preToolUseHookHelper.ts:55-91`), reading the live session mode and mapping `ApprovalDecision` (`shared/types/approval.ts:34-38`) → `PermissionResult` (`sdk.d.ts:1858-1870`):

```ts
canUseTool: async (toolName, input, _opts) => {
  // Defense-in-depth: honor the user/project allowlist even on the auto path.
  if (isToolAllowed(toolName, input, allowRules)) return { behavior: 'allow' };
  try {
    const d = await ApprovalRouter.getInstance()
      .requestApproval(gateRunId, toolName, input, () => {}); // socketReply no-op on SDK path
    return d.behavior === 'allow'
      ? { behavior: 'allow', ...(d.updatedInput ? { updatedInput: d.updatedInput } : {}) }
      : { behavior: 'deny', message: d.message ?? 'Denied by reviewer' };
  } catch (e) {
    if (e instanceof RunNotRunningError) return { behavior: 'deny', message: 'Run not active' };
    throw e;
  }
}
```

Notes: `toolUseID` is SDK-stamped; `deny.message` is mandatory; do **not** set `interrupt` (let the agent retry, matching the hook deny path). **Hard constraint:** `canUseTool ⊥ permissionPromptToolName` (runtime throws). cyboflow sets the latter nowhere (grep = 0) — add a guard comment. `deriveLaneFromTaskDispatch` is **NOT** here — it lives in the always-firing hook (§4 step 0), because the auto classifier normally `allow`s a benign `Task` dispatch so `canUseTool` would never fire for it. The `status='running'` gate dependency is shared with the hook path (§6) — sequence this slice after the gate vehicle.

---

## 6. GATE VEHICLE — Option B (persistent chat sentinel)

**Chosen: Option B over Option A.** Option A (re-pointing `sessions.run_id`) destroys Role D — the resting-view diff (`RunDiffTabPanel` → `runs.ts:1190` `base_sha`), `useLifecycleSession.ts:26`, recovery linkage — and churns `run_id` on every first-chat-after-flow, racing close-out. Option B splits the two roles cleanly, matching the user's model.

**The bug is temporal:** `sessions.run_id` carries Role D (latest flow run, display/diff/close-out) and Role G (a running gate for the next turn). They coincide only because `runLauncher.ts:379-381` overwrites `run_id`; once that flow goes terminal, a chat turn resolves `runId` = terminal flow run, `reviveQuickRunToRunning` no-ops (JOIN requires `w.name='__quick__'`), and `ApprovalRouter`'s guarded `UPDATE … WHERE status='running'` (`approvalRouter.ts:292-296`) matches 0 rows → `RunNotRunningError` → silent deny.

**Design:** `sessions.chat_run_id` = a dedicated, persistent `__quick__` sentinel, **never clobbered** by `runLauncher`. `sessions.run_id` keeps Role D. Chat turns gate on `chat_run_id`; flow steps gate on the flow run.

### Distinguishing chat-turn vs flow-execution at the spawn seam (no new flag)

The discriminator: **does `getDbSession(options.sessionId)` resolve a real session row?** — verified correct on **both** substrates because the RunExecutor invariant `sessionId===runId` (`runExecutor.ts:597-598`) is substrate-agnostic (the facade passes `sessionId=runId` to the SDK manager AND the interactive manager for flow steps):
- **FLOW step:** `panelId === sessionId === runId`; `getDbSession(runId)` returns **undefined** ⇒ gate on `panelId` = the flow run (which IS `'running'` during execution) ⇒ flow pauses. Byte-identical to today.
- **CHAT turn:** real session UUID as `sessionId` ⇒ `getDbSession` resolves ⇒ gate on the chat sentinel.

### Mint-on-read at the single gate-resolution chokepoint (covers all chat entry points)

The chat branch resolves to a **guaranteed-non-NULL** `chat_run_id`. Because chat spawns funnel through `startPanel` / `continuePanel` / `restartPanelWithHistory` / reopen — all reaching `spawnCliProcess` — minting at one IPC handler would miss first-turn/reopen. Instead inject a **`chatSentinelProvider(sessionId): string`** (mints a `__quick__` sentinel via `ensureQuickWorkflow` + `createRun(sessionId)` and persists `chat_run_id` if NULL; returns the existing one otherwise) and call it **once in the gate resolution**. This keeps `workflowRegistry` ownership at the orchestrator layer (the provider is constructed there and injected into the manager) while covering every chat entry point at a single point. The minted row **MUST** be a `__quick__` workflow run (asserted in tests) so `reviveQuickRunToRunning`'s JOIN guard (`transitions.ts:205-217`) matches.

`claudeCodeManager.ts:484-485` becomes:
```ts
const sessionRow = this.sessionManager.getDbSession(sessionId);
const gateRunId = sessionRow
  ? this.chatSentinelProvider(sessionId)   // chat turn — guaranteed __quick__ sentinel, minted-on-read
  : panelId;                               // flow step — the flow run
```
**No `?? run_id` arm** (it re-introduced #4's silent deny for terminal flows and could hijack a *live* flow run's gate). The existing `reviveQuickRunToRunning(this.db, gateRunId)` at `:497` then flips the chat sentinel back to `'running'` unchanged; for a flow step `gateRunId === panelId === flow run` it no-ops.

The hook/`canUseTool` mode read resolves the owner session from `gateRunId` (§3b), so it is correct for both vehicles.

### Chat-during-active-flow guard (new — from MED-3)

The clean split structurally permits a chat sentinel `'running'` concurrently with a live flow run on the same worktree (two `query()`s writing the same files). The one-active guard (`runLauncher.ts:287-302`) only blocks a second *flow* and excludes sentinels. **Add a guard at the chat spawn seam:** reject (or queue) a chat turn while the session's `run_id` flow run is non-terminal. (Today's coupling via the shared `run_id` masked this; the split makes it explicit, so we guard it rather than regress.)

### PTY seam

`interactiveClaudeManager.ts:634` (CYBOFLOW_RUN_ID) and `:741` (pipeline) mirror the resolution. **Verified:** interactive flow steps also pass `sessionId=runId`, so `getDbSession(options.sessionId)` returns undefined for a flow ⇒ correct flow branch (no mis-route to `chat_run_id`):
```ts
const sessionRow = this.sessionManager.getDbSession(options.sessionId);
const runId = sessionRow
  ? this.chatSentinelProvider(options.sessionId)           // chat turn
  : (options.runId ?? panelId);                            // flow step
```
Then `handleShellApprovalRequest` (`mcpQueryHandler.ts:1946`) → `ApprovalRouter.requestApproval` (`:2019-2021`) gates on the chat sentinel.

### Role-G readers to repoint from `run_id` → `chat_run_id`

Leave Role-D readers on `run_id` (`useLifecycleSession.ts:26`, `DraggableProjectTreeView.tsx:893`, `RunRightRail.tsx:335-337`, `runRecovery.ts:190`). Move Role-G readers — each gets an explicit test (mis-classification silently breaks the resting-view diff/close-out, risk §4):
- `index.ts:1107` turn-end PTY rest filter → `dbSession.chat_run_id` vs `evt.runId`.
- `ipc/session.ts:983-984` `registerLivePanel(dbSession.chat_run_id, …)`.
- `ClaudePanel.tsx:45` `approvalRunId`, `:57-58` `interactiveRunId` → new serialized `chatRunId` field (add to `sessionManager.ts:235`).
- Interactive kill/end paths (`session.ts:719`, `project.ts:343`, `git.ts:72`) → key on `chat_run_id`.

`reviveQuickRunToRunning` clears `ended_at`/`error_message` on the chat sentinel (`transitions.ts:222-227`) — safe because Role-D (display/diff/close-out) reads `run_id`, a *distinct* run. This separation is load-bearing; the reader table above is the authority.

---

## 7. SESSION INVARIANT (requirement #2)

### 7a. createRun throws (sliced caller-first; see §8)

Add at the top of `createRun` (`workflowRegistry.ts:631`), after the workflow lookup, before `runProjectId` resolution:
```ts
if (!sessionId) {
  throw new Error('WorkflowRegistry.createRun: sessionId is required (run cannot be session-less)');
}
```
Once both callers pass it (Slice 1a), tighten `sessionId?: string` → `sessionId: string` (`:633`) and simplify `sessionId ?? null` → `sessionId` (`:728`) (Slice 1b).

### 7b. Caller A — quick sentinel (`ipc/session.ts:439`)

The session row is fully resolved at `:405-422` before the `createRun` call. Pass `session.id` instead of `undefined`:
```ts
const { runId, substrate: resolvedSubstrate } = cyboflow.workflowRegistry.createRun(
  sentinelWorkflowId, requestedSubstrate, session.id, requestedAgentMode,
);
```
Write `chat_run_id` alongside the existing `sessions.run_id` backfill (`:472`). The conditional interactive-only `session_id` stamp at `:491` becomes **dead** (createRun now stamps `session_id` for the SDK sentinel too) and is removed.

### 7c. Caller B — `runLauncher.launch` (`runLauncher.ts:321`)

The live legacy no-session branch (`:330-334` `createDeterministicWorktree`, guards at `:366`/`:380`) becomes unreachable. Tighten end-to-end (Slice 1b):
- `runs.start` input: `sessionId: z.string().min(1)` required (`runs.ts:784`).
- `runLauncher.launch`: `sessionId?: string` → `sessionId: string` (`:199`); delete the `createDeterministicWorktree` else-branch (`:332-334`); unwrap the `if (sessionId)` guards at `:330`/`:366`/`:380`.

All frontend launch surfaces thread a session via `ensureSessionForLaunch` (`WorkflowPicker`, `SessionStartWizard`, `useTaskRunLauncher`, `WorkflowEditorModal`, Insights-from-findings, sprint batches). **Verify before tightening:** the compound-from-findings and "ship"-flow launches (per MEMORY, live) thread a session. `cyboflow_create_sprint_batch` creates lane rows in the existing run (no `createRun`). Demo seed INSERTs `workflow_runs` directly (bypasses `createRun`, no `session_id` → NULL, never `__quick__`, never matched by the token scan). All safe.

### 7d. SDK-sentinel session_id + token reconciliation (co-shipped)

Stamping the SDK sentinel's `session_id` would make the whole-session meter double-count: `getSessionTokenUsage` (session_outputs) **and** `selectSessionRunTokenTotals` (raw_events `WHERE session_id`, `insightsQueries.ts:463`, **no workflow JOIN today**) both count SDK chat turns — disjoint today *only* because the SDK sentinel's `session_id` is NULL. **The exclusion query MUST land in the same commit as the stamp** (§8 Slice 1b) — otherwise the live meter double-counts every SDK quick turn:
```sql
SELECT r.id FROM workflow_runs r
JOIN workflows w ON w.id = r.workflow_id
WHERE r.session_id = ?
  AND NOT (w.name = '__quick__' AND r.substrate = 'sdk')
```
Interactive sentinels write no `session_outputs`, so they MUST stay counted via the run scan — hence the substrate discriminator.

Blast-radius of stamping (audited, all benign/desirable): `runLauncher.ts:296` one-active guard already excludes sentinels; `index.ts:1541` Dismiss-cancel becomes symmetric with interactive; `artifactLifecycle.ts:42` prune correctly includes the sentinel; `git.ts:137` filtered to `batch_id IS NOT NULL` (sentinels NULL) — unaffected.

### 7e. Pill display

`QuickSessionComposer` already reads `activeSession.agentPermissionMode` and persists via `API.sessions.updateAgentPermissionMode` — no change. `ChatInput.tsx:455` sources `currentMode` from the **host session** (resolve `activeRun.session_id` → session store `agentPermissionMode`) and **persists via `API.sessions.updateAgentPermissionMode`** (not `runs.setPermissionMode`), so both hosts read and write the identical chokepoint (§3d). Update the stale `permission_mode_snapshot — ISSUE #2` comments at `ChatInput.tsx:443` / `PermissionModePill.tsx:17`. Relabel the launch picker as "session permission mode" (§3e).

---

## 8. SLICING (ordered; each keeps the gate green and shippable)

> Sequencing: 1a (caller-first) keeps the gate green before the throw; 1b couples the throw + signature tighten + ~35 test-fixture edits + the token-exclusion query in ONE commit (the stamp and exclusion must co-ship). The gate vehicle (Slice 3) precedes auto-prompting (Slice 7) — `canUseTool` shares the `status='running'` gate dependency. The SDK dynamic hook (Slice 6) needs the Slice-3 `chat_run_id` and the Slice-1b sentinel `session_id` stamp (so the run→session join resolves for chat).

**Slice 1a — Callers pass a real `sessionId` (permissive signature, gate green).**
Goal: live callers comply before the throw; no test churn.
Files: `ipc/session.ts:439` (pass `session.id`; remove dead `:491` stamp), `runs.ts:784` (`sessionId` required at the tRPC boundary), `runLauncher.ts` (ensure a session is always threaded). Signature stays `sessionId?: string`.
Tests: `sessionQuickCreate.test.ts` (assert `createRunArgs[*][2] === session.id`; update removed-stamp assertions).

**Slice 1b — Tighten the invariant: createRun throws + signatures + token exclusion (one commit).**
Goal: hard #2 + double-count-safe stamp.
Files: `workflowRegistry.ts` (throw + `sessionId: string` + `sessionId` not `?? null`), `runLauncher.ts` (sig tighten, delete legacy worktree branch, unwrap guards), `shared/types/workflows.ts` (type tighten), `insightsQueries.ts:463` (exclude SDK `__quick__`), **all ~35 session-less test call sites** in `workflowRegistry.test.ts` and `runLauncher.test.ts:272,318`.
Tests: new unit `createRun(undefined)` throws; `runLauncher` launch-without-session throws; `insightsQueries.test.ts` SDK-sentinel-excluded / interactive-included cases.

**Slice 2 — History backfill migration.**
Goal: #2 cleanup (idempotent).
Files: new `039_backfill_run_session_id.sql`.
Tests: migration idempotence smoke.

**Slice 3 — Gate vehicle: `sessions.chat_run_id` + mint-on-read provider + chat-during-flow guard.**
Goal: pure gate vehicle; #4.
Files: new `038_session_chat_run_id.sql`; `chatSentinelProvider` (orchestrator layer, injected); `ipc/session.ts` (write `chat_run_id` at create); `claudeCodeManager.ts:484-485` + `interactiveClaudeManager.ts:634,741` (gate resolution via provider, **no `run_id` arm**); chat-during-active-flow guard; `sessionManager.ts:235` (serialize `chatRunId`); Role-G readers (`index.ts:1107`, `ipc/session.ts:983`, `ClaudePanel.tsx:45,57`, `session.ts:719`, `project.ts:343`, `git.ts:72`).
Tests: chat turn in a session with a terminal flow run resolves `gateRunId = chat_run_id` and `reviveQuickRunToRunning` returns `revived:true`; **assert the minted sentinel's workflow name is `__quick__`**; flow step (`sessionId===runId`) resolves `panelId`; mint-on-read fires for a `chat_run_id IS NULL` session before spawn; chat rejected while flow active; PTY flow-step gates on the flow run (not the sentinel).

**Slice 4 — Mode resolver + flow-path readers (PTY + RunExecutor + programmatic).**
Goal: session is the execution authority for non-SDK-hook paths; #1.
Files: new `resolveRunAgentPermissionMode` (keyed on run via join); `runExecutor.ts:1457,475,183` (resolver + thunk + ctx field); `defaultProgrammaticRunner.ts:114`; `spawnStepRunner.ts:74` (per-step re-resolve); `mcpQueryHandler.ts:2145` (join session).
Tests: per reader — session mode honored, NULL → global default / router-gate; **join-miss arm** (legacy sentinel) returns null→router-gate; programmatic ctx field.

**Slice 5 — Session-mode write chokepoint + `runs.setPermissionMode` + launch picker.**
Goal: all mode writes land on the session through one chokepoint; #1.
Files: extract `updateSessionAgentPermissionMode` from `ipc/session.ts:1918-1967`; `runs.ts:1014-1060` (re-route through it, **drop terminal guard for the session write**, `noOp:'not_found'` only when no session); `runLauncher.launch` (write `requestedPermissionMode` to session when supplied, untouched when omitted).
Tests: `setPermissionMode` updates `sessions.agent_permission_mode` + fires `session-updated` + interactive re-prime; works on a session whose flow run is terminal (#4); NULL `session_id` → `not_found` not `already_terminal`; launch with explicit mode writes session, without leaves it untouched.

**Slice 6 — SDK dynamic hook (live per-call mode, owner resolved from run).**
Goal: live switch on next tool call for all hook-decided modes; #1/#3 for SDK flows.
Files: `claudeCodeManager.ts` — rewrite `composeHookOptions` (always one hook), `makeDynamicPreToolUseHook` (resolve `ownerSessionId` once from `gateRunId`, live-read mode per call, model-eligibility per call, `deriveLaneFromTaskDispatch` at top), `readLiveSessionMode`, `buildSdkOptions` pins `permissionMode:'auto'` whenever `modelSupportsAutoMode`.
Tests: hook re-reads mode per call; `default→acceptEdits` flips edit auto-allow next call; `→dontAsk` returns allow; allowlist honored; **flow run (sessionId===runId) reads the HOST session mode via the join, not global default** (the §1 regression guard); `auto`-on-unsupported-model routes through ApprovalRouter; lane derivation fires in auto-defer; `AskUserQuestion` routed in all modes. (Mock `query()` iterator.)

**Slice 7 — `canUseTool` auto prompting (after 3 + 6).**
Goal: auto `'ask'` becomes a blocking prompt; #5.
Files: `claudeCodeManager.ts` — unconditional `canUseTool` in `buildSdkOptions`; `ApprovalDecision`→`PermissionResult` map; allowlist short-circuit; `RunNotRunningError`→deny; `permissionPromptToolName` guard comment.
Tests: classifier `'ask'` → ApprovalRouter → allow/deny/updatedInput mapping; deny path unchanged (`maybeFoldAutoDenyVisibility` still folds non-blocking); allowlisted tool short-circuits; `canUseTool` never reached in hook-decided modes.

**Slice 8 — Pill source/write + label + comment cleanup.**
Goal: UI reads + writes the session SoT; docs accurate.
Files: `ChatInput.tsx:455` (source from session), persist via `API.sessions.updateAgentPermissionMode`; `:443` + `PermissionModePill.tsx:17` (comments); launch picker relabel (§3e).
Tests: frontend vitest — ChatInput renders + persists session mode via the session mutation.

---

## 9. RISKS & OPEN QUESTIONS (riskiest first)

1. **`canUseTool` × native classifier coexistence in `auto` (highest).** The plan rests on the SDK firing `can_use_tool` for the classifier's `'ask'` while `permissionMode:'auto'` is pinned and a `PreToolUse` hook is installed. Evidenced from `sdk.mjs` + `sdk.d.ts:3199-3200` but the least-exercised combination today (it currently *throws*). **Must be live-smoked** on a real `auto` run before sign-off.
2. **Auto-pin blast radius in `default`/`acceptEdits` (new).** Pinning `permissionMode:'auto'` whenever `modelSupportsAutoMode` routes non-PreToolUse-gated tools through the classifier even in non-auto modes. **Live-smoke a `default`-mode run invoking a non-hooked tool** to confirm no behavior regression.
3. **Slice-1b test churn coupled with a runtime-affecting throw.** ~35 session-less test call sites + the throw + signature tighten + token exclusion are one commit. 1a (caller-first) ensures live paths comply first; the only red surface in 1b is mechanical test-fixture edits. Verify the full `pnpm test:unit` in the parent before merge.
4. **Mint-on-read ordering inside the gate seam.** The `chatSentinelProvider` MUST mint-and-persist `chat_run_id` *before* `getDbSession`/revive reads it in the same turn, and the minted row MUST be a `__quick__` workflow (else `reviveQuickRunToRunning` silently no-ops, swallowed at `claudeCodeManager.ts:505`). Asserted in Slice-3 tests.
5. **Migration renumber collision.** `038`/`039` collide with unmerged `visual-verify` (036/037) and the mcp-plugin renumber history. Diff the applied set on `main` HEAD at merge; `039` is idempotent so a post-hoc renumber is harmless.
6. **Role-G/Role-D reader misclassification.** Moving a Role-D reader to `chat_run_id` silently breaks the resting-view diff/close-out. The §6 table is the authority; each moved reader needs an explicit test.
7. **`reviveQuickRunToRunning` clears `ended_at`/`error_message` on the chat sentinel.** Safe because Role-D reads `run_id`, a distinct run. Verify no close-out path treats a revived chat sentinel as the active flow.
8. **Interactive orchestrated mode liveness is coarser** (REPL-restart granularity, §4 limit 5). **Open question for sign-off:** acceptable for v1? SDK gets next-tool-call; interactive gets next-REPL-spawn.
9. **PTY `auto`/`dontAsk` boundary stays next-spawn** (§4 limit 4). Confirm acceptable for v1.
10. **Open — "always allow this tool" affordance.** `canUseTool`'s `options.suggestions` (`sdk.d.ts:158-166`) enables it, but `ApprovalDecision` carries no `updatedPermissions`. Additive-later, out of scope.
11. **Open — should classifier-*denied* tools prompt instead of auto-deny?** Out of `canUseTool`'s reach (SDK never asks about a classifier deny); would require running `default` instead of `auto`. Confirm the current non-blocking fold is the desired UX.
12. **Open — per-run picker now permanently mutates session mode** (§3e). Confirm the relabeled UI semantics ("session permission mode") are acceptable.

---

## 10. TEST PLAN

`pnpm test:unit` is the AC gate. **Per MEMORY (`feedback_workflow_test_run_stall`): full suites (~110s) stall workflow/subagent Bash at ~180s — run TARGETED tests (`pnpm --filter main test <file>`) + per-workspace typecheck inside agents; run the full gate in the parent.** Run `pnpm rebuild better-sqlite3` before `pnpm --filter main test` to restore host-Node ABI (NMV 127 vs Electron 136).

**Unit (targeted, per slice):**
- 1a: `sessionQuickCreate.test.ts` arg + removed-stamp updates.
- 1b: `workflowRegistry` throw on session-less; `runLauncher` session-required; ~35 fixture edits; `insightsQueries.test.ts` SDK-excluded / interactive-included.
- 2: migration 039 idempotence.
- 3: gate-resolution (chat vs flow, no `run_id` arm); `reviveQuickRunToRunning` `revived:true` + **`__quick__` workflow assertion**; mint-on-read before spawn; chat-during-flow rejection; PTY flow-step gates on flow run; serialize `chatRunId`.
- 4: `resolveRunAgentPermissionMode` (session hit / NULL→default / **join-miss→router-gate**); `mcpQueryHandler.resolveRunPermissionMode` join; programmatic ctx field.
- 5: chokepoint write (persist + `session-updated` + interactive re-prime); terminal-flow session still writable (#4); NULL `session_id`→`not_found`; launch picker write/no-write.
- 6: hook per-call re-read, all branches, allowlist, AskUserQuestion in all modes, model-eligibility-per-call, lane derivation in auto-defer, **flow-run reads host session mode (not global default)**.
- 7: `canUseTool` mapping (allow/deny/updatedInput), `RunNotRunningError`→deny, allowlist short-circuit, deny-fold unchanged, never-reached in hook-decided modes.
- 8: frontend ChatInput/QuickSessionComposer pill source + session-mutation persist.

**Integration / live-smoke (manual, `pnpm dev`; `test:e2e` non-functional here):**
- #4: chat turn in a session whose flow run is terminal → a real blocking prompt (was silent-deny).
- #3: change mode mid-flow (default↔acceptEdits) → effect on the very next tool call; a Task sub-agent's tool call honors the parent's new mode.
- #5: `auto` run where the classifier escalates `'ask'` → blocking prompt via the review queue; classifier `deny` still folds non-blocking; classifier `allow` proceeds.
- Risk #2: a `default`-mode run invoking a non-PreToolUse-gated tool — confirm no behavior regression under the always-pinned `auto`.
- PTY: `default↔acceptEdits` live per call after lookup repoint; `auto`/`dontAsk` boundary is next-spawn (documented limit).
- Concurrency: confirm chat is rejected/queued while a flow run is active (new guard).

**Parity/regression:** schema-parity check covers `chat_run_id` / serialized `chatRunId`; run the full `pnpm test:unit` in the parent before sign-off.

Key files: `main/src/services/panels/claude/claudeCodeManager.ts` (`:484-485,551,895-945,1108-1176,1238-1275`), `interactiveClaudeManager.ts` (`:634,741`), `main/src/orchestrator/workflowRegistry.ts` (`:631,725`), `runLauncher.ts` (`:287-302,321-382`), `runExecutor.ts` (`:183,475,597-598,1457`), `defaultProgrammaticRunner.ts:114`, `spawnStepRunner.ts:74`, `approvalRouter.ts:232,292-296`, `preToolUseHookHelper.ts:55-91`, `main/src/orchestrator/mcpServer/mcpQueryHandler.ts:1946,2145`, `main/src/orchestrator/trpc/routers/runs.ts:784,1014-1060`, `main/src/ipc/session.ts:439,491,983,1918-1967`, `main/src/orchestrator/insightsQueries.ts:463`, `main/src/services/cyboflow/transitions.ts:204-227`, `main/src/database/migrations/038_session_chat_run_id.sql` + `039_backfill_run_session_id.sql`, `frontend/src/components/.../ChatInput.tsx` + `PermissionModePill.tsx` + `QuickSessionComposer.tsx`.
