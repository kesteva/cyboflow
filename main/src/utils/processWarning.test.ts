import { describe, it, expect } from 'vitest';
import { formatProcessWarning, DEPRECATION_STACK_FRAMES } from './processWarning';

function makeWarning(name: string, message: string, stack?: string, code?: string): Error & { code?: string } {
  const w = new Error(message) as Error & { code?: string };
  w.name = name;
  if (code !== undefined) w.code = code;
  w.stack = stack;
  return w;
}

const STACK = [
  'DeprecationWarning: fs.Stats constructor is deprecated.',
  ...Array.from({ length: 10 }, (_, i) => `    at caller${i} (/app/node_modules/dep/index.js:${i + 1}:1)`),
].join('\n');

describe('formatProcessWarning', () => {
  it('appends the top stack frames to a deprecation warning so the caller is identifiable', () => {
    const out = formatProcessWarning(
      makeWarning('DeprecationWarning', 'fs.Stats constructor is deprecated.', STACK, 'DEP0180'),
      1500,
    );
    const lines = out.split('\n');
    expect(lines[0]).toBe('(node:1500) [DEP0180] DeprecationWarning: fs.Stats constructor is deprecated.');
    expect(lines.slice(1)).toHaveLength(DEPRECATION_STACK_FRAMES);
    expect(lines[1]).toContain('at caller0 (/app/node_modules/dep/index.js:1:1)');
  });

  it('keeps non-deprecation warnings to the one-line form', () => {
    const out = formatProcessWarning(
      makeWarning('MaxListenersExceededWarning', 'Possible EventEmitter memory leak', STACK),
      42,
    );
    expect(out).toBe('(node:42) MaxListenersExceededWarning: Possible EventEmitter memory leak');
  });

  it('tolerates a deprecation warning with no stack', () => {
    const out = formatProcessWarning(makeWarning('DeprecationWarning', 'x', undefined, 'DEP0001'), 7);
    expect(out).toBe('(node:7) [DEP0001] DeprecationWarning: x');
  });
});
