/**
 * useSessionMetrics — live metadata for the QuickSessionCanvas session node.
 *
 * A quick session (a session with NO active workflow run) renders as a single
 * graph node showing four live metrics: elapsed time, tokens used, files seen,
 * and the working diff (+added / −deleted). This hook surfaces those plus the
 * session's model and branch.
 *
 *   - elapsed: ticks every 1s, derived client-side from `session.createdAt` (the
 *     session is alive for as long as the node is shown, so the clock keeps
 *     running). Never animated — just a number — so it ignores reduced-motion.
 *   - tokens / filesSeen / diff / model / branch: snapshot-polled from
 *     `API.sessions.getStatistics` (the SAME aggregation SessionStats uses —
 *     session_outputs token sums + execution_diffs line/file stats). Polled on a
 *     short cadence so the node tracks the running chat without a stream wire.
 *
 * Returns formatted display strings (elapsed "4m 12s", tokens "12.4k") plus the
 * raw diff/files numbers so the canvas can colour the diff (+ green / − rust)
 * only once it is non-zero.
 */
import { useEffect, useRef, useState } from 'react';
import { API } from '../utils/api';
import type { Session } from '../types/session';

// ---------------------------------------------------------------------------
// getStatistics response — narrow to the fields this hook consumes. The IPC
// surface is typed `unknown` (see frontend/src/types/electron.d.ts); SessionStats
// casts the same way. We validate defensively before reading.
// ---------------------------------------------------------------------------

interface StatisticsShape {
  session?: { model?: string | null; branch?: string | null };
  tokens?: { totalInputTokens?: number; totalOutputTokens?: number };
  files?: {
    totalFilesChanged?: number;
    totalLinesAdded?: number;
    totalLinesDeleted?: number;
  };
}

function isStatisticsShape(value: unknown): value is StatisticsShape {
  return typeof value === 'object' && value !== null;
}

export interface SessionMetrics {
  /** Elapsed wall-clock since session creation, e.g. "4m 12s". */
  elapsed: string;
  /** Cumulative tokens (input + output), e.g. "12.4k". */
  tokens: string;
  /** Distinct files touched in the session worktree. */
  filesSeen: number;
  /** Working diff line counts; both 0 until the agent edits something. */
  diff: { plus: number; minus: number };
  /** Resolved model name (e.g. "sonnet 4.5"), or null when unknown. */
  model: string | null;
  /** Worktree branch (e.g. "quick-20260607-…"), or null when unknown. */
  branch: string | null;
}

/** Re-poll cadence for the snapshot metrics (tokens / files / diff). */
const STATS_POLL_MS = 5000;
/** Re-compute cadence for the elapsed clock. */
const ELAPSED_TICK_MS = 1000;

/** Last path segment of a worktree path, used as a branch fallback. */
function worktreeBasename(p: string | undefined | null): string | null {
  if (!p) return null;
  const trimmed = p.replace(/[/\\]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/** Format an elapsed millisecond span as a compact "Xh Ym" / "Xm Ys" / "Xs". */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** Format a token count as "936" / "12.4k" / "1.2M" (trailing .0 trimmed). */
export function formatTokenCount(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

export function useSessionMetrics(session: Session | null): SessionMetrics {
  const createdAt = session?.createdAt ?? null;
  const sessionId = session?.id ?? null;

  // Elapsed — derived from createdAt, recomputed on a 1s tick.
  const [elapsedMs, setElapsedMs] = useState<number>(() =>
    createdAt ? Date.now() - new Date(createdAt).getTime() : 0,
  );

  useEffect(() => {
    if (createdAt === null) {
      setElapsedMs(0);
      return;
    }
    const base = new Date(createdAt).getTime();
    const tick = () => setElapsedMs(Date.now() - base);
    tick();
    const id = window.setInterval(tick, ELAPSED_TICK_MS);
    return () => window.clearInterval(id);
  }, [createdAt]);

  // Snapshot metrics — polled from getStatistics.
  const [stats, setStats] = useState<StatisticsShape | null>(null);
  // Guard against a late response from a previous session overwriting the new one.
  const sessionIdRef = useRef<string | null>(sessionId);
  sessionIdRef.current = sessionId;

  useEffect(() => {
    if (sessionId === null) {
      setStats(null);
      return;
    }
    let cancelled = false;

    const load = async () => {
      try {
        const res = await API.sessions.getStatistics(sessionId);
        if (cancelled || sessionIdRef.current !== sessionId) return;
        if (res.success && isStatisticsShape(res.data)) {
          setStats(res.data);
        }
      } catch {
        // Best-effort: keep the last known snapshot on a transient failure.
      }
    };

    void load();
    const id = window.setInterval(() => void load(), STATS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [sessionId]);

  const inputTokens = stats?.tokens?.totalInputTokens ?? 0;
  const outputTokens = stats?.tokens?.totalOutputTokens ?? 0;
  const model = stats?.session?.model ?? null;
  const branch =
    stats?.session?.branch ?? worktreeBasename(session?.worktreePath) ?? session?.baseBranch ?? null;

  return {
    elapsed: formatElapsed(elapsedMs),
    tokens: formatTokenCount(inputTokens + outputTokens),
    filesSeen: stats?.files?.totalFilesChanged ?? 0,
    diff: {
      plus: stats?.files?.totalLinesAdded ?? 0,
      minus: stats?.files?.totalLinesDeleted ?? 0,
    },
    model,
    branch,
  };
}
