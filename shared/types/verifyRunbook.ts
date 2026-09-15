/**
 * The verification RUNBOOK contract — the committed, portable half of "how do
 * you stand this project up so it can be verified"
 * (docs/proposals/verification-setup-flow.md §5.2 seam 1 + §5.3).
 *
 * WHY THIS FILE EXISTS AT ALL. Two prior designs failed in opposite directions
 * (§1): the legacy waterfall required a MANUALLY authored `.cyboflow/verify.json`
 * nobody ever wrote, and the agent engine GUESSES the build/serve form per run
 * with no memory — and guessed wrong every single time (0-for-5 in production).
 * The runbook is the middle: derive once, PROVE by actually running it, persist,
 * reuse, invalidate on drift. The proof is the whole difference from
 * `verify.json`; a file that merely exists earns nothing (see
 * {@link VerifyRunbookV1} on why this file is only half the contract).
 *
 * THE SPLIT HALVES (§5.3 — the single most load-bearing rule here).
 * A runbook has a COMMITTED-PORTABLE half (this file's shape, living at
 * {@link VERIFY_RUNBOOK_RELATIVE_PATH} in the repo, travelling with the code
 * through every branch/clone/CI checkout) and a MACHINE-LOCAL half (a DB record
 * — see main/src/orchestrator/verify/runbookStore.ts — keyed by project +
 * modality and CAS-versioned against this half's content hash). The boundary is
 * not stylistic:
 *
 *   - Portable (HERE): commands as PARAMETERIZED LEVER TEMPLATES (`${PORT}`,
 *     never a resolved port), behaviors, modality declarations, readiness and
 *     attestation specs. Everything true of the PROJECT on any machine.
 *   - Machine-local (NOT here): host capabilities and resolved lever BINDINGS
 *     that are stable per host — binary paths, the data-dir lever's name, ABI
 *     facts — plus the proof provenance (§5.3) and the input/host fingerprints
 *     that demote the runbook when they drift.
 *   - REQUEST-SCOPED VALUES ARE IN NEITHER HALF. Ports and temp dirs are
 *     resolved by the scheduler per request, AFTER lease acquisition. A
 *     persisted port goes stale, diverges from the actually-held lease, or
 *     collides — root cause (b)/(e) of §1's failure table is precisely this
 *     mistake made informally. "A committed runbook derived on one machine must
 *     not encode another machine's lies."
 *
 * WHY `attestation` IS REQUIRED PER MODALITY (§7.1). The proposal's hardest
 * invariant is "no attestation channel ⇒ no `passed`, period" — a verification
 * that cannot prove the surface it drove IS this deliverable is not a
 * verification (the port pool is an in-process mutex that "guards the logical
 * slot, NOT the OS socket"; a warm cache or the user's own running app answers
 * happily). Making the field OPTIONAL here would push that failure to the far
 * end of a 10-minute deploy; making it REQUIRED means the setup flow must name
 * the channel while it is deriving the runbook, and the proof run then proves
 * the channel exists. That is exactly §7.1's "setup PROVES the channel exists as
 * part of the proof".
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO: it does not lint `build`/`serve` for
 * dependency-mutating commands. §5.3's "dependency mutation is runner-enforced,
 * not linted" is a v2 correction with teeth — a lint here cannot reach the OTHER
 * source of build steps (`VerificationTaskV1.build`, composed by an agent at
 * request time), so the guard that matters lives in the RUNNER, at execution
 * time, over every composed task regardless of origin. Duplicating a weaker
 * version of it here would only create the illusion of coverage.
 *
 * Purity invariant (mirrors ./visualVerification.ts, its sibling and the source
 * of the AttestationSpec / VerificationModality shapes re-used below): pure
 * types + consts + hand-rolled runtime guards. NO node / electron / IPC imports,
 * so the renderer (the phase-3 health panel, the setup wizard) and the main
 * process (the store, the runner) import the identical contract.
 */
import type {
  AttestationSpec,
  VerificationModality,
  ViewportSpec,
} from './visualVerification';
import { isAttestationSpec } from './visualVerification';

/**
 * The project-root-relative path of the portable runbook half. A single
 * constant so the setup flow's writer, the store's reader, and tests all
 * reference one canonical location — sibling to
 * `verifyConfigLoader.VERIFY_CONFIG_RELATIVE_PATH` (`.cyboflow/verify.json`),
 * which it does NOT replace: `verify.json` is the per-deliverable product
 * config, this is the derived-and-proven "how to stand it up" record.
 */
export const VERIFY_RUNBOOK_RELATIVE_PATH = '.cyboflow/verify-runbook.json';

