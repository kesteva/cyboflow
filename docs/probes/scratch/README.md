# IDEA-013 probe kit (TASK-805) — runbook

Throwaway empirical probes for the **dual-substrate Claude** epic. These artifacts are
deliberately under `docs/probes/scratch/` so they are **outside** the app build
(`main/tsconfig.json` scopes to `src/**` + `../shared/**`; nothing here is wired into
`package.json`/asar). Run them by hand against a **live installed `claude`** and a **real
Pro/Max subscription**, then record verdicts in `../IDEA-013-probe-findings.md`.

> Contract facts these scripts encode (from the Claude Code hooks/sessions docs, confirmed
> 2026-05-29): omit `matcher` to match ALL tools; `timeout` is in **seconds** (default 600);
> the PreToolUse hook stdin carries `transcript_path`/`session_id`/`cwd`; **exit 2 takes
> precedence** over stdout JSON; a **`Stop`** hook fires at turn end; `$CLAUDE_PROJECT_DIR`
> is exported to hooks and the parent env is inherited. The *unknowns* (subagent firing,
> cwd-encoding, `--session-id` interactive, env inheritance, hard timeout cap) are exactly
> what these probes measure.

## Prerequisites

```bash
claude --version          # interactive binary under test
node --version            # for the .mjs hooks/harness
npx tsx --version         # to run probe-transcript.ts (or: pnpm dlx tsx)
```

Run everything from the cyboflow repo root so `$CLAUDE_PROJECT_DIR` resolves to a tree that
contains `docs/probes/scratch/`. Pick a throwaway worktree as the probe cwd if you don't
want probe transcripts mixed into your normal project's `~/.claude/projects/` folder.

## Order of operations (each row links to a finding line)

| # | Probe | Command | Gates |
|---|-------|---------|-------|
| A  | Hook fires + blocks synchronously | see **Probe A** below | S5 PRIMARY / whole gating story |
| A2 | Subagent hook scope + AskUserQuestion | see **Probe A2** | S5/S7 subagent decision |
| B  | session-id discovery + encodeCwd | `npx tsx probe-transcript.ts watch <abs-cwd>` then `discover`/`encode` | S1/S2 |
| C  | REPL turn-end (no `result` line) | inspect `Stop` log + `classify` | S3 completion |
| D  | Shannon bridge status | `bash fetch-shannon-status.sh` | Q1 |
| E  | transcript-vs-wire `__unknown__` rate | `npx tsx probe-transcript.ts classify <jsonl>` | S2 normalizer |
| F  | interactive MCP load + report_step | (gated on IDEA-029 socket up — see note) | S6 |
| G  | socket round-trip incl. human window | (gated on IDEA-029 socket up — see note) | S5 timeout |
| H  | parallel sessions on a real plan | `node probe-parallel.mjs 4` | whole-epic go/no-go |

### Probe A — does an interactive PreToolUse hook fire + block?

1. Apply the probe settings WITHOUT polluting your live `.claude/`. Two safe options:
   - **`--settings` injection (preferred — also tests the S3 injection path):**
     ```bash
     export CYBOFLOW_ORCH_SOCKET=/tmp/idea013-probe.sock   # to test env inheritance
     export PROBE_BLOCK_SECONDS=0                            # raise to 180 for the long-block test
     export PROBE_MODE=deny-json                             # deny-json | allow-json | ask-json | exit2 | precedence
     claude --settings "$(cat docs/probes/scratch/settings.json)"
     ```
   - **transient local settings:** `cp docs/probes/scratch/settings.json .claude/settings.local.json`,
     run `claude`, then **delete it** afterwards. (`settings.local.json` is gitignored.)
2. In the session, ask: `Run the bash command: echo hello`.
3. Watch `tail -f /tmp/idea013-probe-hook.log` in another terminal. Record for each sub-claim:
   - **(a) fires for MAIN session** — a `PreToolUse`/`Bash` line appears in the log.
   - **(b) blocks synchronously** — with `PROBE_MODE=deny-json` the echo is **blocked** (Claude reports denial).
   - **(c) blocks for MINUTES** — re-run with `PROBE_BLOCK_SECONDS=180`; confirm Claude waits ~3 min (not killed at 5–10s). Note any hard cap.
   - **(d) inherits `CYBOFLOW_ORCH_SOCKET`** — the log's `env_orch_socket` field is the value you exported, not `null`.
   - **(e) exit-2-vs-JSON precedence** — run `PROBE_MODE=precedence` (emits an ALLOW JSON **and** exit 2). If the tool is **blocked**, exit 2 wins (matches docs); if it **runs**, JSON won.
4. **KILL:** any sub-claim FAIL ⇒ S5 ships the native-TUI fallback (no roll-our-own gating); S7 picker surfaces "approval routing unavailable".

### Probe A2 — subagent scope + AskUserQuestion

