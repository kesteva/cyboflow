/**
 * parseVisualTaskSection — the §5.1 composition-contract parser tests. Pins
 * the fence-aware section/marker grammar: happy-path round-trip, both
 * NOT-APPLICABLE forms, missing/duplicate/contract-error edge cases, and that
 * headings/markers INSIDE a fenced code block never count as structure.
 */
import { describe, it, expect } from 'vitest';
import { parseVisualTaskSection } from '../visualTaskSection';

const VALID_TASK_JSON = JSON.stringify({
  version: 1,
  summary: 'Check the login form renders',
  behaviors: [{ id: 'b1', description: 'Login form renders', expected: 'Form is visible on screen' }],
});

function sectionBlock(json: string, fence = '```'): string {
  return `## Visual verification task\n${fence}json\n${json}\n${fence}\n`;
}

describe('parseVisualTaskSection', () => {
  it('parses the happy path with surrounding prose and other sections', () => {
    const text = [
      '# Task verify result',
      '',
      'VERDICT: PASS',
      '',
      'Some prose explaining the change.',
      '',
      sectionBlock(VALID_TASK_JSON),
      '',
      '## Notes',
      '',
      'Trailing content that must not affect parsing.',
    ].join('\n');

    const result = parseVisualTaskSection(text);
    expect(result.kind).toBe('task');
    if (result.kind === 'task') {
      expect(result.task.version).toBe(1);
      expect(result.task.summary).toBe('Check the login form renders');
      expect(result.task.behaviors).toHaveLength(1);
      expect(result.task.behaviors[0].id).toBe('b1');
    }
  });

  it('terminates the section at a following "## Next section" heading', () => {
    const text = `${sectionBlock(VALID_TASK_JSON)}\n## Next section\n\nUnrelated content.`;
    const result = parseVisualTaskSection(text);
    expect(result.kind).toBe('task');
  });

  it('parses NOT-APPLICABLE with an em-dash separated reason', () => {
    const text = 'VERDICT: PASS\n\nVISUAL-VERIFICATION: NOT-APPLICABLE — backend-only change, no UI\n';
    const result = parseVisualTaskSection(text);
    expect(result).toEqual({ kind: 'not_applicable', reason: 'backend-only change, no UI' });
  });

  it('parses NOT-APPLICABLE with a hyphen separated reason', () => {
    const text = 'VISUAL-VERIFICATION: NOT-APPLICABLE - CLI-only change\n';
    const result = parseVisualTaskSection(text);
    expect(result).toEqual({ kind: 'not_applicable', reason: 'CLI-only change' });
  });

  it('parses NOT-APPLICABLE with a colon separated reason', () => {
    const text = 'VISUAL-VERIFICATION: NOT-APPLICABLE: config change only\n';
    const result = parseVisualTaskSection(text);
    expect(result).toEqual({ kind: 'not_applicable', reason: 'config change only' });
  });

  it('parses NOT-APPLICABLE with no reason as an empty string', () => {
    const text = 'VISUAL-VERIFICATION: NOT-APPLICABLE\n';
    const result = parseVisualTaskSection(text);
    expect(result).toEqual({ kind: 'not_applicable', reason: '' });
  });

  it('tolerates leading whitespace before the NOT-APPLICABLE marker', () => {
    const text = '  VISUAL-VERIFICATION: NOT-APPLICABLE — indented marker\n';
    const result = parseVisualTaskSection(text);
    expect(result).toEqual({ kind: 'not_applicable', reason: 'indented marker' });
  });

  it('returns missing when neither the section nor the marker is present', () => {
    expect(parseVisualTaskSection('VERDICT: PASS\n\nAll good, nothing else to say.')).toEqual({
      kind: 'missing',
    });
  });

  it('returns missing for null / undefined / empty text', () => {
    expect(parseVisualTaskSection(null)).toEqual({ kind: 'missing' });
    expect(parseVisualTaskSection(undefined)).toEqual({ kind: 'missing' });
    expect(parseVisualTaskSection('')).toEqual({ kind: 'missing' });
  });

  it('errors on a duplicate "## Visual verification task" heading', () => {
    const text = `${sectionBlock(VALID_TASK_JSON)}\n${sectionBlock(VALID_TASK_JSON)}`;
    const result = parseVisualTaskSection(text);
    expect(result.kind).toBe('contract_error');
    if (result.kind === 'contract_error') {
      expect(result.error).toMatch(/duplicate/i);
      expect(result.error).toMatch(/heading/i);
    }
  });

  it('errors on a duplicate NOT-APPLICABLE line', () => {
    const text =
      'VISUAL-VERIFICATION: NOT-APPLICABLE — first\nVISUAL-VERIFICATION: NOT-APPLICABLE — second\n';
    const result = parseVisualTaskSection(text);
    expect(result.kind).toBe('contract_error');
    if (result.kind === 'contract_error') {
      expect(result.error).toMatch(/duplicate/i);
    }
  });

  it('errors when both a section and a NOT-APPLICABLE line are present', () => {
    const text = `${sectionBlock(VALID_TASK_JSON)}\nVISUAL-VERIFICATION: NOT-APPLICABLE — conflicting\n`;
    const result = parseVisualTaskSection(text);
    expect(result.kind).toBe('contract_error');
    if (result.kind === 'contract_error') {
      expect(result.error).toMatch(/both/i);
    }
  });

  it('errors on zero fences in the section', () => {
    const text = '## Visual verification task\n\nNo fence here, just prose.\n\n## Next\n\nx';
    const result = parseVisualTaskSection(text);
    expect(result.kind).toBe('contract_error');
    if (result.kind === 'contract_error') {
      expect(result.error).toMatch(/fence/i);
    }
  });

  it('errors on more than one fence in the section (duplicate fence)', () => {
    const text = `## Visual verification task\n\`\`\`json\n${VALID_TASK_JSON}\n\`\`\`\n\`\`\`json\n${VALID_TASK_JSON}\n\`\`\`\n`;
    const result = parseVisualTaskSection(text);
    expect(result.kind).toBe('contract_error');
    if (result.kind === 'contract_error') {
      expect(result.error).toMatch(/duplicate fence/i);
    }
  });

  it('errors on malformed JSON inside the fence', () => {
    const text = sectionBlock('{ this is not valid json ');
    const result = parseVisualTaskSection(text);
    expect(result.kind).toBe('contract_error');
    if (result.kind === 'contract_error') {
      expect(result.error).toMatch(/invalid json/i);
    }
  });

  it('errors on a schema-invalid task (bad behavior: missing expected)', () => {
    const badJson = JSON.stringify({
      version: 1,
      summary: 'Missing expected field',
      behaviors: [{ id: 'b1', description: 'Something happens' }],
    });
    const result = parseVisualTaskSection(sectionBlock(badJson));
    expect(result.kind).toBe('contract_error');
    if (result.kind === 'contract_error') {
      expect(result.error).toMatch(/behaviors\[0\]\.expected/);
    }
  });

  it('ignores a "##" heading look-alike inside a code fence (not a duplicate heading)', () => {
    const text = [
      sectionBlock(VALID_TASK_JSON),
      '## Notes',
      '```markdown',
      '## Visual verification task',
      'This looks like a heading but is fenced content and must not count as a duplicate.',
      '```',
    ].join('\n');
    const result = parseVisualTaskSection(text);
    expect(result.kind).toBe('task');
  });

  it('ignores a fake NOT-APPLICABLE line inside a code fence elsewhere in the doc', () => {
    const text = [
      sectionBlock(VALID_TASK_JSON),
      '## Notes',
      '```text',
      'VISUAL-VERIFICATION: NOT-APPLICABLE — this is just an example in a fence',
      '```',
    ].join('\n');
    const result = parseVisualTaskSection(text);
    expect(result.kind).toBe('task');
  });

  it('supports tilde fences', () => {
    const text = sectionBlock(VALID_TASK_JSON, '~~~');
    const result = parseVisualTaskSection(text);
    expect(result.kind).toBe('task');
    if (result.kind === 'task') {
      expect(result.task.summary).toBe('Check the login form renders');
    }
  });
});
