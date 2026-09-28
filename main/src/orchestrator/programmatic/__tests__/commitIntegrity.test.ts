import { describe, it, expect } from 'vitest';
import { commitIntegrityExcerpt, parsePorcelainPaths } from '../commitIntegrity';

describe('parsePorcelainPaths', () => {
  it('keeps the leading-space status column intact and returns each path', () => {
    // `runGitAsync` does not trim, so " M" (worktree-modified) keeps its space.
    expect(parsePorcelainPaths(' M src/a.ts\n?? src/new.ts\nA  src/b.ts\n')).toEqual([
      'src/a.ts',
      'src/new.ts',
      'src/b.ts',
    ]);
  });

  it('returns the destination of a rename', () => {
    expect(parsePorcelainPaths('R  old/x.ts -> new/x.ts\n')).toEqual(['new/x.ts']);
  });

  it('returns nothing for a clean tree', () => {
    expect(parsePorcelainPaths('')).toEqual([]);
  });
});

describe('commitIntegrityExcerpt', () => {
  it('flags ambiguous ownership and lists the NEW paths when siblings shared the worktree', () => {
    const text = commitIntegrityExcerpt(
      { headAdvanced: false, dirty: true, dirtyPaths: ['old.ts', 'new.ts'], newDirtyPaths: ['new.ts'] },
      true,
    );
    expect(text).toContain('OWNERSHIP IS AMBIGUOUS');
    expect(text).toContain('appeared while this lane ran');
    expect(text).toContain('- new.ts');
    expect(text).not.toContain('- old.ts');
  });

  it('says the lane ran alone and truncates long path lists', () => {
    const paths = Array.from({ length: 45 }, (_, i) => `f${i}.ts`);
    const text = commitIntegrityExcerpt({ headAdvanced: false, dirty: true, dirtyPaths: paths }, false);
    expect(text).toContain('No other lane was running');
    expect(text).toContain('- f39.ts');
    expect(text).not.toContain('- f40.ts');
    expect(text).toContain('… and 5 more');
  });
});
