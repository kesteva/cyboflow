/**
 * CONTROLLER-SIDE validation of a drafted runbook, before anything is written
 * (docs/proposals/lane-runbook-bootstrap.md §8, checks 1–3).
 *
 * The schema check lives in `runbookDraft.parseRunbookDraftResult` (it is part of
 * the output contract). What lives HERE is the pair of semantic checks that ask
 * whether the commands the agent proposed are commands this project actually
 * has:
 *
 *   2. the §7.2 dependency guard, unchanged and shared — a runbook that smuggles
 *      an install through is exactly as dangerous as a composed task that does,
 *      and arguably worse because it is PROVEN and would repeat on every request.
 *   3. every `build`/`serve` command must resolve to a DECLARED `package.json`
 *      script invocation.
 *
 * WHY RULE 3 IS THE HIGHEST-VALUE GUARD IN THE PROPOSAL. §1's diagnosis of the
 * pre-runbook era is that the engine "guesses the environment per-run with no
 * memory and guesses wrong every time" — 0-for-5 in production, on exactly this:
 * the shape of the serve command. The Verify Setup agent's prompt answers that
 * with a prose rule ("never guess a command; read it out of the project"), and
 * prose is not enforcement. This converts it into a mechanical check, and in
 * doing so makes "the agent proposed this command" and "the project documents
 * this command" the same statement. An agent that invents `vite --port 5173` for
 * a project whose script is `dev:web` cannot get past this, and the honest
 * outcome — `NOT-POSSIBLE`, a human designs it in Verify Setup — is exactly what
 * should happen there.
 *
 * WHAT IT DELIBERATELY DOES NOT DO is understand shell. A chained command
 * (`&&`, `;`, a pipe, a subshell) is REJECTED rather than decomposed: the rule is
 * "this command is a documented script of this project", and a chain is by
 * construction something the project does not document as one unit. A project
 * that needs a chain expresses it as a script, which is both the check passing
 * and the better artifact.
 *
 * PURE — every input is a value the caller already read.
 */
import { findForbiddenTaskCommands } from './dependencyCommandGuard';
import type { VerifyRunbookModality, VerifyRunbookV1 } from '../../../../shared/types/verifyRunbook';
import type { VerificationTaskV1 } from '../../../../shared/types/visualVerification';

/** Why a drafted runbook was refused. Reported verbatim on the degrade path. */
export type RunbookDraftRejection =
  | { kind: 'forbidden-dependency-command'; offenders: string[]; message: string }
  | { kind: 'undeclared-command'; offenders: string[]; message: string }
  | { kind: 'unreadable-manifest'; message: string };

export type RunbookDraftValidation = { ok: true } | { ok: false; rejection: RunbookDraftRejection };

/**
 * Shell metacharacters that make a command more than one invocation. Their
 * presence is the rejection itself — see the module header on why this does not
 * try to decompose them.
 *
 * A BARE `&` COUNTS. It was missed on the first pass because `&&` was listed and
 * a single ampersand reads like a lesser version of it; it is not — `pnpm dev &
 * rm -rf x` backgrounds the script and runs the rest, and the resolver below
 * would have answered "dev", a declared script, and let it through. This
 * command's blast radius is not one run: it is committed, proven, and re-executed
 * on every verification of this project from then on. Redirection is refused on
 * the same grounds.
 */
