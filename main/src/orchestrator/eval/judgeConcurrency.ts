/**
 * judgeConcurrency — a process-wide ceiling on how many eval JUDGE subprocesses
 * may spawn AT ONCE, shared across BOTH eval workers.
 *
 * EvalWorker (rubric jury) and PairwiseJudgeWorker (A/B pairwise) each own their
 * own concurrency-1 PQueue and grade serially, but they run CONCURRENTLY with
 * each other by design. So when an A/B experiment settles, up to two heavy LLM
 * judge subprocesses spawn at the same moment — each Claude juror greps the live
 * worktree over many turns, each Codex juror spawns an app-server — and that
 * lands exactly when the user is opening the just-settled session, showing up as
 * UI lag.
 *
 * Routing every `judge.grade()` call through one shared limiter caps that peak
 * without touching either worker's own serialization. Default concurrency 1 fully
 * serializes judge spawns across the two workers (trading a little verdict latency
 * for lower CPU during the settle window). Override via
 * CYBOFLOW_EVAL_JUDGE_CONCURRENCY (integer ≥ 1) to allow more overlap.
 *
 * Pure utility (only p-queue) — imports no concrete service, so both workers can
 * depend on it while staying standalone-typecheckable (mirrors scoring.ts).
 */
import PQueue from 'p-queue';

/** Fully-serialized default: at most one judge subprocess in flight app-wide. */
const DEFAULT_JUDGE_CONCURRENCY = 1;

function resolveConcurrency(): number {
  const raw = process.env.CYBOFLOW_EVAL_JUDGE_CONCURRENCY;
  if (raw === undefined) return DEFAULT_JUDGE_CONCURRENCY;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_JUDGE_CONCURRENCY;
}

let limiter: PQueue | null = null;

/** Lazily construct the shared limiter (concurrency fixed at first use). */
function getLimiter(): PQueue {
  if (limiter === null) limiter = new PQueue({ concurrency: resolveConcurrency() });
  return limiter;
}

/**
 * Run one judge grade behind the shared concurrency ceiling. Transparent to the
 * caller: resolves with the grade's value and rejects with its error (the workers
 * keep their own retry/try-catch around this). No timeout options are passed, so
 * the queued task always resolves the fn's `T` — the `| void` in p-queue's `add`
 * typing only arises with `throwOnTimeout: false`, which we never use.
 */
export function runJudgeGrade<T>(fn: () => Promise<T>): Promise<T> {
  return getLimiter().add(fn) as Promise<T>;
}
