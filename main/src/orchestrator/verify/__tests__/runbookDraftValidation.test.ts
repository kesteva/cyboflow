/**
 * Unit tests for the controller-side draft validation
 * (docs/proposals/lane-runbook-bootstrap.md §8 checks 2–3).
 *
 * Check 3 — "every build/serve command must resolve to a DECLARED package.json
 * script" — is the highest-value guard in the proposal, and most of this file is
 * about it. The reason is §1's diagnosis: the engine used to guess the serve
 * command per run, with no memory, and guessed wrong every single time in
 * production. The setup agent's answer to that was a PROSE rule ("never guess a
 * command"), and prose is not enforcement. This check makes "the agent proposed
 * this command" and "the project documents this command" the same statement.
 *
 * The resolver is deliberately CONSERVATIVE, and the tests pin that direction
 * rather than merely the happy path: a false rejection costs one trip through
 * Verify Setup where a human writes the command, while a false acceptance is an
 * unreviewed command the harness then runs on every verification forever.
 */
import { describe, it, expect } from 'vitest';
import { commandsForModality, scriptNameForCommand, validateDraftedRunbook } from '../runbookDraftValidation';
import type { VerifyRunbookV1 } from '../../../../../shared/types/verifyRunbook';

const MANIFEST = JSON.stringify({
  scripts: { build: 'vite build', dev: 'vite', preview: 'vite preview', 'verify:serve': 'vite preview' },
});

function runbook(over: { build?: string[]; serveCmd?: string } = {}): VerifyRunbookV1 {
  return {
    version: 1,
    modalities: {
      web: {
        ...(over.build !== undefined ? { build: over.build } : { build: ['pnpm run build'] }),
        ...(over.serveCmd !== undefined
          ? { serve: { cmd: over.serveCmd } }
          : { serve: { cmd: 'pnpm run preview --port ${PORT}' } }),
        attestation: { kind: 'dom-marker', selector: '[data-verify-build]' },
      },
    },
  };
}

function validate(over: { build?: string[]; serveCmd?: string } = {}, manifest: string | null = MANIFEST) {
  return validateDraftedRunbook({ runbook: runbook(over), modality: 'web', packageJsonRaw: manifest });
}

describe('scriptNameForCommand — composition and redirection', () => {
  it.each([
    // A single `&` composes exactly as `&&` does; it was missed because `&&`
    // was listed and an ampersand reads like a lesser version of it. The tail
    // rides into a shell, and this command is committed, proven, and re-run on
    // every later verification of the project.
    'pnpm dev & rm -rf /tmp/x',
    'pnpm dev > /tmp/out',
    'pnpm dev >> /tmp/out',
    'pnpm dev < /tmp/in',
  ])('does not resolve `%s`', (command) => {
    expect(scriptNameForCommand(command)).toBeNull();
  });

  it.each([
    // Package-manager flags that change WHICH project's script runs. These sit
    // after the script name, where everything else is the script's own argument.
    'npm run build --prefix ../other',
    'npm run build --prefix=../other',
    'pnpm --filter web dev',
    'pnpm dev --node-options=--require=/tmp/x',
  ])('does not resolve `%s` — it redirects the project', (command) => {
    expect(scriptNameForCommand(command)).toBeNull();
  });

  it('still resolves the shape this feature exists to support', () => {
    expect(scriptNameForCommand('pnpm run preview --port ${PORT}')).toBe('preview');
    expect(scriptNameForCommand('pnpm --silent run build')).toBe('build');
    expect(scriptNameForCommand('bun run dev')).toBe('dev');
  });
});