export const SHELL_COMPOSITION_PATTERN = /(&&|\|\||[;|&`<>]|\$\(|\n|\r)/;

/**
 * Package-manager prefixes whose next non-flag token names a script.
 *
 * `run` is optional for every one of them (pnpm/yarn/bun accept the bare form,
 * and npm's bare form is an error rather than a different meaning), so the
 * resolver skips it when present rather than requiring it.
 */
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

/**
 * Tokens that follow a package manager but are NOT script names — package-manager
 * flags that take no value. A flag that DOES take a value (`--filter x`) would
 * shift the script position, and rather than model each manager's flag grammar
 * this resolver simply fails to resolve, which is a rejection. That is the
 * correct direction: `pnpm --filter web dev` runs a script in a workspace package,
 * and the runbook's commands execute from the repo root.
 */
const VALUELESS_PM_FLAGS = new Set(['--silent', '-s', '--quiet']);

/**
 * Flags that change WHICH project's script runs, wherever they appear.
 *
 * Everything after the script name is normally the script's own argument
 * (`pnpm dev --port ${PORT}` is the shape this feature exists to support), but
 * package managers keep parsing their own flags there too: `npm run build
 * --prefix ../other` resolves to the declared script `build` and then runs a
 * DIFFERENT project's copy of it. The runbook's commands execute from the repo
 * root by construction, so none of these has a legitimate use here.
 */
const PROJECT_REDIRECTING_FLAGS = new Set([
  '--prefix', '-C', '--cwd', '--dir', '--workspace', '-w', '--workspaces',
  '--filter', '-F', '--package', '--node-options', '--script-shell', '--use-npm-ci',
]);

/**
 * The script name a command invokes, or `null` when it does not resolve to one.
 *
 * Recognizes `<pm> [run] <script> [args…]`. Everything else — a bare binary, an
 * `npx`/`pnpm dlx` invocation, a shell chain, an env-var prefix — returns null
 * and is reported as undeclared. Being conservative is the point: a false
 * rejection costs a project one trip through Verify Setup, where a human writes
 * the command; a false acceptance is an unreviewed command the harness then runs
 * on every verification forever.
 */
export function scriptNameForCommand(command: string): string | null {
  const trimmed = command.trim();
  if (trimmed.length === 0) return null;
  if (SHELL_COMPOSITION_PATTERN.test(trimmed)) return null;

  const tokens = trimmed.split(/\s+/);
  const pm = tokens[0];
  if (!PACKAGE_MANAGERS.has(pm)) return null;

  let idx = 1;
  while (idx < tokens.length && VALUELESS_PM_FLAGS.has(tokens[idx])) idx += 1;
  if (idx < tokens.length && tokens[idx] === 'run') idx += 1;
  const candidate = tokens[idx];
  if (candidate === undefined) return null;
  // A flag in the script position means the command is doing something other
  // than running a script (`pnpm --version`, `npm run --workspace=x`).
  if (candidate.startsWith('-')) return null;
  // A redirecting flag anywhere in the command disqualifies it, including after
  // the script name — see PROJECT_REDIRECTING_FLAGS.
  for (const token of tokens) {
    if (PROJECT_REDIRECTING_FLAGS.has(token.split('=')[0])) return null;
  }
  return candidate;
}

/** Build the synthetic task the shared §7.2 guard takes, from a runbook entry's commands. */
function taskFromCommands(build: string[], serveCmd: string | undefined): VerificationTaskV1 {
  return {
    version: 1,
    summary: 'runbook draft validation',
    behaviors: [],
    ...(build.length > 0 ? { build } : {}),
    ...(serveCmd !== undefined ? { serve: { cmd: serveCmd } } : {}),
  };
}

/**
 * Every command a runbook entry would execute, in the order the harness runs
 * them: the build steps, then the serve command.
 */
export function commandsForModality(runbook: VerifyRunbookV1, modality: VerifyRunbookModality): string[] {
  const entry = runbook.modalities[modality];
  if (entry === undefined) return [];
  return [...(entry.build ?? []), ...(entry.serve?.cmd !== undefined ? [entry.serve.cmd] : [])];
}

/**
 * Validate a drafted runbook's commands for ONE modality against the project's
 * own manifest.
 *
 * `packageJsonRaw` is the root `package.json` as read from the tree the runbook
 * will be committed to — and, when a rung-1 `add-script` is part of the same
 * draft, the POST-EDIT content. The ordering matters: an agent that proposes both
 * "add a `verify:serve` script" and "serve with `pnpm verify:serve`" is
 * self-consistent, and validating against the pre-edit manifest would reject the
 * one shape this feature exists to enable.
 *
 * An unreadable or script-less manifest is a REJECTION, not a pass. "I could not
 * check" and "it checks out" are different answers, and only one of them may
 * result in a machine-authored command being committed.
 */
export function validateDraftedRunbook(args: {
  runbook: VerifyRunbookV1;
  modality: VerifyRunbookModality;
  packageJsonRaw: string | null;
}): RunbookDraftValidation {
  const entry = args.runbook.modalities[args.modality];
  if (entry === undefined) {
    return {
      ok: false,
      rejection: {
        kind: 'unreadable-manifest',
        message: `the drafted runbook declares no "${args.modality}" entry`,
      },
    };
  }

  const build = entry.build ?? [];
  const serveCmd = entry.serve?.cmd;

  // (2) §7.2 — the SHARED guard, over the runbook's own commands.
  const forbidden = findForbiddenTaskCommands(taskFromCommands(build, serveCmd));
  if (forbidden.length > 0) {
    return {
      ok: false,
      rejection: {
        kind: 'forbidden-dependency-command',
        offenders: forbidden,
        message:
          'the drafted runbook contains dependency-mutating command(s): ' +
          forbidden.map((c) => `\`${c}\``).join(', ') +
          '. Dependencies are prepared for a verification before it runs; a runbook may only build and serve.',
      },
    };
  }

  // (3) Every command must name a script this project DECLARES.
  if (args.packageJsonRaw === null) {
    return {
      ok: false,
      rejection: {
        kind: 'unreadable-manifest',
        message:
          'the project root package.json could not be read, so the drafted commands could not be checked ' +
          'against the scripts this project declares',
      },
    };
  }
  let declared: Set<string>;
  try {
    const parsed: unknown = JSON.parse(args.packageJsonRaw);
    const manifest = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    const scripts = manifest.scripts;
    declared =
      typeof scripts === 'object' && scripts !== null && !Array.isArray(scripts)
        ? new Set(Object.keys(scripts as Record<string, unknown>))
        : new Set<string>();
  } catch (err) {
    return {
      ok: false,
      rejection: {
        kind: 'unreadable-manifest',
        message: `the project root package.json is not valid JSON (${err instanceof Error ? err.message : String(err)}), so the drafted commands could not be checked`,
      },
    };
  }

  const undeclared = [...build, ...(serveCmd !== undefined ? [serveCmd] : [])].filter((command) => {
    const script = scriptNameForCommand(command);
    return script === null || !declared.has(script);
  });
  if (undeclared.length > 0) {
    return {
      ok: false,
      rejection: {
        kind: 'undeclared-command',
        offenders: undeclared,
        message:
          'the drafted runbook proposes command(s) this project does not declare as a package.json script: ' +
          undeclared.map((c) => `\`${c}\``).join(', ') +
          '. A verification runbook may only invoke scripts the project itself documents — the harness never ' +
          'runs a command a human has not already written down.',
      },
    };
  }

  return { ok: true };
}