/**
 * The modality keys a PORTABLE runbook may declare — the subset of
 * {@link VerificationModality} a project can actually describe today. `mobile`
 * is excluded by construction: §4's scope decision defers it entirely (it rests
 * in the phase-0 `unsupported` state with reason "deferred — pending Xcode
 * MCP"), so a runbook claiming to declare it would be claiming a capability no
 * code path can honor. `Extract<...>` rather than a re-spelled union so the two
 * stay pinned together — widening `VerificationModality` without revisiting this
 * line is a compile error, not a silent divergence.
 */
export type VerifyRunbookModality = Extract<
  VerificationModality,
  'web' | 'cdp-app' | 'native-screen'
>;

/**
 * The three declarable modality keys, for iteration (validators, UI pickers,
 * the setup wizard's per-modality loop) without re-listing the union by hand.
 */
export const VERIFY_RUNBOOK_MODALITIES: readonly VerifyRunbookModality[] = [
  'web',
  'cdp-app',
  'native-screen',
] as const;

/** Runtime guard for one of {@link VERIFY_RUNBOOK_MODALITIES}. */
export function isVerifyRunbookModality(v: unknown): v is VerifyRunbookModality {
  return v === 'web' || v === 'cdp-app' || v === 'native-screen';
}

/**
 * How to stand this project up for ONE modality (§5.3). Every command here is
 * a LEVER TEMPLATE: `${PORT}`-style placeholders that the scheduler substitutes
 * per request after acquiring the lease, never a resolved value.
 */
export interface VerifyRunbookModalityEntry {
  /**
   * Ordered shell steps that produce the deliverable, run in the snapshot
   * worktree. NEVER install/rebuild commands — §7.2: a snapshot's
   * `node_modules` is SYMLINKED from the live sprint worktree, so an install
   * inside the snapshot writes THROUGH the symlink and flips dependency ABIs
   * under sibling lanes, invisibly to `checkSnapshotMutated` (which diffs
   * tracked files only). Dependency preparation belongs to the preparer, not
   * to a runbook command — and the runner REJECTS such commands at execution
   * time regardless of what is written here (see this file's header on why
   * that guard is not duplicated as validation).
   */
  build?: string[];
  /**
   * The long-running step that makes the deliverable observable. `attach: 'cdp'`
   * is the Electron/native-app-with-webview form (`cmd` launches the APP, which
   * exposes a CDP endpoint the driver attaches to) — root cause (a) of §1's
   * failure table is task-verify composing the generic web form for a project
   * that needed exactly this. Absent = classic web serve (the driver launches
   * its own headless chromium and navigates).
   */
  serve?: {
    /** May reference `${PORT}` — the leased port is substituted per request. */
    cmd: string;
    attach?: 'cdp';
    readyWhen?: { urlPath?: string; timeoutMs?: number };
  };
  /**
   * REQUIRED — the verified-artifact-identity channel for this modality (§7.1).
   * Not optional the way `VerificationTaskV1.attestation` is: a composed TASK
   * may predate the widening and must still round-trip, but a runbook is
   * authored by the setup flow after this contract existed, and the proof run
   * PROVES this channel comes up. "No attestation ⇒ no `passed`, period."
   */
  attestation: AttestationSpec;
  /** Free-text derivation notes for a human reading the committed file (why this form, what was tried). */
  notes?: string;
  /** Optional per-modality capture viewports, when the project's UI has meaningful breakpoints. */
  viewports?: ViewportSpec[];
}

/**
 * The committed-portable runbook half (§5.3). One file per project at
 * {@link VERIFY_RUNBOOK_RELATIVE_PATH}, declaring one entry per modality the
 * project's UI actually has — §4's "modalities compose per project": a desktop
 * app declares `cdp-app` for its web-view content AND `native-screen` for OS
 * chrome, and one modality's outage never suppresses the other (capability and
 * proof state are tracked per modality, §3.3).
 *
 * THIS SHAPE IS HALF A CONTRACT. Its content hash
 * ({@link main/src/orchestrator/verify/runbookHash.ts}) is the CAS key of the
 * machine-local record, and a request pins BOTH (§5.2 seam 3: the portable hash
 * and the local record version are stamped on the request row at enqueue, and
 * the runner executes exactly that revision or rejects). A runbook file alone —
 * however well written — is `unproven-draft`, which the phase-0 degrade gate
 * treats exactly like `absent`: skip + a setup CTA, never a lane-blocking FAIL.
 */
