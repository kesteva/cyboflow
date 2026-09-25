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
  SIMCTL_LIFECYCLE_DENY_PATTERN,
  findForbiddenTaskCommands,
  forbiddenDepCommandDenyMessage,
  forbiddenProcessKillDenyMessage,
  forbiddenSimctlLifecycleDenyMessage,
  isProcessKillCommand,
} from '../dependencyCommandGuard';
import type { VerificationTaskV1 } from '../../../../../shared/types/visualVerification';

/** Fresh test per call — the pattern carries no /g flag, but re-reading it here documents that. */
const matches = (cmd: string): boolean => FORBIDDEN_DEP_COMMAND_PATTERN.test(cmd);
/** The canUseTool check itself — the pattern over the quote-masked command. */
const matchesKill = (cmd: string): boolean => isProcessKillCommand(cmd);
const matchesSimctl = (cmd: string): boolean => SIMCTL_LIFECYCLE_DENY_PATTERN.test(cmd);

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

describe('forbiddenDepCommandDenyMessage', () => {
  it('names the command, states the rule, and routes to the honest outcome', () => {
    const message = forbiddenDepCommandDenyMessage('pnpm install');
    expect(message).toContain('pnpm install');
    expect(message).toContain('forbidden inside verification snapshots');
    expect(message).toContain('build_failed');
  });

  // Design A2: "a build that needs a forbidden dependency step is
  // `unverifiable`, never `build_failed`" — in EXPLORE only.
  it('routes an explore request to "unverifiable", never "build_failed"', () => {
    const message = forbiddenDepCommandDenyMessage('pod install', 'explore');
    expect(message).toContain('pod install');
    expect(message).toContain('report outcome "unverifiable"');
    expect(message).not.toContain('report outcome "build_failed"');
  });

  it.each(['pinned', 'legacy', undefined] as const)('keeps the build_failed exit for mode %j', (mode) => {
    expect(forbiddenDepCommandDenyMessage('pnpm install', mode)).toBe(forbiddenDepCommandDenyMessage('pnpm install'));
    expect(forbiddenDepCommandDenyMessage('pnpm install', mode)).toContain('report outcome "build_failed"');
  });
});

// ---------------------------------------------------------------------------
// A1.4 explore guards (runbook-optional-verification.md "Structural guards
// (RS-8)") — PROCESS_KILL_COMMAND_PATTERN is COMMAND-POSITION-SENSITIVE
// (unlike FORBIDDEN_DEP_COMMAND_PATTERN above), so its false-positive table is
// the load-bearing half of this suite: a miss here is a blocked kill an agent
// legitimately needed to type as an argument or a script name.
// ---------------------------------------------------------------------------

