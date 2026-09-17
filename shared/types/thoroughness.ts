/**
 * Solution thoroughness — how finished the software a project builds has to be.
 *
 * Launch's interview asks this FIRST, before anything else, because the answer
 * prunes the rest of the interview and then sizes every downstream contract:
 * how long an architecture section may be, whether tasks carry edge-case
 * criteria, whether a review treats a security gap as blocking or advisory, and
 * what tuning level the session wizard defaults to. The brief carries the answer
 * as a `THOROUGHNESS:` flag line beside the existing `UI_PROTOTYPE:` /
 * `ARCH_DESIGN:` flags; the approve-brief gate parses it out and stamps it on the
 * PROJECT (migration 135), where it outlives the Launch run and every later
 * Sprint/Ship run reads it back.
 *
 * This module is the vocabulary ONLY — the level union, the flag parser, and the
 * tuning-level mapping. The per-level prompt BUDGETS live in
 * `shared/types/thoroughnessBudgets.ts`, which imports the union from here; the
 * split keeps this file free of prose that changes on a different cadence than
 * the vocabulary.
 */

/**
 * The three levels, in increasing order of finish.
 *
 * - `prototype` — throwaway; the point is to prove the idea, not to keep it.
 * - `v1` — working software ONE person relies on. Today's implicit default.
 * - `production` — other people depend on it: hardening, recovery, data durability.
 */
export type SolutionThoroughness = 'prototype' | 'v1' | 'production';

/** The levels as an ordered, readonly tuple — the canonical iteration order. */
export const SOLUTION_THOROUGHNESS_LEVELS = ['prototype', 'v1', 'production'] as const satisfies readonly SolutionThoroughness[];

/** Narrowing guard for an untrusted string (a parsed flag, a DB column read). */
export function isSolutionThoroughness(value: unknown): value is SolutionThoroughness {
  return (
    typeof value === 'string' &&
    (SOLUTION_THOROUGHNESS_LEVELS as readonly string[]).includes(value)
  );
}

/**
 * Matches the brief's `THOROUGHNESS: <level>` flag as a single LINE.
 *
 * Deliberately `[ \t]` rather than `\s` — `\s` spans newlines, which would let a
 * bare `THOROUGHNESS:` line plus an unrelated later word spoof a level. Leading
 * whitespace and an optional list marker are tolerated because the interview
 * agent writes these flags inside a bullet list as often as at column zero;
 * trailing whitespace and a trailing period are tolerated for the same reason.
 * Case-insensitive on BOTH halves: the flag key is conventionally SHOUTED and
 * the value conventionally lowercase, but neither is worth a silent miss.
 */
const THOROUGHNESS_FLAG_LINE_RE = /^[ \t]*(?:[-*+][ \t]+)?\**THOROUGHNESS\**[ \t]*:[ \t]*\**[ \t]*([A-Za-z0-9]+)/im;

/**
 * The solution thoroughness declared by a brief's `THOROUGHNESS:` flag line, or
 * null when the brief carries no such line or names a level outside the union.
 *
 * Null is the SAFE answer and the one every caller is built around: no
 * `# Solution thoroughness` section is rendered into a step prompt, no project
 * column is stamped, and the wizard keeps its existing default. Guessing a level
 * from the prose would silently change how thoroughly a whole project gets built.
 *
 * LAST flag line wins, mirroring the section extractors' last-heading-wins rule:
 * a brief revised at the gate appends its correction rather than editing in
 * place, and the correction is the answer.
 */
export function parseThoroughnessFlag(briefMarkdown: string | null | undefined): SolutionThoroughness | null {
  if (typeof briefMarkdown !== 'string' || briefMarkdown.length === 0) return null;
  let found: SolutionThoroughness | null = null;
  for (const line of briefMarkdown.split(/\r?\n/)) {
    const m = THOROUGHNESS_FLAG_LINE_RE.exec(line);
    if (!m) continue;
    const value = m[1].toLowerCase();
    if (isSolutionThoroughness(value)) found = value;
  }
  return found;
}

/** The workflow tuning levels a thoroughness maps onto (mirrors TuningLevel's preset arms). */
export type ThoroughnessTuningLevel = 'efficient' | 'standard' | 'thorough';

/**
 * The tuning level a project's thoroughness defaults the session wizard to.
 *
 * A DEFAULT, never a lock: the wizard's explicit override still wins, and a
 * pinned variant's own level wins ahead of this (a variant belongs to exactly
 * one level's pool, so a stamp-driven level would otherwise break the pin's
 * containment guard). The mapping is deliberately total — every level has an
 * answer, so a stamped project always gets a considered default.
 */
export function thoroughnessToTuningLevel(level: SolutionThoroughness): ThoroughnessTuningLevel {
  switch (level) {
    case 'prototype':
      return 'efficient';
    case 'v1':
      return 'standard';
    case 'production':
      return 'thorough';
  }
}
