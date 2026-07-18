# Global agent — S1.5 live-smoke checklist (interactive half)

The automated half (boot wiring, digest turn end-to-end, sink persistence, log review,
rail render) is exercised by the session that built the feature. The items below need a
human clicking against live data in `pnpm dev`.

## Job 1 — sessions overview
- [ ] Open the app to a landing view; the agent rail auto-digests once (or press
      "Where is everything?"). Digest groups by project, running/blocked first,
      matches the board's actual state (spot-check 2–3 sessions).

## Job 2 — reprioritize + kickoff
- [ ] "Triage the backlog" → agent proposes a reprioritize card with per-item rows.
- [ ] Confirm → per-row ✓ appear; board reflects new priorities/stages after refresh.
- [ ] Confirm a launch-run card → run starts; its session appears in the rail/board and
      is inspectable; the run's worktree exists.
- [ ] Force a launch failure (e.g. propose a sprint launch with a bogus task seed) →
      card shows failed; no orphan session/worktree remains (compensation saga).

## Job 3 — modify a workflow
- [ ] "Modify a workflow …" → edit-workflow card with a sensible summary.
- [ ] Confirm → the change is visible in the workflow editor.
- [ ] Stale-CAS path: get an edit-workflow card, then edit the same workflow manually in
      the editor BEFORE confirming the card → Confirm yields the superseded card state
      and a refreshed-diff loopback turn from the agent (never a blind overwrite).

## Cross-cutting
- [ ] open-session card targeting a run in a DIFFERENT project than the active one →
      navigation lands correctly (projectId enrichment).
- [ ] Double-click Confirm rapidly → exactly one execution; no error toast (claimed
      race-loser reconciles silently).
- [ ] Visual pass vs. the design packet (card head bar, needs-confirm badge, rust/ghost
      buttons, resolved rows, rail header + GLOBAL chip).
- [ ] `cyboflow-backend-debug.log`: no `agent_thread` sink warnings, no FK errors after
      a full session of use.

Delete this file once the checklist has been run to satisfaction.
