# System view — live macOS smoke (TASK-261)

Date: 2026-09-30, macOS 26 (darwin 25.6.0), arm64. Captures live in
[`system-view-live-smoke/`](system-view-live-smoke/); every quoted block below is pasted verbatim from
those files (`.txt`/`.json`) or from the terminal. Screenshots are 1920x1200 (`Emulation.setDeviceMetricsOverride`,
[`driver.mjs`](system-view-live-smoke/driver.mjs) — a one-off Node 22 CDP driver, no dependencies).

## Verdict

The System view is reachable from the Sidebar rail item and renders real machine data. Prune (footer button and
`⋯` menu), Kill tree, Kill-all (process-type card), Reap-all-stale and the forced-failure error path were each
driven end-to-end against real targets, and the dialog figures matched the on-disk values.
**Two real defects were found and fixed in this task's diff** (below); one macOS limitation and two minor
observations are recorded as not-fixed.

## Defects found and fixed

1. **Descendant PID count was always 0 on macOS, and the reap executor's default tree walk found no children.**
   The Kill-tree dialog for `sh -c 'cd <wt> && sleep 600 & sleep 600 & wait'` (pid 32221) said
   `0 descendant PIDs` while `ps` showed three (32223, 32224, 32225) — see
   `03-kill-tree-dialog.txt` / `03-kill-tree-dialog.png` (before) and `03-kill-tree-dialog-after-fix.txt` (after).
   Cause: `platformProcess.ts`'s default POSIX child lister ran GNU `ps -o pid= --ppid N 2>/dev/null || true`,
   which macOS `ps` rejects (`ps: illegal option -- --`), and `|| true` swallowed it. The manifest builder
   (`reapManifest.ts`) and `ReapExecutorImpl` use the default lister, so on macOS the manifest under-reported
   and the executor pre-enumerated no descendants. (`AbstractCliManager` and `runCommandManager` already injected
   `pgrep -P`, which is why the older kill paths worked.) Fix: the sync and async defaults now run `pgrep -P N`.
   Test: `platformProcess.test.ts` "default POSIX child lister (real process tree)" walks a real `sh` tree with the
   un-injected lister; on darwin its in-test negative control asserts the old GNU command lists nothing for the same
   live tree.
2. **A batch containing a parent and its child reported the child as an error.** "Kill all (N)" on the process-type
   card killed pid 35431's tree (which took 35433 down with it), then reached 35433 and reported
   `Root pid 35433 already exited; its 1 descendant(s) could not be verified gone` as a failed target
   (before-fix output, captured live):

   ```
   errors: Some targets were not reaped:
   cd (pid 35433) — Root pid 35433 already exited; its 1 descendant(s) could not be verified gone
   ```

   Fix (`reapExecutor.ts`): pids of a `killed` target and its pre-enumerated descendants are remembered for the batch;
   a later target whose root is dead and covered by an earlier kill is `killed`, not `failed`. Test:
   `reapExecutor.test.ts` "does not report a child target as unverified when a parent target in the same batch
   already killed it", with a negative control (a dead root nothing covered is still `failed`).
   After the fix the same action reported `Reaped 4 targets. || errors: none` (`07-kill-all-type-result.txt`).

Commit: `f66279741`.

## 1. Fixture inventory

Created under `/tmp/cf-smoke261/repo` (`git init -b main`, one commit; `worktrees/` and `payload/` in
`.git/info/exclude`; a 3 MB `payload/blob` in each worktree so byte figures are non-trivial).

| fixture | path | `git status --porcelain` | `git rev-list --count main..HEAD` | `du -sk` |
|---|---|---|---|---|
| clean | `/private/tmp/cf-smoke261/repo/worktrees/clean` | *(empty)* | 0 | 3080 |
| dirty | `/private/tmp/cf-smoke261/repo/worktrees/dirty` | ` M README.md`, `?? uncommitted.txt` | 0 | 3084 |
| ahead | `/private/tmp/cf-smoke261/repo/worktrees/ahead` | *(empty)* | 1 | 3084 |
| proc | `/private/tmp/cf-smoke261/repo/worktrees/proc` | *(empty)* | 0 | 3080 |
| main repo (in-place checkout) | `/private/tmp/cf-smoke261/repo` | *(empty)* | — | — |
| locked (added for step 6) | `/private/tmp/cf-smoke261/repo/worktrees/locked` | `?? pinned.txt` (`chflags uchg`) | 0 | 12 |

`git worktree list` at setup:

