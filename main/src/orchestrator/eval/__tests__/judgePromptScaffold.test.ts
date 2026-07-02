/**
 * Unit tests for judgePromptScaffold + the jury's structured-output schema.
 *
 * The contract these lock down (per the B1 "K=3→K<3 schema-drift degradation"
 * retirement):
 *  - the RUN-INDEPENDENT judge-prompt skeleton (judgeStaticPromptText) embeds
 *    EVERY rubric sub-check id, so the judge is told exactly which ids to emit a
 *    verdict for — a rubric id present in the schema-space but absent from the
 *    prompt (or vice-versa) is silent K-sample degradation;
 *  - the skeleton is a PURE function of the rubric (it feeds run_evals.prompt_hash,
 *    so two calls must be byte-identical and a preamble edit must change it);
 *  - the JUDGE_OUTPUT_SCHEMA verdict enum stays pinned to VERDICTS and its shape
 *    is snapshot-locked (the shape IS the contract — the one sanctioned snapshot).
 *
 * Note (adapted from the plan): the schema's per-verdict `id` is intentionally a
 * permissive `string` (the parser normalizes ids defensively) — it does NOT
 * enumerate the rubric sub-check ids. The real "no-drift" invariant therefore
 * lives in the PROMPT (which lists every id), asserted below.
 */
import { describe, it, expect } from 'vitest';
import {
  judgeStaticPromptText,
  JUDGE_PROMPT_PREAMBLE_LINES,
  JUDGE_PROMPT_OUTPUT_LINES,
} from '../judgePromptScaffold';
import { RUBRIC, allSubChecks } from '../rubric';
import { JUDGE_OUTPUT_SCHEMA } from '../evalJury';
import { VERDICTS } from '../scoring';

describe('judgeStaticPromptText', () => {
  it('embeds every rubric sub-check id (no prompt↔rubric drift)', () => {
    const text = judgeStaticPromptText();
    for (const check of allSubChecks(RUBRIC)) {
      expect(text.includes(check.id)).toBe(true);
    }
    // Sanity: all 58 sub-checks are present (7 dimensions, 9+9+8+7+8+9+8).
    expect(allSubChecks(RUBRIC)).toHaveLength(58);
  });

  it('is a pure function of the rubric — two calls are byte-identical (prompt_hash stability)', () => {
    expect(judgeStaticPromptText()).toBe(judgeStaticPromptText());
  });

  it('includes the preamble, output, and section-marker scaffolding in order', () => {
    const text = judgeStaticPromptText();
    // Every static preamble/output line is present verbatim.
    for (const line of [...JUDGE_PROMPT_PREAMBLE_LINES, ...JUDGE_PROMPT_OUTPUT_LINES]) {
      if (line.length === 0) continue; // blank spacer lines are not distinctive
      expect(text.includes(line)).toBe(true);
    }
    expect(text.includes('===== RUBRIC =====')).toBe(true);
    expect(text.includes('===== OUTPUT =====')).toBe(true);
    // The scoring-contract preamble MUST precede the rubric block (framing before data).
    expect(text.indexOf('SCORING CONTRACT:')).toBeLessThan(text.indexOf('===== RUBRIC ====='));
    // ...and the rubric MUST precede the output-format block.
    expect(text.indexOf('===== RUBRIC =====')).toBeLessThan(text.indexOf('===== OUTPUT ====='));
  });

  it('changes when the rubric changes (a version bump alters the hashed text)', () => {
    const base = judgeStaticPromptText();
    const bumped = judgeStaticPromptText({ ...RUBRIC, version: 'test-9.9' });
    expect(bumped).not.toBe(base);
    expect(bumped.includes('test-9.9')).toBe(true);
  });
});

describe('JUDGE_OUTPUT_SCHEMA', () => {
  it('pins the per-verdict enum to the canonical VERDICTS set', () => {
    const verdicts = JUDGE_OUTPUT_SCHEMA.properties as Record<string, unknown>;
    const items = (verdicts.verdicts as { items: { properties: Record<string, { enum?: string[] }> } }).items;
    expect(items.properties.verdict.enum).toEqual([...VERDICTS]);
  });

  it('requires the verdict skeleton (id + verdict + evidence) and top-level verdicts array', () => {
    expect(JUDGE_OUTPUT_SCHEMA.required).toEqual(['verdicts']);
    const items = (
      (JUDGE_OUTPUT_SCHEMA.properties as Record<string, unknown>).verdicts as {
        items: { required: string[] };
      }
    ).items;
    expect(items.required).toEqual(['id', 'verdict', 'evidence']);
  });

  it('snapshot-locks the full schema shape (the shape is the K-sample contract)', () => {
    // The one sanctioned snapshot (per the plan): a schema-shape drift silently
    // degrades every jury sample, so we freeze the exact skeleton.
    expect(JUDGE_OUTPUT_SCHEMA).toMatchInlineSnapshot(`
      {
        "additionalProperties": false,
        "properties": {
          "findings": {
            "items": {
              "additionalProperties": false,
              "properties": {
                "body": {
                  "type": "string",
                },
                "catastrophic": {
                  "type": "boolean",
                },
                "dimension": {
                  "type": "string",
                },
                "file": {
                  "type": "string",
                },
                "line": {
                  "type": "number",
                },
                "netNew": {
                  "type": "boolean",
                },
                "severity": {
                  "enum": [
                    "info",
                    "warning",
                    "error",
                  ],
                  "type": "string",
                },
                "subCheckId": {
                  "type": "string",
                },
                "title": {
                  "type": "string",
                },
              },
              "required": [
                "title",
                "severity",
              ],
              "type": "object",
            },
            "type": "array",
          },
          "verdicts": {
            "items": {
              "additionalProperties": false,
              "properties": {
                "evidence": {
                  "type": "string",
                },
                "id": {
                  "type": "string",
                },
                "verdict": {
                  "enum": [
                    "PASS",
                    "FAIL",
                    "UNKNOWN",
                    "NOT_APPLICABLE",
                  ],
                  "type": "string",
                },
              },
              "required": [
                "id",
                "verdict",
                "evidence",
              ],
              "type": "object",
            },
            "type": "array",
          },
        },
        "required": [
          "verdicts",
        ],
        "type": "object",
      }
    `);
  });
});
