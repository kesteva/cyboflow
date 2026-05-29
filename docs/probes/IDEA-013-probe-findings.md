# IDEA-013 probe findings — decision record (TASK-805)

**Status:** TEMPLATE / DRAFT — verdicts marked `TBD` are filled by running the probe kit in
`scratch/` (see `scratch/README.md`). Values marked `(planning estimate)` were observed during
the 2026-05-29 design workflow and MUST be re-confirmed on the exact `--settings`-isolated,
no-`-p` spawn config the future InteractiveClaudeManager uses.

This record resolves **Q1–Q4** and names, for each downstream slice **S1–S7**, the explicit
fallback its gating probe selects. The SDK substrate keeps shipping while these run, so blocking
the epic here is zero-cost.

---

## Q1–Q4 resolutions

| Q | Question | Resolution | Evidence |
|---|----------|------------|----------|
| **Q1** | Roll-our-own vs adopt Shannon? | **ROLL-OUR-OWN** behind a swappable `TranscriptSource` seam (a future `ShannonTranscriptSource` is a one-factory-branch swap). | Probe D — Shannon bridge "Planned, not started"; **Bun**+**tmux** runtime cost unacceptable for the 2026-06-15 deadline. `(planning estimate — re-confirm via fetch-shannon-status.sh)` |
| **Q2** | Do interactive PreToolUse hooks fire + block synchronously? | `TBD` — **gates whether a GATED interactive substrate ships at all.** | Probe A (5 sub-claims) + Probe A2. |
| **Q3** | Is the structured panel lost? | **NO** — preserved by tailing the transcript through a **normalizer**; coarser turn-level (not token-level) granularity. | Probe E (schema divergence). |
| **Q4** | How is completion detected? | Deterministic **turn-end signal** (`Stop hook` PRIMARY; `stop_hook_summary`+`turn_duration` markers SECONDARY) → EOF/`/exit` to PTY stdin → PTY exit as teardown CONSEQUENCE. | Probe C. |

---

## Probe results

### Probe A — interactive PreToolUse hook fires + blocks (gates S5 PRIMARY) — `TBD`
| Sub-claim | Verdict | Evidence |
|---|---|---|
| (a) fires for the MAIN session's own Bash call | `TBD` | hook log line for `Bash` |
| (b) `exit 2` / `permissionDecision:'deny'` BLOCKS synchronously | `TBD` | echo blocked |
| (c) hook subprocess can block for **minutes** (not 5–10s) | `TBD` | `PROBE_BLOCK_SECONDS=180`; note any hard cap |
| (d) inherits `CYBOFLOW_ORCH_SOCKET` from the PTY env | `TBD` | log `env_orch_socket` ≠ null |
| (e) `exit 2` vs JSON `permissionDecision` precedence | `TBD` | `PROBE_MODE=precedence` (docs: exit 2 wins) |

**KILL (any FAIL):** S5 takes the **native-TUI fallback** — no roll-our-own gating shipped; S7
substrate picker surfaces "approval routing unavailable" on the interactive (subscription) substrate.

### Probe A2 — subagent hook scope + AskUserQuestion (ship-gating) — `TBD`
- Hook fires for a **Task-subagent's** tool call? `TBD`.
  **KILL (if NOT):** ungated subagent tool calls are a **ship blocker** for subagent-spawning
  workflows (planner/sprint/compound) — S5/S7 must **restrict interactive selection** for those
  workflows OR **force-deny the Task tool**, not merely document it.
- **AskUserQuestion**: confirmed it has **no answer-injection channel** via a command hook
  (`updatedInput` is SDK-`HookJSONOutput`-only) → **native-TUI-only** v1 limit; no QuestionRouter
  wiring on the interactive substrate. `TBD (confirm)`.

