/**
 * visualTaskSection — parses a task-verify agent's final markdown output for
 * the REQUIRED, two-sided §5.1 composition contract
 * (docs/proposals/verification-agent-redesign.md): on `VERDICT: PASS`, when
 * visual verification is enabled for the run, the output must contain EXACTLY
 * one of a `## Visual verification task` fence (a `VerificationTaskV1` JSON
 * payload) or an explicit `VISUAL-VERIFICATION: NOT-APPLICABLE` line. Absence
 * of both is NEVER silently treated as "nothing to verify" — the caller
 * (typed step-output channel consumer) decides what a `'missing'` result
 * means given whether visual verification is enabled for the run; this module
 * only parses.
 *
 * Fence-aware throughout: reuses the SHARED `makeFenceState`/`H2_LINE_RE`
 * grammar from `shared/types/artifacts.ts` (the same parser family as
 * `extractArchDesignSection`) so a `##`-prefixed line or a fake NOT-APPLICABLE
 * line inside a fenced code block is content, never structure.
 */
import { makeFenceState, H2_LINE_RE } from '../../../../shared/types/artifacts';
import { parseVerificationTaskV1 } from '../../../../shared/types/visualVerification';
import type { VerificationTaskV1 } from '../../../../shared/types/visualVerification';

export type VisualTaskSectionResult =
  | { kind: 'task'; task: VerificationTaskV1 }
  | { kind: 'not_applicable'; reason: string }
  | { kind: 'missing' } // neither section nor NOT-APPLICABLE line present
  | { kind: 'contract_error'; error: string };

/** The section heading line, case-insensitive on the words, trailing whitespace tolerated. */
const SECTION_HEADING_RE = /^##\s+Visual verification task\s*$/i;

/**
 * The NOT-APPLICABLE marker line: leading whitespace tolerated, the keyword
 * pair is case-sensitive (it is a machine-parsed marker, not prose). Captures
 * everything after the `NOT-APPLICABLE` token so the reason can be extracted
 * separately.
 */
const NOT_APPLICABLE_RE = /^\s*VISUAL-VERIFICATION:\s*NOT-APPLICABLE\b(.*)$/;

/**
 * Strips an optional leading separator (`—`, `-`, or `:`, with surrounding
 * whitespace) from the NOT-APPLICABLE marker's tail, then trims. An absent or
 * whitespace-only tail yields `''` (empty reason is allowed).
 */
function extractNotApplicableReason(tail: string): string {
  const trimmed = tail.trim();
  if (trimmed.length === 0) return '';
  const m = /^[—\-:]\s*(.*)$/.exec(trimmed);
  return m ? m[1].trim() : trimmed;
}

export function parseVisualTaskSection(text: string | null | undefined): VisualTaskSectionResult {
  if (!text) return { kind: 'missing' };
  const lines = text.split(/\r?\n/);

  const fence = makeFenceState();
  const headingIndices: number[] = [];
  const notApplicableEntries: Array<{ index: number; reason: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence.handleLine(line)) continue;
    if (fence.inFence()) continue;
    if (SECTION_HEADING_RE.test(line)) {
      headingIndices.push(i);
      continue;
    }
    const naMatch = NOT_APPLICABLE_RE.exec(line);
    if (naMatch) {
      notApplicableEntries.push({ index: i, reason: extractNotApplicableReason(naMatch[1]) });
    }
  }

  if (headingIndices.length > 1) {
    return {
      kind: 'contract_error',
      error: 'duplicate "## Visual verification task" heading (more than one section present)',
    };
  }
  if (notApplicableEntries.length > 1) {
    return { kind: 'contract_error', error: 'duplicate VISUAL-VERIFICATION: NOT-APPLICABLE line' };
  }
  if (headingIndices.length === 1 && notApplicableEntries.length === 1) {
    return {
      kind: 'contract_error',
      error:
        'both a "## Visual verification task" section and a VISUAL-VERIFICATION: NOT-APPLICABLE line are present',
    };
  }
  if (headingIndices.length === 0 && notApplicableEntries.length === 0) {
    return { kind: 'missing' };
  }
  if (notApplicableEntries.length === 1) {
    return { kind: 'not_applicable', reason: notApplicableEntries[0].reason };
  }

  // Exactly one heading, no NOT-APPLICABLE line: extract + validate the section.
  const headingIndex = headingIndices[0];
  const sectionStart = headingIndex + 1;

  // Re-run the SAME global fence walk up to sectionStart, then continue it to
  // find the section's end — the next H2 line outside a fence, or EOF. This
  // mirrors extractArchDesignSection's boundary-finding exactly.
  const boundaryFence = makeFenceState();
  let sectionEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (boundaryFence.handleLine(line)) continue;
    if (boundaryFence.inFence()) continue;
    if (i > headingIndex && H2_LINE_RE.test(line)) {
      sectionEnd = i;
      break;
    }
  }

  // Scan the section body for fenced code blocks (fresh, section-scoped fence
  // state — the heading requires the outer fence to be closed at this point,
  // so the section always begins outside any fence).
  const sectionFence = makeFenceState();
  let openCount = 0;
  let currentFenceLines: string[] = [];
  let lastClosedFenceLines: string[] | null = null;

  for (let i = sectionStart; i < sectionEnd; i++) {
    const line = lines[i];
    const wasInFence = sectionFence.inFence();
    const isDelimiter = sectionFence.handleLine(line);
    const nowInFence = sectionFence.inFence();
    if (isDelimiter) {
      if (!wasInFence && nowInFence) {
        openCount++;
        currentFenceLines = [];
      } else if (wasInFence && !nowInFence) {
        lastClosedFenceLines = currentFenceLines;
      }
      continue;
    }
    if (nowInFence) {
      currentFenceLines.push(line);
    }
  }

  if (openCount === 0) {
    return {
      kind: 'contract_error',
      error: 'no fenced code block found in the "## Visual verification task" section',
    };
  }
  if (openCount > 1) {
    return {
      kind: 'contract_error',
      error: 'duplicate fence in the "## Visual verification task" section (expected exactly one)',
    };
  }
  if (sectionFence.inFence() || lastClosedFenceLines === null) {
    return {
      kind: 'contract_error',
      error: 'unterminated fenced code block in the "## Visual verification task" section',
    };
  }

  const fenceContent = lastClosedFenceLines.join('\n');
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(fenceContent);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: 'contract_error', error: `invalid JSON in visual verification task fence: ${message}` };
  }

  const parsed = parseVerificationTaskV1(parsedJson);
  if (!parsed.ok) {
    return { kind: 'contract_error', error: `invalid visual verification task: ${parsed.error}` };
  }
  return { kind: 'task', task: parsed.task };
}
