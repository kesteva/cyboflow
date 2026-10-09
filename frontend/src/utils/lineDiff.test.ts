import { describe, expect, it } from 'vitest';
import { diffLines } from './lineDiff';

describe('diffLines', () => {
  it('marks identical text as all same', () => {
    expect(diffLines('a\nb', 'a\nb')).toEqual([
      { type: 'same', text: 'a' },
      { type: 'same', text: 'b' },
    ]);
  });

  it('reports a replaced line as remove then add', () => {
    expect(diffLines('a\nb\nc', 'a\nx\nc')).toEqual([
      { type: 'same', text: 'a' },
      { type: 'remove', text: 'b' },
      { type: 'add', text: 'x' },
      { type: 'same', text: 'c' },
    ]);
  });

  it('reports inserted and deleted lines', () => {
    expect(diffLines('a\nc', 'a\nb\nc')).toEqual([
      { type: 'same', text: 'a' },
      { type: 'add', text: 'b' },
      { type: 'same', text: 'c' },
    ]);
    expect(diffLines('a\nb\nc', 'a\nc').filter((l) => l.type === 'remove')).toEqual([{ type: 'remove', text: 'b' }]);
  });

  it('handles empty sides', () => {
    expect(diffLines('', 'a')).toEqual([{ type: 'add', text: 'a' }]);
    expect(diffLines('a', '')).toEqual([{ type: 'remove', text: 'a' }]);
    expect(diffLines('', '')).toEqual([]);
  });
});
