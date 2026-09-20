/**
 * Adversarial review — the machine-readable half of the Launch/Planner/Ship
 * `adversarial-review` step's critique.
 *
 * The step's subagent returns a `## Result` document holding `### Blocking`
 * (must-fix), `### Findings` (advisory) and — on a re-review — `### Prior
 * entries` (the carry-forward ledger: one line per id from the PREVIOUS round
 * saying what became of it, which is the only way a reader can tell a converging
 * review from one that merely found a different set of defects). The first two
 * carry `#### AR-n — title` entries
 * with a small set of bolded fields; the ledger carries plain list lines. The
 * step agent PROMOTES all three
 * sections to top level (`## Blocking` / `## Findings` / `## Prior entries`) when it composes the run's
 * `adversarial-review` ARTIFACT, which is the only thing that survives the step's
 * turn. BOTH depths parse here, because the artifact is the promoted form while a
 * Revise threads the raw nested form back into the design steps. `AR-n` ids are
 * numbered once across both sections — they never restart under Findings — which
 * is what makes an id a safe idempotence key for the approve-side finding filing. Two consumers then have to read it back
 * without an agent in the loop:
 *
 *   - the `approve-design` gate body, which needs the counts and the blocking
 *     titles to tell the human what they are approving;
 *   - the gate's APPROVE side effect, which files one non-blocking accepted-risk
 *     finding per entry so nothing the reviewer raised is silently dropped.
 *
 * DESIGN: LENIENT, never throwing. The producer is a language model, so the parse
 * has to degrade rather than fail — a missing field yields an entry without it, an
 * unparseable severity falls back rather than dropping the entry, and a document
 * with no recognizable headings yields empty arrays. The cost of a lenient miss is
 * one finding that reads a bit thin; the cost of a strict throw is a gate that
 * cannot open.
 */

/** Severity as the reviewer declares it, ordered most to least serious. */
export type AdversarialSeverity = 'blocker' | 'major' | 'minor' | 'advisory';

/** The severities as an ordered, readonly tuple. */
export const ADVERSARIAL_SEVERITIES = ['blocker', 'major', 'minor', 'advisory'] as const satisfies readonly AdversarialSeverity[];

/**
 * One reviewed defect or observation.
 *
 * `id` is the reviewer's own `AR-n` label, which is what makes an entry stable
 * across a re-review: the approve side effect keys idempotence on it, and the
 * Revise feedback asks the re-run to say which `AR-n` ids it resolved.
 */
export interface AdversarialFinding {
  /** The `AR-n` label from the entry's heading (e.g. 'AR-3'). */
  id: string;
  /** The heading text after the label. */
  title: string;
  severity: AdversarialSeverity;
  /** What the entry is about — spec / prototype / architecture / criteria. */
  area?: string;
  /** The defect itself. */
  what?: string;
  /** Why it matters. */
  why?: string;
  /** The concrete change the reviewer proposes. */
  fix?: string;
}

/**
 * What became of a prior round's entry, as the re-review reports it in its
 * carry-forward ledger.
 *
 * `set-aside` is the supervisor's steering excluding an entry from this lap;
 * `withdrawn` is the reviewer no longer standing behind it. The two are kept
 * apart because only one of them is a judgement about the DEFECT.
 */
export type PriorEntryStatus =
  | 'resolved'
  | 'unresolved'
  | 'resolved-with-regression'
  | 'set-aside'
  | 'withdrawn';

/**
 * One line of a re-review's `## Prior entries` ledger: an id from the PREVIOUS
 * round and what this round found of it.
 *
 * `previousSeverity` is the severity the entry carried LAST round, which is the
 * only way a reader can count prior blockers apart from prior advisories — this
 * round's document may not list the entry at all (it was resolved), so its
 * current severity does not exist. Optional because the reviewer may omit the
 * parenthesis; a ledger line without it still carries its status.
 */
export interface PriorEntry {
  /** The `AR-n` label, normalized (e.g. 'AR-3'). */
  id: string;
  /** The entry's severity in the PREVIOUS round, when the reviewer declared it. */
  previousSeverity?: AdversarialSeverity;
  status: PriorEntryStatus;
  /** For `resolved-with-regression (see AR-m)`: the `AR-m` the regression became. */
  ref?: string;
  /** The reviewer's one-line explanation, when there is one. */
  note?: string;
}