export interface VerifyRunbookV1 {
  version: 1;
  /**
   * At least one declared modality. `Partial<Record<...>>` because a project
   * declares only what it has — an absent key means "this project has no such
   * surface", which is a different statement from a declared-but-broken one.
   */
  modalities: Partial<Record<VerifyRunbookModality, VerifyRunbookModalityEntry>>;
  /**
   * Project-wide isolation lever NAMES (§4 "isolation levers are part of the
   * roster contract, not per-project improvisation"). Names only — never
   * values: `portEnv` is the env var the serve command reads the leased port
   * from, `dataDirEnv` the one that redirects the app's state directory (the
   * fix for §1's root cause (b): cyboflow's own single-instance lock is keyed
   * on `CYBOFLOW_DIR`, defeating `--user-data-dir`), `cdpPortFlag` the CLI flag
   * that pins the app's CDP port, and `nonceEnv` the one the build or serve step
   * reads this request's attestation nonce from. The VALUES bound to them are
   * request-scoped and resolved after lease acquisition.
   *
   * `portEnv`, `nonceEnv` and `dataDirEnv` are the three the harness EXPORTS
   * (see `resolveLeverEnv`; `dataDirEnv` is bound to the request-scoped
   * `VERIFY_DATA_DIR`, a fresh empty directory per request — F3). Declaring them
   * is what makes the runbook self-sufficient, because it moves the port
   * binding, the attestation marker and the state-directory isolation off
   * whatever the verification agent inferred from `notes` and onto the harness.
   * `cdpPortFlag` stays declarative (a CLI flag is not an env var).
   */
  levers?: {
    portEnv?: string;
    dataDirEnv?: string;
    cdpPortFlag?: string;
    nonceEnv?: string;
    notes?: string;
  };
}

// ---------------------------------------------------------------------------
// Runtime validation
// ---------------------------------------------------------------------------

/** True for a non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True for a string with at least one non-whitespace character. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** True for a finite number strictly greater than zero. */
function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** True for an array whose every element is a string (an empty array counts). */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * Validate one modality entry. Split out so the error paths read
 * `modalities["cdp-app"].serve.cmd: ...` — the same first-problem-wins,
 * path-named posture as {@link parseVerificationTaskV1}, so a setup-flow
 * re-delegation can quote the exact defect rather than "invalid runbook".
 */
function parseModalityEntry(
  value: unknown,
  path: string,
): { ok: true; entry: VerifyRunbookModalityEntry } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: `${path}: expected an object` };

  let build: string[] | undefined;
  if (value.build !== undefined) {
    if (!isStringArray(value.build)) return { ok: false, error: `${path}.build: expected an array of strings` };
    build = value.build;
  }

  let serve: VerifyRunbookModalityEntry['serve'];
  if (value.serve !== undefined) {
    if (!isRecord(value.serve)) return { ok: false, error: `${path}.serve: expected an object` };
    if (!isNonEmptyString(value.serve.cmd)) {
      return { ok: false, error: `${path}.serve.cmd: expected non-empty string` };
    }
    const cmd = value.serve.cmd;

    let attach: 'cdp' | undefined;
    if (value.serve.attach !== undefined) {
      if (value.serve.attach !== 'cdp') {
        return { ok: false, error: `${path}.serve.attach: expected the string 'cdp' when present` };
      }
      attach = value.serve.attach;
    }

    let readyWhen: NonNullable<VerifyRunbookModalityEntry['serve']>['readyWhen'];
    if (value.serve.readyWhen !== undefined) {
      if (!isRecord(value.serve.readyWhen)) {
        return { ok: false, error: `${path}.serve.readyWhen: expected an object` };
      }
      const rw = value.serve.readyWhen;
      if (rw.urlPath !== undefined && typeof rw.urlPath !== 'string') {
        return { ok: false, error: `${path}.serve.readyWhen.urlPath: expected string` };
      }
      if (rw.timeoutMs !== undefined && !isPositiveFiniteNumber(rw.timeoutMs)) {
        return { ok: false, error: `${path}.serve.readyWhen.timeoutMs: expected positive finite number` };
      }
      readyWhen = {
        ...(rw.urlPath !== undefined ? { urlPath: rw.urlPath } : {}),
        ...(rw.timeoutMs !== undefined ? { timeoutMs: rw.timeoutMs } : {}),
      };
    }

    serve = {
      cmd,
      ...(attach !== undefined ? { attach } : {}),
      ...(readyWhen !== undefined ? { readyWhen } : {}),
    };
  }

  // REQUIRED — see VerifyRunbookModalityEntry.attestation's doc (§7.1).
  if (value.attestation === undefined) {
    return { ok: false, error: `${path}.attestation: required (no attestation channel means no verification can pass)` };
  }
  if (!isAttestationSpec(value.attestation)) {
    const kind = isRecord(value.attestation) ? value.attestation.kind : undefined;
    return {
      ok: false,
      error:
        kind !== undefined
          ? `${path}.attestation: malformed or unrecognized spec for kind "${String(kind)}"`
          : `${path}.attestation: expected an object with a valid "kind"`,
    };
  }
  const attestation: AttestationSpec = value.attestation;

  let notes: string | undefined;
  if (value.notes !== undefined) {
    if (typeof value.notes !== 'string') return { ok: false, error: `${path}.notes: expected string` };
    notes = value.notes;
  }

  let viewports: ViewportSpec[] | undefined;
  if (value.viewports !== undefined) {
    if (!Array.isArray(value.viewports)) return { ok: false, error: `${path}.viewports: expected an array` };
    const parsed: ViewportSpec[] = [];
    for (let i = 0; i < value.viewports.length; i++) {
      const item = value.viewports[i];
      const vpPath = `${path}.viewports[${i}]`;
      if (!isRecord(item)) return { ok: false, error: `${vpPath}: expected an object` };
      if (!isPositiveFiniteNumber(item.width)) {
        return { ok: false, error: `${vpPath}.width: expected positive finite number` };
      }
      if (!isPositiveFiniteNumber(item.height)) {
        return { ok: false, error: `${vpPath}.height: expected positive finite number` };
      }
      if (item.label !== undefined && typeof item.label !== 'string') {
        return { ok: false, error: `${vpPath}.label: expected string` };
      }
      parsed.push({
        width: item.width,
        height: item.height,
        ...(item.label !== undefined ? { label: item.label } : {}),
      });
    }
    viewports = parsed;
  }

  return {
    ok: true,
    entry: {
      attestation,
      ...(build !== undefined ? { build } : {}),
      ...(serve !== undefined ? { serve } : {}),
      ...(notes !== undefined ? { notes } : {}),
      ...(viewports !== undefined ? { viewports } : {}),
    },
  };
}