1. Same hook config. Ask Claude to **spawn a subagent** (Task tool) that runs a Bash command,
   e.g. `Use the Task tool to launch a subagent that runs: echo from-subagent`.
2. Inspect the log: does a `PreToolUse` line appear for the **subagent's** Bash call (look for a
   distinct `session_id`/`parent_tool_use_id`, or simply a second Bash entry)?
   - **KILL:** if NOT ⇒ ungated subagent tool calls are a **ship blocker** for subagent-spawning
     workflows (planner/sprint/compound). S5/S7 must restrict interactive selection for those
     OR force-deny the Task tool — not merely document it.
3. Ask a question that triggers **AskUserQuestion**. Confirm there is **no** field a command hook
   can return to inject the chosen answers (`updatedInput` is SDK-`HookJSONOutput`-only) ⇒ record
   AskUserQuestion as **native-TUI-only** on the interactive substrate.

### Probe B — session-id discovery + encodeCwd (uses probe-transcript.ts)

```bash
# 1. In terminal A, start the watcher BEFORE launching claude:
npx tsx docs/probes/scratch/probe-transcript.ts watch "$(pwd)"
# 2. In terminal B, launch interactive claude in that exact cwd and send one prompt.
# 3. The watcher prints the spawn->first-.jsonl delay  -> set DISCOVERY_TIMEOUT_MS (add margin).
# 4. Verify the cwd encoding and the discovered session file:
npx tsx docs/probes/scratch/probe-transcript.ts encode "$(pwd)"
npx tsx docs/probes/scratch/probe-transcript.ts discover "$(pwd)"
```
Confirm: the UUID is the **filename** (`--session-id` ignored interactively, #44607);
the first physical line is `file-history-snapshot` with **no** `cwd`, so disambiguation must
bind on the first **cwd-bearing** line (not `system/init.cwd`, which never appears interactively).

### Probe C — how a no-`-p` turn ends (uses the Stop log + classify)

After a turn completes in the Probe-A session, check the hook log for a `Stop` entry (PRIMARY
turn-end signal). Then classify the transcript and confirm there is **no** `{type:'result'}` line
and that `system/stop_hook_summary` + `system/turn_duration` markers appear at turn end (SECONDARY):
```bash
npx tsx docs/probes/scratch/probe-transcript.ts classify <path-to-session>.jsonl
```
Also do a **hung-input** case (ask Claude something that waits on input) and confirm the chosen
signal (Stop hook firing) distinguishes a *finished* turn from a *waiting* one.

### Probe D — Shannon bridge status

```bash
bash docs/probes/scratch/fetch-shannon-status.sh
```
Confirm the bidirectional permission-gating bridge is still "Planned, not started" and Bun+tmux
remain required ⇒ Q1 = **roll-our-own** behind the swappable `TranscriptSource` seam.

### Probe E — transcript-vs-wire `__unknown__` rate (HARD GATE)

```bash
# Heuristic inventory (dependency-free, robust):
npx tsx docs/probes/scratch/probe-transcript.ts classify <session>.jsonl
# Optional precise cross-check against the REAL production schema:
npx tsx docs/probes/scratch/probe-transcript.ts classify <session>.jsonl --use-schema
```
Record the `__unknown__` percentage on the **exact** `--settings`-isolated no-`-p` spawn config,
the unmodeled top-level + `system`-subtype inventory, and the STRING-content `user`-line failures.
Commit the conclusion: a normalizer + noise-filter is **mandatory** for S2.

### Probe F / G — gated on IDEA-029 socket runtime

These need IDEA-029's `OrchSocketServer` + `setOrchSocketPath` up under `pnpm dev`. If IDEA-029
isn't merged at probe time, record them as deferred sub-probes to run against the merged tree
(F fallback: per-worktree instruction file if prompt-prepend is unreliable; G fallback: the
Probe-A-fail native-TUI path if `claude` kills the held-open hook or the socket is evicted).

### Probe H — parallel sessions on a real subscription (BUSINESS-RISK GATE)

```bash
node docs/probes/scratch/probe-parallel.mjs 4    # N>=4 parallel interactive sessions
```
> node-pty is built for the Electron ABI; if you hit `NODE_MODULE_VERSION`, run
> `pnpm rebuild @homebridge/node-pty-prebuilt-multiarch` for host node first (mirror of the
> better-sqlite3 note in CLAUDE.md), or use the tmux fallback in that script's header comment.

Record whether all complete or hit rate-limit/throttle/concurrency caps + any usage-limit
responses, cite `support.claude.com/articles/15036540` (blesses interactive terminal/IDE use,
**silent** on automated/parallel/headless driving), and capture an **explicit dated USER
go/no-go sign-off** — OR a recorded decision to ship the value prop as an UNCONFIRMED assumption.

## Cleanup

```bash
rm -f /tmp/idea013-probe-hook.log /tmp/idea013-probe.sock
rm -f .claude/settings.local.json   # if you used the transient-settings method
```
