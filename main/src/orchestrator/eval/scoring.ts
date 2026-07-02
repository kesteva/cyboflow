/**
 * scoring — the PURE aggregation core of the Code-Review Eval. Turns K jury
 * samples (each a per-sub-check verdict set + optional findings) plus the
 * deterministic gate outcome into a single rollup: per-dimension scores + an
 * overall /100 + bands + CI + catastrophic-cap / gate flags.
 *
 * This module is DATA + PURE FUNCTIONS ONLY — zero I/O, no Date/random, no SDK,
 * no DB. Every rule here transcribes "How scoring works" from
 * docs/proposals/code-review-eval-checklist.md (rubric v1.1); the EvalWorker owns
 * the impure edges (SDK call, DB persistence, findings write). Keeping the math
 * pure is what makes the rubric's tricky cases (UNKNOWN exclusion, thin-evidence
 * INACTIVE + renormalization, floor-at-1, catastrophic cap, GATED sentinel)
 * exhaustively unit-testable — this is where review looks hardest.
 */
import {
  RUBRIC,
  AGGREGATION,
  GATED_SENTINEL,
  bandForFraction,
  type Rubric,
  type RubricSubCheck,
  type RubricDimension,
  type DimensionKey,
  type CapFlag,
} from './rubric';

// ---------------------------------------------------------------------------
// Jury I/O shapes (the judge produces these; scoring consumes them)
// ---------------------------------------------------------------------------

/** A single sub-check verdict from ONE jury sample. */
export type Verdict = 'PASS' | 'FAIL' | 'UNKNOWN' | 'NOT_APPLICABLE';

/** Valid verdict tokens — used by the defensive parser in evalJury. */
export const VERDICTS: readonly Verdict[] = ['PASS', 'FAIL', 'UNKNOWN', 'NOT_APPLICABLE'];

export interface SubCheckVerdict {
  /** Rubric sub-check id, e.g. 'COR-2'. */
  id: string;
  verdict: Verdict;
  /** Free-text justification the judge cites (may be empty). */
  evidence: string;
}

/**
 * A judge-surfaced finding. `netNew` is the judge's claim it is not already in
 * the review queue; the worker still dedups against existing review_items.
 * `catastrophic` is set when the finding corresponds to a confirmed cap-trigger
 * class (destructive migration, off-chokepoint write, migration collision,
 * unimplemented AC, or high/critical security).
 */
export interface JudgeFinding {
  /** The sub-check the finding hangs off (e.g. 'SEC-2'); '' when general. */
  subCheckId: string;
  dimension: DimensionKey;
  /** Maps to review_items.severity (DB CHECK: info|warning|error). */
  severity: 'info' | 'warning' | 'error';
  title: string;
  body: string;
  file?: string;
  line?: number;
  netNew: boolean;
  catastrophic: boolean;
}

/** One jury sample: a full pass over the applicable sub-checks + any findings. */
export interface JudgeSample {
  verdicts: SubCheckVerdict[];
  findings: JudgeFinding[];
}

// ---------------------------------------------------------------------------
// Deterministic gate
// ---------------------------------------------------------------------------

export type GateStatus = 'pass' | 'fail' | 'unknown';

/**
 * The deterministic gate (build · test · typecheck · lint). ABSENT ≠ FAILED:
 * cyboflow has no deterministic-gate artifact for orchestrated runs today, so
 * these are typically undefined and the run is NOT gated. Only an explicit
 * 'fail' maps to the GATED sentinel. `raw` folds any step_results rows found.
 */
export interface GateResults {
  build?: GateStatus;
  test?: GateStatus;
  typecheck?: GateStatus;
  lint?: GateStatus;
  raw?: unknown;
}

