---
id: TASK-554
idea: IDEA-012
idea_id: IDEA-012
status: ready
created: 2026-05-11T00:00:00Z
files_owned:
  - .soloflow/active/acceptance/SELF-HOST-LOG.md
files_readonly:
  - .soloflow/active/roadmaps/ROADMAP-001.md
  - .soloflow/active/research/ROADMAP-001-research-risks.md
  - docs/cyboflow_system_design.md
acceptance_criteria:
  - criterion: "A self-host log file exists at .soloflow/active/acceptance/SELF-HOST-LOG.md and contains exactly one timestamped session entry covering at least 8 hours of clock time on a single calendar day."
    verification: "Read SELF-HOST-LOG.md; verify a 'Session start: <ISO>' and 'Session end: <ISO>' line where the difference is >= 8 hours and dates match."
  - criterion: "The log enumerates every Cyboflow run started during the session: workflow name, runId, start timestamp, terminal state (completed | failed | canceled | stuck), and pause/approval count."
    verification: "Visual review — the log's 'Runs' section is a markdown table with columns: Workflow | Run ID | Started | Ended | Terminal State | Approvals | Notes. At least 6 runs covering the 5 SoloFlow workflows (soloflow, planner, sprint, prune, compound) appear."
  - criterion: "Every fallback to Crystal/CLI is logged with: timestamp, what failed in Cyboflow, what was used as a workaround, and a verdict — either 'fix-same-day: <commit-sha or task-id>' or 'defer-to-ROADMAP-002: <one-line rationale>'."
    verification: "Visual review — the log's 'Fallbacks' section. Every row has a verdict column. The verdict 'defer-to-ROADMAP-002' rows include a one-line rationale. The verdict 'fix-same-day' rows reference a commit SHA or a follow-up task in the active sprint."
  - criterion: "Risks-research §10 failure surfaces are addressed in a 'Risk-Check Findings' section: tRPC subscription leaks (memory observation), WAL checkpoint stalls (DB size after session), zombie PTYs (process count after app quit), dock badge desync (manual count vs queue.length verification), p-queue recursive self-deadlock (any observed)."
    verification: "Read SELF-HOST-LOG.md; section 'Risk-Check Findings' lists each of the 5 enumerated surfaces with a one-line observation (e.g., 'memory grew from 180MB → 240MB over 7h, no leak signature')."
  - criterion: "The log's final 'Verdict' line is one of: 'PASS — no fallback observed; v1 acceptance gate met' OR 'PASS-WITH-DEFERS — N fallbacks, all deferred to ROADMAP-002' OR 'FAIL — uncategorized fallbacks remain; re-run required after fix'."
    verification: "Read the final line of SELF-HOST-LOG.md; it matches one of the three verdict templates verbatim."
depends_on: [TASK-551, TASK-552, TASK-553, TASK-555]
estimated_complexity: medium
epic: first-run-onboarding-and-self-host-acceptance
test_strategy:
  needed: false
  justification: "This is a manual acceptance task — the deliverable is a structured log file produced during a real-world session. There is no code to unit-test. The 'tests' are the AC verifications applied to the log itself."
---

# 1-Day Self-Host Acceptance Run

## Objective

Use Cyboflow exclusively for a full working day (~8 hours of active development) running real SoloFlow workflows (soloflow / planner / sprint / prune / compound) on real repos. Log every run, every approval count, every fallback to Crystal or raw Claude CLI. Decide each fallback as either fix-same-day (open a task in the active sprint, ship the fix, re-test) or defer-to-ROADMAP-002 (one-line rationale, accept as known limit). This is the MVP-done gate per ROADMAP-001 brief §"Success Metrics" and the brief's "self-hosting with a 1-day threshold" verbatim definition. Pass = the v1.0.0 DMG ships; FAIL = the gate re-opens and the sprint extends.

## Implementation Steps

This task is a manual acceptance procedure performed by the developer. Steps are workflow, not code.

1. **Preflight (morning of self-host day):**
   - Confirm all TASK-551, TASK-552, TASK-553, TASK-555 are merged and the local build is current. Run `pnpm build:main && pnpm build:frontend` to verify.
   - Start Cyboflow. Confirm the StatusBar dot is green (MCP healthy), the onboarding card is present, and at least one project is registered.
   - Open the .gitignore of the active project — verify `.cyboflow/worktrees/` is listed (created by TASK-552 on project add).
   - Create the log file `.soloflow/active/acceptance/SELF-HOST-LOG.md` with the section skeleton below.

