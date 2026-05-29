/**
 * IDEA-013 PROBE (TASK-805) — Probes B, C, E. THROWAWAY; lives under docs/probes/scratch/
 * which is OUTSIDE main/tsconfig.json (`src/**` + `../shared/**`), so it is not part of the
 * app build. Run with: `npx tsx docs/probes/scratch/probe-transcript.ts <command> ...`.
 *
 * Commands:
 *   encode   <abs-cwd>            Probe B: show the encodeCwd candidate + the matching live ~/.claude/projects dir.
 *   discover <abs-cwd>            Probe B: resolve the newest *.jsonl + its session UUID (filename-only check).
 *   watch    <abs-cwd> [timeout]  Probe B: time spawn->first-.jsonl write (set DISCOVERY_TIMEOUT_MS). Start BEFORE launching claude.
 *   classify <file.jsonl> [--use-schema]   Probes C+E: inventory top-level types/system subtypes, __unknown__
 *                                 rate, result-line presence (C), stop_hook_summary/turn_duration markers (C),
 *                                 first cwd-bearing line + file-history-snapshot first-line check (B),
 *                                 STRING-content user lines + camelCase sessionId + system/init presence (E).
 *
 * CLAUDE.md no-`any` rule honored: parsed lines are `unknown`, narrowed via guards.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// --- Modeled wire types (mirrors main/src/services/streamParser/schemas.ts as of 2026-05-29). ---
const MODELED_TOP_LEVEL: ReadonlySet<string> = new Set([
  'system', 'session_info', 'rate_limit_event', 'assistant', 'user', 'result', 'stream_event',
]);
const MODELED_SYSTEM_SUBTYPES: ReadonlySet<string> = new Set([
  'init', 'compact_boundary', 'hook_started', 'hook_response', 'status',
]);
const MODELED_RESULT_SUBTYPES: ReadonlySet<string> = new Set([
  'success', 'error_max_turns', 'error_max_budget_usd', 'error_during_execution', 'error_max_structured_output_retries',
]);

function projectsDir(): string {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, 'projects');
}

/** Best-known Claude Code cwd->project-dir encoding. Probe B VERIFIES this against the live dir. */
function encodeCwdCandidate(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function getString(rec: Record<string, unknown>, key: string): string | undefined {
  const v = rec[key];
  return typeof v === 'string' ? v : undefined;
}

function listProjectDirs(): string[] {
  const dir = projectsDir();
  try {
    return fs.readdirSync(dir).filter((e) => {
      try { return fs.statSync(path.join(dir, e)).isDirectory(); } catch { return false; }
    });
  } catch {
    return [];
  }
}

function findLiveProjectDir(cwd: string): { candidate: string; matched: string | null; exact: boolean } {
  const candidate = encodeCwdCandidate(cwd);
  const dirs = listProjectDirs();
  if (dirs.includes(candidate)) return { candidate, matched: candidate, exact: true };
  // Fall back to a dir that DECODES (dashes->slashes) to the same path, to surface encoding drift.
  const norm = (s: string): string => s.replace(/[^a-zA-Z0-9]/g, '');
  const target = norm(cwd);
  const fuzzy = dirs.find((d) => norm(d) === target) ?? null;
  return { candidate, matched: fuzzy, exact: false };
}

function newestJsonl(dir: string): { file: string; mtimeMs: number } | null {
  try {
    const entries = fs.readdirSync(dir).filter((e) => e.endsWith('.jsonl'));
    let best: { file: string; mtimeMs: number } | null = null;
    for (const e of entries) {
      const full = path.join(dir, e);
      const m = fs.statSync(full).mtimeMs;
      if (!best || m > best.mtimeMs) best = { file: full, mtimeMs: m };
    }
    return best;
  } catch {
    return null;
  }
}

function cmdEncode(cwd: string): void {
  const { candidate, matched, exact } = findLiveProjectDir(cwd);
  console.log(`cwd:           ${cwd}`);
  console.log(`encodeCwd():   ${candidate}`);
  console.log(`projects dir:  ${projectsDir()}`);
  console.log(`live match:    ${matched ?? '(none found — launch claude in this cwd first)'}`);
  console.log(`exact match:   ${exact ? 'YES (encodeCwd candidate is correct)' : 'NO (see live match above; record the real algorithm)'}`);
  console.log('Record in findings (Probe B): the encodeCwd example + a non-ASCII case + the #19972 collision note.');
}

function cmdDiscover(cwd: string): void {
  const { matched } = findLiveProjectDir(cwd);
  if (!matched) {
    console.log('No matching ~/.claude/projects dir. Launch interactive claude in this cwd first, then retry.');
    return;
  }
  const dir = path.join(projectsDir(), matched);
  const newest = newestJsonl(dir);
  if (!newest) { console.log(`No *.jsonl in ${dir}`); return; }
  const uuid = path.basename(newest.file, '.jsonl');
  console.log(`project dir:   ${dir}`);
  console.log(`newest jsonl:  ${newest.file}`);
  console.log(`session UUID:  ${uuid}  (Probe B: confirm this is the ONLY place the UUID appears; --session-id is ignored interactively, #44607)`);
}

function cmdWatch(cwd: string, timeoutMs: number): void {
  const { matched, candidate } = findLiveProjectDir(cwd);
  const dirName = matched ?? candidate;
  const dir = path.join(projectsDir(), dirName);
  fs.mkdirSync(dir, { recursive: true });
  const before = new Set(fs.existsSync(dir) ? fs.readdirSync(dir).filter((e) => e.endsWith('.jsonl')) : []);
  const start = Date.now();
  console.log(`Watching ${dir} for a NEW *.jsonl. Launch interactive claude in ${cwd} now...`);

  const finish = (file: string | null): void => {
    if (file) {
      console.log(`first new jsonl: ${file}`);
      console.log(`spawn->first-write delay: ${Date.now() - start} ms`);
      console.log(`=> set DISCOVERY_TIMEOUT_MS to comfortably above this (e.g. 5-10x, min a few seconds).`);
    } else {
      console.log(`TIMEOUT after ${timeoutMs} ms — no new *.jsonl appeared. The discovery path must surface a loud failure here.`);
    }
    process.exit(0);
  };

  const timer = setTimeout(() => finish(null), timeoutMs);
  try {
    fs.watch(dir, (_event, filename) => {
      if (filename && filename.endsWith('.jsonl') && !before.has(filename)) {
        clearTimeout(timer);
        finish(path.join(dir, filename));
      }
    });
  } catch {
    // Poll fallback for platforms where fs.watch is unreliable.
    const poll = setInterval(() => {
      const now = fs.readdirSync(dir).filter((e) => e.endsWith('.jsonl'));
      const fresh = now.find((e) => !before.has(e));
      if (fresh) { clearInterval(poll); clearTimeout(timer); finish(path.join(dir, fresh)); }
    }, 100);
  }
}

interface ClassifyStats {
  total: number;
  parseFailures: number;
  unknown: number;
  byTopType: Map<string, number>;
  bySystemSubtype: Map<string, number>;
  unknownTopTypes: Set<string>;
  unknownSystemSubtypes: Set<string>;
  hasResultLine: boolean;
  turnEndMarkers: number;        // system/stop_hook_summary + system/turn_duration (Probe C)
  firstLineType: string | null;  // expect 'file-history-snapshot' (Probe B)
  firstCwdLineIndex: number;     // first line bearing a top-level cwd (Probe B)
  stringContentUserLines: number; // user lines whose message.content is a STRING (Probe E)
  sawCamelSessionId: boolean;    // top-level camelCase sessionId (Probe E)
  sawSystemInit: boolean;        // system/init present? (expected NO interactively) (Probe E)
}

function bump(m: Map<string, number>, k: string): void { m.set(k, (m.get(k) ?? 0) + 1); }

function classifyLine(rec: Record<string, unknown>, idx: number, s: ClassifyStats): void {
  const type = getString(rec, 'type') ?? '(no-type)';
  if (s.firstLineType === null) s.firstLineType = type;
  bump(s.byTopType, type);

  if (s.firstCwdLineIndex < 0 && typeof rec['cwd'] === 'string') s.firstCwdLineIndex = idx;
  if (typeof rec['sessionId'] === 'string') s.sawCamelSessionId = true;

  let modeled = MODELED_TOP_LEVEL.has(type);

  if (type === 'system') {
    const sub = getString(rec, 'subtype') ?? '(no-subtype)';
    bump(s.bySystemSubtype, sub);
    if (sub === 'init') s.sawSystemInit = true;
    if (sub === 'stop_hook_summary' || sub === 'turn_duration') s.turnEndMarkers += 1;
    if (!MODELED_SYSTEM_SUBTYPES.has(sub)) { modeled = false; s.unknownSystemSubtypes.add(sub); }
  } else if (type === 'result') {
    s.hasResultLine = true;
    const sub = getString(rec, 'subtype') ?? '(no-subtype)';
    if (!MODELED_RESULT_SUBTYPES.has(sub)) modeled = false;
  } else if (type === 'user') {
    // userEventSchema requires message.content to be an ARRAY; a STRING fails it.
    const msg = rec['message'];
    if (isRecord(msg) && typeof msg['content'] === 'string') { s.stringContentUserLines += 1; modeled = false; }
  }

  if (!modeled) { s.unknown += 1; if (!MODELED_TOP_LEVEL.has(type)) s.unknownTopTypes.add(type); }
}

async function cmdClassify(file: string, useSchema: boolean): Promise<void> {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const s: ClassifyStats = {
    total: 0, parseFailures: 0, unknown: 0,
    byTopType: new Map(), bySystemSubtype: new Map(),
    unknownTopTypes: new Set(), unknownSystemSubtypes: new Set(),
    hasResultLine: false, turnEndMarkers: 0, firstLineType: null,
    firstCwdLineIndex: -1, stringContentUserLines: 0, sawCamelSessionId: false, sawSystemInit: false,
  };

  // Optional precise cross-check against the REAL production schema.
  let schemaSafeParse: ((v: unknown) => { success: boolean }) | null = null;
  if (useSchema) {
    try {
      const mod: unknown = await import('../../../main/src/services/streamParser/schemas.ts');
      if (isRecord(mod) && 'claudeStreamEventSchema' in mod) {
        const schema = (mod as Record<string, unknown>)['claudeStreamEventSchema'];
        if (isRecord(schema) && typeof (schema as Record<string, unknown>)['safeParse'] === 'function') {
          const fn = (schema as { safeParse: (v: unknown) => { success: boolean } }).safeParse;
          schemaSafeParse = (v: unknown) => fn(v);
        }
      }
    } catch (err) {
      console.log(`(--use-schema unavailable: ${String(err)}. Falling back to the heuristic inventory.)`);
    }
  }
  let schemaUnknown = 0;

  lines.forEach((line, idx) => {
    s.total += 1;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { s.parseFailures += 1; return; }
    if (!isRecord(parsed)) { s.unknown += 1; return; }
    classifyLine(parsed, idx, s);
    if (schemaSafeParse && !schemaSafeParse(parsed).success) schemaUnknown += 1;
  });

  const pct = (n: number): string => `${((n / Math.max(1, s.total)) * 100).toFixed(1)}%`;
  console.log(`file:                ${file}`);
  console.log(`total lines:         ${s.total}`);
  console.log(`parse failures:      ${s.parseFailures}`);
  console.log(`__unknown__ (heur):  ${s.unknown}  (${pct(s.unknown)})  <-- Probe E HARD GATE`);
  if (schemaSafeParse) console.log(`__unknown__ (schema):${schemaUnknown}  (${pct(schemaUnknown)})  (claudeStreamEventSchema.safeParse failures)`);
  console.log(`\ntop-level type counts:`);
  for (const [k, v] of [...s.byTopType.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${MODELED_TOP_LEVEL.has(k) ? ' ' : '!'} ${k}: ${v}`);
  }
  console.log(`system subtype counts:`);
  for (const [k, v] of [...s.bySystemSubtype.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${MODELED_SYSTEM_SUBTYPES.has(k) ? ' ' : '!'} ${k}: ${v}`);
  }
  console.log(`\nunmodeled top-level types:   ${[...s.unknownTopTypes].join(', ') || '(none)'}`);
  console.log(`unmodeled system subtypes:   ${[...s.unknownSystemSubtypes].join(', ') || '(none)'}`);
  console.log(`\n-- Probe C (completion) --`);
  console.log(`has {type:'result'} line:    ${s.hasResultLine}  (expect FALSE for a no-\`-p\` interactive turn)`);
  console.log(`turn-end markers (stop_hook_summary/turn_duration): ${s.turnEndMarkers}  (SECONDARY turn-end signal)`);
  console.log(`-- Probe B (discovery/collision) --`);
  console.log(`first physical line type:    ${s.firstLineType}  (expect 'file-history-snapshot', which LACKS cwd)`);
  console.log(`first cwd-bearing line idx:  ${s.firstCwdLineIndex}  (bind collision disambiguation here, NOT system/init.cwd)`);
  console.log(`-- Probe E (schema divergence) --`);
  console.log(`STRING-content user lines:   ${s.stringContentUserLines}  (fail userEventSchema's array requirement)`);
  console.log(`camelCase top-level sessionId present: ${s.sawCamelSessionId}`);
  console.log(`system/init present:         ${s.sawSystemInit}  (expect FALSE interactively)`);
  console.log(`\nCONCLUSION: a normalizer + noise-filter is MANDATORY for S2 if __unknown__ > ~0% for non-panel lines.`);
}

const [cmd, arg1, arg2] = process.argv.slice(2);
(async () => {
  switch (cmd) {
    case 'encode':
      if (!arg1) { console.error('usage: encode <abs-cwd>'); process.exit(1); }
      cmdEncode(arg1); break;
    case 'discover':
      if (!arg1) { console.error('usage: discover <abs-cwd>'); process.exit(1); }
      cmdDiscover(arg1); break;
    case 'watch':
      if (!arg1) { console.error('usage: watch <abs-cwd> [timeoutMs]'); process.exit(1); }
      cmdWatch(arg1, Number.parseInt(arg2 || '60000', 10) || 60000); break;
    case 'classify':
      if (!arg1) { console.error('usage: classify <file.jsonl> [--use-schema]'); process.exit(1); }
      await cmdClassify(arg1, process.argv.includes('--use-schema')); break;
    default:
      console.error('commands: encode <cwd> | discover <cwd> | watch <cwd> [timeoutMs] | classify <file.jsonl> [--use-schema]');
      process.exit(1);
  }
})().catch((err: unknown) => { console.error(String(err)); process.exit(1); });
