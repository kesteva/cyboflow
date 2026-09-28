/**
 * Mechanical ratchet: `workflow_runs.status` is written through validated paths.
 *
 * The state machine (`shared/workflows/runStateMachine.ts`) has always described
 * which transitions are legal; nothing MADE a writer consult it. A raw
 * `UPDATE workflow_runs SET status = ...` compiles, passes review as "the same
 * shape as the one above it", and silently forces an edge the table forbids —
 * which is how a `queued` run could be merged straight to `completed` and how a
 * run canceled during its worktree build was flipped back to `starting`.
 *
 * There are two sanctioned ways to write the column:
 *   - `main/src/services/cyboflow/transitions.ts` — the guarded helpers. Every
 *     services-side writer uses these.
 *   - a raw UPDATE preceded by `assertTransitionAllowed` (or guarded by a WHERE
 *     clause derived from the table via `allowedSourcesSqlIn`). This is what
 *     `main/src/orchestrator/**` uses: it may not import services/ at runtime
 *     (see standaloneInvariant.test.ts), and transitions.ts is db-coupled
 *     services code — but ALLOWED_TRANSITIONS lives in shared/, which every layer
 *     can reach, so the VALIDATION is never the thing that has to be skipped.
 *
 * This test freezes the surviving raw sites per file, with the reason each one
 * is still raw. It is a RATCHET: the counts may shrink, and a new raw write
 * fails here with a pointer to the two sanctioned paths.
 *
 * Scope note, mirroring standaloneInvariant.test.ts: the scan is TEXTUAL. It
 * strips comments (so a doc comment describing an UPDATE is not a site) and
 * reads the SET clause up to the first WHERE (so `SET outcome = ... WHERE status
 * = ...` is correctly NOT a status write). It does not parse SQL, and it cannot
 * see a status write assembled from fragments — accepted, because every writer in
 * this tree spells the statement as one literal.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Walk up to whichever ancestor holds main/src (vitest may be rooted at either). */
function locateMainSrc(): string {
  let dir = process.cwd();
  for (;;) {
    for (const candidate of [path.join(dir, 'src'), path.join(dir, 'main', 'src')]) {
      if (fs.existsSync(path.join(candidate, 'orchestrator', 'Orchestrator.ts'))) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`Could not locate main/src from ${process.cwd()}`);
    dir = parent;
  }
}

const MAIN_SRC = locateMainSrc();

/**
 * THE chokepoint itself. Its ten guarded helpers are the thing every other
 * writer is being pushed toward, so it is excluded rather than exempted.
 */
const CHOKEPOINT = 'services/cyboflow/transitions.ts';

/**
 * Raw `SET status` writers outside the chokepoint: file -> how many, and why
 * each file still writes raw. Counts may only SHRINK without a reviewer agreeing
 * the new write cannot go through a sanctioned path.
 */
