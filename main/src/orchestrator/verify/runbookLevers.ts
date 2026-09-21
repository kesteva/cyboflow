/**
 * runbookLevers — turning the runbook's declared isolation levers into real
 * environment variables for the verification agent's build and serve steps.
 *
 * WHY THIS EXISTS. `levers` (docs/proposals/verification-setup-flow.md §4) is a
 * set of NAMES: the runbook says "my serve command reads the port from `PORT`",
 * and the harness — the only party that knows the request-scoped VALUES, since
 * the port is leased and the nonce is minted per request — binds them. Until
 * this module, only the harness's own `VERIFY_*` vars were exported and
 * `levers.portEnv` was parsed, hashed and documented while being read by
 * nothing. That left the two facts a web verification actually turns on — does
 * the served surface bind the LEASED port, and does it carry THIS request's
 * attestation nonce — to whatever the verification agent inferred from the
 * runbook's free-text `notes`.
 *
 * That inference is not reproducible, and the failure mode is the expensive
 * direction. Observed live on 2026-08-20: two runs over the same project shape,
 * one agent improvised both bindings and PROVED the runbook, the next replayed
 * it closer to verbatim and failed — so the runbook that got marked proven was
 * one that only works when the agent embellishes it. Exporting the declared
 * levers moves both facts from agent judgment to harness guarantee, which is
 * what `port-from-env` (rung 1) was designed around in the first place.
 *
 * TWO HARD RULES, both because a runbook is machine-authored:
 *
 *   1. A lever may never SHADOW a variable the harness owns. The caller passes
 *      the already-built base env and anything keyed there wins, so a runbook
 *      declaring `portEnv: "VERIFY_PORT"` is a correct no-op rather than a
 *      chance to rewrite the harness's own contract.
 *   2. A name that is not a plain uppercase identifier, or that names part of
 *      the process's execution environment, is DROPPED rather than exported.
 *      `PATH`, `NODE_OPTIONS` and `DYLD_INSERT_LIBRARIES` are not configuration
 *      — a declaration that binds one of them is code execution wearing a
 *      lever's name, and the agent that wrote it is the untrusted party here.
 *
 * Dropping is silent by design at this seam (it returns only the additions);
 * the caller logs what it applied, and a lever that fails to take effect
 * surfaces as an honest attestation failure rather than a pass.
 */
import type { VerifyRunbookV1 } from '../../../../shared/types/verifyRunbook';

/**
 * A lever name must look like an ordinary shell environment identifier. Lower
 * case is rejected too: every documented lever example is upper snake, and
 * accepting `Path` on a case-insensitive lookup is exactly the kind of near-miss
 * the denylist below is meant to stop.
 */
const LEVER_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * Names that configure how a process EXECUTES rather than what it serves.
 * Binding any of these from a runbook would let a drafted lever change which
 * binary runs, which libraries load, or which flags node starts with.
 */
const LEVER_DENIED_ENV_NAMES: ReadonlySet<string> = new Set([
  'PATH',
  'HOME',
  'SHELL',
  'NODE_OPTIONS',
  'NODE_PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'IFS',
]);

/** The request-scoped values the harness binds declared lever names to. */
export interface LeverValues {
  /** The leased port, already stringified — `null` when the task implies no server. */
  port: string | null;
  /** This request's attestation nonce. */
  nonce: string;
  /**
   * This request's FRESH, EMPTY data dir (`VERIFY_DATA_DIR`) — `null` when the
   * caller provisioned none. Request-scoped on purpose: `VERIFY_ARTIFACTS_DIR`
   * is RUN-scoped, so a data dir keyed on it is reused across attempts and
   * carries the previous attempt's state into the next one (F3 / RC4: the
   * passing run vr_bcae0966 reported a stale `orch.sock` EADDRINUSE inside the
   * verified instance).
   */
  dataDir: string | null;
  /**
   * The UDID of the simulator leased for THIS request, or `null` on every
   * non-mobile modality (and on a mobile request whose acquisition never
   * happened). Bound only as a NAME→value export here: §5.3 forbids a
   * persisted UDID anywhere, and this value lives for exactly one request.
   */
  simUdid: string | null;
  /**
   * This request's fresh, private `-derivedDataPath` (`VERIFY_DERIVED_DATA`),
   * or `null` off the mobile path. Exists for the project whose own build
   * script insists on reading the DerivedData root from its own variable
   * name rather than the harness's.
   */
  derivedData: string | null;
}

