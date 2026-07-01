/**
 * evalJury — the pluggable jury. `JudgeClient` is the seam the EvalWorker grades
 * through; `ClaudeJudge` is the ONE v1 implementation (Claude-only, per the rubric
 * "Grader (v1)"). A non-Claude juror is future config and is NOT required to ship.
 *
 * ClaudeJudge holds NO SDK import — it takes an injected `EvalStructuredQueryFn`
 * (real impl in evalJudgeQuery.ts, a fake in tests) so the prompt-build +
 * defensive-parse logic here is unit-testable with a canned structured object. The
 * worker runs K of these per eval; a malformed sample throws so the worker can
 * retry-once-then-drop.
 *
 * Standalone-typecheck note: imports only the rubric (pure data), the scoring
 * types (pure), the model-alias helper (pure), and the query-fn type. No SDK, no
 * DB, no electron.
 */
import { RUBRIC, serializeRubricForPrompt, type DimensionKey } from './rubric';
import {
  VERDICTS,
  type Verdict,
  type SubCheckVerdict,
  type JudgeFinding,
  type JudgeSample,
  type GateResults,
} from './scoring';
import type { EvalStructuredQueryFn } from './evalJudgeQuery';
import type { LoggerLike } from '../types';
import { resolveModelAlias } from '../../services/panels/claude/modelContext';

/** The app's default Opus alias — the v1 judge model (resolved to a concrete id). */
export const DEFAULT_JUDGE_MODEL_ALIAS = 'opus';

/**
 * Deterministic diff-truncation cap (characters). A very large diff is truncated
 * at a stable byte boundary with an explicit in-prompt note so prompt_hash-adjacent
 * behavior stays reproducible and the judge is told the snapshot is partial (it can
 * still grep the worktree for the elided hunks when cwd is present).
 */
export const MAX_DIFF_CHARS = 200_000;

// ---------------------------------------------------------------------------
// JudgeClient seam
// ---------------------------------------------------------------------------

export interface JudgeGradeInput {
  /** The frozen unified diff captured at trigger. */
  diff: string;
  /** Deterministic aggregate stats line for context (optional). */
  diffStatsSummary?: string;
  /** The deterministic gate outcome, when known. */
  gateResults?: GateResults | null;
  /** The run's worktree path, when it still exists (enables read-only grep). */
  cwd?: string;
  /** Concrete model id to pin; falls to the query-fn/SDK default when absent. */
  model?: string;
  signal?: AbortSignal;
}

export interface JudgeClient {
  readonly name: string;
  /** Grade one sample. Throws on a malformed/unusable result (worker retries once). */
  grade(input: JudgeGradeInput): Promise<JudgeSample>;
}

// ---------------------------------------------------------------------------
// Structured-output schema (SDK json_schema)
// ---------------------------------------------------------------------------

/**
 * The verdict object each jury sample must emit. Kept intentionally permissive on
 * strings (the parser normalizes verdict tokens defensively) but shaped so the SDK
 * steers the model to the right skeleton.
 */
export const JUDGE_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'verdict', 'evidence'],
        properties: {
          id: { type: 'string' },
          verdict: { type: 'string', enum: [...VERDICTS] },
          evidence: { type: 'string' },
        },
      },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'severity'],
        properties: {
          subCheckId: { type: 'string' },
          dimension: { type: 'string' },
          severity: { type: 'string', enum: ['info', 'warning', 'error'] },
          title: { type: 'string' },
          body: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'number' },
          netNew: { type: 'boolean' },
          catastrophic: { type: 'boolean' },
        },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

const VALID_DIMENSIONS: ReadonlySet<string> = new Set<DimensionKey>([
  'correctness',
  'security',
  'robustness',
  'design',
  'maintainability',
  'tests',
  'scope',
]);