const FROZEN_RAW_WRITERS: ReadonlyMap<string, { count: number; reason: string }> = new Map([
  [
    'orchestrator/approvalRouter.ts',
    {
      count: 6,
      reason:
        'Five gate open/close writes, each preceded by assertTransitionAllowed / assertTransitionAllowedFromAny; the sixth is the boot sweep that force-fails runs whose approval socket died with the app (a documented recovery bypass, like runRecovery).',
    },
  ],
  [
    'orchestrator/cancelAndRestartHandler.ts',
    {
      count: 1,
      reason:
        'Cancel-then-reinsert must be ONE transaction with the new run INSERT, so it cannot call the helper. Its WHERE is derived from the table via allowedSourcesSqlIn(canceled).',
    },
  ],
  [
    'orchestrator/cancelRunHandler.ts',
    {
      count: 1,
      reason:
        'Orchestrator-side cancel, serialized on the per-run queue alongside the outcome stamp. WHERE derived via allowedSourcesSqlIn(canceled).',
    },
  ],
  [
    'orchestrator/chatSentinelProvider.ts',
    {
      count: 3,
      reason:
        'The mint advance performs queued -> running, an edge ALLOWED_TRANSITIONS deliberately FORBIDS (runStateMachine.test.ts asserts it: a run must pass through starting) — the divergence is real and left for a product decision, see the comment at the site. The other two are the reviveChatSentinel guarded/legacy pair, the inlined mirror of transitions.reviveQuickRunToRunning and itself one of the sanctioned revival bypasses.',
    },
  ],
  [
    'orchestrator/handoverRunHandler.ts',
    {
      count: 1,
      reason:
        'Sanctioned revival path: hands a stalled run to the other execution model by re-driving it from a chosen step.',
    },
  ],
  [
    'orchestrator/humanStepManager.ts',
    {
      count: 4,
      reason:
        'Human-gate open/close writes that must be atomic with the review_items co-write; each is preceded by assertTransitionAllowed / assertTransitionAllowedFromAny.',
    },
  ],
  [
    'orchestrator/nudgeRunHandler.ts',
    { count: 1, reason: 'awaiting_review -> running re-drive; preceded by assertTransitionAllowed.' },
  ],
  [
    'orchestrator/pauseRunHandler.ts',
    {
      count: 1,
      reason:
        'running/awaiting_review -> paused; preceded by assertTransitionAllowedFromAny.',
    },
  ],
  [
    'orchestrator/questionRouter.ts',
    {
      count: 6,
      reason:
        'Three question-gate writes preceded by assertTransitionAllowed, plus three documented bypasses (the gate self-heal and the boot sweep over runs whose question socket died).',
    },
  ],
  [
    'orchestrator/reopenRunHandler.ts',
    { count: 1, reason: 'Sanctioned revival path #2: SDK-only failed -> running via --resume.' },
  ],
  [
    'orchestrator/resumeRunHandler.ts',
    { count: 1, reason: 'paused -> running; preceded by assertTransitionAllowed.' },
  ],
  [
    'orchestrator/retryRunHandler.ts',
    {
      count: 1,
      reason:
        'Sanctioned revival path #4: failed / resting-awaiting_review -> starting at a chosen step.',
    },
  ],
  [
    'orchestrator/rewindRunHandler.ts',
    {
      count: 1,
      reason:
        'Sanctioned revival path #5: rewind to an EARLIER step, aborting a live walk first.',
    },
  ],
  [
    'orchestrator/runLauncher.ts',
    {
      count: 2,
      reason:
        'The queued -> starting launch flip (preceded by assertTransitionAllowed and guarded on status = queued), plus the launch-failure mark-failed write, which is the only place a pre-execution failure reaches a terminal status at all.',
    },
  ],
  [
    'orchestrator/runRecovery.ts',
    {
      count: 5,
      reason:
        'Four boot-sweep writes (sanctioned revival path #1: force-fail stranded orphans, reset programmatic runs to starting, cancel abandoned ones) plus stampSessionRunsPrOpen, a SET-wide close-out whose WHERE is derived via allowedSourcesSqlIn(completed).',
    },
  ],
  [
    'orchestrator/stuckDetector.ts',
    {
      count: 2,
      reason:
        'awaiting_review -> stuck, plus running -> stuck (TASK-300, the parked_no_gate rung: a run with no live turn and no open gate of any kind). The detector is injected a DatabaseLike and may not import the db-coupled helper; each edge is asserted once at statement-prepare time.',
    },
  ],
  [
    'orchestrator/trpc/routers/experiments.ts',
    {
      count: 1,
      reason:
        'settleQuickArm mirrors transitionRunningToAwaitingReview inline (router may not import services/); preceded by assertTransitionAllowed.',
    },
  ],
  [
    'orchestrator/trpc/routers/runs.ts',
    {
      count: 4,
      reason:
        'end (asserted) plus the merge / createPr / dismiss close-outs, whose WHERE clauses are derived via allowedSourcesSqlIn and which refuse an illegal source up front through assertCloseoutTransitionLegal.',
    },
  ],
  [
    'services/createQuickSessionCore.ts',
    {
      count: 1,
      reason:
        'Quick-session sentinel queued -> starting, written inside the session-creation transaction; already preceded by assertTransitionAllowed.',
    },
  ],
]);

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