/** True iff any of the four hard gates explicitly FAILED (absent = not gated). */
export function isGated(gate: GateResults | null | undefined): boolean {
  if (!gate) return false;
  return (
    gate.build === 'fail' ||
    gate.test === 'fail' ||
    gate.typecheck === 'fail' ||
    gate.lint === 'fail'
  );
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export interface DimensionScore {
  key: DimensionKey;
  name: string;
  weight: number;
  /** False when thin-evidence (<2 applicable non-UNKNOWN sub-checks). */
  active: boolean;
  /** 0-100, null when inactive. Rounded for display; the mean uses the exact fraction. */
  score: number | null;
  /** Excellent/Good/Fair/Poor, null when inactive. */
  band: string | null;
  /** PASS / (PASS + FAIL) over resolved sub-checks; null when inactive. */
  passFraction: number | null;
  passCount: number;
  failCount: number;
  unknownCount: number;
  naCount: number;
  /** The special ceiling applied (e.g. COR-2 => 0.89), else null. */
  ceiling: number | null;
}

export interface ScoringResult {
  /** 0-100 weighted geometric mean over ACTIVE dims; null when GATED. */
  overallScore: number | null;
  /** Excellent/Good/Fair/Poor, or the GATED sentinel. */
  band: string | null;
  gated: boolean;
  /** Naive spread of per-sample overalls (min); null when GATED. */
  ciLow: number | null;
  /** Naive spread of per-sample overalls (max); null when GATED. */
  ciHigh: number | null;
  securityFlag: boolean;
  requirementsUnmet: boolean;
  capTriggered: boolean;
  /** Human-readable cap trigger tokens (sub-check ids and/or 'security'). */
  capTriggers: string[];
  dimensions: DimensionScore[];
  sampleCount: number;
}

// ---------------------------------------------------------------------------
// Per-sub-check resolution across samples
// ---------------------------------------------------------------------------

interface SubCheckResolution {
  id: string;
  dimension: DimensionKey;
  /**
   * PASS / FAIL when the sub-check has >=1 non-UNKNOWN, non-NA vote and the pass
   * share resolves; UNKNOWN when it only ever drew UNKNOWN votes; NOT_APPLICABLE
   * when every vote was NA (or the sub-check drew no votes at all). Binary — used
   * for counts + cap detection; the fractional dimension mean uses `passShare`.
   */
  resolved: Verdict;
  /**
   * Doc "K-sample mechanics": the sub-check's value is the pass share of its
   * non-UNKNOWN samples (passVotes / (passVotes + failVotes)); null when the
   * sub-check is not applicable (no decisive vote). This — NOT the binarized
   * `resolved` — is what the dimension mean averages, so a 2-PASS/1-FAIL split
   * contributes 0.667, not 1.0.
   */
  passShare: number | null;
  passVotes: number;
  failVotes: number;
  unknownVotes: number;
  naVotes: number;
  /** The sub-check's specialCeiling (fraction), when the resolved verdict is FAIL. */
  failCeiling: number | null;
}

/**
 * Resolve one sub-check across `samples`. Rule (doc "K-sample mechanics"):
 *  - NOT_APPLICABLE votes are excluded ENTIRELY (never a denominator member).
 *  - UNKNOWN votes are excluded from the pass-share denominator (but counted).
 *  - value = pass share of the non-UNKNOWN, non-NA votes; >=0.5 => PASS.
 *  - no PASS/FAIL votes at all => UNKNOWN (if any UNKNOWN vote) or NOT_APPLICABLE.
 */
function resolveSubCheck(check: RubricSubCheck, samples: JudgeSample[]): SubCheckResolution {
  let passVotes = 0;
  let failVotes = 0;
  let unknownVotes = 0;
  let naVotes = 0;

  for (const sample of samples) {
    const v = sample.verdicts.find((sv) => sv.id === check.id);
    if (!v) continue; // sample never voted this sub-check → no signal
    switch (v.verdict) {
      case 'PASS':
        passVotes += 1;
        break;
      case 'FAIL':
        failVotes += 1;
        break;
      case 'UNKNOWN':
        unknownVotes += 1;
        break;
      case 'NOT_APPLICABLE':
        naVotes += 1;
        break;
    }
  }

  const decisive = passVotes + failVotes;
  let resolved: Verdict;
  let passShare: number | null;
  if (decisive > 0) {
    passShare = passVotes / decisive;
    resolved = passShare >= 0.5 ? 'PASS' : 'FAIL';
  } else if (unknownVotes > 0) {
    passShare = null;
    resolved = 'UNKNOWN';
  } else {
    passShare = null;
    resolved = 'NOT_APPLICABLE';
  }

  return {
    id: check.id,
    dimension: check.dimension,
    resolved,
    passShare,
    passVotes,
    failVotes,
    unknownVotes,
    naVotes,
    failCeiling: resolved === 'FAIL' ? check.specialCeiling : null,
  };
}

// ---------------------------------------------------------------------------
// Dimension aggregation
// ---------------------------------------------------------------------------

interface DimensionAggregate extends DimensionScore {
  /** Exact fraction (unrounded) used for the geometric mean; null when inactive. */
  exactScore: number | null;
}

function aggregateDimension(
  dim: RubricDimension,
  resolutions: SubCheckResolution[],
  opts: { forcedScore?: number } = {},
): DimensionAggregate {
  const { key, name, weight } = dim;
  const passCount = resolutions.filter((r) => r.resolved === 'PASS').length;
  const failCount = resolutions.filter((r) => r.resolved === 'FAIL').length;
  const unknownCount = resolutions.filter((r) => r.resolved === 'UNKNOWN').length;
  const naCount = resolutions.filter((r) => r.resolved === 'NOT_APPLICABLE').length;

  // Applicable = sub-checks with a decisive (non-UNKNOWN, non-NA) pass share.
  const shares = resolutions
    .map((r) => r.passShare)
    .filter((s): s is number => s !== null);
  const applicable = shares.length;

  // Gate-dodge / forced-zero override (doc "Test gate-dodge"): a forced score makes
  // the dimension ACTIVE even under the thin-evidence rule so the penalty cannot be
  // erased by the sub-checks going NOT_APPLICABLE.
  const forced = opts.forcedScore !== undefined;
  const active = forced || applicable >= AGGREGATION.THIN_EVIDENCE_MIN_SUBCHECKS;

  if (!active) {
    return {
      key,
      name,
      weight,
      active: false,
      score: null,
      band: null,
      passFraction: null,
      passCount,
      failCount,
      unknownCount,
      naCount,
      ceiling: null,
      exactScore: null,
    };
  }

  // Dimension score = MEAN of the per-sub-check pass shares (doc "K-sample
  // mechanics"), NOT the count of binarized PASSes — a systematically split jury
  // must not round up to Excellent.
  const rawFraction = forced
    ? (opts.forcedScore as number) / 100
    : applicable > 0
      ? shares.reduce((sum, s) => sum + s, 0) / applicable
      : 0;

  // Special ceilings apply only when their sub-check RESOLVED to FAIL: COR-2 self-
  // authored-green-tests => 0.89; the catastrophic ROB-3/4/5 => Poor (0.39); the
  // SCP-1/DES-2 dimension soft-caps => Fair (0.69). Plus conjunction pair caps
  // (MTN-2 AND MTN-4 both FAIL => Fair). Take the tightest.
  const ceilings = resolutions
    .map((r) => r.failCeiling)
    .filter((c): c is number => c !== null);
  const failedIds = new Set(resolutions.filter((r) => r.resolved === 'FAIL').map((r) => r.id));
  for (const pc of dim.pairCaps ?? []) {
    if (pc.whenAllFail.every((id) => failedIds.has(id))) ceilings.push(pc.ceiling);
  }
  const ceiling = ceilings.length > 0 ? Math.min(...ceilings) : null;
  const cappedFraction = ceiling !== null ? Math.min(rawFraction, ceiling) : rawFraction;

  const exactScore = cappedFraction * 100;
  return {
    key,
    name,
    weight,
    active: true,
    score: Math.round(exactScore),
    band: bandForFraction(cappedFraction).name,
    passFraction: cappedFraction,
    passCount,
    failCount,
    unknownCount,
    naCount,
    ceiling,
    exactScore,
  };
}

// ---------------------------------------------------------------------------
// Weighted geometric mean over active dimensions
// ---------------------------------------------------------------------------

/**
 * Weighted geometric mean of `{ weight, score }` entries, each score floored at
 * AGGREGATION.DIMENSION_FLOOR (1) so a forced/gated 0 drags the overall HARD
 * without zeroing it (doc: "aggregation floor"). Weights are implicitly
 * renormalized by dividing by their own sum, so passing only the ACTIVE
 * dimensions is exactly the renormalization the thin-evidence rule requires.
 * Returns 0 when there is no active weight.
 */
function weightedGeometricMean(entries: Array<{ weight: number; score: number }>): number {
  const totalWeight = entries.reduce((sum, e) => sum + e.weight, 0);
  if (totalWeight <= 0) return 0;
  const logSum = entries.reduce(
    (sum, e) => sum + e.weight * Math.log(Math.max(e.score, AGGREGATION.DIMENSION_FLOOR)),
    0,
  );
  return Math.exp(logSum / totalWeight);
}

/**
 * Overall (0-100, unrounded) for a set of dimension aggregates — active only.
 * Returns NULL when NO dimension is active: an inert diff is skipped, not
 * penalized (doc "Thin-evidence dimensions"), so it never earns a 0/Poor verdict
 * from no evidence — the caller persists a null overall / band instead.
 */
function overallFromDimensions(dims: DimensionAggregate[]): number | null {
  const active = dims.filter((d) => d.active && d.exactScore !== null);
  if (active.length === 0) return null;
  return weightedGeometricMean(
    active.map((d) => ({ weight: d.weight, score: d.exactScore as number })),
  );
}

/**
 * Gate-dodge override (doc "Test gate-dodge"): a behavior-changing diff whose Test
 * dimension has TST-1 resolved FAIL (no runnable test reaches the changed path)
 * FORCES the Test dimension to Poor (score 0). It enters the geometric mean floored
 * at 1, dragging an otherwise-85 run to ≈60 — the penalty must survive even when
 * the other TST sub-checks go NOT_APPLICABLE (which would otherwise mark the
 * dimension thin-evidence INACTIVE and erase the penalty).
 */
function gateDodgeOpts(
  dim: RubricDimension,
  resolutions: SubCheckResolution[],
): { forcedScore?: number } {
  if (dim.key !== 'tests') return {};
  const tst1 = resolutions.find((r) => r.id === 'TST-1');
  return tst1 && tst1.resolved === 'FAIL' ? { forcedScore: 0 } : {};
}

/** Aggregate every dimension over `samples`, applying the gate-dodge override. */
function aggregateAll(rubric: Rubric, samples: JudgeSample[]): DimensionAggregate[] {
  return rubric.dimensions.map((dim) => {
    const resolutions = dim.subChecks.map((check) => resolveSubCheck(check, samples));
    return aggregateDimension(dim, resolutions, gateDodgeOpts(dim, resolutions));
  });
}

// ---------------------------------------------------------------------------
// Catastrophic-cap detection (never averaged away)
// ---------------------------------------------------------------------------

interface CapDetection {
  triggered: boolean;
  triggers: string[];
  securityFlag: boolean;
  requirementsUnmet: boolean;
}

/**
 * A confirmed catastrophic-class finding soft-caps the OVERALL at Fair (<=69).
 * Per doc: "Any single sample asserting a catastrophic-cap trigger is surfaced
 * for reconciliation — cap triggers are never averaged away." So we scan the RAW
 * samples: any sample voting FAIL on a cap-trigger sub-check (ROB-3/4/5, SCP-1)
 * fires it; the dimension-level security cap fires on any high/critical (severity
 * 'error') security finding in any sample.
 */
function detectCaps(rubric: Rubric, samples: JudgeSample[]): CapDetection {
  const triggers = new Set<string>();
  const flags = new Set<CapFlag>();

  const capSubChecks = new Map<string, CapFlag>();
  let securityCapActive = false;
  for (const dim of rubric.dimensions) {
    if (dim.overallCapOnHighSeverity) securityCapActive = true;
    for (const check of dim.subChecks) {
      if (check.capTrigger === 'overall_fair_cap') {
        capSubChecks.set(check.id, check.capFlag);
      }
    }
  }

  for (const sample of samples) {
    for (const v of sample.verdicts) {
      if (v.verdict === 'FAIL' && capSubChecks.has(v.id)) {
        triggers.add(v.id);
        const flag = capSubChecks.get(v.id) ?? null;
        if (flag) flags.add(flag);
      }
    }
    if (securityCapActive) {
      for (const f of sample.findings) {
        // Only a CONFIRMED high/critical security finding soft-caps (doc line 123:
        // a finding the judge cannot fully confirm is a PLAUSIBLE confidence-flag,
        // NO soft-cap). `catastrophic` is the judge's confirmed marker; severity
        // 'error' is the high/critical level. Both required.
        if (f.dimension === 'security' && f.severity === 'error' && f.catastrophic === true) {
          triggers.add('security');
          flags.add('security_flag');
        }
      }
    }
  }

  return {
    triggered: triggers.size > 0,
    triggers: [...triggers].sort(),
    securityFlag: flags.has('security_flag'),
    requirementsUnmet: flags.has('requirements_unmet'),
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface ScoreOptions {
  gateResults?: GateResults | null;
  rubric?: Rubric;
}

/**
 * Score K jury `samples` into the durable rollup. `samples` MUST have length >=1
 * (the worker guarantees at least one valid sample before calling; an empty array
 * would produce an all-inactive, zeroed result rather than throwing).
 *
 * CI method (v1, documented limitation): the confidence interval is the NAIVE
 * [min, max] spread of the per-sample overall scores — NOT a statistical
 * interval. The Agent SDK exposes no temperature knob (design "temp 0" is
 * unsettable), so sample variance is whatever the model produces; a min/max band
 * communicates disagreement without over-claiming rigor. When capped, the band is
 * clamped to the cap; when gated, it is null.
 */
export function scoreSamples(samples: JudgeSample[], opts: ScoreOptions = {}): ScoringResult {
  const rubric = opts.rubric ?? RUBRIC;
  const gate = opts.gateResults ?? null;

  const dims = aggregateAll(rubric, samples);

  const caps = detectCaps(rubric, samples);
  const gated = isGated(gate);

  // Per-sample overalls (raw quality, no cap/gate) for the CI band. A sample with
  // no active dimension yields null and is dropped from the spread.
  const perSampleOveralls = samples
    .map((sample) => overallFromDimensions(aggregateAll(rubric, [sample])))
    .filter((v): v is number => v !== null);

  const rawOverall = overallFromDimensions(dims);

  let overallScore: number | null;
  let band: string | null;
  let ciLow: number | null;
  let ciHigh: number | null;

  if (gated) {
    // GATED sentinel: a deterministic hard-stop failure — NO quality headline.
    overallScore = null;
    band = GATED_SENTINEL;
    ciLow = null;
    ciHigh = null;
  } else if (rawOverall === null) {
    // No active dimension (inert diff): no evidence => no score, not a 0/Poor.
    overallScore = null;
    band = null;
    ciLow = null;
    ciHigh = null;
  } else {
    let capped = rawOverall;
    if (caps.triggered) {
      capped = Math.min(capped, AGGREGATION.OVERALL_CATASTROPHIC_CAP);
    }
    overallScore = Math.round(capped);
    band = bandForFraction(overallScore / 100).name;

    let low = perSampleOveralls.length > 0 ? Math.min(...perSampleOveralls) : capped;
    let high = perSampleOveralls.length > 0 ? Math.max(...perSampleOveralls) : capped;
    if (caps.triggered) {
      low = Math.min(low, AGGREGATION.OVERALL_CATASTROPHIC_CAP);
      high = Math.min(high, AGGREGATION.OVERALL_CATASTROPHIC_CAP);
    }
    ciLow = Math.round(low);
    ciHigh = Math.round(high);
  }

  const dimensions: DimensionScore[] = dims.map(({ exactScore: _exactScore, ...d }) => d);

  return {
    overallScore,
    band,
    gated,
    ciLow,
    ciHigh,
    securityFlag: caps.securityFlag,
    requirementsUnmet: caps.requirementsUnmet,
    capTriggered: caps.triggered,
    capTriggers: caps.triggers,
    dimensions,
    sampleCount: samples.length,
  };
}
