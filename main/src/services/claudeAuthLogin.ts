/**
 * ClaudeAuthLoginService — drives the bundled CLI's `claude auth login` so a
 * user whose Claude login expired can sign back in WITHOUT leaving Cyboflow.
 *
 * WHY THIS EXISTS
 * ---------------
 * The SDK substrate holds no credential of its own: every session borrows the
 * user's Claude Code login (Keychain / ~/.claude/.credentials.json). When that
 * OAuth session expires and cannot be refreshed, the next turn fails with the
 * CLI's "Not logged in · Please run /login" — advice that only works inside
 * the CLI's own TUI. Cyboflow's answer is this service: spawn the same binary
 * the SDK runs, in its `auth login` mode, and relay the two things the user
 * has to do — open the browser, paste the code it hands back.
 *
 * HOW `claude auth login` BEHAVES (2.1.257, non-TTY stdio)
 *   stdout: "Opening browser to sign in…"
 *           "If the browser didn't open, visit: <authorize URL>"
 *           "Paste code here if prompted > "        (waits on stdin)
 *           "Login successful …"                   (then exits 0)
 * The CLI opens the browser itself. On a non-TTY the flow is ALWAYS the
 * paste-a-code variant (the authorize URL carries `code=true` and redirects to
 * platform.claude.com's code page), so the dialog always shows the code field.
 *
 * SECURITY: the pasted code is written to the child's stdin and never logged,
 * never stored, never echoed back over IPC. Stdout is only scanned for the URL
 * and the phase markers; the raw transcript is not surfaced. The authorize URL
 * (PKCE challenge + state) IS returned to the renderer — the browser shows it
 * anyway, and the "browser didn't open" fallback needs it.
 *
 * One attempt at a time per app: a second start() while one is running just
 * returns the running state. A finished attempt (succeeded/failed) is replaced
 * by the next start(). An attempt that sees no completion within
 * {@link LOGIN_TIMEOUT_MS} is killed and reported failed.
 */
import { spawn, execFile, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { ClaudeAuthAccount, ClaudeLoginState } from '../../../shared/types/claudeAuth';
import { IDLE_CLAUDE_LOGIN_STATE } from '../../../shared/types/claudeAuth';

/** Ten minutes: ample for a browser round-trip, short enough not to strand a zombie. */
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const STATUS_TIMEOUT_MS = 10_000;

/** OSC 8 hyperlink wrapper the CLI emits around the URL on some terminals. */
// eslint-disable-next-line no-control-regex
const OSC8_RE = /\x1b\]8;;[^\x1b]*\x1b\\|\x1b\]8;;\x07/g;
/** Any other ANSI CSI sequence (colours, cursor visibility). */
// eslint-disable-next-line no-control-regex
const ANSI_CSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

const AUTH_URL_RE = /https:\/\/[^\s"'<>]+oauth\/authorize[^\s"'<>]*/i;
const CODE_PROMPT_RE = /paste code here/i;
const SUCCESS_RE = /login successful|logged in as/i;

export interface ClaudeAuthLoginDependencies {
  /** Absolute path to a `claude` binary that understands `auth login`; null when none is available. */
  resolveBinary(): string | null;
  spawn: typeof spawn;
  /** Post-login probe: `claude auth status --json`. Rejects on any failure. */
  probeStatus(binary: string): Promise<ClaudeAuthAccount>;
  /** Environment for the child — the login-shell PATH so the CLI can find `open`/`xdg-open`. */
  env(): NodeJS.ProcessEnv;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  log?: (message: string) => void;
}

function stripAnsi(text: string): string {
  return text.replace(OSC8_RE, '').replace(ANSI_CSI_RE, '');
}

/**
 * Parse `claude auth status --json`. Only the non-secret display fields are
 * read out; anything else the CLI adds is ignored.
 */
export function parseAuthStatus(stdout: string): ClaudeAuthAccount {
  const parsed: unknown = JSON.parse(stdout);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('auth status did not return an object');
  }
  const record = parsed as Record<string, unknown>;
  return {
    loggedIn: record.loggedIn === true,
    email: typeof record.email === 'string' && record.email.length > 0 ? record.email : null,
    subscriptionType:
      typeof record.subscriptionType === 'string' && record.subscriptionType.length > 0
        ? record.subscriptionType
        : null,
  };
}

/**
 * The binary ladder: the SDK's own bundled CLI first (it is the one whose
 * credential store the sessions read, and it is pinned new enough to have
 * `auth login`), then the user's configured/PATH `claude` as a fallback.
 * Test seam: `overrides` swaps the probes without a packaged app.
 */