2. **Log skeleton to create:**
   ```
   # Cyboflow Self-Host Acceptance Run

   Session start: <ISO timestamp>
   Session end: <to fill at end>
   Cyboflow version: <git rev-parse HEAD>
   Repos used: <list>

   ## Runs

   | Workflow | Run ID | Started | Ended | Terminal State | Approvals | Notes |
   |---|---|---|---|---|---|---|

   ## Fallbacks

   | Time | What failed | Workaround | Verdict |
   |---|---|---|---|

   ## Risk-Check Findings

   - tRPC subscription leaks (memory observation):
   - WAL checkpoint stalls (DB size delta):
   - Zombie PTYs (process count after app quit):
   - Dock badge desync (manual count vs queue.length):
   - p-queue recursive self-deadlock (any observed):

   ## Verdict

   <one of: PASS — no fallback observed; v1 acceptance gate met / PASS-WITH-DEFERS — N fallbacks, all deferred to ROADMAP-002 / FAIL — uncategorized fallbacks remain; re-run required after fix>
   ```

3. **During the session — discipline rules:**
   - Use Cyboflow as the **only** way to invoke Claude Code. No `claude` CLI directly. No falling back to Crystal proper.
   - Cover all 5 SoloFlow workflows at least once. Sprint and prune especially must each run to terminal state to exercise the queue-mixing differentiator.
   - When something fails or feels worse than Crystal/CLI, write it to the Fallbacks table BEFORE working around it. The discipline is to log first, decide later.
   - Periodically (~every 2 hours) check `Activity Monitor` for the Cyboflow.app memory footprint; record the running observation in the Risk-Check Findings section.

4. **End-of-day procedure:**
   - Quit Cyboflow cleanly via `Cmd+Q`. After quit, run `ps aux | grep -i claude | grep -v grep` and `ps aux | grep -i node-pty | grep -v grep` — record zombie PTY count (target: 0). This is the inherited `SimpleQueue.close()` zombie risk from risks research §10.
   - Run `ls -la ~/.cyboflow/cyboflow.db*` and record file sizes. A `.db-wal` file larger than 50MB indicates checkpoint starvation; flag.
   - Count rows in `raw_events` table to confirm the day-1 indexes hold up: `sqlite3 ~/.cyboflow/cyboflow.db "select count(*) from raw_events; explain query plan select * from raw_events where run_id = 'x' order by id desc limit 100;"` — index must be used.
   - Triage every fallback row:
     - Trivial (<2 hours fix): open a fix task in the current sprint, implement, commit, mark verdict `fix-same-day: <sha>`. Then RE-RUN this self-host on a second day with the fix applied.
     - Non-trivial: file as a follow-up note for ROADMAP-002, mark verdict `defer-to-ROADMAP-002: <one-line rationale>`.
   - Set the Verdict line.

5. **Pass criteria:**
   - Zero fallbacks → PASS, proceed to TASK-555/TASK-556 finalization.
   - Some fallbacks, all triaged as defer-to-ROADMAP-002 with documented one-liners → PASS-WITH-DEFERS, proceed.
   - Any fallback triaged as fix-same-day that has NOT yet been fixed AND re-tested → FAIL. Stop. Fix, repeat self-host on another day.

## Acceptance Criteria

See frontmatter. The log is the deliverable.

## Test Strategy

No code tests — manual acceptance task. The AC verifications above ARE the tests, applied to the log file produced during the run.

## Hardest Decision

The "re-run on a second day if any fix-same-day occurred" rule versus "log-fix-and-keep-going-same-day". Picked the stricter version (re-run next day). Rationale: a fix landed mid-session has not been exercised across a full workload. The MVP-done gate's whole point is *sustained* exposure — fixing at hour 4 and continuing the same session means hours 5–8 ran on a hot codebase that has 0 sustained-use evidence. Re-run preserves the gate's integrity. The tradeoff is calendar time. The brief budgets the gate within the 2-week window; if a single same-day-fix triggers a re-run, the schedule absorbs it.

## Rejected Alternatives

- Two-day rolling acceptance (use Cyboflow for two consecutive working days, lower per-day bar). Rejected — brief explicitly defines the bar as "at least 1 full working day". Doubling makes the gate stricter, not the same.
- Synthetic load test instead of real-day-of-work. Rejected — risks research §10 specifies *the bugs only surface in real workflows*. A scripted load test does not reproduce the rhythm of human approval pacing or the mix of long-pause runs.

## Lowest Confidence Area

Whether the "Risk-Check Findings" instrumentation (memory observation, db size delta, zombie PTY count) catches the right signals. A leak that only manifests at 16 hours of use will not appear at 8. The gate is the brief's stated minimum, not a guarantee. If self-host passes but a leak surfaces post-ship, that's a ROADMAP-002 retrospective input — accepted risk per the brief's risk tolerance section.