/** Deterministically truncate a diff to MAX_DIFF_CHARS with an explicit note. */
export function truncateDiff(diff: string): { text: string; truncated: boolean } {
  if (diff.length <= MAX_DIFF_CHARS) return { text: diff, truncated: false };
  const head = diff.slice(0, MAX_DIFF_CHARS);
  return {
    text: `${head}\n\n[... diff truncated at ${MAX_DIFF_CHARS} chars of ${diff.length}; grep the worktree snapshot for elided hunks ...]`,
    truncated: true,
  };
}

function renderGate(gate: GateResults | null | undefined): string {
  if (!gate) {
    return 'GATE RESULTS: none available for this run (treat as NOT a hard failure — absent != failed).';
  }
  const parts = (['build', 'test', 'typecheck', 'lint'] as const).map(
    (k) => `${k}=${gate[k] ?? 'unknown'}`,
  );
  return `GATE RESULTS: ${parts.join(' ')}`;
}

/**
 * Build the judge prompt: the serialized rubric (whose text feeds prompt_hash) +
 * the diff (truncated) + gate results + strict output instructions. Pure function
 * of its inputs so a given (rubric, diff, gate) always produces the same prompt.
 */
export function buildJudgePrompt(input: JudgeGradeInput): string {
  const { text: diffText, truncated } = truncateDiff(input.diff);
  const lines: string[] = [];

  lines.push(
    'You are an INDEPENDENT, OUT-OF-LOOP code-review judge. You did not write this',
    'code and are not in the authoring loop. Grade the frozen pre-human diff below',
    'against the rubric. You have the full frozen repo snapshot as your working',
    'directory when tools are available — GREP/OPEN it to settle a check before',
    'marking UNKNOWN for a "not visible" reason. UNKNOWN is only for genuinely',
    'external deps or runtime state not derivable from the snapshot.',
    '',
    'SCORING CONTRACT:',
    '- For every APPLICABLE sub-check emit exactly one verdict: PASS | FAIL | UNKNOWN | NOT_APPLICABLE.',
    '- NOT_APPLICABLE when the sub-check\'s APPLIES condition does not hold (excluded entirely).',
    '- UNKNOWN only for an applicable check you genuinely cannot settle from the snapshot.',
    '- Cite concrete evidence (file + line + the rule it violates) for every FAIL.',
    '- Surface any catastrophic-class failure (cap=overall_fair_cap sub-checks, or a',
    '  high/critical security vuln) as a FAIL AND a findings[] entry with catastrophic=true —',
    '  never soften or omit it.',
    '- In findings[], set netNew=true only for issues you believe are not already tracked.',
    '',
    '===== RUBRIC =====',
    serializeRubricForPrompt(RUBRIC),
    '',
    '===== ' + renderGate(input.gateResults) + ' =====',
  );

  if (input.diffStatsSummary) {
    lines.push(`DIFF STATS: ${input.diffStatsSummary}`);
  }
  if (truncated) {
    lines.push('NOTE: the diff below is TRUNCATED — grep the snapshot for elided hunks.');
  }

  lines.push(
    '',
    '===== FROZEN DIFF (pre-human) =====',
    diffText,
    '',
    '===== OUTPUT =====',
    'Return ONLY the structured object: { verdicts: [{ id, verdict, evidence }], findings: [...] }.',
    'Include a verdict for every applicable sub-check id from the rubric above.',
  );

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Defensive parser
// ---------------------------------------------------------------------------

function normalizeVerdict(raw: unknown): Verdict | null {
  if (typeof raw !== 'string') return null;
  const token = raw.trim().toUpperCase().replace(/[\s/_-]+/g, '_');
  if ((VERDICTS as readonly string[]).includes(token)) return token as Verdict;
  // Common near-misses the model may emit.
  if (token === 'NA' || token === 'N_A' || token === 'NOTAPPLICABLE') return 'NOT_APPLICABLE';
  if (token === 'YES' || token === 'PASSED') return 'PASS';
  if (token === 'NO' || token === 'FAILED') return 'FAIL';
  return null;
}

function parseVerdicts(raw: unknown): SubCheckVerdict[] {
  if (!Array.isArray(raw)) return [];
  const out: SubCheckVerdict[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const id = typeof rec.id === 'string' ? rec.id.trim() : '';
    if (!id || seen.has(id)) continue; // drop dupes deterministically (first wins)
    const verdict = normalizeVerdict(rec.verdict);
    if (!verdict) continue;
    seen.add(id);
    out.push({
      id,
      verdict,
      evidence: typeof rec.evidence === 'string' ? rec.evidence : '',
    });
  }
  return out;
}

function parseFindings(raw: unknown): JudgeFinding[] {
  if (!Array.isArray(raw)) return [];
  const out: JudgeFinding[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const title = typeof rec.title === 'string' ? rec.title.trim() : '';
    if (!title) continue; // a finding with no title is unusable
    const severityRaw = typeof rec.severity === 'string' ? rec.severity.toLowerCase() : 'warning';
    const severity: JudgeFinding['severity'] =
      severityRaw === 'error' || severityRaw === 'info' ? severityRaw : 'warning';
    const dimRaw = typeof rec.dimension === 'string' ? rec.dimension.toLowerCase() : '';
    const dimension = (VALID_DIMENSIONS.has(dimRaw) ? dimRaw : 'correctness') as DimensionKey;
    out.push({
      subCheckId: typeof rec.subCheckId === 'string' ? rec.subCheckId : '',
      dimension,
      severity,
      title,
      body: typeof rec.body === 'string' ? rec.body : '',
      ...(typeof rec.file === 'string' && rec.file ? { file: rec.file } : {}),
      ...(typeof rec.line === 'number' && Number.isFinite(rec.line) ? { line: rec.line } : {}),
      netNew: rec.netNew !== false, // default to net-new unless explicitly false
      catastrophic: rec.catastrophic === true,
    });
  }
  return out;
}

/**
 * Defensively parse a raw structured-output object into a JudgeSample. THROWS on
 * an unusable result (not an object, or zero valid verdicts) so the worker treats
 * it as a malformed sample (retry once, then drop). A sample with >=1 valid verdict
 * and any garbage findings is salvaged (findings are best-effort).
 */
export function parseJudgeSample(raw: unknown): JudgeSample {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('judge sample is not an object');
  }
  const rec = raw as Record<string, unknown>;
  const verdicts = parseVerdicts(rec.verdicts);
  if (verdicts.length === 0) {
    throw new Error('judge sample has zero valid verdicts');
  }
  return { verdicts, findings: parseFindings(rec.findings) };
}

