/**
 * judgePromptScaffold — the RUN-INDEPENDENT text of the judge prompt: the
 * independent-judge framing + scoring-contract preamble, the serialized rubric,
 * and the output-format instructions. Split out of evalJury so BOTH the prompt
 * builder AND the prompt-hash (snapshotRunForEval.computeJudgePromptHash) share ONE
 * source of truth — otherwise a change to the scoring-contract preamble alters
 * judge behavior while prompt_hash (a rubric-only fingerprint) stays identical, and
 * provenance comparisons silently lie.
 *
 * Pure leaf: imports ONLY the rubric (pure data) so snapshotRunForEval can hash it
 * without breaking its standalone-typecheck invariant (no services import).
 */
import { RUBRIC, serializeRubricForPrompt, type Rubric } from './rubric';

/** Static intro + SCORING CONTRACT lines (everything before the rubric block). */
export const JUDGE_PROMPT_PREAMBLE_LINES: readonly string[] = [
  'You are an INDEPENDENT, OUT-OF-LOOP code-review judge. You did not write this',
  'code and are not in the authoring loop. Grade the frozen pre-human diff below',
  'against the rubric. You have the full frozen repo snapshot as your working',
  'directory when tools are available — GREP/OPEN it to settle a check before',
  'marking UNKNOWN for a "not visible" reason. UNKNOWN is only for genuinely',
  'external deps or runtime state not derivable from the snapshot.',
  '',
  'SCORING CONTRACT:',
  '- For every APPLICABLE sub-check emit exactly one verdict: PASS | FAIL | UNKNOWN | NOT_APPLICABLE.',
  "- NOT_APPLICABLE when the sub-check's APPLIES condition does not hold (excluded entirely).",
  '- UNKNOWN only for an applicable check you genuinely cannot settle from the snapshot.',
  '- Cite concrete evidence (file + line + the rule it violates) for every FAIL.',
  '- Surface any catastrophic-class failure (cap=overall_fair_cap sub-checks, or a',
  '  high/critical security vuln) as a FAIL AND a findings[] entry with catastrophic=true —',
  '  never soften or omit it.',
  '- In findings[], set netNew=true only for issues you believe are not already tracked.',
];

/** Static output-format instructions (everything after the diff, under OUTPUT). */
export const JUDGE_PROMPT_OUTPUT_LINES: readonly string[] = [
  'Return ONLY the structured object: { verdicts: [{ id, verdict, evidence }], findings: [...] }.',
  'Include a verdict for every applicable sub-check id from the rubric above.',
];

/**
 * The run-independent judge-prompt skeleton (preamble + rubric + output format).
 * This — NOT the rubric alone — is what prompt_hash fingerprints, so a preamble or
 * output-format edit changes the hash and provenance drift is detectable.
 */
export function judgeStaticPromptText(rubric: Rubric = RUBRIC): string {
  return [
    ...JUDGE_PROMPT_PREAMBLE_LINES,
    '',
    '===== RUBRIC =====',
    serializeRubricForPrompt(rubric),
    '',
    '===== OUTPUT =====',
    ...JUDGE_PROMPT_OUTPUT_LINES,
  ].join('\n');
}