export function resolveClaudeAuthBinary(overrides: {
  bundled: () => string | undefined;
  fallback: () => string | undefined;
  existsSync?: (p: string) => boolean;
}): string | null {
  const exists = overrides.existsSync ?? fs.existsSync;
  for (const candidate of [overrides.bundled(), overrides.fallback()]) {
    if (candidate && exists(candidate)) return candidate;
  }
  return null;
}

/**
 * Locate the platform CLI package the SDK depends on from a real (non-asar)
 * node_modules — the dev-mode complement of resolveClaudeExecutablePath, which
 * only answers for a packaged app. Returns undefined when not resolvable.
 */
export function resolveDevBundledClaudePath(
  resolver: (specifier: string) => string = require.resolve,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | undefined {
  const pkg = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`;
  const binName = platform === 'win32' ? 'claude.exe' : 'claude';
  try {
    return path.join(path.dirname(resolver(`${pkg}/package.json`)), binName);
  } catch {
    return undefined;
  }
}

function defaultProbeStatus(binary: string): Promise<ClaudeAuthAccount> {
  return new Promise<ClaudeAuthAccount>((resolve, reject) => {
    execFile(
      binary,
      ['auth', 'status', '--json'],
      { timeout: STATUS_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        try {
          resolve(parseAuthStatus(String(stdout)));
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
  });
}

export class ClaudeAuthLoginService {
  private readonly deps: ClaudeAuthLoginDependencies;
  private state: ClaudeLoginState = { ...IDLE_CLAUDE_LOGIN_STATE };
  private child: ChildProcess | null = null;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  /** Unconsumed stdout tail, so a marker split across chunks still matches. */
  private stdoutTail = '';
  private stderrTail = '';
  /** Monotonic attempt counter — a late exit from a cancelled attempt must not touch the next one. */
  private attempt = 0;
  /** One status probe at a time: the success marker and exit(0) both ask for it. */
  private accountProbe: Promise<void> | null = null;

  constructor(deps: Partial<ClaudeAuthLoginDependencies> & Pick<ClaudeAuthLoginDependencies, 'resolveBinary'>) {
    this.deps = {
      spawn,
      probeStatus: defaultProbeStatus,
      env: () => ({ ...process.env }),
      setTimeout,
      clearTimeout,
      ...deps,
    };
  }

  getState(): ClaudeLoginState {
    return { ...this.state };
  }

  /** Fresh account probe — what a caller uses to confirm a login outside of an attempt. */
  async probeAccount(): Promise<ClaudeAuthAccount | null> {
    const binary = this.deps.resolveBinary();
    if (!binary) return null;
    try {
      return await this.deps.probeStatus(binary);
    } catch {
      return null;
    }
  }

  /**
   * Start a login attempt. Returns immediately with the state after spawn;
   * progress is read back through getState(). Idempotent while an attempt is
   * live.
   */
  start(): ClaudeLoginState {
    if (this.isLive()) return this.getState();

    const binary = this.deps.resolveBinary();
    if (!binary) {
      this.state = {
        ...IDLE_CLAUDE_LOGIN_STATE,
        phase: 'failed',
        error: 'No Claude Code binary is available to run the sign-in.',
      };
      return this.getState();
    }

    const attempt = ++this.attempt;
    this.stdoutTail = '';
    this.stderrTail = '';
    this.state = { ...IDLE_CLAUDE_LOGIN_STATE, phase: 'starting' };

    let child: ChildProcess;
    try {
      child = this.deps.spawn(binary, ['auth', 'login'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: this.deps.env(),
      });
    } catch (error) {
      this.state = {
        ...IDLE_CLAUDE_LOGIN_STATE,
        phase: 'failed',
        error: `Could not start the sign-in: ${error instanceof Error ? error.message : String(error)}`,
      };
      return this.getState();
    }
    this.child = child;

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (attempt !== this.attempt) return;
      this.consumeStdout(chunk);
    });
    child.stderr?.on('data', (chunk: string) => {
      if (attempt !== this.attempt) return;
      this.stderrTail = (this.stderrTail + stripAnsi(chunk)).slice(-2000);
    });
    child.on('error', (error) => {
      if (attempt !== this.attempt) return;
      this.finish({ ok: false, error: `Sign-in process failed: ${error.message}` });
    });
    child.on('exit', (code, signal) => {
      if (attempt !== this.attempt) return;
      void this.onExit(code, signal);
    });

    this.timeoutHandle = this.deps.setTimeout(() => {
      if (attempt !== this.attempt || !this.isLive()) return;
      this.deps.log?.('[ClaudeAuthLogin] sign-in timed out; killing the CLI');
      this.kill();
      this.finish({ ok: false, error: 'The sign-in timed out. Start it again when you are ready.' });
    }, LOGIN_TIMEOUT_MS);

    return this.getState();
  }

  /** Hand the CLI the authorization code the browser displayed. */
  submitCode(code: string): ClaudeLoginState {
    const trimmed = code.trim();
    if (!this.isLive() || !this.child?.stdin || trimmed.length === 0) return this.getState();
    if (this.state.phase !== 'awaiting-code' && this.state.phase !== 'starting') return this.getState();
    this.child.stdin.write(`${trimmed}\n`);
    this.state = { ...this.state, phase: 'verifying' };
    return this.getState();
  }

  /** Abandon the live attempt (if any) and return to idle. */
  cancel(): ClaudeLoginState {
    if (this.isLive()) {
      this.attempt++; // orphan the child's late callbacks
      this.kill();
    }
    this.clearTimer();
    this.child = null;
    this.state = { ...IDLE_CLAUDE_LOGIN_STATE };
    return this.getState();
  }

  /** App shutdown: never leave a login CLI waiting on a stdin nobody will write. */
  dispose(): void {
    this.cancel();
  }

  private isLive(): boolean {
    return this.state.phase === 'starting' || this.state.phase === 'awaiting-code' || this.state.phase === 'verifying';
  }

  private consumeStdout(chunk: string): void {
    const text = stripAnsi(this.stdoutTail + chunk);
    // Keep a bounded tail for cross-chunk matches; a URL is well under 2 KB.
    this.stdoutTail = text.slice(-4000);

    if (this.state.authUrl === null) {
      const match = AUTH_URL_RE.exec(text);
      if (match) {
        // The CLI prints the URL as a terminal hyperlink; the visible label
        // can repeat the query string after the link target. Cut at the first
        // whitespace already done by the regex; also drop a duplicated
        // `&client_id=…` tail if the OSC 8 label leaked in.
        const url = match[0].replace(/(\?[^?]*)\?.*$/, '$1');
        this.state = { ...this.state, authUrl: url, phase: this.state.phase === 'starting' ? 'awaiting-code' : this.state.phase };
      }
    }
    if (this.state.phase === 'starting' && CODE_PROMPT_RE.test(text)) {
      this.state = { ...this.state, phase: 'awaiting-code' };
    }
    if (SUCCESS_RE.test(text) && this.state.phase !== 'succeeded') {
      // The CLI may linger a beat after printing success; treat the marker as
      // the outcome and let exit() confirm it.
      this.finish({ ok: true });
    }
  }

  private async onExit(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (this.state.phase === 'succeeded' || this.state.phase === 'failed' || this.state.phase === 'idle') {
      // finish() already ran from the success marker (or cancel()). Refresh
      // the account probe if we succeeded without one yet.
      if (this.state.phase === 'succeeded' && this.state.account === null) await this.attachAccount();
      this.clearTimer();
      this.child = null;
      return;
    }
    if (code === 0) {
      this.finish({ ok: true });
      await this.attachAccount();
      return;
    }
    const detail = this.stderrTail.trim() || this.stdoutTail.trim().split('\n').slice(-3).join(' ').trim();
    const reason = signal
      ? `The sign-in was interrupted (${signal}).`
      : `The sign-in did not complete (exit ${code ?? 'unknown'}).`;
    this.finish({ ok: false, error: detail ? `${reason} ${detail}` : reason });
  }

  private finish(outcome: { ok: true } | { ok: false; error: string }): void {
    this.clearTimer();
    if (outcome.ok) {
      this.state = { ...this.state, phase: 'succeeded', error: null };
      // Close stdin so a CLI still waiting on it can exit.
      try { this.child?.stdin?.end(); } catch { /* already closed */ }
      void this.attachAccount();
    } else {
      this.state = { ...this.state, phase: 'failed', error: outcome.error, account: null };
      this.child = null;
    }
  }

  private attachAccount(): Promise<void> {
    if (this.state.phase !== 'succeeded' || this.state.account !== null) return Promise.resolve();
    if (this.accountProbe === null) {
      const attempt = this.attempt;
      this.accountProbe = this.probeAccount()
        .then((account) => {
          if (attempt === this.attempt && this.state.phase === 'succeeded' && account) {
            this.state = { ...this.state, account };
          }
        })
        .finally(() => {
          this.accountProbe = null;
        });
    }
    return this.accountProbe;
  }

  private kill(): void {
    const child = this.child;
    if (!child) return;
    try {
      child.stdin?.end();
    } catch { /* ignore */ }
    try {
      child.kill('SIGTERM');
    } catch { /* already gone */ }
  }

  private clearTimer(): void {
    if (this.timeoutHandle !== null) {
      this.deps.clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }
}