/** One rejected lever, for the caller to log. */
export interface DroppedLever {
  lever: 'portEnv' | 'nonceEnv' | 'dataDirEnv' | 'simUdidEnv' | 'derivedDataEnv';
  name: string;
  reason: 'malformed' | 'denied' | 'shadows-harness';
}

export interface ResolvedLeverEnv {
  /** Keys to ADD to the base env — never overlapping it. */
  additions: Record<string, string>;
  dropped: DroppedLever[];
}

/**
 * Resolve the exportable half of a runbook's levers against a base env.
 *
 * `portEnv`, `nonceEnv`, `dataDirEnv`, `simUdidEnv` and `derivedDataEnv` are
 * exported. Only `cdpPortFlag` remains unbound, and permanently: it is a CLI
 * FLAG, not an env var — there is no environment for this seam to put it in,
 * and the runbook's serve command is the only thing that knows where in its own
 * argv it goes.
 *
 * `dataDirEnv` was parsed, hashed and documented while being read by nothing
 * until F3 (RC4): the harness now provisions a fresh per-request dir and passes
 * it as {@link LeverValues.dataDir}, so a project whose app reads a data-dir env
 * var gets attempt isolation without editing its serve command.
 */
export function resolveLeverEnv(
  base: Readonly<Record<string, string>>,
  levers: VerifyRunbookV1['levers'] | undefined,
  values: LeverValues,
): ResolvedLeverEnv {
  const additions: Record<string, string> = {};
  const dropped: DroppedLever[] = [];
  if (levers === undefined) return { additions, dropped };

  const bind = (lever: DroppedLever['lever'], name: string | undefined, value: string | null) => {
    if (name === undefined || value === null) return;
    if (!LEVER_NAME_PATTERN.test(name)) {
      dropped.push({ lever, name, reason: 'malformed' });
      return;
    }
    if (LEVER_DENIED_ENV_NAMES.has(name)) {
      dropped.push({ lever, name, reason: 'denied' });
      return;
    }
    // Rule 1. `Object.hasOwn` rather than a truthiness check: a harness var
    // deliberately set to the empty string is still the harness's to own. A
    // declaration that names a harness var ALREADY carrying this exact value
    // (`portEnv: "VERIFY_PORT"`) is neither an addition nor a drop — it is
    // already bound, and reporting it as rejected would put a scary line in the
    // log for the one lever spelling that is trivially correct.
    if (Object.hasOwn(base, name)) {
      if (base[name] !== value) dropped.push({ lever, name, reason: 'shadows-harness' });
      return;
    }
    additions[name] = value;
  };

  bind('portEnv', levers.portEnv, values.port);
  bind('nonceEnv', levers.nonceEnv, values.nonce);
  bind('dataDirEnv', levers.dataDirEnv, values.dataDir);
  // The mobile tier's two levers. Both go through the SAME `bind` as every
  // other one — same identifier pattern, same execution-environment denylist,
  // same "a harness var wins" rule — so a runbook cannot reach `PATH` or
  // rewrite `VERIFY_SIM_UDID` by coming in through the newer door. Both are
  // `null` off the mobile path, which makes them silent no-ops there rather
  // than drops.
  bind('simUdidEnv', levers.simUdidEnv, values.simUdid);
  bind('derivedDataEnv', levers.derivedDataEnv, values.derivedData);
  return { additions, dropped };
}