/**
 * Blank out comments while PRESERVING offsets and line breaks, tracking string
 * literals so a `//` inside a SQL string is not mistaken for a comment.
 */
export function stripComments(text: string): string {
  let out = '';
  let i = 0;
  let mode: 'code' | 'block' | 'line' | 'str' = 'code';
  let quote = '';
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (mode === 'code') {
      if (c === '/' && n === '*') { mode = 'block'; out += '  '; i += 2; continue; }
      if (c === '/' && n === '/') { mode = 'line'; out += '  '; i += 2; continue; }
      if (c === '"' || c === "'" || c === '`') { mode = 'str'; quote = c; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (mode === 'block') {
      if (c === '*' && n === '/') { mode = 'code'; out += '  '; i += 2; continue; }
      out += c === '\n' ? '\n' : ' '; i++; continue;
    }
    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += '\n'; i++; continue; }
      out += ' '; i++; continue;
    }
    // inside a string literal
    if (c === '\\') { out += '  '; i += 2; continue; }
    if (c === quote) { mode = 'code'; out += c; i++; continue; }
    out += c; i++; continue;
  }
  return out;
}

const UPDATE_RUNS = /UPDATE\s+workflow_runs\b/gi;

/** 1-based line numbers of every raw `UPDATE workflow_runs ... SET status = ...`. */
export function findStatusWrites(source: string): number[] {
  const text = stripComments(source);
  const hits: number[] = [];
  UPDATE_RUNS.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = UPDATE_RUNS.exec(text)) !== null) {
    const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 800);
    // The SET clause ends at WHERE. Reading past it would count
    // `SET outcome = ... WHERE status = ...` as a status write.
    const whereAt = tail.search(/\bWHERE\b/i);
    const setClause = whereAt === -1 ? tail : tail.slice(0, whereAt);
    if (/\bstatus\s*=/i.test(setClause)) hits.push(text.slice(0, m.index).split('\n').length);
  }
  return hits;
}

function isProductionFile(relPath: string): boolean {
  if (!relPath.endsWith('.ts')) return false;
  if (relPath.endsWith('.test.ts') || relPath.endsWith('.itest.ts')) return false;
  const segments = relPath.split(path.sep);
  return (
    !segments.includes('__tests__') &&
    !segments.includes('__test_fixtures__') &&
    !segments.includes('test') &&
    !segments.includes('dist')
  );
}

function listProductionFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? path.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) out.push(...listProductionFiles(path.join(dir, entry.name), rel));
    else if (entry.isFile() && isProductionFile(rel)) out.push(rel);
  }
  return out;
}

/** relPath (posix) -> line numbers, for every production file with a status write. */
function scanTree(): Map<string, number[]> {
  const found = new Map<string, number[]>();
  for (const rel of listProductionFiles(MAIN_SRC)) {
    const hits = findStatusWrites(fs.readFileSync(path.join(MAIN_SRC, rel), 'utf8'));
    if (hits.length > 0) found.set(rel.split(path.sep).join('/'), hits);
  }
  return found;
}

// ---------------------------------------------------------------------------