describe('PROCESS_KILL_COMMAND_PATTERN — command-position kill/pkill/killall', () => {
  const directKills = [
    'kill -9 1234',
    'pkill -f server',
    'killall node',
    'KILL -9 1234', // case-insensitive, like FORBIDDEN_DEP_COMMAND_PATTERN
  ];
  it.each(directKills)('matches %j at the start of the command', (cmd) => {
    expect(matchesKill(cmd)).toBe(true);
  });

  const afterSeparators = [
    'lsof -ti :3000 | xargs kill -9', // the exact A1.4 example
    'cd /tmp && kill -9 1234',
    'echo hi; pkill -f server',
    '$(kill -9 1234)',
    '`killall node`',
  ];
  it.each(afterSeparators)('matches %j (kill in command position after a separator/wrapper)', (cmd) => {
    expect(matchesKill(cmd)).toBe(true);
  });

  const wrappedForms = [
    'sudo kill -9 1234',
    'env FOO=bar kill -9 1234',
    'nohup kill -9 1234',
    'time pkill -f server',
  ];
  it.each(wrappedForms)('matches %j (kill after a benign wrapper command)', (cmd) => {
    expect(matchesKill(cmd)).toBe(true);
  });

  // Adversarial-review additions: command positions a shell really has that the
  // first cut's separator class missed — the loop form above all, since
  // "kill whatever holds the port" is usually written exactly that way.
  const moreCommandPositions = [
    'for p in $(lsof -ti :3000); do kill -9 $p; done',
    'while read p; do kill $p; done < pids.txt',
    'if true; then kill 1234; fi',
    'test -n "$P" && { kill "$P"; }',
    '! kill -0 1234',
    '/bin/kill -9 1234', // a directory prefix on the binary itself
    '/usr/bin/pkill -f server',
    'FOO=1 kill 1234', // a leading assignment, no `env`
    'timeout 5 kill 1234', // a wrapper with a numeric operand
    'lsof -ti :3000 | xargs -P 4 kill',
    'lsof -ti :3000 | xargs -I {} kill -9 {}',
    'command kill 1234',
    'exec killall node',
  ];
  it.each(moreCommandPositions)('matches %j (kill in a command position a real shell has)', (cmd) => {
    expect(matchesKill(cmd)).toBe(true);
  });

  // Adversarial-review round 2: a quoted `-c` body is a command line, a wrapper
  // may be named by path, and a wrapper flag may take a non-numeric operand.
  const bypassSpellings = [
    'sh -c "kill -9 $(lsof -ti :3000)"',
    "bash -c 'pkill -f vite'",
    'bash -lc "killall node"',
    'sh -c "grep x f; kill 1"',
    '/usr/bin/env kill 1',
    'sudo -u me kill 1',
    'xargs -I % kill %',
    'lsof -ti :3000 | xargs -n 1 kill',
    'echo "$(kill 1)"', // a command substitution inside double quotes still runs
    'timeout -s KILL 5 kill 1', // the signal name is skipped, the real kill is not
  ];
  it.each(bypassSpellings)('matches %j (quoted -c body / wrapper by path / wrapper flag operand)', (cmd) => {
    expect(matchesKill(cmd)).toBe(true);
  });

  // 24 flags: instant when linear, ~9 s under the ambiguous `-{1,2}\S+` spelling —
  // long enough to fail the budget, short enough that a regression FAILS, not hangs.
  it('stays linear on a long run of wrapper flags (no 2^n backtracking on a miss)', () => {
    const flags = Array.from({ length: 24 }, (_, i) => `--flag${i}`).join(' ');
    const started = Date.now();
    expect(matchesKill(`xargs ${flags} echo done`)).toBe(false);
    expect(Date.now() - started).toBeLessThan(250);
  });

  // The flag-operand arm must not overlap the numeric one (`-P 4` read two ways
  // per pair would double per pair on a miss).
  it('stays linear on a long run of flag + operand pairs', () => {
    const pairs = Array.from({ length: 24 }, () => '-P 4 -I %').join(' ');
    const started = Date.now();
    expect(matchesKill(`xargs ${pairs} echo done`)).toBe(false);
    expect(Date.now() - started).toBeLessThan(250);
  });

  // The asymmetry under test, per the module doc: a miss here silently lets a
  // live kill through; a false positive blocks an innocent command reading
  // "kill" as a substring, in a flag, or in quoted text — all named explicitly
  // in the task spec as cases that must NOT match.
  const innocuous = [
    '--kill-others', // a flag fragment, not a command name
    'pnpm dev --kill-others',
    'skill', // "kill" as a substring of another word
    'node scripts/skill-tree.js',
    'killed', // an inflected form, not the command
    'echo "the build killed itself"',
    'echo "kill this process"', // quoted text after an unrelated command
    '$VERIFY_DRIVER stop', // the sanctioned way to stop what you started
    'docker kill some_container', // "kill" as a SUBCOMMAND, not command position
    'ps aux | grep kill', // an argument after a separator, not a command
    'which kill',
    'ls /usr/bin/kill', // a path to kill as an ARGUMENT
    'node dist/kill.js',
    './node_modules/.bin/tree-kill 1234', // a different binary whose name ends in kill
    'OUT=tmp/kill.log; echo "$OUT"', // an assignment whose value merely contains kill
    'kill_switch=1 pnpm dev',
    'if [ -f x ]; then echo ok; fi',
    // Adversarial-review round 2: a signal NAME handed to `timeout`, and a `|`
    // or `(` inside quoted data, are not command positions.
    'timeout -s KILL 120 pnpm build',
    'timeout --signal KILL 60 pnpm build',
    'timeout -s kill 60 pnpm build',
    'grep -E "error|kill" serve.log',
    'ps aux | grep -E "vite|kill"',
    "grep -E '(kill|term)' serve.log",
    'grep -c "kill" serve.log', // -c of a non-shell is not a command body
    "sh -c \"grep -E 'a|kill' f\"", // quoted data inside a -c body is still data
  ];
  it.each(innocuous)('does NOT match %j', (cmd) => {
    expect(matchesKill(cmd)).toBe(false);
  });
});

