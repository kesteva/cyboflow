/**
 * artifactLifecycle — (retired) session-close pruning of run artifacts.
 *
 * Under the IDEA-039 artifact lifecycle the reap of a run's UNCOMMITTED
 * artifacts (DB rows + the on-disk `artifacts/runs/<runId>` subtree) moved OFF
 * the session-dismiss path and onto MERGE / create-PR close-out, where it is
 * driven by `ArtifactRouter.reapForRun(projectId, runId)` (wired at the
 * git.ts session-merge + create-PR seams and the legacy runs.merge/createPr
 * seams). A dismiss-without-merge intentionally LEAKS the run's uncommitted
 * artifacts (accepted product decision) — there is no GC sweep. Committed
 * artifacts are snapshotted to the project-root commit store and survive every
 * close-out.
 *
 * The former `pruneSessionOnlyArtifacts(db, sessionId)` helper (the old
 * session-dismiss reap) has been removed; its only caller in ipc/session.ts was
 * deleted alongside it. This module is retained as documentation of where the
 * reap now lives.
 */
export {};