describe('workflow_runs.status write chokepoint', () => {
  const found = scanTree();

  it('finds the chokepoint itself (guards against a broken walker)', () => {
    expect(found.get(CHOKEPOINT)?.length ?? 0).toBeGreaterThan(5);
    expect(found.size).toBeGreaterThan(10);
  });

  it('no production file writes workflow_runs.status outside the frozen set', () => {
    const unexpected = [...found.keys()]
      .filter(rel => rel !== CHOKEPOINT && !FROZEN_RAW_WRITERS.has(rel))
      .sort();
    expect(
      unexpected,
      'Write it through a guarded helper in main/src/services/cyboflow/transitions.ts, or — if this file may not import services/ — call assertTransitionAllowed from shared/workflows/runStateMachine before the raw UPDATE and add an entry here',
    ).toEqual([]);
  });

  it('no frozen file grew a new raw status write', () => {
    const grown: string[] = [];
    for (const [rel, { count }] of FROZEN_RAW_WRITERS) {
      const actual = found.get(rel)?.length ?? 0;
      if (actual > count) grown.push(`${rel}: ${actual} raw status writes, frozen at ${count}`);
    }
    expect(
      grown,
      'A new raw UPDATE landed in a file that already had some. Validate it against shared/workflows/runStateMachine and raise the frozen count deliberately',
    ).toEqual([]);
  });

  it('every exemption is real, still-offending, and reasoned (no stale entries)', () => {
    for (const [rel, { count, reason }] of FROZEN_RAW_WRITERS) {
      expect(fs.existsSync(path.join(MAIN_SRC, rel.split('/').join(path.sep))), `${rel} no longer exists`).toBe(true);
      expect(reason.length, `${rel} needs a real reason`).toBeGreaterThan(40);
      const actual = found.get(rel)?.length ?? 0;
      expect(
        actual,
        `${rel} now has ${actual} raw status writes but is frozen at ${count} — LOWER the count (a ratchet only tightens)`,
      ).toBe(count);
    }
  });

  it('the scanner detects the forms it claims to (self-check)', () => {
    const positives: [string, number][] = [
      ["db.prepare(`UPDATE workflow_runs SET status = 'failed' WHERE id = ?`)", 1],
      // Multi-line template literal — how nearly every real site is written.
      ['db.prepare(`UPDATE workflow_runs\n  SET status = @to, updated_at = ?\n  WHERE id = @id`)', 1],
      // Single-quoted one-liner (runLauncher's launch-failure write).
      ['db.prepare("UPDATE workflow_runs SET status = \'failed\', error_message = ? WHERE id = ?")', 1],
      // Interpolated guard — allowedSourcesSqlIn renders into the WHERE.
      ['`UPDATE workflow_runs SET status = \'canceled\' WHERE id = ? AND status IN ${sql}`', 1],
      // Two statements in one file are two sites.
      [
        "`UPDATE workflow_runs SET status = 'a' WHERE id = ?`;\n`UPDATE workflow_runs SET status = 'b' WHERE id = ?`;",
        2,
      ],
      // Lowercase SQL still counts.
      ['`update workflow_runs set status = ? where id = ?`', 1],
    ];
    for (const [sample, expected] of positives) {
      expect(findStatusWrites(sample).length, sample).toBe(expected);
    }

    const negatives = [
      // A doc comment describing the write is not the write.
      "/**\n * Guarded UPDATE workflow_runs SET status = 'running' WHERE ...\n */\nconst x = 1;",
      "// UPDATE workflow_runs SET status = 'stuck'",
      // Status only in the WHERE — this is an OUTCOME write, not a status write.
      "`UPDATE workflow_runs SET outcome = 'canceled', updated_at = ? WHERE id = ? AND status = 'running'`",
      "`UPDATE workflow_runs SET rail_dismissed_at = CURRENT_TIMESTAMP WHERE id = ? AND status != 'queued'`",
      // Other columns entirely.
      "`UPDATE workflow_runs SET worktree_path = ?, branch_name = ? WHERE id = ?`",
      "`UPDATE workflow_runs SET claude_session_id = ? WHERE id = ? AND claude_session_id IS NULL`",
      // A different table.
      "`UPDATE approvals SET status = 'approved' WHERE id = ?`",
      "`UPDATE sessions SET status = 'stopped' WHERE id = ?`",
    ];
    for (const sample of negatives) {
      expect(findStatusWrites(sample), sample).toEqual([]);
    }
  });

  it('stripComments preserves line numbers so reported lines are usable', () => {
    const src = "const a = 1;\n// UPDATE workflow_runs SET status = 'x'\n`UPDATE workflow_runs SET status = 'y' WHERE id = ?`";
    expect(findStatusWrites(src)).toEqual([3]);
  });

  it('does not treat a // inside a SQL string as a comment', () => {
    const src = "`UPDATE workflow_runs SET status = 'running' /* not a comment in SQL */ WHERE url = 'http://x'`";
    // The block comment inside the template IS stripped (it is still a comment to
    // the scanner) but the statement is found, and the http:// does not swallow
    // the rest of the file.
    expect(findStatusWrites(`${src}\nconst after = 1;`)).toEqual([1]);
  });
});
