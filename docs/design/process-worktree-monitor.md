# Design: process & worktree System view — a top-level reaping surface

**Status:** SHIPPED (IDEA-037) as the **System** view — `SystemView` / `cyboflow.system` (see `docs/ARCHITECTURE.md` → "System view"). This file is the approved design plus its measured cost budget; where it disagrees with the code, the code wins.
**Naming amendment:** the design session called this surface "Monitor" (`MonitorView`, `monitorOpen`, `cyboflow.monitor`). `cyboflow.monitor` (`routers/monitor.ts`) is already the unrelated per-run supervisor-chat router, so the surface shipped as **System**. Sibling routers: `cyboflow.monitorReap` (destructive two-step gate) and `cyboflow.worktreeMonitor` (registry / disk-usage queries).
**Date:** 2026-08-12
**Idea:** IDEA-037 — *Add a process and worktree monitor* (the idea's title; the shipped surface is the System view)
**Prototype:** [`docs/prototypes/monitor-ui-prototype.html`](../prototypes/monitor-ui-prototype.html) — static HTML+CSS, no JS; open directly in a browser (authored under the working title; its markup and `data-design-id`s still read `monitor-*`)
**Scope decided with the user:** worktrees + disk, live processes, and held ports; primary job is **reaping** (not observing); a **new top-level view**; **grouped cards** (not a dense table).

---

## Baseline

This is a **net-new top-level view** — cyboflow had no process/worktree view before this — so there is no existing surface to reproduce. The design is nonetheless grounded in two real seams read during the session:

**App-shell chrome the new view must match** (`frontend/src/`):
- `App.tsx` (~257–400) — center surface is a priority-ordered ternary keyed off `useNavigationStore`, each branch wrapped in its own `<ErrorBoundary>`. A new view registers as one more branch.
- `stores/navigationStore.ts` — one mutually-exclusive boolean per full-width overlay (`insightsOpen`, `workflowsOpen`, `verifyQueueOpen`, `backlogOpen`, …); every `open*`/`toggle*` clears its siblings and forces `view: 'home'`. Shipped as `systemOpen` + `openSystem`/`closeSystem`/`toggleSystem` following that exact pattern.
- `components/Sidebar.tsx:315–341` — rail-item recipe (pill icon + two-line label + optional count badge, `inset 3px` active accent). The System view gets a rail item here (shipped as "System", entirely absent on Windows via `isWindowsPlatform()`).
- `components/Insights/InsightsView.tsx` + `components/cyboflow/VerifyQueueView.tsx` — the view-shell idiom the prototype copies verbatim: `flex h-full w-full flex-col overflow-hidden bg-bg-primary`, header `border-b border-border-primary bg-bg-secondary px-7 py-4` with `.eyebrow` + `h2`, scroll container `flex-1 overflow-y-auto`, `font-mono`. Its loading skeleton (`animate-pulse` + `bg-bg-secondary`) is the idiom the disk-pending state copies.
- `components/Backlog/TaskCard.tsx` + `markers.tsx` — card shell (`rounded-card border bg-card-bg shadow-sm`) and the `.eyebrow` badge triad (`border-{status}/40 bg-{status}/10 text-{status}`) reused for every badge/dot here.
- `components/ui/Dropdown.tsx` — the portaled menu primitive the `⋯` card menu should use rather than hand-rolling.
- Tokens (`styles/tokens/*.css`) inlined verbatim into the prototype: paper default (sharp corners, JetBrains Mono, terracotta) on bare `:root`; dark under `@media (prefers-color-scheme: dark)` as the JS-free stand-in for the app's `.dark` class (which also restores rounded radii). Icons are lucide-react (`Loader2` + `animate-spin motion-reduce:animate-none` is the house spinner).

**Data seams the actions bind to** (`main/src/`):
- Worktrees: `WorktreeManager.listWorktrees()` (`worktreeManager.ts:414`, `git worktree list --porcelain` — the only enumerator that catches git-tracked orphans), owner rows in `sessions.worktree_path` (`database.ts:594`) and `workflow_runs.worktree_path` (`database.ts:1516`); `in_place`/`is_main_repo` flags guard the "your real checkout" case. Prune reuses `removeWorktree` / `removeWorktreeByPath` (`:277`, `:316`) → the exact teardown sequence at `ipc/session.ts:1348–1390`, including its conditional `deleteBranch` (skipped when the branch pre-existed).
- Processes: no central PID registry today — handles live in `AbstractCliManager`, `RunShellManager.shells`, and `CodexBrokerReaper`'s on-demand `ps` scan. Kill reuses `AbstractCliManager.killProcessTree` (`:1012`) / `getAllDescendantPids` (`:955`) and `CodexBrokerReaper.killBrokerTrees`.
- Ports: TCP-probe pattern at `index.ts:1595–1606` (:4521, :9223); `OrchSocketServer.clientsByRun` / `connections` (`orchSocketServer.ts:76,83`) for socket clients; `EADDRINUSE`-safe `start()` (`:99–192`) already detects the foreign-instance collision the prototype surfaces.
- IPC: new `cyboflow.system` tRPC sub-router (`routers/system.ts`) following the `health.ts` setter-injection template; frontend polls with the `useVerificationRequests.ts` interval-hook pattern (2.5 s).

---

## Design

A **new top-level view "System"** (primary sidebar rail item, orphan-count badge) whose job is **reaping** runaway processes and stale worktrees — observability is present but actions are the point. Layout, top to bottom:

1. **Header** — `System` title, eyebrow "System · live process & worktree monitor", right-aligned *Updated Ns ago* + auto-refresh pill + Refresh.
2. **Toolbar strip** — four stat tiles (Worktrees, Processes, **Disk used** — showing measurement progress "Disk · 3 of 5" with a spinner while the staggered pass completes, **Orphans** — warning-tinted, labelled with its kind split "1 wt · 1 proc"); a **group-by segmented control**; a sort control (disk / idle / CPU / owner); and a **Reap all stale** destructive action.
3. **Ports & sockets** — kept as its own **top-level section** (not folded into owning worktree cards): `:4521` dev server, `:9223` CDP, `orch.sock` (N clients · runs bound), plus a **conflict** card when a foreign instance (dev-dmg) also holds a port. Individual worktree cards still footnote the ports they hold, so ownership isn't lost — the section is the "what's bound on this machine" answer, which is the question you actually arrive with.
4. **Orphans — reclaim** (placed *above* active worktrees because reaping is the primary job), split into two labelled subgroups so the reap backlog never mixes kinds:
   - **Stale worktrees** — count + MB on disk to reclaim → **Prune worktree**.
   - **Orphaned processes** — count + RAM/CPU to reclaim → **Kill tree**.
5. **Grouped body — toggleable between two groupings** (the segmented control in the toolbar):
   - **By worktree** (default): one card per worktree — kind tile, name, owner badge (**Session** vs **Run**), dirty/clean + ahead/behind pills, disk + age + last-viewed, **Open session / Open run**, reveal-in-Finder, `⋯` menu. Processes nest inside as a table (status dot, name, type badge, pid, CPU% with hot values amber, Mem, uptime, per-process **Kill tree**). Footer: ports held + **Kill all processes** / **Prune worktree**.
   - **By process type**: one card per process *type* (CLI · Claude SDK, CLI · Codex, Shell PTY, Codex broker · detached), each with an aggregate line (count · CPU · RAM) and a **Kill all (N)** action; rows swap the Detail column for an **owning-worktree** column, with orphans rendered as a warning-tinted "none — orphaned". This grouping is what makes the recurring "kill every detached Codex broker" sweep a single action instead of a hunt across cards.

   The static prototype renders **By worktree** as the live state and **By process type** in a dashed *Toggle state B* frame below, since a JS-free mock can't switch.

6. **Confirm dialog — gates every destructive action** (Prune, Kill tree, Kill all, Reap all stale). Not a generic "are you sure": it shows an itemized **manifest** of exactly what dies, each row carrying its kind glyph, the reclaim total (disk + RAM) in the subtitle, an explicit **uncommitted-work warning** when any target worktree is dirty ("Pruning discards them permanently — nothing is stashed"), and an opt-in **Also delete branch** checkbox mirroring the conditional-`deleteBranch` behavior of the real teardown path. Cancel / solid-danger confirm; Esc cancels.

### Disk measurement has three legible states

Because disk sizing runs off the poll loop (lazy, staggered, concurrency 1 — see cost budget), a card's disk figure is never simply "there":

- **Measured** — the value (`disk 312 MB`).
- **Measuring now** — inline spinner + `measuring…`. Exactly one worktree shows this at a time, which is an honest rendering of the concurrency-1 queue.
- **Queued** — a pulsing skeleton bar matching the app's `animate-pulse` loading idiom, with `role="status"` + `aria-label` for screen readers.

Both animations honour `prefers-reduced-motion`. The aggregate Disk tile carries the same progress ("Disk · 3 of 5"), so a partial total never reads as a final one. Cards must render `diskBytes: null` as one of these states — never as `0 MB`.

### Kind vs state — two axes, deliberately encoded differently

- **Kind** (worktree vs process) → leading **icon tile** + kind badge + subgroup header, one hue **and shape** per kind: worktree = folder glyph, info/blue, **square** (a place on disk); process = chip glyph, compound/violet, **round** (a running thing). Shape carries the distinction independently of color, so it survives both themes and color-vision deficiency.
- **State** (orphan vs healthy) → card border tint + section placement.

The folder tile appears on **every** worktree card, active ones included, so a folder tile always means "worktree" anywhere in the view rather than reading as an orphan marker.

Light + dark are supported via the inlined palettes. The prototype carries 72 unique stable `data-design-id` attributes (`monitor-view`, `monitor-groupby-proctype` — the prototype's original ids; the shipped components are `SystemView` et al., `port-4521`, `wt-ivory-open`, `wt-sprint-disk-measuring`, `wt-main-disk-queued`, `orphan-group-processes`, `type-group-codex-broker`, `confirm-dialog`, `confirm-dirty-warning`, …).

**Honest ceiling:** the mock uses sample data, and the group-by toggle + confirm dialog are shown as static states rather than working interactions. Live CPU/mem, disk sizing, and a unified process/worktree registry are **not yet plumbed** — see gaps below.

---

## Sampling cost budget (measured, not estimated)

Benchmarked on the developer's machine on 2026-08-12 (678 live processes, 16 worktrees, 700k files / 37 GB total). **This section is normative — it constrains the implementation.**

| Operation | CPU cost | Verdict |
|---|---|---|
| `ps -axo pid,ppid,pcpu,pmem,etime,comm` — **one full scan**, 678 procs | **2 ms** (39 ms wall) | Free — 0.08% of one core at 2.5 s |
| `ps -p <12 pids>` targeted | 0.715 s / 20 runs — **no cheaper than a full scan** | Never do per-pid `ps` |
| `du -sk` one worktree (59.8k files) | **0.46 s** | Expensive |
| `du -sk` × 16 worktrees | **7.4 s** | Would peg ~3 cores permanently at a 2.5 s poll |
| `du -sk -I node_modules` | 0.011 s (42× cheaper) | Rejected — hides the 2.2 GB that *is* the reclaim |

Three findings that bind the implementation:

1. **CPU/mem sampling is effectively free — keep it on the 2.5 s poll.** `ps` is ~4,000× cheaper than `du`.
2. **Cost is process-spawn-dominated, not row-count-dominated.** A naive `ps -p <pid>` per tracked process would cost ~12 spawns × 36 ms ≈ **430 ms per poll** — 10× worse than scanning everything once. **Rule: one full `ps` scan per tick, indexed by pid in memory.** This is also why the existing `codexBrokerReaper.ts:150` single-scan pattern is the right thing to extend.
3. **`du` does not warm-cache at this scale** — three consecutive warm runs on the repo took 14.8 s each, identical to cold. There is no "second call is cheap" escape hatch; the only lever is cadence.

**Disk sizing must therefore live on a separate, slow cadence — never the poll loop:**

- Computed **lazily and staggered**, one worktree at a time (**concurrency 1**), with a **multi-minute TTL** (~5 min). Worktree size is a slow-moving quantity — it moves on installs and builds, not seconds — so a 2.5 s cadence was wrong on the merits regardless of cost.
- **Invalidated eagerly** on prune, and refreshable on demand from the sort control / card menu.
- Surfaces the **measured / measuring / queued** states described above rather than a bare number.
- **Do not exclude `node_modules`.** Verified: 0 of 57,929 files are hardlinked, so each worktree holds a genuine full 2.2 GB copy — ~35 GB across 16 worktrees. That is the single largest reclaim lever in the product and the main reason the disk column exists; the reported figure is honest (no shared-store double-counting to caveat).
- **Gate the whole poll on view visibility** — no sampling while the System view isn't mounted/focused, consistent with the renderer-CPU-audit precedent.

Net steady-state cost with the view open: ~2 ms CPU per 2.5 s tick (≈0.08% of a core), plus one ~0.46 s `du` every ~5 min amortized across worktrees. With the view closed: zero.

---

## Implementation notes

New plumbing (the real gaps found in grounding — all of it has since shipped; the shipped module is named in each item):

1. **Unified worktree registry** — a main-process reconciler that `UNION`s `sessions.worktree_path` + `workflow_runs.worktree_path` against `WorktreeManager.listWorktrees()` truth, tagging each as session-owned / run-owned / **orphan**. No dedicated `worktrees` table — the registry stays a derived read model. **Shipped:** `services/worktreeRegistry.ts` (tags `session-owned` / `run-owned` / `orphan` / `in_place` / `is_main_repo`; the last two carry `prunable: false` in the returned shape), fronted by `services/worktreeMonitorProvider.ts` and `cyboflow.worktreeMonitor.registry`.
2. **Disk usage** — no `du`/`getDirectorySize` helper exists anywhere in `main/src`; add one, governed by the cadence rules in the cost-budget section above (lazy, staggered, TTL'd, concurrency 1, invalidated on prune). It must expose per-worktree state (`measured | measuring | queued`) to the view, not just a nullable number. **Shipped:** `services/diskUsageService.ts` (`DISK_USAGE_TTL_MS` = 5 min, serial queue, `invalidate` wired into `WorktreeManager`'s removal paths, `requestFresh` for the manifest gate), exposed via `cyboflow.worktreeMonitor.diskUsage` / `.requestFresh`; on win32 the tri-state gains an explicit `unsupported`.
3. **Process registry + CPU/mem** — no cross-manager PID list and no sampling lib. Add a snapshot service built on **a single `ps -axo pid,ppid,pcpu,pmem,etime,command` scan per tick** (extending `codexBrokerReaper.ts:150`), unioned with the manager-private maps (`AbstractCliManager`, `RunShellManager.shells`) and mapped to an owning worktree **and a process-type enum** — the type field is what the by-type grouping and its Kill-all actions key on. A PID whose mapped worktree is absent materializes the **Orphaned processes** subgroup. No `pidusage`/`ps-list` dependency is needed; the scan already yields every column the view shows. **Shipped:** `services/processSnapshot/processSnapshotService.ts` (one `listProcesses()` per `snapshot()`), `processTypes.ts` (the process-type enum), `classify.ts` (owned / foreign / orphan / suspected — `foreign` and `suspected` are structurally excluded from sweep sets) and the shared `parsePsOutputWithCpuMem` in `services/processTable.ts`. Every spawn site stamps `CYBOFLOW_INSTANCE` / `CYBOFLOW_WORKTREE` via `utils/spawnMarker.ts`; `spawnMarkerReader.ts` reads them back (linux `/proc/<pid>/environ` only — on macOS/Windows rows carry no marker: processes with a manager handle still classify `owned`, marker-less cyboflow-shaped ones `suspected`, the rest `foreign`, and since `orphan` needs a marker naming a dead instance no sweep-eligible orphans appear there).
4. **Port/socket status** — `cyboflow.system.snapshot` query combining the `index.ts:1595` TCP probe (4521/9223) with new getters exposing `OrchSocketServer.connections.size` / `clientsByRun` (then private). **Shipped:** `orchestrator/portProbe.ts` + `orchestrator/systemTypes.ts` (`SystemSnapshot`), `OrchSocketServer.getConnectionCount()` / `getRunBindingCounts()`, composed by `services/systemSnapshotProvider.ts` behind `cyboflow.system.snapshot`. The TCP probe reports `inUse` only — no port→owner detection. **Since 0.5.1:** the probed TCP ports are a user setting (`AppConfig.systemWatchedPorts`, edited via the gear on the Ports & sockets section; default 3000/5000/8080, `shared/types/systemWatchedPorts.ts`), and the snapshot carries them as `ports.tcp[]`; cyboflow's own dev renderer / CDP ports are appended only in a dev build, resolved from `CYBOFLOW_VITE_PORT` / `CYBOFLOW_CDP_PORT` (`resolveWatchedPorts` in `systemViewComposition.ts`).
5. **Reap confirmation contract** — every destructive action resolves a **manifest** server-side *before* prompting (targets, kinds, reclaimable bytes, dirty-file counts, descendant PID counts; **shipped:** `services/monitor/reapManifest.ts`, `cyboflow.monitorReap.resolve` / `.execute`) so the dialog states facts rather than guesses; the same manifest is then passed to execution, so what the user confirmed is exactly what runs. Dirty/ahead detection is a fresh one-shot `probeWorktreeGit` read at resolve time (the status cache is keyed by session, so it holds nothing for an orphan and can be stale); the `GitStatusManager` cache is only the fallback when the probe yields nothing. **The manifest forces a fresh `du` of its targets only** — jumping the TTL queue — so the reclaim figure is accurate at the moment of decision; ~0.46 s per target is acceptable latency for a destructive gate, and it avoids ever confirming against a stale or absent number.
6. **Frontend** — `SystemView.tsx` (the prototype's markup), a `systemOpen` nav flag + Sidebar rail item + `App.tsx` branch, a 2.5 s polling hook mirroring `useVerificationRequests.ts` **gated on view visibility**, and a persisted group-by preference (localStorage — route any key rename through `utils/migrateLocalStorageKey.ts`). The kind tile/badge should be one shared `<KindTag kind="worktree" | "process">` so hue + shape stay locked together at every call site. **Open session / Open run** reuses the existing session-activation path so it behaves identically to opening from the sidebar. **Shipped:** `hooks/useSystemSnapshot.ts` (`enabled` gate), `utils/systemGroupBy.ts` (key `cyboflow-system-group-by`, migrated from the working-title `cyboflow-monitor-group-by`), `components/cyboflow/KindTag.tsx`, and `components/System/` (`ManifestConfirmDialog`, `KillProcessConfirmDialog`, `useWorktreeReap`, `useProcessReap`).

Reused primitives (do **not** reinvent): `WorktreeManager.removeWorktree`/`removeWorktreeByPath` + `ipc/session.ts:1348` teardown; `AbstractCliManager.killProcessTree`/`getAllDescendantPids`; `CodexBrokerReaper.killBrokerTrees`/`reapForWorktree`; `RunShellManager.close`; `GitStatusManager` ahead/behind + dirty cache; `OrchSocketServer` connection maps; `ui/Dropdown` for the `⋯` menu. Respect the `in_place`/`is_main_repo` guard on every prune path — the in-place card disables Prune outright.

**Files to touch:** `main/src/services/` (new process snapshot service + disk-usage helper), `main/src/orchestrator/trpc/routers/{system,monitorReap,worktreeMonitor}.ts` (new sub-routers, `health.ts` template), `main/src/index.ts` (boot injection), `frontend/src/components/cyboflow/SystemView.tsx`, `frontend/src/stores/navigationStore.ts`, `frontend/src/components/Sidebar.tsx`, `frontend/src/App.tsx`.
