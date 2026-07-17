/**
 * useArtifactsList — live list of a run's artifacts (deliverables).
 *
 * Seeds from `trpc.cyboflow.artifacts.list({ runId })` — now a CB-merged UNION
 * of uncommitted DB rows and committed on-disk snapshots (deduped by identity,
 * DB winning) — and stays reactive via the project-scoped
 * `trpc.cyboflow.artifacts.onArtifactChanged` subscription:
 *   - created / updated / committed → upsert the carried `event.artifact`
 *   - deleted                       → remove `event.artifactId`
 *
 * INVARIANT (IDEA-039): a commit is a SAME-ID `'committed'` upsert, NEVER a
 * `'deleted'` + re-create. `upsert`/`mergeSeed`/the deleted-removal all key on
 * `id`, so the committed snapshot (same id, `committed=true`) simply replaces the
 * uncommitted row in place — the tab/list never blinks. The ONLY `'deleted'`
 * events are the merge/create-PR reap of still-uncommitted rows; committed
 * snapshots survive close-out and keep reading back through the seed union.
 *
 * The subscription is project-scoped (every run in the project shares one
 * channel), so events are filtered to the current run on upsert. Returns `[]`
 * until BOTH `runId` and `projectId` are non-null; the effect re-seeds and
 * re-subscribes when either changes, and cleans up on unmount / dep change.
 *
 * The seed MERGES into state rather than replacing it: an artifact minted
 * mid-run can arrive over the live subscription after the seed snapshot was
 * taken but before the seed query resolves, so the seed preserves any such
 * subscription-only id instead of clobbering it (see {@link mergeSeed}).
 *
 * Backs the right-rail Artifacts panel (the reopen surface) and the M5 artifact
 * tab renderer; the durable source of truth is the artifacts DB table.
 *
 * onData payload is AppRouter-inferred (ArtifactChangedEvent) — written as
 * `onData: (event) => …`. NEVER a local event type or `unknown` + shape guard
 * (CLAUDE.md hard rule).
 *
 * Which hook to use: this run-scoped hook is for a specific run's deliverables
 * (e.g. the run right-rail panel scoped to one flow run). For anything keyed by
 * the SESSION-scoped centerPaneStore tab store (RunCenterPane /
 * QuickSessionCenterPane / the quick-session Artifacts rail arm), use
 * {@link useSessionArtifactsList} instead — a run-scoped list paired with a
 * session-keyed tab store lets tabs opened under one run read as "vanished"
 * (and get pruned) the moment the center pane switches to a different run
 * hosted by the same session.
 */
import { useEffect, useState } from 'react';
import { trpc } from '../trpc/client';
import type { Artifact } from '../../../shared/types/artifacts';

export interface UseArtifactsListResult {
  artifacts: Artifact[];
  /**
   * False until the initial `artifacts.list` seed query has resolved (or failed)
   * for the current run; true thereafter. Distinguishes "empty because still
   * loading" from "empty because the run has no artifacts" — the auto-open seed
   * pass MUST wait for this before deciding which artifacts are pre-existing
   * (open silently) vs. freshly minted (steal focus). Resets to false on a
   * run/project change.
   */
  loaded: boolean;
}

/** Upsert by id (replace existing, else append) — keeps created_at ordering stable. */
function upsert(list: Artifact[], next: Artifact): Artifact[] {
  const idx = list.findIndex((a) => a.id === next.id);
  if (idx === -1) return [...list, next];
  const copy = list.slice();
  copy[idx] = next;
  return copy;
}

