/**
 * Integration tests for TranscriptTailSource.
 *
 * Hermetic: `projectsRoot` points at an `os.tmpdir()` temp dir (never touches the
 * real `~/.claude`). Fixture lines mirror the canonical Probe-E inventory recorded
 * in docs/probes/IDEA-013-probe-findings.md (session `efde13c6`, 2026-06-01):
 * noise types, panel-critical assistant/user lines, STRING-content user lines, and
 * stop_hook_summary / turn_duration turn-end markers.
 *
 * Covers: discovery of a new *.jsonl basename as the session UUID; discovery
 * timeout -> reject + loud logger; incremental tail with a split line + a
 * malformed line; onTurnEnd firing; truncation/re-append (inode/offset re-sync);
 * stop() exits the loop; and the collision fallback (binds the cwd-matching file).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TranscriptTailSource } from '../transcriptTailSource';
import { encodeCwd } from '../encodeCwd';

function makeSpyLogger() {
  return { warn: vi.fn(), error: vi.fn(), verbose: vi.fn() };
}

const WORKTREE = '/private/tmp/idea013-probe-worktree';

// Real-shaped fixture lines (Probe-E inventory).
function assistantTextLine(text: string, cwd = WORKTREE): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      model: 'claude-opus-4-8',
      id: 'msg_01',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
    },
    cwd,
    sessionId: 'efde13c6',
    uuid: 'ae153392',
  });
}

function fileHistorySnapshotLine(): string {
  // Real first physical line — carries NO top-level cwd.
  return JSON.stringify({
    type: 'file-history-snapshot',
    messageId: '01bc38e2',
    snapshot: { trackedFileBackups: {} },
    isSnapshotUpdate: false,
  });
}

function stopHookSummaryLine(cwd = WORKTREE): string {
  return JSON.stringify({
    type: 'system',
    subtype: 'stop_hook_summary',
    hookCount: 2,
    cwd,
    sessionId: 'efde13c6',
  });
}

let tmpRoot: string;
let keyDir: string;
const sources: TranscriptTailSource[] = [];

function trackedSource(opts: ConstructorParameters<typeof TranscriptTailSource>[0]): TranscriptTailSource {
  const s = new TranscriptTailSource(opts);
  sources.push(s);
  return s;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-transcript-'));
  keyDir = path.join(tmpRoot, encodeCwd(WORKTREE));
  fs.mkdirSync(keyDir, { recursive: true });
});

afterEach(() => {
  for (const s of sources) s.stop();
  sources.length = 0;
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('TranscriptTailSource', () => {
  it('discovers a newly-written *.jsonl basename as the session UUID', async () => {
    // One pre-existing file in the snapshot so discovery must pick the NEW one.
    fs.writeFileSync(path.join(keyDir, 'preexisting-0000.jsonl'), '');

    const logger = makeSpyLogger();
    const src = trackedSource({
      worktreePath: WORKTREE,
      projectsRoot: tmpRoot,
      discoveryTimeoutMs: 1500,
      logger,
    });

    await src.start(() => undefined);

    const newUuid = 'efde13c6-ea3e-4e43-86bb-f082bb8a66f7';
    fs.writeFileSync(path.join(keyDir, `${newUuid}.jsonl`), assistantTextLine('hi') + '\n');

    await src.waitForFirstLine(1500);
    expect(src.getSessionUuid()).toBe(newUuid);
  });

  it('rejects with a loud diagnostic when no transcript appears (discovery timeout)', async () => {
    const logger = makeSpyLogger();
    const src = trackedSource({
      worktreePath: WORKTREE,
      projectsRoot: tmpRoot,
      discoveryTimeoutMs: 80,
      logger,
    });

    await src.start(() => undefined);

    await expect(src.waitForFirstLine(80)).rejects.toThrow(/discovery timeout/i);
    expect(logger.error).toHaveBeenCalled();
  });

  it('tails incrementally: split line reassembled, malformed line skipped, in order', async () => {
    const logger = makeSpyLogger();
    const received: unknown[] = [];
    const src = trackedSource({
      worktreePath: WORKTREE,
      projectsRoot: tmpRoot,
      discoveryTimeoutMs: 1500,
      logger,
    });

    await src.start((obj) => received.push(obj));

    const file = path.join(keyDir, 'session-aaaa.jsonl');
    fs.writeFileSync(file, '');
    await src.waitForFirstLine(1500);

    // Write line 1 split across two appends, then a malformed line, then line 2.
    const l1 = assistantTextLine('first');
    fs.appendFileSync(file, l1.slice(0, 20));
    await new Promise((r) => setTimeout(r, 80));
    fs.appendFileSync(file, l1.slice(20) + '\n');
    fs.appendFileSync(file, '{ this is not json }\n');
    fs.appendFileSync(file, assistantTextLine('second') + '\n');

    await waitFor(() => received.length >= 2);

    expect(received).toHaveLength(2);
    const e0 = received[0] as { type: string; message: { content: Array<{ text: string }> } };
    const e1 = received[1] as { type: string; message: { content: Array<{ text: string }> } };
    expect(e0.type).toBe('assistant');
    expect(e0.message.content[0].text).toBe('first');
    expect(e1.message.content[0].text).toBe('second');
    expect(logger.warn).toHaveBeenCalled(); // malformed line skipped (logged)
  });

  it('fires onTurnEnd on a stop_hook_summary line (not via onLine)', async () => {
    const logger = makeSpyLogger();
    const lines: unknown[] = [];
    const turnEnds: string[] = [];
    const src = trackedSource({
      worktreePath: WORKTREE,
      projectsRoot: tmpRoot,
      discoveryTimeoutMs: 1500,
      logger,
    });

    await src.start(
      (obj) => lines.push(obj),
      (marker) => turnEnds.push(marker),
    );

    const file = path.join(keyDir, 'session-bbbb.jsonl');
    fs.writeFileSync(file, '');
    await src.waitForFirstLine(1500);

    fs.appendFileSync(file, assistantTextLine('working') + '\n');
    fs.appendFileSync(file, stopHookSummaryLine() + '\n');

    await waitFor(() => turnEnds.length >= 1);
    expect(turnEnds).toContain('stop_hook_summary');
    // The turn-end marker was NOT forwarded as a panel line.
    expect(lines).toHaveLength(1);
  });

  it('survives truncation + re-append (inode/offset re-sync)', async () => {
    const logger = makeSpyLogger();
    const received: unknown[] = [];
    const src = trackedSource({
      worktreePath: WORKTREE,
      projectsRoot: tmpRoot,
      discoveryTimeoutMs: 1500,
      logger,
    });

    await src.start((obj) => received.push(obj));

    const file = path.join(keyDir, 'session-cccc.jsonl');
    fs.writeFileSync(file, assistantTextLine('before') + '\n');
    await src.waitForFirstLine(1500);
    await waitFor(() => received.length >= 1);

    // Truncate + rewrite the file (size shrinks below offset -> re-sync to 0).
    fs.rmSync(file);
    fs.writeFileSync(file, assistantTextLine('after') + '\n');

    await waitFor(() => received.length >= 2);
    const last = received[received.length - 1] as { message: { content: Array<{ text: string }> } };
    expect(last.message.content[0].text).toBe('after');
  });

  it('stops the tail loop and forwards nothing after stop()', async () => {
    const logger = makeSpyLogger();
    const received: unknown[] = [];
    const src = trackedSource({
      worktreePath: WORKTREE,
      projectsRoot: tmpRoot,
      discoveryTimeoutMs: 1500,
      logger,
    });

    await src.start((obj) => received.push(obj));
    const file = path.join(keyDir, 'session-dddd.jsonl');
    fs.writeFileSync(file, assistantTextLine('one') + '\n');
    await src.waitForFirstLine(1500);
    await waitFor(() => received.length >= 1);

    src.stop();
    const countAtStop = received.length;

    fs.appendFileSync(file, assistantTextLine('two') + '\n');
    await new Promise((r) => setTimeout(r, 200));
    expect(received).toHaveLength(countAtStop); // nothing more forwarded
  });

  it('collision fallback: binds the file whose top-level cwd matches the worktree', async () => {
    const logger = makeSpyLogger();
    const src = trackedSource({
      worktreePath: WORKTREE,
      projectsRoot: tmpRoot,
      discoveryTimeoutMs: 2000,
      logger,
    });

    await src.start(() => undefined);

    // Two NEW files in the same encodeCwd key dir. First physical line is a
    // file-history-snapshot (no cwd); the first cwd-bearing line differs.
    const matchUuid = 'match-1111-2222-3333-444444444444';
    const otherUuid = 'other-aaaa-bbbb-cccc-dddddddddddd';

    const otherFile = path.join(keyDir, `${otherUuid}.jsonl`);
    const matchFile = path.join(keyDir, `${matchUuid}.jsonl`);

    fs.writeFileSync(
      otherFile,
      fileHistorySnapshotLine() + '\n' + assistantTextLine('other', '/some/other/worktree') + '\n',
    );
    fs.writeFileSync(
      matchFile,
      fileHistorySnapshotLine() + '\n' + assistantTextLine('mine', WORKTREE) + '\n',
    );

    await src.waitForFirstLine(2000);
    expect(src.getSessionUuid()).toBe(matchUuid);
  });

  // bindKnownFileFromEnd — no-fork resume: bind the pre-existing transcript and
  // tail from EOF so post-resume lines flow WITHOUT re-emitting the prior history.
  describe('bindKnownFileFromEnd (no-fork resume)', () => {
    it('binds a pre-existing file from EOF: prior history is NOT re-emitted, new appends ARE', async () => {
      const logger = makeSpyLogger();
      const received: unknown[] = [];
      const src = trackedSource({
        worktreePath: WORKTREE,
        projectsRoot: tmpRoot,
        discoveryTimeoutMs: 1500,
        logger,
      });

      // Pre-existing transcript with prior history (would be re-emitted if bound
      // from offset 0).
      const uuid = 'resume-1234-5678-9abc-def000000000';
      const file = path.join(keyDir, `${uuid}.jsonl`);
      fs.writeFileSync(
        file,
        assistantTextLine('history one') + '\n' + assistantTextLine('history two') + '\n',
      );

      await src.start((obj) => received.push(obj));
      const bound = src.bindKnownFileFromEnd(uuid);
      expect(bound).toBe(true);
      await src.waitForFirstLine(1500);
      expect(src.getSessionUuid()).toBe(uuid);

      // Nothing dispatched yet — we tailed from EOF, skipping the prior history.
      await new Promise((r) => setTimeout(r, 120));
      expect(received).toHaveLength(0);

      // A new (post-resume) append IS dispatched.
      fs.appendFileSync(file, assistantTextLine('after resume') + '\n');
      await waitFor(() => received.length >= 1);
      const last = received[received.length - 1] as { message: { content: Array<{ text: string }> } };
      expect(last.message.content[0].text).toBe('after resume');
    });

    it('returns false when the known file is absent (leaves discovery running)', async () => {
      const logger = makeSpyLogger();
      const src = trackedSource({
        worktreePath: WORKTREE,
        projectsRoot: tmpRoot,
        discoveryTimeoutMs: 80,
        logger,
      });

      await src.start(() => undefined);
      const bound = src.bindKnownFileFromEnd('does-not-exist-0000-0000-000000000000');
      expect(bound).toBe(false);
      // Discovery still owns settlement → times out loudly (not silently bound).
      await expect(src.waitForFirstLine(80)).rejects.toThrow(/discovery timeout/i);
    });

    it('is a no-op once already bound via discovery', async () => {
      const logger = makeSpyLogger();
      const src = trackedSource({
        worktreePath: WORKTREE,
        projectsRoot: tmpRoot,
        discoveryTimeoutMs: 1500,
        logger,
      });

      await src.start(() => undefined);
      const discovered = 'disc-1111-2222-3333-444444444444';
      fs.writeFileSync(path.join(keyDir, `${discovered}.jsonl`), assistantTextLine('hi') + '\n');
      await src.waitForFirstLine(1500);
      expect(src.getSessionUuid()).toBe(discovered);

      // A pre-existing other file exists, but bind is refused (already bound).
      const other = 'other-9999-8888-7777-666666666666';
      fs.writeFileSync(path.join(keyDir, `${other}.jsonl`), assistantTextLine('x') + '\n');
      expect(src.bindKnownFileFromEnd(other)).toBe(false);
      expect(src.getSessionUuid()).toBe(discovered);
    });
  });
});
