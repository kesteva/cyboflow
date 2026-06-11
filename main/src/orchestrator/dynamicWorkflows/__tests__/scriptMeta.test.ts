/**
 * Unit tests for parseScriptMeta — fail-soft regex extraction of the
 * `export const meta = {...}` literal from a persisted workflow script.
 */
import { describe, it, expect } from 'vitest';
import { parseScriptMeta } from '../scriptMeta';

describe('parseScriptMeta', () => {
  it('extracts name, description, and phases from a realistic script (single quotes)', () => {
    const source = `
// Auto-generated dynamic workflow script
export const meta = {
  name: 'Parallel refactor',
  description: 'Refactors the API layer in parallel',
  phases: [
    { title: 'Analyze', detail: 'Map the modules' },
    { title: 'Execute' },
    { title: 'Verify', detail: 'Run the gate' },
  ],
};

export default async function run(ctx) {
  // workflow body — irrelevant to meta parsing
}
`;
    expect(parseScriptMeta(source)).toEqual({
      name: 'Parallel refactor',
      description: 'Refactors the API layer in parallel',
      phases: [
        { title: 'Analyze', detail: 'Map the modules' },
        { title: 'Execute' },
        { title: 'Verify', detail: 'Run the gate' },
      ],
    });
  });

  it('accepts double-quoted strings (including apostrophes inside)', () => {
    const source = `export const meta = {
  name: "Fix the user's session bug",
  description: "One-shot",
  phases: [{ title: "Phase A", detail: "It's quick" }],
};`;
    expect(parseScriptMeta(source)).toEqual({
      name: "Fix the user's session bug",
      description: 'One-shot',
      phases: [{ title: 'Phase A', detail: "It's quick" }],
    });
  });

  it('unescapes escaped quotes in string values', () => {
    const source = `export const meta = { name: 'It\\'s alive', phases: [] };`;
    expect(parseScriptMeta(source).name).toBe("It's alive");
  });

  it('returns null description when the key is missing', () => {
    const source = `export const meta = { name: 'NoDesc', phases: [{ title: 'Only' }] };`;
    expect(parseScriptMeta(source)).toEqual({
      name: 'NoDesc',
      description: null,
      phases: [{ title: 'Only' }],
    });
  });

  it('returns empty phases when the phases key is missing', () => {
    const source = `export const meta = { name: 'Bare', description: 'No phases key' };`;
    expect(parseScriptMeta(source)).toEqual({
      name: 'Bare',
      description: 'No phases key',
      phases: [],
    });
  });

  it('skips phase entries without a title', () => {
    const source = `export const meta = {
  name: 'Partial',
  phases: [{ detail: 'orphan detail' }, { title: 'Kept' }],
};`;
    expect(parseScriptMeta(source).phases).toEqual([{ title: 'Kept' }]);
  });

  it('a phase title containing braces does not break the brace scanner', () => {
    const source = `export const meta = {
  name: 'Tricky',
  phases: [{ title: 'Use {curly} text' }],
  description: 'after phases',
};`;
    const meta = parseScriptMeta(source);
    expect(meta.name).toBe('Tricky');
    expect(meta.description).toBe('after phases');
    expect(meta.phases).toEqual([{ title: 'Use {curly} text' }]);
  });

  it('fail-soft: source without a meta block returns nulls/empty', () => {
    expect(parseScriptMeta('export default async function run() {}')).toEqual({
      name: null,
      description: null,
      phases: [],
    });
  });

  it('fail-soft: an unterminated meta block returns nulls/empty', () => {
    expect(parseScriptMeta(`export const meta = { name: 'broken'`)).toEqual({
      name: null,
      description: null,
      phases: [],
    });
  });

  it('fail-soft: empty source returns nulls/empty', () => {
    expect(parseScriptMeta('')).toEqual({ name: null, description: null, phases: [] });
  });
});
