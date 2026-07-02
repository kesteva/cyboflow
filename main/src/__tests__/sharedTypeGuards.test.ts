/**
 * Table-driven guards for the leaf shared modules that ride the IPC/tRPC wire.
 *
 * These three helpers are the runtime narrowing points for values that arrive
 * from config / frontmatter / env / the DB (all `unknown` at the boundary). A
 * silent regression here (accepting a bad value, or rejecting a good one) does
 * not fail the build — it corrupts a run's substrate, mis-sorts a finding, or
 * drops tool-result text on the floor. Pin the exact contracts.
 *
 * Covered:
 *   1. isCliSubstrate — valid union members, invalid strings, null/undefined/objects.
 *   2. isFindingPriority — the P0/P1/P2 domain, plus null (the "un-prioritized"
 *      sentinel that must NOT pass the guard).
 *   3. extractToolResultText — string content, array-of-blocks content, the
 *      error `tool_result` shape (is_error + array content), and degenerate inputs.
 */
import { describe, it, expect } from 'vitest';
import { isCliSubstrate, DEFAULT_SUBSTRATE } from '../../../shared/types/substrate';
import { isFindingPriority, FINDING_PRIORITIES } from '../../../shared/types/reviews';
import { extractToolResultText } from '../../../shared/utils/extractToolResultText';
import type { ToolResultBlock } from '../../../shared/types/claudeStream';

describe('isCliSubstrate', () => {
  it.each([
    ['sdk', true],
    ['interactive', true],
  ] as const)('accepts the union member %s', (value, expected) => {
    expect(isCliSubstrate(value)).toBe(expected);
  });

  it.each([
    ['SDK'], // wrong case — the CHECK domain is case-sensitive
    ['Interactive'],
    ['pty'],
    ['claude'],
    [''],
    ['sdk '], // trailing space must not pass
  ])('rejects the non-member string %j', (value) => {
    expect(isCliSubstrate(value)).toBe(false);
  });

  it.each([
    [null],
    [undefined],
    [0],
    [1],
    [true],
    [{}],
    [['sdk']],
  ])('rejects the non-string value %j', (value) => {
    expect(isCliSubstrate(value)).toBe(false);
  });

  it('the DEFAULT_SUBSTRATE is itself a valid substrate (self-consistency)', () => {
    expect(isCliSubstrate(DEFAULT_SUBSTRATE)).toBe(true);
  });
});

describe('isFindingPriority', () => {
  it.each([...FINDING_PRIORITIES])('accepts the domain member %s', (value) => {
    expect(isFindingPriority(value)).toBe(true);
  });

  it.each([
    ['P3'], // one past the top of the domain
    ['p0'], // wrong case
    ['0'],
    ['high'],
    [''],
  ])('rejects the out-of-domain string %j', (value) => {
    expect(isFindingPriority(value)).toBe(false);
  });

  it('rejects null — the un-prioritized sentinel must NOT be treated as a priority', () => {
    // NULL priority is a legacy/un-triaged finding; consumers render it as an
    // explicit "unset" badge and sort it LAST. If the guard ever accepted null
    // it would fabricate a bogus label. Pin the rejection.
    expect(isFindingPriority(null)).toBe(false);
  });

  it.each([
    [undefined],
    [1],
    [{ priority: 'P0' }],
    [['P0']],
  ])('rejects the non-string value %j', (value) => {
    expect(isFindingPriority(value)).toBe(false);
  });
});

describe('extractToolResultText', () => {
  it('returns a plain string content unchanged', () => {
    expect(extractToolResultText('hello world')).toBe('hello world');
  });

  it('returns the empty string for empty string content', () => {
    expect(extractToolResultText('')).toBe('');
  });

  it('joins the text of an array-of-blocks content in order', () => {
    const content: ToolResultBlock['content'] = [
      { type: 'text', text: 'foo' },
      { type: 'text', text: 'bar' },
      { type: 'text', text: 'baz' },
    ];
    expect(extractToolResultText(content)).toBe('foobarbaz');
  });

  it('flattens the error tool_result shape (is_error + array content)', () => {
    // The real error wire shape: an is_error block carrying array content.
    // extractToolResultText must still produce the concatenated string so the
    // caller can JSON.parse / .includes on it without a runtime type crash.
    const block: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: 'toolu_err',
      is_error: true,
      content: [{ type: 'text', text: 'Error: ' }, { type: 'text', text: 'boom' }],
    };
    expect(extractToolResultText(block.content)).toBe('Error: boom');
  });

  it('treats a missing/undefined text field in a block as the empty string', () => {
    // A block whose `text` is absent must contribute '' — never the string
    // "undefined" and never a throw. Cast through unknown to model a wire block
    // that dropped its text field.
    const content = [
      { type: 'text', text: 'a' },
      { type: 'text' } as unknown as { type: string; text: string },
      { type: 'text', text: 'b' },
    ];
    expect(extractToolResultText(content)).toBe('ab');
  });

  it('returns the empty string for a non-string, non-array content (defensive)', () => {
    // Guards the "content is neither a string nor an array" degenerate case the
    // helper explicitly defends against (returns '' rather than throwing).
    expect(extractToolResultText(null as unknown as ToolResultBlock['content'])).toBe('');
    expect(extractToolResultText(undefined as unknown as ToolResultBlock['content'])).toBe('');
  });
});