export interface ParsedAdversarialReview {
  /** Entries under `## Blocking` — must-fix. */
  blocking: AdversarialFinding[];
  /** Entries under `## Findings` — advisory. */
  findings: AdversarialFinding[];
  /**
   * The `## Prior entries` carry-forward ledger — empty on a first review, and
   * empty for any document written before the ledger existed. ALWAYS present so
   * a consumer can read `.prior.length` without a guard.
   */
  prior: PriorEntry[];
}

/** A section heading line at H2 or H3 (`## Blocking` / `### Blocking`). */
const SECTION_HEADING_RE = /^[ \t]*#{2,3}[ \t]+(.+?)[ \t]*$/;
/** An entry heading line (`#### AR-1 — Title`), tolerating any dash and 4-6 hashes. */
const ENTRY_HEADING_RE = /^[ \t]*#{4,6}[ \t]+(AR[-\s]?\d+)[ \t]*(?:[—–-][ \t]*)?(.*)$/i;
/** A bolded field line: `**Severity:** blocker   **Area:** spec`. */
const FIELD_RE = /\*\*([^*]+?)\s*:\*\*[ \t]*([^*]*)/g;
/** A fenced-code delimiter (``` or ~~~), at any indent. */
const FENCE_RE = /^[ \t]*(?:```|~~~)/;
/**
 * One ledger line: `- AR-3 (major) — unresolved — the fix moved the check`.
 * The severity parenthesis and the dash are both optional, and any list marker
 * and dash flavour are accepted — the producer is a language model.
 */
const PRIOR_LINE_RE =
  /^[ \t]*[-*+][ \t]+(AR[-\s]?\d+)\b[ \t]*(?:\(([^)]*)\))?[ \t]*(?:[—–:-][ \t]*)?(.*)$/i;
/** The five status words, longest-first so `resolved-with-regression` wins over `resolved`. */
const PRIOR_STATUS_RE = /^(resolved[-\s]with[-\s]regression|unresolved|resolved|set[-\s]aside|withdrawn)\b/i;
/** The regression pointer that may follow the status: `(see AR-7)`. */
const PRIOR_REF_RE = /^[ \t]*\([ \t]*see[ \t]+(AR[-\s]?\d+)[ \t]*\)/i;
/**
 * Every `AR-n` token, for `maxAdversarialId`. The leading `\b` is load-bearing:
 * without it the `ar` inside ordinary prose (`year 2026`, `a linear 4-step flow`)
 * matches and inflates the spent-id range the re-review prompt quotes. There is
 * deliberately no trailing `\b` — `AR-12abc` should degrade to 12, not be rejected.
 */
const AR_TOKEN_RE = /\bAR[-\s]?(\d+)/gi;

/** Section buckets this parser recognizes; anything else is ignored. */
type SectionKey = 'blocking' | 'findings' | 'prior' | null;
/** The two sections that hold `#### AR-n` ENTRIES (the ledger holds lines, not entries). */
type EntryBucket = 'blocking' | 'findings';

function classifySection(heading: string): SectionKey {
  const h = heading.trim().toLowerCase();
  // `## Result` is the wrapper, not a bucket — fall through to null so entries
  // written before any Blocking/Findings heading are not misfiled.
  if (h.startsWith('blocking')) return 'blocking';
  if (h.startsWith('finding')) return 'findings';
  if (h.startsWith('prior entr')) return 'prior';
  return null;
}

function normalizeSeverity(raw: string | undefined, fallback: AdversarialSeverity): AdversarialSeverity {
  const v = (raw ?? '').trim().toLowerCase();
  const hit = ADVERSARIAL_SEVERITIES.find((s) => v.startsWith(s));
  return hit ?? fallback;
}

/** `AR-3`, `AR 3`, `ar3` all normalize to `AR-3` so idempotence keys line up. */
function normalizeId(raw: string): string {
  const digits = /(\d+)/.exec(raw);
  return digits ? `AR-${digits[1]}` : raw.trim().toUpperCase();
}

/** Collapse inline whitespace and strip trailing punctuation noise from a field value. */
function cleanField(value: string): string | undefined {
  const v = value.replace(/\s+/g, ' ').trim().replace(/[\s.;,]+$/, '');
  return v.length > 0 ? v : undefined;
}

/** `resolved with regression` / `Set Aside` → the canonical union member. */
function normalizePriorStatus(raw: string): PriorEntryStatus {
  return raw.trim().toLowerCase().replace(/\s+/g, '-') as PriorEntryStatus;
}

/**
 * Parse ONE `## Prior entries` ledger line, or null when the line is not one.
 *
 * STRICT about the status word and lenient about everything else: a line whose
 * status is not one of the five is DROPPED rather than guessed at, because the
 * gate's convergence arithmetic counts these — inventing a status would make the
 * gate report progress that nobody verified. Everything else (the list marker,
 * the dash flavour, the severity parenthesis, the note) degrades the usual way.
 */
function parsePriorLine(line: string): PriorEntry | null {
  const m = PRIOR_LINE_RE.exec(line);
  if (m === null) return null;
  const statusMatch = PRIOR_STATUS_RE.exec(m[3]);
  if (statusMatch === null) return null;

  const entry: PriorEntry = { id: normalizeId(m[1]), status: normalizePriorStatus(statusMatch[1]) };

  const declared = (m[2] ?? '').trim().toLowerCase();
  const severity = ADVERSARIAL_SEVERITIES.find((s) => declared.startsWith(s));
  if (severity !== undefined) entry.previousSeverity = severity;

  let rest = m[3].slice(statusMatch[0].length);
  const refMatch = PRIOR_REF_RE.exec(rest);
  if (refMatch !== null) {
    entry.ref = normalizeId(refMatch[1]);
    rest = rest.slice(refMatch[0].length);
  }
  const note = cleanField(rest.replace(/^[ \t]*[—–:-][ \t]*/, ''));
  if (note !== undefined) entry.note = note;
  return entry;
}

/**
 * The highest `AR-n` number appearing anywhere in a document, or 0 when there is
 * none.
 *
 * Deliberately a whole-document scan rather than a walk of the parsed buckets:
 * the point is "which ids have been SPENT in this run", and an id can survive
 * only in the ledger (resolved last round, listed nowhere else this round). The
 * next round's prompt hands this number to the reviewer so a new entry continues
 * from it instead of colliding with a retired id.
 */
export function maxAdversarialId(markdown: string | null | undefined): number {
  if (typeof markdown !== 'string' || markdown.length === 0) return 0;
  let max = 0;
  AR_TOKEN_RE.lastIndex = 0;
  for (let m = AR_TOKEN_RE.exec(markdown); m !== null; m = AR_TOKEN_RE.exec(markdown)) {
    const n = Number.parseInt(m[1], 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

/**
 * Parse an adversarial-review document into its two buckets.
 *
 * `None.` (or an empty section) yields an empty array for that bucket, which is
 * the reviewer's way of saying "nothing here" and must read as zero rather than
 * as an unparsed document.
 *
 * Fields are read from the bolded `**Key:** value` pairs anywhere between an
 * entry's heading and the next heading, so the reviewer may put several on one
 * line or one per line. `Why it matters` maps to `why`; every other key matches on
 * its first word, so `**Fix:**` and `**Fix (proposed):**` both land on `fix`.
 *
 * An entry's severity defaults to its SECTION: an entry under `## Blocking` with
 * no parseable severity is a `blocker`, one under `## Findings` is `advisory`.
 * That keeps a sloppily-formatted blocking defect from being downgraded to a
 * non-blocking note, which is the failure direction that actually costs something.
 */
export function parseAdversarialReviewDoc(markdown: string | null | undefined): ParsedAdversarialReview {
  const result: ParsedAdversarialReview = { blocking: [], findings: [], prior: [] };
  if (typeof markdown !== 'string' || markdown.length === 0) return result;

  let section: SectionKey = null;
  let current: { entry: AdversarialFinding; bucket: EntryBucket; body: string[] } | null = null;
  // Fence state, consulted ONLY by the ledger (its heading and its lines). The
  // two older buckets keep their pre-ledger behaviour byte for byte: their
  // recognition never looked at fences and changing that here would silently
  // re-parse documents this module has been reading for two releases. The ledger
  // is new, so it gets the stricter rule from the start — a fenced EXAMPLE of a
  // ledger line (the reviewer prompt shows one) must never count as an entry.
  let inFence = false;

  const flush = (): void => {
    if (!current) return;
    const text = current.body.join('\n');
    const fields = new Map<string, string>();
    FIELD_RE.lastIndex = 0;
    for (let m = FIELD_RE.exec(text); m !== null; m = FIELD_RE.exec(text)) {
      const key = m[1].trim().toLowerCase();
      const value = cleanField(m[2]);
      if (value !== undefined && !fields.has(key)) fields.set(key, value);
    }
    const pick = (prefix: string): string | undefined => {
      for (const [key, value] of fields) if (key.startsWith(prefix)) return value;
      return undefined;
    };
    const entry = current.entry;
    entry.severity = normalizeSeverity(
      pick('severity'),
      current.bucket === 'blocking' ? 'blocker' : 'advisory',
    );
    const area = pick('area');
    const what = pick('what');
    const why = pick('why');
    const fix = pick('fix');
    if (area !== undefined) entry.area = area;
    if (what !== undefined) entry.what = what;
    if (why !== undefined) entry.why = why;
    if (fix !== undefined) entry.fix = fix;
    // A title-less entry still carries an id and a severity — better a thin
    // finding than a dropped one.
    if (entry.title.length === 0) entry.title = entry.id;
    result[current.bucket].push(entry);
    current = null;
  };

  for (const line of markdown.split(/\r?\n/)) {
    if (FENCE_RE.test(line)) inFence = !inFence;

    const entryMatch = ENTRY_HEADING_RE.exec(line);
    if (entryMatch) {
      flush();
      // A `#### AR-n` under the LEDGER is a re-statement, not an entry: the
      // ledger's whole job is to name ids the current round is NOT re-filing, so
      // promoting one to `blocking` would double-count it at the gate.
      if (section === 'prior') continue;
      // An entry before any recognized section heading is treated as advisory —
      // it exists, so it must not vanish.
      const bucket: EntryBucket = section === null ? 'findings' : section;
      current = {
        bucket,
        body: [],
        entry: {
          id: normalizeId(entryMatch[1]),
          title: entryMatch[2].replace(/\s+/g, ' ').trim(),
          severity: bucket === 'blocking' ? 'blocker' : 'advisory',
        },
      };
      continue;
    }

    const sectionMatch = SECTION_HEADING_RE.exec(line);
    if (sectionMatch) {
      flush();
      const classified = classifySection(sectionMatch[1]);
      // A `## Prior entries` heading inside a fence is an EXAMPLE of the format,
      // not the section itself — fall through as if it were unrecognized.
      if (classified === 'prior' && inFence) continue;
      // Only RESET the bucket on a heading we recognize, or on the `## Result`
      // wrapper. An unrelated heading between entries (a reviewer's `### Notes`)
      // leaves the current bucket alone rather than silently re-filing what
      // follows.
      if (classified !== null || /^result\b/i.test(sectionMatch[1].trim())) section = classified;
      continue;
    }

    if (section === 'prior' && !inFence) {
      const priorEntry = parsePriorLine(line);
      if (priorEntry !== null) result.prior.push(priorEntry);
      continue;
    }

    if (current) current.body.push(line);
  }
  flush();

  return result;
}

/**
 * The severity a filed review-item finding carries for an adversarial entry.
 *
 * blocker/major → 'error', minor → 'warning', advisory → 'info'. The two most
 * serious levels collapse deliberately: the review-item vocabulary has three
 * steps and these findings are filed NON-BLOCKING (the human already chose to
 * accept them at the gate), so the distinction that matters downstream is
 * "someone should look at this" vs "noted".
 */
export function adversarialSeverityToReviewSeverity(
  severity: AdversarialSeverity,
): 'error' | 'warning' | 'info' {
  switch (severity) {
    case 'blocker':
    case 'major':
      return 'error';
    case 'minor':
      return 'warning';
    case 'advisory':
      return 'info';
  }
}