describe('forbiddenProcessKillDenyMessage', () => {
  it('names the command, states the rule, and routes to the driver / unverifiable', () => {
    const message = forbiddenProcessKillDenyMessage('kill -9 1234');
    expect(message).toContain('kill -9 1234');
    expect(message).toContain('harness-owned');
    expect(message).toContain('unverifiable');
  });

  // LEAVE_RUNNING_EXPLORE: "do not run "$VERIFY_DRIVER" stop … an unattested run
  // can never reach passed". A deny that steered cleanup onto a bare stop would
  // tear the leased surface down before attestation.
  it('never recommends a final stop: leave the surface running, stop only as half of a restart', () => {
    const message = forbiddenProcessKillDenyMessage('kill $SERVE_PID');
    expect(message).toContain('leave it running when you finish');
    expect(message).toContain('"$VERIFY_DRIVER" stop immediately followed by "$VERIFY_DRIVER" serve again');
    expect(message).toContain('never a stop on its own');
    expect(message).not.toMatch(/stop only what you yourself started/);
    expect(message).not.toMatch(/through\s+"\$VERIFY_DRIVER stop"/);
  });
});

describe('SIMCTL_LIFECYCLE_DENY_PATTERN — leased-simulator lifecycle verbs', () => {
  const verbs = ['install', 'launch', 'boot', 'create', 'delete', 'shutdown', 'erase', 'uninstall', 'terminate'];

  for (const verb of verbs) {
    it(`matches "xcrun simctl ${verb}"`, () => {
      expect(matchesSimctl(`xcrun simctl ${verb} $VERIFY_SIM_UDID`)).toBe(true);
    });
    it(`matches the bare "simctl ${verb}" (no xcrun prefix)`, () => {
      expect(matchesSimctl(`simctl ${verb} $VERIFY_SIM_UDID`)).toBe(true);
    });
  }

  it('matches anywhere in the command, not just at the start (mirrors FORBIDDEN_DEP_COMMAND_PATTERN)', () => {
    expect(matchesSimctl('set -e && xcrun simctl terminate $VERIFY_SIM_UDID com.example.app')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(matchesSimctl('XCRUN SIMCTL BOOT $VERIFY_SIM_UDID')).toBe(true);
  });

  // Design A1.4: "SIMCTL_LIFECYCLE_PATTERN plus erase|uninstall|all|booted" —
  // `booted`/`all` resolve to devices this request never leased.
  const wrongDeviceTargets = [
    'xcrun simctl io booted screenshot shot.png',
    'xcrun simctl openurl booted myapp://x',
    'xcrun simctl spawn booted log stream',
    'xcrun simctl privacy booted grant all com.x',
    'xcrun simctl status_bar booted override --time 9:41',
    'xcrun simctl shutdown all',
    'xcrun simctl erase all',
    'simctl io booted recordVideo out.mov',
  ];
  it.each(wrongDeviceTargets)('matches %j (targets "booted" / "all", not the leased UDID)', (cmd) => {
    expect(matchesSimctl(cmd)).toBe(true);
  });

  it('matches a lifecycle verb behind simctl\'s own flags (`--set <dir>`)', () => {
    expect(matchesSimctl('xcrun simctl --set /tmp/devs boot X')).toBe(true);
    expect(matchesSimctl('xcrun simctl --set /tmp/devs io booted screenshot s.png')).toBe(true);
  });

  const innocuous = [
    'xcrun simctl list devices', // an inspection verb, not a lifecycle mutation
    'xcrun simctl help',
    'xcrun simctl io $VERIFY_SIM_UDID screenshot out.png', // the leased device, by UDID
    'xcrun simctl openurl $VERIFY_SIM_UDID myapp://x',
    'xcrun simctl privacy $VERIFY_SIM_UDID grant all com.x', // `all` as a service, not a device
    'xcrun simctl list devices booted', // a read-only search term under `list`
    'xcrun simctl --set /tmp/devs list devices booted',
    'xcrun xcodebuild -scheme MyApp',
  ];
  it.each(innocuous)('does NOT match %j', (cmd) => {
    expect(matchesSimctl(cmd)).toBe(false);
  });
});

describe('forbiddenSimctlLifecycleDenyMessage', () => {
  it('names the command, states the rule, and routes to the driver / unverifiable', () => {
    const message = forbiddenSimctlLifecycleDenyMessage('xcrun simctl terminate $VERIFY_SIM_UDID com.example.app');
    expect(message).toContain('xcrun simctl terminate $VERIFY_SIM_UDID com.example.app');
    expect(message).toContain('harness-owned');
    expect(message).toContain('unverifiable');
    expect(message).toContain('never "booted" or "all"');
  });
});
