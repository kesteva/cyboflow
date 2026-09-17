/**
 * Adversarial review — the machine-readable half of the Launch/Planner/Ship
 * `adversarial-review` step's critique.
 *
 * The step's subagent returns a `## Result` document holding `### Blocking`
 * (must-fix) and `### Findings` (advisory), each with `#### AR-n — title` entries
 * carrying a small set of bolded fields. The step agent PROMOTES those two
 * sections to top level (`## Blocking` / `## Findings`) when it composes the run's
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

export interface ParsedAdversarialReview {
  /** Entries under `## Blocking` — must-fix. */
  blocking: AdversarialFinding[];
  /** Entries under `## Findings` — advisory. */
  findings: AdversarialFinding[];
}

/** A section heading line at H2 or H3 (`## Blocking` / `### Blocking`). */
const SECTION_HEADING_RE = /^[ \t]*#{2,3}[ \t]+(.+?)[ \t]*$/;
/** An entry heading line (`#### AR-1 — Title`), tolerating any dash and 4-6 hashes. */
const ENTRY_HEADING_RE = /^[ \t]*#{4,6}[ \t]+(AR[-\s]?\d+)[ \t]*(?:[—–-][ \t]*)?(.*)$/i;
/** A bolded field line: `**Severity:** blocker   **Area:** spec`. */
const FIELD_RE = /\*\*([^*]+?)\s*:\*\*[ \t]*([^*]*)/g;

/** Section buckets this parser recognizes; anything else is ignored. */
type SectionKey = 'blocking' | 'findings' | null;

function classifySection(heading: string): SectionKey {
  const h = heading.trim().toLowerCase();
  // `## Result` is the wrapper, not a bucket — fall through to null so entries
  // written before any Blocking/Findings heading are not misfiled.
  if (h.startsWith('blocking')) return 'blocking';
  if (h.startsWith('finding')) return 'findings';
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
  const result: ParsedAdversarialReview = { blocking: [], findings: [] };
  if (typeof markdown !== 'string' || markdown.length === 0) return result;

  let section: SectionKey = null;
  let current: { entry: AdversarialFinding; bucket: Exclude<SectionKey, null>; body: string[] } | null = null;

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
    const entryMatch = ENTRY_HEADING_RE.exec(line);
    if (entryMatch) {
      flush();
      // An entry before any recognized section heading is treated as advisory —
      // it exists, so it must not vanish.
      const bucket: Exclude<SectionKey, null> = section ?? 'findings';
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
      // Only RESET the bucket on a heading we recognize, or on the `## Result`
      // wrapper. An unrelated heading between entries (a reviewer's `### Notes`)
      // leaves the current bucket alone rather than silently re-filing what
      // follows.
      if (classified !== null || /^result\b/i.test(sectionMatch[1].trim())) section = classified;
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
