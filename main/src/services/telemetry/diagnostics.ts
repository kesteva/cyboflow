/**
 * Diagnostics for the in-app bug reporter.
 *
 * Two rules govern this module, both the direct result of adversarial review:
 *
 * 1. STRUCTURED ALLOWLIST ONLY. Everything auto-attached to a bug report is an
 *    explicitly enumerated, classified field. Nothing here serializes an
 *    arbitrary object, a command's output, or a log line into the payload. The
 *    project's existing scrubber only strips the username segment of a home path
 *    (see scrub.ts) — it cannot sanitize free-form text, so free-form text is
 *    never auto-attached.
 *
 * 2. RAW LOG TEXT IS NOT DIAGNOSTICS. `readLogTail` exists to show the user
 *    their own logs so they can decide to include them. It is deliberately NOT
 *    part of `collectDiagnostics`, and the bug reporter only sends it when the
 *    user has explicitly opted in after seeing it.
 */
import * as fs from 'fs';
import * as path from 'path';
import { redactHomePath, redactSecrets } from './scrub';
import { getCyboflowSubdirectory } from '../../utils/cyboflowDirectory';
import { getDevDebugLogPath } from '../../utils/devDebugLog';
import type { TelemetryEnvironment } from './environment';
import type {
  BugReportDiagnostics,
  BugReportLogTail,
  BugReportRecentError,
} from '../../../../shared/types/bugReport';

/**
 * The payload shapes live in `shared/types/bugReport.ts` — the same declarations
 * the renderer and the IPC handler use. Re-exported here so main-process call
 * sites can keep importing from the module that produces them, without a second
 * declaration drifting out of sync across the IPC boundary
 * (see docs/CODE-PATTERNS.md → "IPC / type-parity rules").
 *
 * A recorded error is deliberately narrow: a seam name, an error class, a
 * timestamp, and a bounded home-path-redacted message. The message is included
 * because without it the buffer is close to useless for diagnosis, and it is no
 * broader a disclosure than what `captureSeamError` already sends to Sentry when
 * reporting is on. It is bounded and redacted here, and — like every other
 * field — rendered in the dialog's preview before send, which is the consent seam.
 */
export type { BugReportDiagnostics, BugReportLogTail, BugReportRecentError };

const RECENT_ERROR_LIMIT = 20;
const MESSAGE_MAX_CHARS = 500;

/**
 * In-memory ring buffer of recent handled failures.
 *
 * Module-level and Sentry-independent ON PURPOSE. `captureSeamError` returns
 * early when Sentry is inactive, so a buffer fed from inside that guard would be
 * empty in exactly the case the bug reporter must serve: a user who turned error
 * reporting off and is now filing a report by hand. `recordLocalError` is
 * therefore called BEFORE that guard.
 */
const recentErrors: BugReportRecentError[] = [];

/** Truncate to a hard ceiling, marking elision so a cut is never mistaken for the whole message. */
function truncate(input: string, max: number): string {
  return input.length <= max ? input : `${input.slice(0, max)}… [truncated]`;
}

/**
 * Record a handled failure locally, independent of whether Sentry is active.
 * Never throws: diagnostics must not break the seam they are observing.
 */
export function recordLocalError(seam: string, error: unknown, at: string): void {
  try {
    const err = error instanceof Error ? error : new Error(String(error));
    recentErrors.push({
      at,
      seam,
      errorClass: err.constructor?.name ?? 'Error',
      message: truncate(redactSecrets(redactHomePath(err.message)), MESSAGE_MAX_CHARS),
    });
    // Evict oldest beyond the cap so a crash loop cannot grow this unbounded.
    while (recentErrors.length > RECENT_ERROR_LIMIT) {
      recentErrors.shift();
    }
  } catch {
    // Never throw into app code.
  }
}

/** Snapshot of the recent-error buffer, oldest first. */
export function getRecentErrors(): BugReportRecentError[] {
  return [...recentErrors];
}

/** Test-only: clear the ring buffer between cases. */
export function __resetRecentErrorsForTests(): void {
  recentErrors.length = 0;
}

/**
 * Assemble the structured diagnostics payload. Pure with respect to its inputs
 * so it is testable without an Electron app object.
 */
export function collectDiagnostics(input: {
  appVersion: string;
  electronVersion: string;
  environment: TelemetryEnvironment;
  installId: string;
}): BugReportDiagnostics {
  return {
    appVersion: input.appVersion,
    platform: process.platform,
    arch: process.arch,
    electronVersion: input.electronVersion,
    environment: input.environment,
    installId: input.installId,
    recentErrors: getRecentErrors(),
  };
}

/** Which on-disk log the tail should be read from. */
export type LogSourceKind = BugReportLogTail['kind'];

const TAIL_MAX_BYTES = 64 * 1024;
const TAIL_MAX_LINES = 200;

/**
 * Choose the log source by RUNTIME MODE, never by file existence.
 *
 * Both sinks exist under `pnpm dev`: `Logger` is always constructed (so
 * `~/.cyboflow_dev/logs/` is populated), while dev console traffic ALSO lands in
 * the root `cyboflow-backend-debug.log`. An existence-ordered check would find
 * the logger directory first and silently pick the thinner file every time.
 * Production builds never write the dev debug log at all.
 */
export function resolveLogSourceKind(isPackaged: boolean): LogSourceKind {
  return isPackaged ? 'app-log' : 'dev-debug';
}

/** Newest `cyboflow-*.log` in the app log directory, or null when there is none. */
function newestAppLogFile(): string | null {
  try {
    const logDir = getCyboflowSubdirectory('logs');
    const entries = fs
      .readdirSync(logDir)
      .filter((f) => f.startsWith('cyboflow-') && f.endsWith('.log'))
      .map((f) => {
        const full = path.join(logDir, f);
        return { full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    return entries.length > 0 ? entries[0].full : null;
  } catch {
    return null;
  }
}

/**
 * Read a bounded tail of the appropriate log file.
 *
 * Returned for PREVIEW. The caller must not attach this to a report unless the
 * user opted in after seeing it — no automated pass can make arbitrary log text
 * safe (it can carry prompts, source, command output, and tokens).
 *
 * Known limitation: `Logger` writes through an async queue, so the last few
 * records may not have reached disk when this runs. The tail is a recent
 * snapshot, not a guaranteed-complete one.
 */
export function readLogTail(isPackaged: boolean): BugReportLogTail {
  const kind = resolveLogSourceKind(isPackaged);
  const filePath = kind === 'dev-debug' ? getDevDebugLogPath('backend') : (newestAppLogFile() ?? '');

  if (!filePath) {
    return { kind, filePath: '', text: '', unavailable: true };
  }

  try {
    const { size } = fs.statSync(filePath);
    const start = Math.max(0, size - TAIL_MAX_BYTES);
    const fd = fs.openSync(filePath, 'r');
    try {
      const length = size - start;
      const buffer = Buffer.alloc(length);
      // Decode only what was actually read. The file can be rotated or truncated
      // between the stat and the read, and the unwritten remainder of the buffer
      // is NUL bytes that would otherwise be appended to the preview as garbage.
      const bytesRead = fs.readSync(fd, buffer, 0, length, start);
      const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
      // Drop a leading partial line produced by the byte-offset seek.
      if (start > 0 && lines.length > 1) lines.shift();
      return {
        kind,
        filePath,
        text: lines.slice(-TAIL_MAX_LINES).join('\n'),
        unavailable: false,
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { kind, filePath, text: '', unavailable: true };
  }
}
