/**
 * parseFileHunks — parse a unified `git diff` into per-file hunks WITH line
 * numbers, for the center-pane file-tab's 3-col diff grid (old-no │ new-no │
 * code). The existing DiffViewer `parseUnifiedDiff` collapses each file to full
 * old/new text for Monaco and discards hunk line numbers, so the grid needs this
 * dedicated parser.
 *
 * Pure + side-effect-free. Operates on the raw combined-diff string returned by
 * `getCombinedDiff` (a sequence of `diff --git` blocks).
 */

/** One rendered diff row. `add` rows have no old line no; `del` rows no new. */
export interface HunkLine {
  oldNo: number | null;
  newNo: number | null;
  kind: 'add' | 'del' | 'context';
  text: string;
}

/** A single `@@ … @@` hunk. */
export interface DiffHunk {
  /** The raw `@@ -a,b +c,d @@ …` header line. */
  header: string;
  lines: HunkLine[];
}

export type FileChangeType = 'added' | 'deleted' | 'modified' | 'renamed';

/** A parsed per-file diff with hunks + line numbers. */
export interface ParsedFileDiff {
  /** New path (b/…); for a deletion this is the old path. */
  path: string;
  /** Old path (a/…); differs from `path` only for renames. */
  oldPath: string;
  type: FileChangeType;
  isBinary: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

/** Split a combined diff into its per-file `diff --git …` blocks. */
function splitFileBlocks(diff: string): string[] {
  if (!diff || diff.trim().length === 0) return [];
  return diff.match(/diff --git[\s\S]*?(?=diff --git|$)/g) ?? [];
}

/** Extract a/ and b/ paths from a `diff --git` block header. */
function parsePaths(block: string): { oldPath: string; newPath: string } | null {
  const m = block.match(/diff --git a\/(.*?) b\/(.*?)(?:\n|$)/) ?? block.match(/diff --git a\/(.*?) b\/(.*)/);
  if (!m) return null;
  return { oldPath: m[1] ?? '', newPath: m[2] ?? '' };
}

/** Classify the change type from the block's mode/rename markers. */
function changeType(block: string): FileChangeType {
  if (block.includes('new file mode')) return 'added';
  if (block.includes('deleted file mode')) return 'deleted';
  if (block.includes('rename from') && block.includes('rename to')) return 'renamed';
  return 'modified';
}

/** Parse one `diff --git` block into a ParsedFileDiff (null if unparseable). */
function parseBlock(block: string): ParsedFileDiff | null {
  const paths = parsePaths(block);
  if (!paths) return null;

  const type = changeType(block);
  const isBinary = block.includes('Binary files') || block.includes('GIT binary patch');
  const path = paths.newPath || paths.oldPath;

  if (isBinary) {
    return { path, oldPath: paths.oldPath, type, isBinary: true, additions: 0, deletions: 0, hunks: [] };
  }

  const lines = block.split('\n');
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let additions = 0;
  let deletions = 0;

  for (const line of lines) {
    const hunkHeader = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkHeader) {
      current = { header: line, lines: [] };
      hunks.push(current);
      oldNo = Number(hunkHeader[1]);
      newNo = Number(hunkHeader[2]);
      continue;
    }
    if (current === null) continue; // file-header lines before the first @@ (---, +++, index, mode)

    if (line.startsWith('+')) {
      current.lines.push({ oldNo: null, newNo, kind: 'add', text: line.slice(1) });
      newNo += 1;
      additions += 1;
    } else if (line.startsWith('-')) {
      current.lines.push({ oldNo, newNo: null, kind: 'del', text: line.slice(1) });
      oldNo += 1;
      deletions += 1;
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file" — metadata, not a content row.
      continue;
    } else if (line.startsWith(' ')) {
      current.lines.push({ oldNo, newNo, kind: 'context', text: line.slice(1) });
      oldNo += 1;
      newNo += 1;
    }
    // A blank line inside a hunk is an empty context line (' ' was stripped by
    // the split); represent it as context so spacing is preserved.
    else if (line === '') {
      current.lines.push({ oldNo, newNo, kind: 'context', text: '' });
      oldNo += 1;
      newNo += 1;
    }
  }

  return { path, oldPath: paths.oldPath, type, isBinary: false, additions, deletions, hunks };
}

/** Parse every file in a combined diff. */
export function parseFileDiffs(diff: string): ParsedFileDiff[] {
  const out: ParsedFileDiff[] = [];
  for (const block of splitFileBlocks(diff)) {
    const parsed = parseBlock(block);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * Find a single file's parsed diff within a combined diff. Matches the new path
 * first (b/…), then the old path (covers deletions / renames). Returns null when
 * the file has no changes in the diff.
 */
export function findFileDiff(diff: string, filePath: string): ParsedFileDiff | null {
  const all = parseFileDiffs(diff);
  return all.find((f) => f.path === filePath) ?? all.find((f) => f.oldPath === filePath) ?? null;
}