```
/private/tmp/cf-smoke261/repo                 2dc92d5 [main]
/private/tmp/cf-smoke261/repo/worktrees/ahead f67e171 [smoke-ahead]
/private/tmp/cf-smoke261/repo/worktrees/clean 2dc92d5 [smoke-clean]
/private/tmp/cf-smoke261/repo/worktrees/dirty 2dc92d5 [smoke-dirty]
/private/tmp/cf-smoke261/repo/worktrees/proc  2dc92d5 [smoke-proc]
```

Test process tree (spawned with `cd <proc worktree> && …` so its command line names a known worktree):

```
32221     1       00:01 sh -c cd /private/tmp/cf-smoke261/repo/worktrees/proc && sleep 600 & sleep 600 & wait
32223 32221       00:01 sh -c cd /private/tmp/cf-smoke261/repo/worktrees/proc && sleep 600 & sleep 600 & wait
32224 32221       00:01 sleep 600
32225 32223       00:01 sleep 600
```

Descendants of 32221: 32223, 32224, 32225 (3). Descendants of 32223: 32225 (1). The tree was respawned as
35431/35433/35434/35435, then 37384/37386/37387/37388, for the later steps (`05-respawned-pids.txt`).

## 2. Dev instance

`CYBOFLOW_DIR=~/.cyboflow_smoke261 CYBOFLOW_CDP_PORT=9457 pnpm dev` (fresh data dir — not `~/.cyboflow_dev`, not a
sibling's :9223). Project `smoke261` added through the "Add Project" dialog. Two `sessions` rows
(`smoke-sess-dirty`, `smoke-sess-ahead`) were inserted directly into the throwaway smoke DB so those two worktrees
render as session-owned cards with Prune (an unowned worktree is an *orphan* and is reclaimed only through
Reap-all-stale). Footer, read over CDP before any click:

```
v0.4.6 • agent-sprint-8b3f719a • d6345d51e          (first run; dist rebuilt after the fixes)
v0.4.6 • agent-sprint-8b3f719a • f66279741          (second run = HEAD `git rev-parse --short HEAD`)
```

The first run's `main/dist` predated HEAD, so it was rebuilt (`pnpm build:main`) and the app restarted before the
fix-verification runs.

## 3. Reachability

Selector: `[data-testid=system-rail-item]` clicked over CDP → `[data-testid=system-view]` present.
`01-system-view.png`, `01-system-view-innertext.txt` (first 300 lines; the rest is ~760 foreign read-only rows from
this machine; captured before `isUnrelatedHostProcess` began dropping unrelated host processes before the wire, so a current run no longer shows them). Head of the dump:

```
SYSTEM · LIVE PROCESS & WORKTREE MONITOR
System
Updated 1s ago
AUTO-REFRESH · 2.5S
Refresh
PROJECT
smoke261
WORKTREES
5
PROCESSES
825
DISK USED
12.3 MB
5 worktrees measured
ORPHANS
4
4 wt · 0 proc
```

## 4. Cards vs step 1 (`02-cards.json`, `02-worktree-cards.png`)

```
ahead : WORKTREE | ahead | SESSION | branch smoke-ahead | disk 3 MB | Open session | Kill all processes | Prune worktree
dirty : WORKTREE | dirty | SESSION | branch smoke-dirty | disk 3 MB | Open session | Kill all processes | Prune worktree
repo  : WORKTREE | repo | MAIN REPO | branch main | disk 260 KB | Your real checkout — it can never be pruned | Kill all processes | Prune worktree
```

Disk 3 MB = `du -sk` 3080–3084; the main-repo card reads 260 KB (nested `worktrees/*` subtracted, not the ~12 MB `du` of the
whole tree). The unowned `clean`/`proc` worktrees render as ORPHAN cards in the Orphans section
(`/private/tmp/cf-smoke261/repo/worktrees/clean | ORPHAN`, `No owning session or run`, `BRANCH smoke-clean`, `DISK 3 MB`).
Live process rows: `PROCESS | cd | SUSPECTED | No owning worktree | PID | 32221 | CPU | 0.0% | MEM | 0.0% | UP | 1m | Kill tree`
(and 32223, 32224, 32225).

**Main-repo Prune is disabled in the running UI** (footer button, `02-cards.json`):

```
"disabled": true, "reason": "Your real checkout — it can never be pruned"
<button type="button" data-testid="wt-prune" class="… disabled:cursor-not-allowed disabled:opacity-50" disabled="" title="Your real checkout — it can never be pruned">Prune worktree</button>
```

and in the `⋯` menu (`16-main-repo-menu-prune-disabled.json`, `16-main-repo-menu.png`):
`"disabled": true … "text": "Prune worktree\nYour real checkout — it can never be pruned"`.

## 5. Destructive actions: dialog vs real values, then outcome

| action | dialog (verbatim file) | real value | outcome |
|---|---|---|---|
| Kill tree on pid 32221 (row button) | `03-kill-tree-dialog-after-fix.txt`: "This process is not tagged as cyboflow's — killing it may affect other software / cd / pid 32221 / **3 descendant PIDs**" (before the fix: 0) | 3 (`ps`) | `ps` afterwards: no `sleep 600`/`worktrees/proc &` rows; `04-kill-tree-result.txt`: `Reaped 1 target. || errors: none` |
| Kill all (type card "Other") | `06-kill-all-type-dialog.txt`: "Kill all Other processes / 4 targets / cd pid 37384 **3 descendant PIDs** / cd pid 37386 1 / sleep 37387 0 / sleep 37388 0" | 3 / 1 / 0 / 0 | all dead; `07-kill-all-type-result.txt`: `Reaped 4 targets. || errors: none` |
| Prune dirty (footer button, "Also delete branch" checked) | `08-…txt`: "Prune dirty? / 1 target · 3 MB disk reclaimable / 1 target has uncommitted changes. Pruning discards them permanently — nothing is stashed. / … **2 dirty files** / 3 MB disk" | 2 porcelain lines, 3084 KB | toggling the checkbox re-resolved the list (`09b-…txt`: "The list was refreshed for your branch choice. Review it and confirm again."); second confirm removed the dir; `git branch --list 'smoke-*'` no longer had `smoke-dirty`; the `smoke-sess-dirty` sessions row was untouched (`10-prune-dirty-result.txt`) |
| Prune ahead (`⋯` menu, branch checkbox off) | `11-…txt`: "1 target has commits ahead of main that is not merged. / ahead / … **1 ahead of main** / 3 MB disk" | `rev-list` 1, 3084 KB | dir gone, branch `smoke-ahead` kept (`12-prune-ahead-result.txt`) |
| Reap all stale (clean + proc + locked) | `13-…txt`: "Reap 3 stale targets? / 3 targets · 6 MB disk reclaimable / 1 target has uncommitted changes… / clean … 3 MB / locked … **1 dirty file** / 12 KB / proc … 3 MB" | 3080 + 12 + 3080 KB; locked has `?? pinned.txt` | `clean` and `proc` removed, `locked` kept (`14-reap-all-stale-result.txt`) |

## 6. Forced failure

`chflags uchg` on `worktrees/locked/pinned.txt` before confirming Reap-all-stale. Visible error in the System view
(`15-forced-failure-visible-error.txt`):

```
1 target could not be removed.
locked: Failed to remove worktree: error: failed to delete '/private/tmp/cf-smoke261/repo/worktrees/locked': Operation not permitted
```

## 7. Cleanup (`18-cleanup.txt`)

```
git worktree list:
/private/tmp/cf-smoke261/repo 2dc92d5 [main]
fixture dir exists? ls: /tmp/cf-smoke261: No such file or directory
data dir exists? ls: /Users/raimundoesteva/.cyboflow_smoke261: No such file or directory
leftover fixture pids:
(none)
dev app procs on 9457:
(none)
```

(The fixture repo and the dev instance were removed; `git worktree remove` on `locked` printed
`fatal: 'worktrees/locked' is not a working tree` because git had already deregistered it during the failed prune —
the directory itself was then removed with the repo.)

## Not fixed / not exercised

- **The macOS marker reader cannot identify orphaned processes.** `spawnMarkerReader.ts` reads
  `CYBOFLOW_INSTANCE` only from `/proc/<pid>/environ` (linux); on darwin no row is
  *marker*-classified. Rows with a manager handle still classify `owned`, marker-less
  cyboflow-shaped rows `suspected`, and no row can be classified `orphan` ("ORPHANED
  PROCESSES — 0 orphaned" throughout).
  The process half of Reap-all-stale therefore had no target here;
  the live path was covered instead by Kill tree / Kill all on `suspected` rows behind the "not tagged" confirm.
  The marker-based orphan reap remains covered by the real-process e2e (TASK-260), not by this macOS smoke.
- **`Kill all (N)` can count transient rows.** The button read `Kill all (6)` while the dialog listed 4 targets: the
  snapshot briefly included short-lived `git`/shell children whose command lines name a known worktree (and, once,
  the tool shell whose argv contained the fixture path — that dialog was cancelled, not confirmed). "Kill all" on the
  `Other` group is by design a *suspected*-tier action ("kill with care"); the dialog, not the button count, is the
  authoritative target list.
- **Stale reap-error strip persists** after the failed prune until dismissed/replaced (`17-final-state-innertext.txt`
  still shows the `locked` error with 0 orphans); harmless, left as is.
- The worktree card shows owner/branch/disk but not the design's dirty/ahead pills; dirty/ahead facts are surfaced in
  the confirm dialogs (verified above).