### Probe B — session-id discovery + encodeCwd (gates S1/S2) — `TBD`
- `encodeCwd` live-verified example: `TBD` (e.g. `/Users/x/Developer/app` → `-Users-x-Developer-app`); non-ASCII case: `TBD`; **#19972** collision note recorded.
- `DISCOVERY_TIMEOUT_MS` from measured spawn→first-`.jsonl` delay: `TBD ms` (with margin).
- Session UUID is **filename-only** (`--session-id` ignored interactively, **#44607**): `TBD`.
- First physical line is **`file-history-snapshot`** with NO `cwd`; disambiguation binds on the
  first **cwd-bearing** line (NOT `system/init.cwd`, which never appears interactively): `TBD`.

### Probe C — how a no-`-p` turn ends (gates S3 completion) — `TBD`
- The **REPL** does NOT self-exit after a turn (returns to the prompt): `TBD`.
- NO `{type:'result'}` **result line** in the interactive transcript: `TBD`.
- Turn-end mechanism: **`Stop hook`** fires (PRIMARY) `TBD`; `system/stop_hook_summary` +
  `system/turn_duration` markers appear at turn end (SECONDARY) `TBD`.
- **hung-input** case distinguishes a finished turn from one waiting on input: `TBD`.

### Probe D — Shannon bridge status (gates Q1) — `TBD (re-confirm)`
- Bidirectional permission-gating bridge: **Planned / Implemented** `TBD`.
- Runtime deps still **Bun** + **tmux**: `TBD`. `@dexh/shannon-agent-sdk` Node/Electron build: `TBD`.
- → Q1 = **roll-our-own** behind the swappable `TranscriptSource` seam.

### Probe E — transcript-vs-wire `__unknown__` rate (HARD GATE, gates S2 normalizer) — `TBD`
- `__unknown__` rate on the exact spawn config: `TBD %` `(planning estimate: 45%+)`.
- Unmodeled top-level types: `last-prompt`, `mode`, `permission-mode`, `bridge-session`,
  `attachment`, `ai-title`, `file-history-snapshot`, `queue-operation` `(planning — re-confirm)`.
- Unmodeled `system` subtypes: `stop_hook_summary`, `turn_duration`, `local_command`,
  `bridge_status`, `api_error` `(planning — re-confirm)`.
- STRING-content `user` lines fail `userEventSchema`'s array requirement: `TBD`.
- **CONCLUSION:** a **normalizer** + **noise-filter** is **MANDATORY** for S2 (not optional drift patching).

### Probe F — interactive MCP load + report_step fires (S6) — `TBD (gated on IDEA-029 socket up)`
- `cyboflow_report_step` listed/callable from the MAIN interactive session: `TBD`.
- A **prompt-body-prepended** instruction actually CAUSES a `report_step` call (watch
  `cyboflow-backend-debug.log` for `handleReportStep`): `TBD`.
- **Fallback:** if the prepend is unreliable, S6 delivers instructions via a per-worktree instruction file.

### Probe G — socket round-trip incl. human-decision window (de-risks S5) — `TBD (gated on IDEA-029 socket up)`
- ApprovalRequest→verdict round-trip through the shell hook over a **multi-minute** human window
  via heartbeat; `claude` does not kill the hook; the held-open socket is not evicted: `TBD`.
- **Fallback:** if `claude` kills the hook or the socket is evicted mid-wait → Probe-A-fail native-TUI path.

### Probe H — parallel sessions on a real subscription (WHOLE-EPIC go/no-go) — `TBD`
- N≥4 **parallel** interactive sessions on a real Pro/Max plan: `TBD/N` completed; `TBD/N` saw
  **rate-limit**/usage-limit/throttle; any concurrency caps: `TBD`.
- Support article cited: **support.claude.com/articles/15036540** (blesses interactive terminal/IDE
  use; SILENT on automated/parallel/headless driving).
- **USER DECISION (dated, required):** `__________` — go / no-go / ship-as-**UNCONFIRMED**-assumption.
  (Human gate — cannot be satisfied by an automated assertion.)

---

## Per-slice fallback selection (S1–S7)

| Slice | Depends on probe | If PASS | If FAIL → fallback |
|-------|------------------|---------|--------------------|
| **S1** selection seam | B | proceed | n/a (pure plumbing) |
| **S2** normalizer | E (+ B for collision key) | ship normalizer per measured inventory | extend `schemas.ts` with a transcript-event union; if even that fails, escalate Q3 (xterm view primary) |
| **S3** completion | C | EOF/`/exit` on the turn-end signal | conservative quiescence-timeout + explicit user "turn done" affordance (documented reduced determinism) |
| **S5** gating | A (+ A2 subagent + G window) | shell-hook → socket → ApprovalRouter (PRIMARY) | **native-TUI fallback**; picker surfaces "approval routing unavailable"; AskUserQuestion native-TUI-only |
| **S6** step tracking | F | prompt-body prepend → `cyboflow_report_step` | per-worktree instruction file |
| **S7** picker/docs | A/A2/E/H | surface caveats + parity test | surface the degraded caveats prominently in the picker |

> **Note:** S4 (dispatch + facade) is not probe-gated; it is depends-on-MERGE of IDEA-029 TASK-799.

---

## How this was produced
Run the kit in `scratch/` (order A→A2→B→C→D→E→F→G→H per `scratch/README.md`), paste verdicts/
measurements above, then delete `/tmp/idea013-probe-hook.log` and any transient settings. The
`scratch/` artifacts are throwaway evidence-gatherers, excluded from the app build.