/**
 * Merge the async seed snapshot into whatever the subscription already delivered,
 * WITHOUT letting the (older) seed override newer subscription state.
 *
 * The seed snapshot is taken on the server BEFORE the query resolves, so an event
 * that fires during the flight is NEWER than the seed for that id. Naively taking
 * the seed for every id it contains would (a) RESURRECT a row deleted mid-flight
 * and (b) DOWNGRADE a row the subscription just committed/updated back to its
 * pre-event shape, with no later event to repair it. So the caller records the
 * ids the subscription touched during the flight (`subUpdatedIds`) and deleted
 * (`subDeletedIds`); this merge:
 *   - drops seed rows whose id the subscription DELETED (no resurrection);
 *   - drops seed rows whose id the subscription UPDATED (prev holds the newer
 *     shape, carried over below);
 *   - keeps everything else in `prev` that the (filtered) seed doesn't represent
 *     — subscription-only ids AND the newer versions of overlapping ids.
 * Seed ordering is preserved; carried-over ids land after it.
 */
function mergeSeed(
  prev: Artifact[],
  rows: Artifact[],
  subUpdatedIds: Set<string>,
  subDeletedIds: Set<string>,
): Artifact[] {
  const seedWins = rows.filter((a) => !subDeletedIds.has(a.id) && !subUpdatedIds.has(a.id));
  const seedWinIds = new Set(seedWins.map((a) => a.id));
  const carriedOver = prev.filter((a) => !seedWinIds.has(a.id) && !subDeletedIds.has(a.id));
  return carriedOver.length === 0 ? seedWins : [...seedWins, ...carriedOver];
}

export function useArtifactsList(
  runId: string | null,
  projectId: number | null,
): UseArtifactsListResult {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    // Nothing to track until both the run and its project are known.
    if (runId === null || projectId === null) {
      setArtifacts([]);
      setLoaded(false);
      return;
    }

    // `cancelled` guards the async seed from landing after a dep change/unmount.
    let cancelled = false;
    // Ids the subscription touched WHILE the seed was in flight — the seed is
    // older than these, so it must not resurrect a delete or downgrade an update.
    let seeded = false;
    const subUpdatedIds = new Set<string>();
    const subDeletedIds = new Set<string>();
    // Reset so a stale list never flashes while the new seed is in flight, and
    // mark the new run's seed as not-yet-loaded.
    setArtifacts([]);
    setLoaded(false);

    void trpc.cyboflow.artifacts.list
      .query({ runId })
      .then((rows) => {
        // Merge (not replace): the seed wins only for ids the subscription did NOT
        // touch mid-flight; newer subscription state (updates/deletes) is preserved.
        if (!cancelled) {
          setArtifacts((prev) => mergeSeed(prev, rows, subUpdatedIds, subDeletedIds));
          seeded = true;
          setLoaded(true);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          console.warn('[useArtifactsList] initial list failed:', err);
          // The seed completed (unsuccessfully); unblock consumers waiting on
          // `loaded` so a fetch error doesn't strand the seed pass forever.
          seeded = true;
          setLoaded(true);
        }
      });

    // Project-scoped change stream. Payload type is inferred from AppRouter
    // (ArtifactChangedEvent) — never a local mirror or `unknown` + guard.
    const sub = trpc.cyboflow.artifacts.onArtifactChanged.subscribe(
      { projectId },
      {
        onData: (event) => {
          // The channel carries every run in the project; ignore other runs.
          if (event.runId !== runId) return;
          if (event.action === 'deleted') {
            if (!seeded) {
              subDeletedIds.add(event.artifactId);
              subUpdatedIds.delete(event.artifactId);
            }
            setArtifacts((prev) => prev.filter((a) => a.id !== event.artifactId));
            return;
          }
          // created / updated / committed all carry the shaped artifact.
          if (event.artifact !== null) {
            const next = event.artifact;
            if (!seeded) {
              subUpdatedIds.add(next.id);
              subDeletedIds.delete(next.id);
            }
            setArtifacts((prev) => upsert(prev, next));
          }
        },
        onError: (err: unknown) =>
          console.warn('[useArtifactsList] onArtifactChanged error:', err),
      },
    );

    return () => {
      cancelled = true;
      sub.unsubscribe();
    };
  }, [runId, projectId]);

  return { artifacts, loaded };
}

