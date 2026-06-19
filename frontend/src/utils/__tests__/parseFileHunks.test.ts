/**
 * parseFileHunks tests — per-file hunk parsing with line numbers for the
 * center-pane file-tab diff grid. Covers modify / add / delete / rename / binary
 * / no-newline, plus single-file lookup by new and old path.
 */
import { describe, it, expect } from 'vitest';
import { parseFileDiffs, findFileDiff } from '../parseFileHunks';

const MODIFY = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,3 @@',
  ' line1',
  '-old line',
  '+new line',
  ' line3',
].join('\n');

const ADD = [
  'diff --git a/src/new.ts b/src/new.ts',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/src/new.ts',
  '@@ -0,0 +1,2 @@',
  '+first',
  '+second',
].join('\n');

const DELETE = [
  'diff --git a/src/gone.ts b/src/gone.ts',
  'deleted file mode 100644',
  'index 4444444..0000000',
  '--- a/src/gone.ts',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-bye1',
  '-bye2',
].join('\n');

const RENAME = [
  'diff --git a/old/name.ts b/new/name.ts',
  'similarity index 90%',
  'rename from old/name.ts',
  'rename to new/name.ts',
  'index 5555555..6666666 100644',
  '--- a/old/name.ts',
  '+++ b/new/name.ts',
  '@@ -1,2 +1,2 @@',
  ' keep',
  '-was',
  '+now',
].join('\n');

const BINARY = [
  'diff --git a/img.png b/img.png',
  'new file mode 100644',
  'index 0000000..7777777',
  'Binary files /dev/null and b/img.png differ',
].join('\n');

const NO_NEWLINE = [
  'diff --git a/eof.txt b/eof.txt',
  'index 8888888..9999999 100644',
  '--- a/eof.txt',
  '+++ b/eof.txt',
  '@@ -1 +1 @@',
  '-before',
  '\\ No newline at end of file',
  '+after',
  '\\ No newline at end of file',
].join('\n');

describe('parseFileHunks', () => {
  it('parses a modified file with correct line numbers', () => {
    const [f] = parseFileDiffs(MODIFY);
    expect(f).toMatchObject({ path: 'src/a.ts', type: 'modified', additions: 1, deletions: 1, isBinary: false });
    expect(f.hunks).toHaveLength(1);
    expect(f.hunks[0].lines).toEqual([
      { oldNo: 1, newNo: 1, kind: 'context', text: 'line1' },
      { oldNo: 2, newNo: null, kind: 'del', text: 'old line' },
      { oldNo: null, newNo: 2, kind: 'add', text: 'new line' },
      { oldNo: 3, newNo: 3, kind: 'context', text: 'line3' },
    ]);
  });

  it('parses an added file', () => {
    const [f] = parseFileDiffs(ADD);
    expect(f).toMatchObject({ path: 'src/new.ts', type: 'added', additions: 2, deletions: 0 });
    expect(f.hunks[0].lines.map((l) => [l.newNo, l.kind, l.text])).toEqual([
      [1, 'add', 'first'],
      [2, 'add', 'second'],
    ]);
  });

  it('parses a deleted file', () => {
    const [f] = parseFileDiffs(DELETE);
    expect(f).toMatchObject({ path: 'src/gone.ts', type: 'deleted', additions: 0, deletions: 2 });
    expect(f.hunks[0].lines.every((l) => l.kind === 'del' && l.newNo === null)).toBe(true);
  });

  it('parses a rename with distinct old/new paths', () => {
    const [f] = parseFileDiffs(RENAME);
    expect(f).toMatchObject({ path: 'new/name.ts', oldPath: 'old/name.ts', type: 'renamed' });
  });

  it('marks binary files and emits no hunks', () => {
    const [f] = parseFileDiffs(BINARY);
    expect(f).toMatchObject({ path: 'img.png', isBinary: true });
    expect(f.hunks).toEqual([]);
  });

  it('ignores "No newline at end of file" markers', () => {
    const [f] = parseFileDiffs(NO_NEWLINE);
    expect(f.additions).toBe(1);
    expect(f.deletions).toBe(1);
    expect(f.hunks[0].lines).toEqual([
      { oldNo: 1, newNo: null, kind: 'del', text: 'before' },
      { oldNo: null, newNo: 1, kind: 'add', text: 'after' },
    ]);
  });

  it('findFileDiff locates a file by new path and by old path (rename/delete)', () => {
    const combined = [MODIFY, RENAME, DELETE].join('\n');
    expect(findFileDiff(combined, 'src/a.ts')?.type).toBe('modified');
    expect(findFileDiff(combined, 'new/name.ts')?.type).toBe('renamed');
    expect(findFileDiff(combined, 'old/name.ts')?.type).toBe('renamed'); // old path
    expect(findFileDiff(combined, 'src/gone.ts')?.type).toBe('deleted');
    expect(findFileDiff(combined, 'does/not/exist.ts')).toBeNull();
  });

  it('returns [] for an empty diff', () => {
    expect(parseFileDiffs('')).toEqual([]);
  });
});