describe('scriptNameForCommand', () => {
  it.each([
    ['pnpm run build', 'build'],
    ['pnpm build', 'build'],
    ['npm run build', 'build'],
    ['yarn build', 'build'],
    ['yarn run build', 'build'],
    ['bun run build', 'build'],
    ['pnpm dev --port ${PORT}', 'dev'],
    ['pnpm --silent run dev', 'dev'],
    ['  pnpm   run   preview  ', 'preview'],
    ['PORT=${PORT} npm run dev', 'dev'],
    ['PORT=$VERIFY_PORT HOST=${PORT} pnpm dev', 'dev'],
    ['CYBOFLOW_DIR="$VERIFY_DATA_DIR" pnpm electron', 'electron'],
  ])('resolves `%s` to the script `%s`', (command, expected) => {
    expect(scriptNameForCommand(command)).toBe(expected);
  });

  it.each([
    ['a bare binary', 'vite --port 5173'],
    ['a framework CLI', 'next dev'],
    ['python', 'python3 -m http.server ${PORT}'],
    ['npx', 'npx serve dist'],
    ['an && chain', 'pnpm run build && pnpm run preview'],
    ['a ; chain', 'pnpm run build; pnpm run preview'],
    ['a pipe', 'pnpm run build | tee log'],
    ['a subshell', 'pnpm run $(cat which-script)'],
    ['an env-var prefix with a literal value', 'PORT=5173 pnpm run dev'],
    ['an env-var prefix with a non-lever expansion', 'PORT=$HOME pnpm run dev'],
    ['a lever value with a suffix', 'DATA="$VERIFY_DATA_DIR/x" pnpm run dev'],
    ['NODE_OPTIONS set to a lever', 'NODE_OPTIONS=${PORT} pnpm run dev'],
    ['DYLD_ set to a lever', 'DYLD_INSERT_LIBRARIES=$VERIFY_DATA_DIR pnpm run dev'],
    ['only assignments, no command', 'PORT=${PORT}'],
    ['a flag in the script position', 'pnpm --version'],
    ['a value-taking pm flag that shifts the script position', 'pnpm --filter web dev'],
  ])('does NOT resolve %s', (_label, command) => {
    // Each of these is a command the project has not written down as one unit.
    // `--filter web dev` is the subtle one: it runs a script in a WORKSPACE
    // package, and the runbook's commands execute from the repo root — rather
    // than model each package manager's flag grammar, the resolver simply fails
    // to resolve, which is a rejection.
    expect(scriptNameForCommand(command)).toBeNull();
  });
});

describe('validateDraftedRunbook — declared scripts', () => {
  it('accepts commands that all name declared scripts', () => {
    expect(validate()).toEqual({ ok: true });
  });

  it('rejects a serve command that names a script this project does not declare', () => {
    const result = validate({ serveCmd: 'pnpm run start:web' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.rejection.kind).toBe('undeclared-command');
    expect(result.rejection.message).toContain('start:web');
  });

  it('rejects a bare binary even when the framework would obviously accept it', () => {
    // The exact class §1 records as 0-for-5 in production. `vite --port` is a
    // command that WOULD work on many projects and was not written down on this
    // one, which is the whole distinction being enforced.
    const result = validate({ serveCmd: 'vite --port ${PORT}' });
    expect(result.ok).toBe(false);
  });

  it('names EVERY offender, not just the first', () => {
    // The message is what a human reads on the degrade path, and "one of your
    // commands is wrong" sends them looking.
    const result = validate({ build: ['make all'], serveCmd: 'serve dist' });
    if (result.ok) throw new Error('unreachable');
    expect(result.rejection.kind).toBe('undeclared-command');
    if (result.rejection.kind !== 'undeclared-command') throw new Error('unreachable');
    expect(result.rejection.offenders).toEqual(['make all', 'serve dist']);
  });

  it('accepts a runbook with no build steps at all', () => {
    // "This project needs no build step" is a positive statement a runbook is
    // allowed to make; an empty build must not be read as a missing one.
    expect(validate({ build: [] })).toEqual({ ok: true });
  });
});

describe('validateDraftedRunbook — the manifest itself', () => {
  it('REJECTS when package.json cannot be read', () => {
    // "I could not check" and "it checks out" are different answers, and only one
    // of them may result in a machine-authored command being committed.
    const result = validate({}, null);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.rejection.kind).toBe('unreadable-manifest');
  });

  it('REJECTS when package.json is not valid JSON', () => {
    const result = validate({}, '{ not json');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.rejection.kind).toBe('unreadable-manifest');
  });

  it('rejects every command when the manifest declares no scripts', () => {
    const result = validate({}, '{"name":"app"}');
    expect(result.ok).toBe(false);
  });
});

describe('validateDraftedRunbook — the §7.2 dependency guard', () => {
  it('rejects a runbook that would install dependencies', () => {
    // Shared with the enqueue seam on purpose. A runbook that smuggles an
    // install through is exactly as dangerous as an agent-composed task that
    // does — and arguably worse, because it is PROVEN and repeats on every
    // request.
    const result = validate({ build: ['pnpm install', 'pnpm run build'] });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.rejection.kind).toBe('forbidden-dependency-command');
  });

  it('runs BEFORE the declared-script rule, so the install is what gets named', () => {
    // `pnpm install` happens to also be an undeclared script name. Reporting it
    // as "not a declared script" would send the agent off to add an `install`
    // script — precisely the wrong lesson.
    const result = validate({ build: ['pnpm install'] });
    if (result.ok) throw new Error('unreachable');
    expect(result.rejection.kind).toBe('forbidden-dependency-command');
  });
});

describe('commandsForModality', () => {
  it('returns build steps then the serve command, in execution order', () => {
    expect(commandsForModality(runbook({ build: ['a', 'b'], serveCmd: 'c' }), 'web')).toEqual(['a', 'b', 'c']);
  });

  it('is empty for a modality the runbook does not declare', () => {
    expect(commandsForModality(runbook(), 'cdp-app')).toEqual([]);
  });
});
