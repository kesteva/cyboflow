/**
 * dependencyCommandGuard — the §7.2 forbidden-command pattern
 * (docs/proposals/verification-setup-flow.md).
 *
 * The asymmetry under test: a MISS costs a cross-lane ABI flip written through
 * the snapshot's symlinked node_modules (invisible to `git diff HEAD`), while a
 * false positive costs one recomposition. So the matrix below pins BOTH sides —
 * every dependency-mutating form matches, and every project-script lookalike
 * (`pnpm run build`, `npm test`, `yarn dev`) does NOT.
 */
import { describe, it, expect } from 'vitest';
import {
  FORBIDDEN_DEP_COMMAND_PATTERN,
  findForbiddenTaskCommands,
} from '../dependencyCommandGuard';
import type { VerificationTaskV1 } from '../../../../../shared/types/visualVerification';

/** Fresh test per call — the pattern carries no /g flag, but re-reading it here documents that. */
const matches = (cmd: string): boolean => FORBIDDEN_DEP_COMMAND_PATTERN.test(cmd);

describe('FORBIDDEN_DEP_COMMAND_PATTERN — package-manager dependency verbs', () => {
  const managers = ['pnpm', 'npm', 'yarn', 'bun'];
  const verbs = ['install', 'i', 'ci', 'add', 'rebuild', 'up', 'update', 'upgrade'];

  for (const manager of managers) {
    for (const verb of verbs) {
      it(`matches "${manager} ${verb}"`, () => {
        expect(matches(`${manager} ${verb}`)).toBe(true);
      });
    }
  }

  it('matches with a trailing package argument', () => {
    expect(matches('pnpm add lodash')).toBe(true);
    expect(matches('npm install --save-dev vitest')).toBe(true);
    expect(matches('bun add react react-dom')).toBe(true);
  });

  it('matches through intervening FLAG tokens', () => {
    expect(matches('pnpm -r install')).toBe(true);
    expect(matches('npm --prefix ./main ci')).toBe(false); // non-flag token breaks the run (documented limit)
    expect(matches('pnpm --frozen-lockfile install')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(matches('PNPM INSTALL')).toBe(true);
    expect(matches('Npm Ci')).toBe(true);
  });
});

describe('FORBIDDEN_DEP_COMMAND_PATTERN — rebuild + browser-install forms', () => {
  it('matches the electron ABI rebuilds', () => {
    expect(matches('electron-rebuild')).toBe(true);
    expect(matches('npx electron-rebuild -f -w better-sqlite3')).toBe(true);
    expect(matches('npx electron-builder install-app-deps')).toBe(true);
    expect(matches('electron-builder install-app-deps')).toBe(true);
  });

  it('matches `playwright install` whatever the launcher', () => {
    expect(matches('npx playwright install')).toBe(true);
    expect(matches('npx playwright install chromium')).toBe(true);
    expect(matches('pnpm exec playwright install --with-deps')).toBe(true);
    expect(matches('playwright install')).toBe(true);
  });

  it('matches `pnpm rebuild better-sqlite3` — the ABI flip in package-manager clothing', () => {
    expect(matches('pnpm rebuild better-sqlite3')).toBe(true);
  });
});

describe('FORBIDDEN_DEP_COMMAND_PATTERN — position independence', () => {
  it('matches AFTER a && chain (the shape that hides an install inside a build step)', () => {
    expect(matches('pnpm run build && pnpm install')).toBe(true);
  });

  it('matches after a ; separator', () => {
    expect(matches('echo hi; npm ci')).toBe(true);
  });

  it('matches inside a nested sh -c', () => {
    expect(matches('sh -c "cd main && pnpm install"')).toBe(true);
  });

  it('matches when it is not the first token of the line', () => {
    expect(matches('    CI=1 pnpm install --frozen-lockfile')).toBe(true);
  });
});

describe('FORBIDDEN_DEP_COMMAND_PATTERN — mobile-tier dependency mutation', () => {
  it('matches CocoaPods dependency verbs', () => {
    expect(matches('pod install')).toBe(true);
    expect(matches('pod update')).toBe(true);
    expect(matches('pod repo update')).toBe(true);
    expect(matches('cd ios && pod install')).toBe(true);
  });

  it('matches SwiftPM\'s standalone resolve/update subcommand', () => {
    expect(matches('swift package resolve')).toBe(true);
    expect(matches('swift package update')).toBe(true);
  });

  it('matches xcodebuild\'s explicit SwiftPM re-resolve flag', () => {
    expect(matches('xcodebuild -resolvePackageDependencies -scheme MyApp')).toBe(true);
  });

  it('does NOT match an ordinary xcodebuild build that resolves SwiftPM into its own clonedSourcePackagesDirPath', () => {
    expect(
      matches(
        'xcodebuild build -scheme MyApp -destination "id=$VERIFY_SIM_UDID" ' +
          '-derivedDataPath "$VERIFY_DERIVED_DATA" ' +
          '-clonedSourcePackagesDirPath "$VERIFY_DERIVED_DATA/SourcePackages" ' +
          'CODE_SIGNING_ALLOWED=NO',
      ),
    ).toBe(false);
  });

  it('does NOT match a bare "pod" invocation that is not a dependency verb', () => {
    expect(matches('pod --version')).toBe(false);
    expect(matches('pod lib lint')).toBe(false);
  });
});

describe('FORBIDDEN_DEP_COMMAND_PATTERN — innocuous lookalikes must NOT match', () => {
  const innocuous = [
    'pnpm run build',
    'pnpm build',
    'pnpm dev --port ${PORT}',
    'pnpm dev',
    'npm test',
    'npm run start',
    'yarn dev',
    'bun run build',
    'pnpm test:unit',
    'pnpm --filter web run build',
    'npm run install-nothing', // "install" appears, but only inside a longer script name
    'node scripts/updater.js', // "update" appears as a substring of a filename
    './installer.sh', // "install" as a substring
    'echo "reinstall the deps yourself"',
    'pnpm exec playwright test',
    'electron .',
    'electron-builder --dir',
    'git add -A', // 'add' verb, but not after a package manager
  ];
  for (const cmd of innocuous) {
    it(`does NOT match "${cmd}"`, () => {
      expect(matches(cmd)).toBe(false);
    });
  }

  it('does not match a project script literally NAMED install (scripts are what build steps run)', () => {
    expect(matches('pnpm run install')).toBe(false);
  });
});

describe('findForbiddenTaskCommands', () => {
  const base: VerificationTaskV1 = {
    version: 1,
    summary: 's',
    behaviors: [{ id: 'b1', description: 'd', expected: 'e' }],
  };

  it('returns [] for a task with no build/serve at all', () => {
    expect(findForbiddenTaskCommands(base)).toEqual([]);
  });

  it('returns [] for a clean build + serve', () => {
    const task: VerificationTaskV1 = {
      ...base,
      build: ['pnpm run build:main', 'pnpm run build:frontend'],
      serve: { cmd: 'pnpm dev --port ${PORT}' },
    };
    expect(findForbiddenTaskCommands(task)).toEqual([]);
  });

  it('returns every offending BUILD entry VERBATIM, in task order', () => {
    const task: VerificationTaskV1 = {
      ...base,
      build: ['pnpm install --frozen-lockfile', 'pnpm run build', 'npx electron-rebuild'],
    };
    expect(findForbiddenTaskCommands(task)).toEqual([
      'pnpm install --frozen-lockfile',
      'npx electron-rebuild',
    ]);
  });

  it('covers serve.cmd too, appended after the build offenders', () => {
    const task: VerificationTaskV1 = {
      ...base,
      build: ['pnpm add sqlite3'],
      serve: { cmd: 'pnpm install && pnpm dev --port ${PORT}' },
    };
    expect(findForbiddenTaskCommands(task)).toEqual([
      'pnpm add sqlite3',
      'pnpm install && pnpm dev --port ${PORT}',
    ]);
  });

  it('flags a CDP-attach serve that installs before launching the app', () => {
    const task: VerificationTaskV1 = {
      ...base,
      serve: { cmd: 'pnpm install && electron . --remote-debugging-port=$VERIFY_DRIVER_PORT', attach: 'cdp' },
    };
    expect(findForbiddenTaskCommands(task)).toHaveLength(1);
  });
});
