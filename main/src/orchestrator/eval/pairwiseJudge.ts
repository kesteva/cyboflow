/**
 * pairwiseJudge — the pluggable pairwise A/B judge (slice C), cloned from
 * evalJury.ts. `PairwiseJudgeClient` is the seam the PairwiseJudgeWorker grades
 * through; `ClaudePairwiseJudge` is the ONE v1 implementation. It holds NO SDK
 * import — it takes an injected `PairwiseStructuredQueryFn` (real impl in
 * pairwiseJudgeQuery.ts, a fake in tests) so the prompt-build + defensive-parse
 * logic here is unit-testable with a canned structured object.
 *
 * The worker runs K of these per comparison, each with a randomized
 * `positionAFirst` so position bias cancels in aggregate; the labels the judge
 * sees are neutral ("Solution 1" / "Solution 2") and the worker maps the raw
 * '1'/'2'/'tie' output back to arm identity using the persisted `positionAFirst`.
 *
 * Standalone-typecheck note: imports only the diff-truncation helper (pure), the
 * model-alias helper (pure), the spec-hash helper (node:crypto), and the query-fn
 * type. No SDK, no DB, no electron.
 */
import { truncateDiff } from './evalJury';
import { computeSpecHash } from '../specHash';
import type { PairwiseStructuredQueryFn } from './pairwiseJudgeQuery';
import type { LoggerLike } from '../types';
import { resolveModelAlias } from '../../services/panels/claude/modelContext';

/** The app's default Opus alias — the v1 pairwise judge model (resolved to a concrete id). */
export const DEFAULT_PAIRWISE_JUDGE_MODEL_ALIAS = 'opus';

// ---------------------------------------------------------------------------
// PairwiseJudgeClient seam
// ---------------------------------------------------------------------------

export interface PairwiseGradeInput {
  /** Frozen unified diff for arm A. */
  diffA: string;
  /** Frozen unified diff for arm B. */
  diffB: string;
  /** Optional seed-idea body (the task goal) for idea-seeded experiments. */
  seedContext?: string;
  /** When true, arm A is presented as "Solution 1"; when false, arm B is. */
  positionAFirst: boolean;
  /** Optional deterministic diff-stats summary lines. */
  statsA?: string;
  statsB?: string;
  signal?: AbortSignal;
}

/** The raw pairwise verdict a single judge sample emits (neutral labels). */
export interface PairwiseRawResult {
  preference: '1' | '2' | 'tie';
  confidence: number; // 0..1
  rationale: string;
}

export interface PairwiseJudgeClient {
  readonly name: string;
  /** The concrete resolved model id (persisted as judge_model), when known. */
  readonly resolvedModel?: string;
  /** Grade one sample. Throws on a malformed/unusable result (worker retries once). */
  grade(input: PairwiseGradeInput): Promise<PairwiseRawResult>;
}

// ---------------------------------------------------------------------------
// Structured-output schema (SDK json_schema)
// ---------------------------------------------------------------------------

/**
 * The verdict object each pairwise sample must emit. Kept permissive on the
 * preference token (the parser normalizes 'A'/'first'/etc.) but shaped so the SDK
 * steers the model to the right skeleton.
 */
export const PAIRWISE_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['preference', 'confidence', 'rationale'],
  properties: {
    preference: { type: 'string', enum: ['1', '2', 'tie'] },
    confidence: { type: 'number' },
    rationale: { type: 'string' },
  },
};

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

/**
 * The RUN-INDEPENDENT scaffold that prompt_hash fingerprints. Kept as one string
 * so a scoring-contract edit changes the hash (mirrors judgeStaticPromptText).
 */
const PAIRWISE_PREAMBLE = [
  'You are an impartial code-review judge comparing two candidate solutions to the',
  'same task. You will be shown Solution 1 and Solution 2 as unified diffs. Judge',
  'which solution is the better implementation overall — correctness, robustness,',
  'design, maintainability, test coverage, and scope discipline all matter.',
  '',
  'Rules:',
  '- Judge ONLY the diffs (and the task goal, if given). Do not assume unshown code.',
  '- Neither position implies quality: "Solution 1" is not favored over "Solution 2".',
  '- If the two are genuinely equivalent (or both empty/trivial), answer "tie".',
].join('\n');

const PAIRWISE_OUTPUT_INSTRUCTIONS = [
  'Respond with a single JSON object:',
  '  preference:  "1" (Solution 1 is better), "2" (Solution 2 is better), or "tie".',
  '  confidence:  a calibrated number in [0,1] (how sure you are of the preference;',
  '               use a low value for a marginal call, near 0 for a genuine tie).',
  '  rationale:   one or two sentences justifying the preference, citing concrete',
  '               differences between the two diffs.',
].join('\n');

/**
 * Build the pairwise judge prompt. Pure function of its inputs (so a given
 * (diffA, diffB, seed, positionAFirst) always produces the same prompt). Solution
 * 1 = arm A iff `positionAFirst`, else arm B; each diff is truncated via the
 * shared `truncateDiff` (200k cap).
 */
