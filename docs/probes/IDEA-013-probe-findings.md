# IDEA-013 probe findings — decision record (TASK-805)

**Status:** Probes **A, A2, B(encode), C, D, E** RESOLVED via a live interactive `claude` battery on
**2026-06-01** (sessions under `~/.claude/projects/-private-tmp-idea013-probe/`, driven through the
`docs/probes/scratch/` kit), and **Probe H = GO** (user sign-off 2026-06-01, on operator experience).
**Q1–Q4 are resolved and the whole-epic go/no-go is GO — the epic is greenlit.** The only remaining items
are non-gating sub-probes: **B-timing** (`DISCOVERY_TIMEOUT_MS`, a constant to calibrate during S2) and
**F/G** (validate the IDEA-029-dependent slices once that socket runtime exists).

## Q1–Q4 resolutions

| Q | Question | Resolution | Evidence |
|---|----------|------------|----------|
| **Q1** | Roll-our-own vs adopt Shannon? | **ROLL-OUR-OWN** behind a swappable `TranscriptSource` seam. | **Probe D (2026-06-01):** GOAL_PROGRESS.md — bridge "Planned", *"no shannon-mcp-bridge binary yet, no oRPC Unix-socket host server yet"*; requires **Bun**+**tmux**; no Node/Electron build of `@dexh/shannon-agent-sdk`. |
| **Q2** | Do interactive PreToolUse hooks fire + block synchronously? | **YES — RESOLVED.** Interactive hooks fire AND synchronously gate (deny blocks; holds for minutes; exit-2 precedence). **S5 ships its PRIMARY shell-hook gating; native-TUI fallback OFF the table.** | **Probe A (a–e) all PASS** (below). |
| **Q3** | Is the structured panel lost? | **NO** — preserved by tailing the transcript through a **mandatory normalizer**; coarser turn-level granularity. | **Probe E (canonical) 78.4% `__unknown__`** — `assistant` lines parse as modeled; noise types dropped by the normalizer + **noise-filter**. |
| **Q4** | How is completion detected? | **`Stop` hook PRIMARY** (fires deterministically at turn end) → EOF/`/exit` to PTY stdin → PTY exit as teardown CONSEQUENCE; `stop_hook_summary`+`turn_duration` markers SECONDARY. | **Probe C** — `Stop` fired in every session; **no `result` line**; turn-end markers present. |

## Probe results

### Probe A — interactive PreToolUse hook fires + blocks (gates S5 PRIMARY) — **PASS (all 5)**
| Sub-claim | Verdict | Evidence (2026-06-01) |
|---|---|---|
| (a) fires for the MAIN session's own Bash call | **PASS** | `event:PreToolUse, tool_name:Bash, parent_tool_use_id:null` (session `bd0aea1e`) |
| (b) deny BLOCKS synchronously | **PASS** | Claude: *"The command was blocked… `echo hello` never executed"*, reason `IDEA-013 probe deny` |
| (c) hook subprocess can block for **minutes** (not 5–10s) | **PASS** | Run with `PROBE_BLOCK_SECONDS=180` → Claude *"Cooked for 3m 7s"* then denied; no short kill-cap (`timeout:600` governs) |
| (d) inherits `CYBOFLOW_ORCH_SOCKET` from the PTY env | **PASS** | hook log: `env_orch_socket:"/tmp/idea013.sock"` (+ `CLAUDE_PROJECT_DIR`, `claudecode:1`) |
| (e) `exit 2` vs JSON `permissionDecision` precedence | **PASS** | `precedence` mode (allow-JSON **+** exit 2) → Claude blocked: *"returned an error … allow-JSON + exit 2"*; **exit 2 wins**, stderr fed to model |

**KILL not triggered.** S5 ships the shell-hook → `CYBOFLOW_ORCH_SOCKET` → ApprovalRouter PRIMARY path.