// ---------------------------------------------------------------------------
// ClaudeJudge — the one v1 implementation
// ---------------------------------------------------------------------------

export interface ClaudeJudgeDeps {
  /** The SDK query fn (real impl in evalJudgeQuery.ts; a fake in tests). */
  structuredQuery: EvalStructuredQueryFn;
  logger?: LoggerLike;
  /** Judge model alias/id; defaults to the app's Opus. Resolved via resolveModelAlias. */
  model?: string;
}

export class ClaudeJudge implements JudgeClient {
  readonly name = 'claude';
  /** The concrete resolved model id the jury pins (persisted as judge_model). */
  readonly resolvedModel: string | undefined;
  private readonly deps: ClaudeJudgeDeps;

  constructor(deps: ClaudeJudgeDeps) {
    this.deps = deps;
    this.resolvedModel = resolveModelAlias(deps.model ?? DEFAULT_JUDGE_MODEL_ALIAS);
  }

  async grade(input: JudgeGradeInput): Promise<JudgeSample> {
    const prompt = buildJudgePrompt(input);
    const raw = await this.deps.structuredQuery({
      prompt,
      schema: JUDGE_OUTPUT_SCHEMA,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(this.resolvedModel ? { model: this.resolvedModel } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return parseJudgeSample(raw);
  }
}