/**
 * Strict runtime validator for the committed portable half. Rejects on the
 * FIRST structural problem, naming the offending path — same contract as
 * `parseVerificationTaskV1`, for the same reason (a setup flow that gets
 * "invalid runbook" back cannot fix it; one that gets
 * `modalities["web"].serve.cmd: expected non-empty string` can).
 *
 * REBUILDS the returned value field-by-field rather than casting the input:
 * the parsed object is what gets hashed and persisted, so it must contain
 * exactly the fields this validator checked — an unknown extra key is TOLERATED
 * on input (forward compat, this file's sibling posture) but must never ride
 * into the content hash, or a future field's mere presence would re-key every
 * existing runbook.
 *
 * `modalities` must carry at least one KNOWN key: an empty (or entirely
 * unknown-keyed) map declares nothing, and "declares nothing" is not a runbook
 * — it is the `absent` state, which the degrade gate already handles honestly.
 */
export function parseVerifyRunbookV1(
  value: unknown,
): { ok: true; runbook: VerifyRunbookV1 } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: 'root: expected an object' };
  if (value.version !== 1) return { ok: false, error: 'version: expected literal 1' };

  if (!isRecord(value.modalities)) return { ok: false, error: 'modalities: expected an object' };
  const modalities: VerifyRunbookV1['modalities'] = {};
  for (const key of VERIFY_RUNBOOK_MODALITIES) {
    const raw = value.modalities[key];
    if (raw === undefined) continue;
    const parsed = parseModalityEntry(raw, `modalities["${key}"]`);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    modalities[key] = parsed.entry;
  }
  if (Object.keys(modalities).length === 0) {
    return {
      ok: false,
      error: `modalities: expected at least one of ${VERIFY_RUNBOOK_MODALITIES.join('|')}`,
    };
  }

  let levers: VerifyRunbookV1['levers'];
  if (value.levers !== undefined) {
    if (!isRecord(value.levers)) return { ok: false, error: 'levers: expected an object' };
    const l = value.levers;
    for (const field of ['portEnv', 'dataDirEnv', 'cdpPortFlag', 'nonceEnv', 'notes'] as const) {
      if (l[field] !== undefined && typeof l[field] !== 'string') {
        return { ok: false, error: `levers.${field}: expected string` };
      }
    }
    levers = {
      ...(typeof l.portEnv === 'string' ? { portEnv: l.portEnv } : {}),
      ...(typeof l.dataDirEnv === 'string' ? { dataDirEnv: l.dataDirEnv } : {}),
      ...(typeof l.cdpPortFlag === 'string' ? { cdpPortFlag: l.cdpPortFlag } : {}),
      ...(typeof l.nonceEnv === 'string' ? { nonceEnv: l.nonceEnv } : {}),
      ...(typeof l.notes === 'string' ? { notes: l.notes } : {}),
    };
  }

  return {
    ok: true,
    runbook: {
      version: 1,
      modalities,
      ...(levers !== undefined ? { levers } : {}),
    },
  };
}