### Probe A2 — subagent hook scope + AskUserQuestion — **PASS (best case)**
- **Subagent: the PreToolUse hook FIRES for a subagent's tool call → gateable → NOT a ship-blocker.** `PreToolUse/Agent` launch (`18:06:21`) → nested `PreToolUse/Bash` for `echo from-subagent` (`18:06:23`); subagent ran (output `from-subagent`). **S5/S7 do NOT need to restrict planner/sprint/compound or force-deny the Task tool.**
  - **Attribution caveat (design note for S5/S6):** the subagent's Bash reported the **same `session_id`** as the parent with **`parent_tool_use_id:null`** — hooks fire for subagent tools but the payload does **not** tag them as a sub-session. The Task tool surfaces as `tool_name:"Agent"` (input keys `description/prompt/subagent_type`).
  - Minor: the subagent UI summary showed *"1 PostToolUse hook ran"* (only PreToolUse+Stop were configured) — our log confirms a **PreToolUse** fired, so gating holds; worth a glance but not blocking.
- **AskUserQuestion: native-TUI-only — CONFIRMED.** `PreToolUse/AskUserQuestion` fires (`tool_input_keys:["questions"]`, so it is gateable allow/deny), but with `allow` it rendered Claude's **native multiple-choice menu** in the REPL (*"Enter to select · ↑/↓ to navigate"*). A command hook has **no `updatedInput` channel** to inject the chosen answer → cyboflow's QuestionRouter does NOT wire on this substrate; documented v1 limit.

