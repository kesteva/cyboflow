# Cyboflow Self-Host Acceptance Run

Session start: <to fill>
Session end: <to fill>
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
