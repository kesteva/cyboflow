/**
 * useArtifactTabsSync — keeps a session's center-pane artifact tabs in sync with
 * its live artifacts list.
 *
 * Shared by RunCenterPane (flow runs, keyed by the active run's parent session)
 * and QuickSessionCenterPane (quick sessions). Both hosts share ONE
 * centerPaneStore bucket per session key, so both feed this hook the SAME
 * SESSION-scoped list (`useSessionArtifactsList` — every run the session
 * hosted, chat sentinel + flow runs alike); a run-scoped list here would make
 * the prune effect below close the other host's still-valid tabs on every
 * RunCenterPane ↔ QuickSessionCenterPane switch. (RunCenterPane falls back to
 * the run-scoped list only for legacy parentless runs, whose run-id session
 * key is never shared with a quick pane.) This hook takes the resolved
 * `{ artifacts, loaded }` and:
 *   - registers a center-pane tab for every artifact, focusing only ones
 *     genuinely minted AFTER the pane's current session key started being
 *     watched (a fresh deliverable surfaces itself without yanking focus off
 *     pre-existing tabs on load/reopen);
 *   - prunes any artifact tab whose backing row vanished from the live list
 *     (so a pruned/deleted artifact never strands a tab on a perpetual
 *     "Loading…" state).
 */
import { useEffect, useRef } from 'react';
import { useCenterPaneStore } from '../stores/centerPaneStore';
import { FLOW_TAB_ID } from '../../../shared/types/centerPane';
import type { Artifact } from '../../../shared/types/artifacts';

export function useArtifactTabsSync(sessionKey: string, artifacts: Artifact[], loaded: boolean): void {
  // ── Auto-open artifact tabs ────────────────────────────────────────────────
  // Register a tab for every artifact, and FLIP the center pane to ones genuinely
  // minted AFTER this pane mounted for the current session (a fresh deliverable
  // surfaces itself). The pre-existing set surfaced on first load must NOT yank
  // the user off the Flow tab.
  //
  // The DB `is_new` flag CANNOT be trusted for this: it is never written back to
  // 0, so on app refresh / fresh run re-select `artifacts.list` re-seeds every
  // prior artifact with isNew===true — which would steal focus on every reload
  // (exactly what this effect forbids). Instead we treat "new" as purely a
  // client-session notion: the FIRST sync for a session key marks every artifact
  // already present as already-seen (so it is opened WITHOUT stealing focus), and
  // only ids that appear in a LATER sync count as freshly minted and focus.
  //
  // The seed pass is GATED on `loaded`: useArtifactsList returns [] while its
  // seed query is in flight, so without the gate the "initial seed" would be
  // consumed on that empty pre-load list — then the real artifacts arrive in a
  // LATER sync and are mistaken for fresh mints, stealing focus to the last one
  // (the reopen-lands-on-an-artifact bug). Waiting for `loaded` means the initial
  // seed runs against the actual resolved list.
  //
  // centerPaneStore.openArtifactTab ALWAYS focuses the tab it opens/touches —
  // there is no no-focus "register" action. To open the initial seed without
  // stealing focus we capture the active tab id before the pass and restore it
  // afterwards (the Flow tab carries no `isNew`, so focusTab restoring it is a
  // no-op beyond setting activeTabId).
  const seenArtifactIds = useRef<Set<string>>(new Set());
  // Reset the seen-set when the pane switches to a different run/session so a
  // new run's freshly-minted artifacts focus correctly.
  const seenForKey = useRef<string | null>(null);
  useEffect(() => {
    // Wait for the seed query to resolve before deciding pre-existing vs. fresh
    // (an empty list while loading must not consume the initial-seed pass).
    if (!loaded) return;
    const store = useCenterPaneStore.getState();
    // The active tab the user is currently on — restored after the initial seed
    // so pre-existing artifacts open silently (no focus steal).
    const activeBeforeSeed = store.bySession[sessionKey]?.activeTabId ?? FLOW_TAB_ID;

    const isInitialSeed = seenForKey.current !== sessionKey;
    if (isInitialSeed) {
      seenArtifactIds.current = new Set();
      seenForKey.current = sessionKey;
    }

    for (const artifact of artifacts) {
      if (seenArtifactIds.current.has(artifact.id)) continue;
      seenArtifactIds.current.add(artifact.id);
      // On the initial seed, every artifact is "pre-existing" — open it but do
      // NOT steal focus (it is restored below) so first load never yanks the user
      // off the Flow tab. After the initial seed, an unseen artifact id is
      // genuinely fresh THIS session: it is content-driven (only minted once it
      // has content), so we FLIP the center pane to it (focus:true) — the run just
      // produced a deliverable and the pane surfaces it. The seenArtifactIds guard
      // means each id flips at most once (no repeated yanking on later syncs).
      //
      // Same-atype collapse (deliberate v1 semantics): the artifacts table is
      // UNIQUE(run_id, atype), so a SESSION-scoped list can hold several rows
      // sharing one atype (e.g. two planner runs in one session → two
      // idea-specs). centerPaneStore keys artifact tabs by atype alone
      // (`art:<atype>` — "one tab per atype within a session"), so the slot
      // acts as one VIEWER per atype: the loop leaves the newest row
      // (created_at order) in the slot, and clicking a specific card in the
      // right-rail ArtifactsPanel swaps that row into it. Per-artifact tabs
      // would need the store's tab-id scheme to change — out of scope here.
      store.openArtifactTab(sessionKey, {
        atype: artifact.atype,
        label: artifact.label,
        artifactId: artifact.id,
        committed: artifact.committed,
        isNew: false,
        ...(isInitialSeed ? {} : { focus: true }),
      });
    }

    // Restore focus after the initial seed so opening pre-existing artifacts
    // never yanks the user off the Flow (or whichever) tab they were on.
    if (isInitialSeed && artifacts.length > 0) {
      useCenterPaneStore.getState().focusTab(sessionKey, activeBeforeSeed);
    }
  }, [artifacts, sessionKey, loaded]);

  // ── Close tabs whose backing artifact row vanished ─────────────────────────
  // A pruned / deleted artifact leaves its center-pane tab stranded on a
  // perpetual "Loading…" state (renderActiveTab can't resolve the row). Close
  // any artifact tab whose id AND atype no longer appear in the live list.
  useEffect(() => {
    // Only prune against a RESOLVED list: while the seed is loading the list is
    // [] (unknown, not "deleted"), so closing here would wrongly drop valid tabs
    // on every reopen and re-open them when the seed lands (flicker).
    if (!loaded) return;
    const session = useCenterPaneStore.getState().bySession[sessionKey];
    if (!session) return;
    for (const tab of session.tabs) {
      if (tab.kind !== 'artifact') continue;
      // A tab with NO artifactId was chip-opened for a not-yet-minted artifact
      // ("creates ⟨artifact⟩" opens eagerly) — it renders the not-created-yet
      // state and must NOT be pruned; auto-open stamps the id once it mints.
      if (!tab.artifactId) continue;
      const stillExists =
        artifacts.some((a) => a.id === tab.artifactId) ||
        artifacts.some((a) => a.atype === tab.atype);
      if (!stillExists) {
        // Drop our memory of the id too, so a re-mint re-opens (and focuses) it.
        if (tab.artifactId) seenArtifactIds.current.delete(tab.artifactId);
        useCenterPaneStore.getState().closeTab(sessionKey, tab.id);
      }
    }
  }, [artifacts, sessionKey, loaded]);
}