/**
 * useSessionArtifactsList — live list of a SESSION's artifacts across ALL its
 * runs (the '__quick__' chat sentinel plus any flow runs it hosted).
 *
 * Identical lifecycle to {@link useArtifactsList} — seeds from
 * `trpc.cyboflow.artifacts.listBySession({ sessionId })`, merges the seed the
 * same way (see {@link mergeSeed}), and stays reactive via the SAME
 * project-scoped `onArtifactChanged` subscription — but filters events by
 * `event.sessionId` instead of `event.runId`, since a session's artifacts can
 * come from more than one run.
 *
 * Use this (rather than the run-scoped `useArtifactsList`) for anything backed
 * by the SESSION-keyed centerPaneStore tab store: RunCenterPane and
 * QuickSessionCenterPane share the same tab-store key (the run's parent
 * session id), so the list feeding their tab-sync effect must be session-
 * scoped too — otherwise a tab opened under one run reads as "vanished" (and
 * gets pruned by useArtifactTabsSync) the instant the center pane switches to
 * a different run hosted by the same session. Run-scoped call sites (e.g. the
 * run right-rail panel scoped to one specific flow run) should keep using
 * `useArtifactsList`.
 */
export function useSessionArtifactsList(
  sessionId: string | null,
  projectId: number | null,
): UseArtifactsListResult {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    // Nothing to track until both the session and its project are known.
    if (sessionId === null || projectId === null) {
      setArtifacts([]);
      setLoaded(false);
      return;
    }

    // `cancelled` guards the async seed from landing after a dep change/unmount.
    let cancelled = false;
    // Ids the subscription touched WHILE the seed was in flight (see mergeSeed).
    let seeded = false;
    const subUpdatedIds = new Set<string>();
    const subDeletedIds = new Set<string>();
    // Reset so a stale list never flashes while the new seed is in flight, and
    // mark the new session's seed as not-yet-loaded.
    setArtifacts([]);
    setLoaded(false);

    void trpc.cyboflow.artifacts.listBySession
      .query({ sessionId })
      .then((rows) => {
        // Merge (not replace): newer subscription state wins over the older seed.
        if (!cancelled) {
          setArtifacts((prev) => mergeSeed(prev, rows, subUpdatedIds, subDeletedIds));
          seeded = true;
          setLoaded(true);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          console.warn('[useSessionArtifactsList] initial list failed:', err);
          // The seed completed (unsuccessfully); unblock consumers waiting on
          // `loaded` so a fetch error doesn't strand the seed pass forever.
          seeded = true;
          setLoaded(true);
        }
      });

    // Project-scoped change stream (shared with useArtifactsList) — filtered to
    // this session's runs via event.sessionId instead of event.runId, since a
    // session's artifacts can span more than one run.
    const sub = trpc.cyboflow.artifacts.onArtifactChanged.subscribe(
      { projectId },
      {
        onData: (event) => {
          // The channel carries every run in the project; ignore other sessions.
          if (event.sessionId !== sessionId) return;
          if (event.action === 'deleted') {
            if (!seeded) {
              subDeletedIds.add(event.artifactId);
              subUpdatedIds.delete(event.artifactId);
            }
            setArtifacts((prev) => prev.filter((a) => a.id !== event.artifactId));
            return;
          }
          // created / updated / committed all carry the shaped artifact.
          if (event.artifact !== null) {
            const next = event.artifact;
            if (!seeded) {
              subUpdatedIds.add(next.id);
              subDeletedIds.delete(next.id);
            }
            setArtifacts((prev) => upsert(prev, next));
          }
        },
        onError: (err: unknown) =>
          console.warn('[useSessionArtifactsList] onArtifactChanged error:', err),
      },
    );

    return () => {
      cancelled = true;
      sub.unsubscribe();
    };
  }, [sessionId, projectId]);

  return { artifacts, loaded };
}
