/**
 * judgeConcurrency — a process-wide ceiling on how many eval JUDGE subprocesses
 * may spawn AT ONCE, split into two lanes so normal runs grade fast while A/B
 * experiments stay gentle on CPU.
 *
 * Two things spawn judge subprocesses: EvalWorker (the rubric jury — 2×Claude +
 * 1×Codex) and PairwiseJudgeWorker (the A/B pairwise judge). They run
 * CONCURRENTLY with each other, and each Claude juror greps the live worktree
 * over many turns, so when a side-by-side A/B experiment settles you get a burst
 * of heavy subprocesses right as the user opens the just-settled session — the
 * reported "loading an A/B session is laggy". A normal (non-experiment) run has
 * no pairwise worker and only ever settles one run's rubric eval at a time, so
 * it can afford to grade its jurors in parallel.
 *
 * Hence two lanes:
 *   - 'normal' (default concurrency 3) — a non-experiment run's rubric jury; run
 *     the jurors in parallel so the eval score lands ~3× sooner.
 *   - 'ab' (default concurrency 1) — a side-by-side experiment arm's rubric eval
 *     AND every pairwise sample; fully serialized so an A/B settle spawns at most
 *     one judge subprocess at a time.
 * The lanes are independent limiters, so a background normal eval never steals
 * the A/B lane's serialization (and vice-versa). Override either default with
 * CYBOFLOW_EVAL_JUDGE_CONCURRENCY / CYBOFLOW_EVAL_JUDGE_CONCURRENCY_AB.
 *
 * Pure utility (only p-queue) — imports no concrete service, so both workers can
 * depend on it while staying standalone-typecheckable (mirrors scoring.ts).
 */
import PQueue from 'p-queue';

/** Which concurrency lane a judge grade belongs to (see module docs). */
export type JudgeLane = 'normal' | 'ab';

/** Parallel jurors for a normal run; serialized spawns for an A/B settle. */
const DEFAULT_NORMAL_CONCURRENCY = 3;
const DEFAULT_AB_CONCURRENCY = 1;

function resolveConcurrency(envName: string, fallback: number): number {
  const raw = process.env[envName];
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

const limiters: Record<JudgeLane, PQueue | null> = { normal: null, ab: null };

/** Lazily construct the per-lane limiter (concurrency fixed at first use). */
function limiterFor(lane: JudgeLane): PQueue {
  const existing = limiters[lane];
  if (existing !== null) return existing;
  const concurrency =
    lane === 'ab'
      ? resolveConcurrency('CYBOFLOW_EVAL_JUDGE_CONCURRENCY_AB', DEFAULT_AB_CONCURRENCY)
      : resolveConcurrency('CYBOFLOW_EVAL_JUDGE_CONCURRENCY', DEFAULT_NORMAL_CONCURRENCY);
  const created = new PQueue({ concurrency });
  limiters[lane] = created;
  return created;
}

/**
 * Run one judge grade behind its lane's concurrency ceiling. Transparent to the
 * caller: resolves with the grade's value and rejects with its error (the workers
 * keep their own retry/try-catch around this). No timeout options are passed, so
 * the queued task always resolves the fn's `T` — the `| void` in p-queue's `add`
 * typing only arises with `throwOnTimeout: false`, which we never use.
 */
export function runJudgeGrade<T>(lane: JudgeLane, fn: () => Promise<T>): Promise<T> {
  return limiterFor(lane).add(fn) as Promise<T>;
}