### Probe B — session-id discovery + encodeCwd (gates S1/S2) — PASS (encode) / `TBD` (timing)
- `encodeCwd` EXACT match: `[^a-zA-Z0-9]→-` (e.g. `/Users/.../.warp/...` → `-Users-...--warp-...`, double-dash for `/.`). **#19972** collision note recorded.
- Session UUID is **filename-only**; `--session-id` interactive behavior still `TBD` (#44607).
- First physical line is `last-prompt` (no `cwd`); the literal `file-history-snapshot`-first ordering varies by launch path. Disambiguation binds on the **first cwd-bearing line** (idx **4** observed), NOT `system/init.cwd` (never appears).
- **BONUS:** the PreToolUse hook stdin payload itself carries **`transcript_path` + `session_id` + `cwd`** — so when gating is ON, the session file is known directly from the hook (no tail-discovery race). Tail-discovery is only the fallback when gating is off.
- `DISCOVERY_TIMEOUT_MS` from measured spawn→first-`.jsonl` delay: `TBD ms` (run `probe-transcript.ts watch`).

### Probe C — how a no-`-p` turn ends (gates S3 completion) — **PASS**
- The **`Stop` hook fires** at turn end in interactive mode — confirmed across sessions (`bd0aea1e` +7s; `2f4c9bac` +184s after a 180s block; `efde13c6`). **PRIMARY turn-end signal for S3.**
- **No `{type:'result'}` result line** in any bare-REPL transcript (confirmed). `system/stop_hook_summary` + `system/turn_duration` markers present (SECONDARY signal).
- REPL self-exit / hung-input distinction: `TBD` (the `Stop` hook already gives a deterministic primary signal, so this is lower-priority).

### Probe D — Shannon bridge status (gates Q1) — **PASS (RESOLVED)**
- Bidirectional permission-gating bridge: **Planned**, not implemented (*"no `shannon-mcp-bridge` binary yet, no oRPC Unix-socket host server yet"*). Requires **Bun** + **tmux** (`#!/usr/bin/env bun`, `tmux 3.6a`). No Node/Electron `@dexh/shannon-agent-sdk` build documented. → **Q1 = roll-our-own** behind the swappable `TranscriptSource` seam. ✓

### Probe E — transcript-vs-wire `__unknown__` rate (HARD GATE, gates S2 normalizer) — **PASS**
- **Canonical (bare-REPL `efde13c6`, 2026-06-01): 78.4% `__unknown__`** (29/37). (Indicative agent-session sample was 55.2%.)
- Unmodeled top-level: `last-prompt`, `mode`, `permission-mode`, `bridge-session`, `attachment`, `file-history-snapshot`, `ai-title`. (`queue-operation`/`local_command`/`api_error` did not appear in this sample.)
- Unmodeled `system` subtypes: `stop_hook_summary`, `turn_duration`, `bridge_status`. **Every `system` line was an unmodeled subtype** (none of init/compact_boundary/hook_started/hook_response/status).
- `assistant` lines **parse as modeled** (panel-critical content survives). 2 STRING-content `user` lines fail `userEventSchema`'s array requirement. camelCase top-level `sessionId` present; `system/init` absent.
- `bridge-session`/`bridge_status` originate from the `/remote-control` launch path — a local-only launch may differ; the normalizer must drop **any** unmodeled type by default.
- **CONCLUSION:** a **normalizer** + **noise-filter** is **MANDATORY** for S2 (not optional drift patching). ✓

### Probe F — interactive MCP load + report_step fires (S6) — `TBD (gated on IDEA-029 socket up)`
- Run with `--mcp-config` injecting the cyboflow stdio entry once IDEA-029's socket runtime exists. **Fallback:** per-worktree instruction file if prompt-prepend is unreliable.

### Probe G — socket round-trip incl. human-decision window (de-risks S5) — `TBD (gated on IDEA-029 socket up)`
- Probe A(c) already proved the hook can block for minutes; G validates the full ApprovalRouter round-trip over the held-open socket once it exists. **Fallback:** native-TUI path (now unlikely, given Probe A passed).

### Probe H — parallel sessions on a real subscription (WHOLE-EPIC go/no-go) — **GO (user sign-off 2026-06-01)**
- Not run as a controlled harness measurement. **USER DECISION (2026-06-01): GO** — the user has, in practice,
  run **substantially more than 4 parallel** interactive `claude` sessions on their plan without hitting
  concurrency/rate-limit walls, so the "8 parallel agents on your subscription" value prop is accepted on
  **operator experience**.
- Caveat: support article **support.claude.com/articles/15036540** blesses interactive terminal/IDE use but is
  SILENT on automated/parallel driving, so this is a **knowingly-accepted product/business assumption**
  (experiential, not a measured rate-limit guarantee). The `probe-parallel.mjs` harness remains available to
  quantify if ever needed; the SDK substrate stays the fallback for heavy/automated load. Revisit only if
  parallel interactive runs hit usage-limit responses in real use.

## Bonus findings (resolve previously-"NOT documented" unknowns)

- **Hook env inheritance:** the hook subprocess inherits exported parent env (`CYBOFLOW_ORCH_SOCKET` came through), and `CLAUDE_PROJECT_DIR` + `CLAUDECODE=1` are set. (Was "implied, not explicit" — now confirmed.)
- **Hook payload carries `transcript_path`/`session_id`/`cwd`:** simplifies S2 discovery when gating is on.
- **Task tool name = `Agent`** (`subagent_type` input) — the exact name S5 would force-deny (not needed).
- **`permission_mode` observed: `auto`** in these sessions.

## Per-slice fallback selection (S1–S7)

| Slice | Gating probe | Outcome |
|-------|--------------|---------|
| **S1** selection seam | B | proceed (encodeCwd confirmed) |
| **S2** normalizer | E (+ B collision key) | **ship the mandatory normalizer + noise-filter** (78.4% unknown); drop unmodeled types; bind collision on first cwd-bearing line |
| **S3** completion | C | **`Stop` hook PRIMARY** (deterministic) → EOF→PTY teardown; `stop_hook_summary`/`turn_duration` SECONDARY; no `result` line |
| **S5** gating | A, A2 | **PRIMARY shell-hook → socket → ApprovalRouter SHIPS** (no native-TUI fallback). Subagents gateable (no workflow restriction). **AskUserQuestion native-TUI-only** (documented limit). |
| **S6** step tracking | F | `TBD` (IDEA-029 socket); prompt-body prepend, per-worktree-file fallback |
| **S7** picker/docs | A/A2/E/H | surface caveats: AskUserQuestion native-TUI-only, coarser turn-level streaming; **drop** "approval routing unavailable" (Probe A passed) unless H fails |

> S4 (dispatch + facade) is not probe-gated; depends-on-MERGE of IDEA-029 TASK-799.

## How this was produced
Live battery run 2026-06-01 via `docs/probes/scratch/` against a bare interactive `claude` in
`/private/tmp/idea013-probe` (hook log streamed to the orchestrating agent). Probes B-timing, F, G, H remain.
Cleanup: `rm -rf /tmp/idea013-probe /tmp/idea013-probe-hook.log /tmp/idea013.sock` when done.
