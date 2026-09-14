// Test setup file for Vitest
import { vi } from 'vitest';

import { startOrphanWatchdog } from '../../../vitestOrphanWatchdog';

// Exit if our vitest root dies. A fork-pool worker has no lifetime link to its
// parent and macOS has no PDEATHSIG, so a hard-killed root (agent Bash timeout,
// stopped session, killProcessTree) otherwise leaves this process spinning at
// full CPU forever. No-op unless we really are a fork-pool worker.
startOrphanWatchdog();

// Inject a git config setting through the GIT_CONFIG_* env-config channel
// (same precedence as `git -c`, inherited by every child git spawn including
// the product's runGitAsync). Reaches every repo fixture the unit and
// integration suites create — main/vitest.config.ts and
// vitest.config.integration.ts both list this file as a setupFiles entry
// (the gate config deliberately has none).
function injectGitConfig(key: string, value: string): void {
  const countKey = 'GIT_CONFIG_COUNT';
  const count = Number.parseInt(process.env[countKey] ?? '0', 10) || 0;
  process.env[`GIT_CONFIG_KEY_${count}`] = key;
  process.env[`GIT_CONFIG_VALUE_${count}`] = value;
  process.env[countKey] = String(count + 1);
}

// Pin git's newline handling for every repo fixture a test creates. Git-for-
// Windows installs with `core.autocrlf=true` in the SYSTEM config, which
// silently rewrites LF checkouts to CRLF and breaks byte-level content
// assertions that POSIX suites (and CI) rely on. A no-op on POSIX hosts,
// where autocrlf is already unset/false, and a fix rather than a config
// clobber on Windows — the developer's other global settings stay in effect.
injectGitConfig('core.autocrlf', 'false');

// Repo fixtures otherwise inherit the developer's USER-level git ignores —
// core.excludesFile, or its XDG fallback ~/.config/git/ignore when unset —
// and a `*.log` / `*.tmp` pattern there hides fixture files from both
// `git ls-files --others --exclude-standard` and `git clean -fd`, breaking
// tests that create files with those extensions and expect them to show up
// as untracked / get swept. Pointing excludesFile at /dev/null disables ONLY
// that user-level layer: in-repo .gitignore and .git/info/exclude are
// untouched, so ignore-semantics tests keep working. Safe on Windows too:
// Git-for-Windows maps `/dev/null` to the NUL device, and git silently
// tolerates a nonexistent excludes path in any case.
injectGitConfig('core.excludesFile', '/dev/null');

// Mock Electron modules
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/path'),
    getName: vi.fn(() => 'Cyboflow'),
    getVersion: vi.fn(() => '0.1.0'),
  },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    removeHandler: vi.fn(),
  },
  BrowserWindow: vi.fn(),
}));

// Mock the telemetry SDKs — their native/electron-coupled entry points do not
// load in the host-Node test environment. Any module that transitively imports
// main/src/services/telemetry (e.g. the IPC layer via trackUsage) would otherwise
// fail to collect. Telemetry is a no-op in tests regardless (never initialized).
vi.mock('@sentry/electron/main', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
}));
vi.mock('@aptabase/electron/main', () => ({
  initialize: vi.fn(),
  trackEvent: vi.fn(),
}));

// Set up global test environment
global.console = {
  ...console,
  // Suppress logs during tests unless debugging
  log: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};