export function buildPairwisePrompt(input: PairwiseGradeInput): string {
  const { positionAFirst } = input;
  // Solution 1 / Solution 2 are the (diff, stats) of A/B depending on orientation.
  const first = positionAFirst
    ? { diff: input.diffA, stats: input.statsA }
    : { diff: input.diffB, stats: input.statsB };
  const second = positionAFirst
    ? { diff: input.diffB, stats: input.statsB }
    : { diff: input.diffA, stats: input.statsA };

  const firstTrunc = truncateDiff(first.diff);
  const secondTrunc = truncateDiff(second.diff);

  const lines: string[] = [PAIRWISE_PREAMBLE, ''];

  if (input.seedContext && input.seedContext.trim().length > 0) {
    lines.push('===== TASK GOAL =====', input.seedContext.trim(), '');
  }

  lines.push('===== SOLUTION 1 =====');
  if (first.stats) lines.push(`DIFF STATS: ${first.stats}`);
  if (firstTrunc.truncated) lines.push('NOTE: this diff is TRUNCATED.');
  lines.push(firstTrunc.text, '');

  lines.push('===== SOLUTION 2 =====');
  if (second.stats) lines.push(`DIFF STATS: ${second.stats}`);
  if (secondTrunc.truncated) lines.push('NOTE: this diff is TRUNCATED.');
  lines.push(secondTrunc.text, '');

  lines.push('===== OUTPUT =====', PAIRWISE_OUTPUT_INSTRUCTIONS);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Defensive parser
// ---------------------------------------------------------------------------

/** Normalize a preference token to '1' | '2' | 'tie'. Returns null on garbage. */
function normalizePreference(raw: unknown): '1' | '2' | 'tie' | null {
  if (typeof raw !== 'string') return null;
  const token = raw.trim().toLowerCase();
  if (token === '1' || token === 'a' || token === 'first' || token === 'solution 1') return '1';
  if (token === '2' || token === 'b' || token === 'second' || token === 'solution 2') return '2';
  if (token === 'tie' || token === 'draw' || token === 'equal' || token === 'neither') return 'tie';
  return null;
}

/**
 * Defensively parse a raw structured-output object into a PairwiseRawResult.
 * THROWS on an unusable result (not an object, unrecognized preference, or a
 * non-string rationale) so the worker treats it as a malformed sample (retry
 * once, then drop). Confidence is clamped to [0,1]; a non-finite confidence
 * defaults to 0.5.
 */
export function parsePairwiseSample(raw: unknown): PairwiseRawResult {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('pairwise sample is not an object');
  }
  const rec = raw as Record<string, unknown>;

  const preference = normalizePreference(rec.preference);
  if (!preference) {
    throw new Error('pairwise sample has no recognizable preference');
  }

  if (typeof rec.rationale !== 'string') {
    throw new Error('pairwise sample has no string rationale');
  }
  const rationale = rec.rationale;

  let confidence = typeof rec.confidence === 'number' && Number.isFinite(rec.confidence)
    ? rec.confidence
    : 0.5;
  if (confidence < 0) confidence = 0;
  if (confidence > 1) confidence = 1;

  return { preference, confidence, rationale };
}

// ---------------------------------------------------------------------------
// Prompt-hash content address
// ---------------------------------------------------------------------------

/**
 * The prompt-hash content address: the sha256 of the FULL run-independent
 * pairwise scaffold (preamble + output instructions), not the diffs — so a
 * preamble edit that changes judge behavior actually changes the hash (mirrors
 * computeJudgePromptHash).
 */
export function computePairwisePromptHash(): string {
  return computeSpecHash(`${PAIRWISE_PREAMBLE}\n\n${PAIRWISE_OUTPUT_INSTRUCTIONS}`);
}

// ---------------------------------------------------------------------------
// ClaudePairwiseJudge — the one v1 implementation
// ---------------------------------------------------------------------------

export interface ClaudePairwiseJudgeDeps {
  /** The SDK query fn (real impl in pairwiseJudgeQuery.ts; a fake in tests). */
  structuredQuery: PairwiseStructuredQueryFn;
  logger?: LoggerLike;
  /** Judge model alias/id; defaults to Opus. Resolved via resolveModelAlias. */
  model?: string;
}

export class ClaudePairwiseJudge implements PairwiseJudgeClient {
  readonly name = 'claude-pairwise';
  /** The concrete resolved model id the judge pins (persisted as judge_model). */
  readonly resolvedModel: string | undefined;
  private readonly deps: ClaudePairwiseJudgeDeps;

  constructor(deps: ClaudePairwiseJudgeDeps) {
    this.deps = deps;
    this.resolvedModel = resolveModelAlias(deps.model ?? DEFAULT_PAIRWISE_JUDGE_MODEL_ALIAS);
  }

  async grade(input: PairwiseGradeInput): Promise<PairwiseRawResult> {
    const prompt = buildPairwisePrompt(input);
    const raw = await this.deps.structuredQuery({
      prompt,
      schema: PAIRWISE_OUTPUT_SCHEMA,
      ...(this.resolvedModel ? { model: this.resolvedModel } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return parsePairwiseSample(raw);
  }
}
