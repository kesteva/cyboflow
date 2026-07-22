import { describe, expect, it } from 'vitest';
import { toStrictOutputSchema } from '../strictOutputSchema';
import { JUDGE_OUTPUT_SCHEMA } from '../../../../../orchestrator/eval/evalJury';

type JsonSchema = Record<string, unknown>;

/** Assert every object node lists ALL its properties in `required` (OpenAI strict). */
function assertStrict(node: unknown, path = '$'): void {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return;
  const schema = node as JsonSchema;
  if (schema.properties && typeof schema.properties === 'object') {
    const propKeys = Object.keys(schema.properties as JsonSchema).sort();
    const required = (Array.isArray(schema.required) ? [...schema.required] : []).sort();
    expect(required, `${path}.required must equal all properties`).toEqual(propKeys);
    expect(schema.additionalProperties, `${path}.additionalProperties`).toBe(false);
    for (const [k, v] of Object.entries(schema.properties as JsonSchema)) {
      assertStrict(v, `${path}.properties.${k}`);
    }
  }
  if (schema.items) assertStrict(schema.items, `${path}.items`);
  for (const c of ['anyOf', 'oneOf', 'allOf']) {
    const branches = schema[c];
    if (Array.isArray(branches)) branches.forEach((b, i) => assertStrict(b, `${path}.${c}[${i}]`));
  }
}

describe('toStrictOutputSchema', () => {
  it('promotes every property to required across all nested objects', () => {
    assertStrict(toStrictOutputSchema(JUDGE_OUTPUT_SCHEMA));
  });

  it('makes the real judge schema Codex-acceptable (the 100% failure repro)', () => {
    const strict = toStrictOutputSchema(JUDGE_OUTPUT_SCHEMA) as JsonSchema;
    // Root: findings was optional → now required alongside verdicts.
    expect((strict.required as string[]).sort()).toEqual(['findings', 'verdicts']);
    const findings = (strict.properties as JsonSchema).findings as JsonSchema;
    const item = findings.items as JsonSchema;
    // The exact key the live 400 named ('Missing subCheckId') is now required…
    expect(item.required).toContain('subCheckId');
    // …and nullable (originally optional), so the model can still emit absence.
    const subCheckId = (item.properties as JsonSchema).subCheckId as JsonSchema;
    expect(subCheckId.type).toEqual(['string', 'null']);
    // An originally-required field stays non-nullable.
    const title = (item.properties as JsonSchema).title as JsonSchema;
    expect(title.type).toBe('string');
  });

  it('widens a nullable enum to admit null', () => {
    const strict = toStrictOutputSchema({
      type: 'object',
      required: [],
      properties: { grade: { type: 'string', enum: ['a', 'b'] } },
    }) as JsonSchema;
    const grade = (strict.properties as JsonSchema).grade as JsonSchema;
    expect(grade.type).toEqual(['string', 'null']);
    expect(grade.enum).toEqual(['a', 'b', null]);
  });

  it('does not mutate the input schema', () => {
    const before = JSON.stringify(JUDGE_OUTPUT_SCHEMA);
    toStrictOutputSchema(JUDGE_OUTPUT_SCHEMA);
    expect(JSON.stringify(JUDGE_OUTPUT_SCHEMA)).toBe(before);
  });

  it('is idempotent', () => {
    const once = toStrictOutputSchema(JUDGE_OUTPUT_SCHEMA);
    const twice = toStrictOutputSchema(once);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });
});
