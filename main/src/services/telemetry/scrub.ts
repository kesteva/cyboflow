import type { Event, Breadcrumb, StackFrame } from '@sentry/electron/main';

/**
 * Privacy scrubbing for Sentry payloads.
 *
 * cyboflow handles user source code, absolute file paths, repo names, and LLM
 * prompts. None of that may ever leave the machine. These helpers run in
 * Sentry's `beforeSend` / `beforeBreadcrumb` hooks to strip:
 *   - server/host names
 *   - the `extra` and `user` bags (may carry prompts / PII)
 *   - directory components of stack-frame paths, JS (filename/abs_path) and
 *     native (package) alike (basename only)
 *   - absolute home paths inside messages / exception values (-> '~/')
 *   - console breadcrumbs entirely (they contain code/prompts)
 *
 * Nothing here may throw into the SDK: callers wrap defensively, but we also
 * keep this code total and side-effect-light.
 */

/**
 * Node function names that only appear on the stack of a *stream write* — the
 * synchronous or dispatched path a `Socket`/`Writable` takes when flushing bytes.
 * An `EPIPE` surfacing through one of these is a broken-pipe write: the reader
 * closed the other end of the pipe.
 */
const STREAM_WRITE_FRAMES = new Set([
  'Socket._write',
  'Socket._writeGeneric',
  'Writable.write',
  '_write',
  'writeOrBuffer',
  'writeGeneric',
  'afterWriteDispatched',
]);

/**
 * True when `event` is a broken-pipe write (`write EPIPE` off a stream-write
 * frame). This is an inherent, unpreventable condition of piped stdio: the
 * reader can close the other end of stdout/stderr (or a child's pipe) between
 * our open-check and our write. The app already swallows these at the process
 * level (`index.ts` uncaughtException + stream 'error' handlers) and keeps
 * running — but Sentry's default uncaught-exception integration still captures
 * them as fatal *before* our handler swallows them, so `beforeSend` must drop
 * them or they flood the inbox on every release (CYBOFLOW-APP-D / -E).
 *
 * SCOPED deliberately: we require BOTH an EPIPE mention AND a stream-write frame,
 * so any *other* EPIPE — one we haven't already decided to handle — still reports.
 */
export function isBenignStreamWriteEpipe<T extends Event>(event: T): boolean {
  const values = event.exception?.values;
  if (!values) return false;
  for (const value of values) {
    const mentionsEpipe =
      (typeof value.value === 'string' && value.value.includes('EPIPE')) ||
      (typeof value.type === 'string' && value.type.includes('EPIPE'));
    if (!mentionsEpipe) continue;
    const frames = value.stacktrace?.frames;
    if (!frames) continue;
    for (const frame of frames) {
      if (typeof frame.function === 'string' && STREAM_WRITE_FRAMES.has(frame.function)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Electron process types that the SDK could not identify. The startup minidump
 * sweep stamps `'event.process'` from crashpad's `process_type` annotation,
 * falling back to the literal `'unknown'` when the annotation is absent
 * (@sentry/electron `sentry-minidump/index.js`, the `sendNativeCrashes` call in
 * `setup()`).
 */
const UNIDENTIFIED_PROCESS = 'unknown';

/**
 * Stamp `crash_source` on a NATIVE crash event: `'app'` for one of cyboflow's
 * own Electron processes, `'external-process'` for anything else.
 *
 * WHY THIS EXISTS. `Sentry.init` starts Electron's crashReporter, which installs
 * a Crashpad handler by setting the task exception port — and on macOS that port
 * is INHERITED across fork/exec. Every process spawned beneath the app therefore
 * reports its crashes into cyboflow's project under `_productName: cyboflow`: the
 * bundled `peekaboo` / `codex` binaries we drive on purpose, and also whatever a
 * session agent shells out to (a `vitest` worker OOMing mid `pnpm test:unit` is
 * the observed case). Untagged, all of it reads as "cyboflow crashed" —
 * CYBOFLOW-APP-J spent six weeks merging two unrelated failure modes because
 * `__pthread_kill` was the only symbolicated frame in either.
 *
 * WHY THE TAG AND NOT A DROP. The split we actually want — our own binaries
 * (a peekaboo crash means native-screen verification is broken, which IS our
 * bug) vs. an agent's stray descendant — needs thread names and the module list.
 * Those live in the minidump, which rides along as an opaque ATTACHMENT and is
 * symbolicated server-side; `beforeSend` sees crashpad annotations only. So the
 * finer split belongs in Sentry's fingerprinting rules, and dropping here would
 * be all-or-nothing across a boundary we cannot see. Tag, never discard.
 *
 * DIRECTION OF FAILURE. Only an explicitly unidentified process is called
 * external. A named renderer (`getRendererName`) or a process type Electron adds
 * later stays `'app'` — misfiling one of OUR crashes as external noise is the
 * expensive mistake, so the ambiguous case fails toward us.
 *
 * Non-native events are left alone: JS errors already carry a trustworthy
 * `'event.process'` from the SDK's context integration and were never ambiguous.
 */
export function tagCrashSource<T extends Event>(event: T): T {
  if (event.platform !== 'native') return event;

  const process = event.tags?.['event.process'];
  const unidentified = typeof process !== 'string' || process === UNIDENTIFIED_PROCESS;

  event.tags = { ...event.tags, crash_source: unidentified ? 'external-process' : 'app' };
  return event;
}

/**
 * A stack frame as it actually arrives from a NATIVE minidump.
 *
 * The SDK's `StackFrame` models JS frames and omits `package`, but the Sentry
 * event protocol defines it for native frames — it is the path to the owning
 * binary or dylib, and on a minidump it is the ONLY path field set
 * (filename/abs_path stay undefined). Observed live on CYBOFLOW-APP-J:
 * `/Users/<name>/.nvm/versions/node/<ver>/bin/node`.
 */
type FrameWithPackage = StackFrame & { package?: string };

/** Return the final path segment, splitting on both POSIX and Windows separators. */
function basename(p: string): string {
  // Split on '/' or '\' and take the last non-empty segment.
  const segments = p.split(/[\\/]/);
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].length > 0) {
      return segments[i];
    }
  }
  return p;
}

/**
 * Replace any absolute user-home path with '~/'. Generic across platforms:
 *   /Users/<name>/...  (macOS)   -> ~/...
 *   /home/<name>/...   (Linux)   -> ~/...
 * Matches the prefix only; the trailing path (which may itself be sensitive,
 * e.g. a repo name) is preserved relative to '~' so the trace stays useful.
 */
export function redactHomePath(input: string): string {
  return input.replace(/(?:\/Users|\/home)\/[^/\s]+\//g, '~/');
}

/**
 * Redact secrets of KNOWN SHAPES from a string, in order:
 *   - cyboflow cloud tokens: `cbd_` (device), `cbh_` (relay-http) and the reserved
 *     `cbf_` / `cbr_` / `cbt_` prefixes → `<prefix>[redacted]`
 *   - `cba_c_…` client secrets → `cba_c_[redacted]`
 *   - `Bearer <credential>` (any case) → `Bearer [redacted]`
 *   - Bridge pairing codes `WORD-WORD-NNNN` (case-insensitive) → `[pairing-code]`
 *   - Anthropic API keys `sk-ant-…` → `sk-ant-[redacted]`
 * A string containing none of these is returned unchanged.
 */
export function redactSecrets(input: string): string {
  return input
    .replace(/\b(cb[dhfrt]_)[A-Za-z0-9_-]+/g, '$1[redacted]')
    .replace(/\bcba_c_\S+/g, 'cba_c_[redacted]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b[A-Za-z]{3,8}-[A-Za-z]{3,8}-\d{4}\b/g, '[pairing-code]')
    .replace(/\bsk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-[redacted]');
}

/**
 * NOT A GENERAL-PURPOSE SCRUBBER — read this before reusing `redactHomePath`.
 *
 * `redactHomePath` removes the USERNAME segment and nothing else. By design it
 * PRESERVES everything after it, so `/Users/alice/private-repo/src/x.ts`
 * becomes `~/private-repo/src/x.ts`. That is the right trade for a stack trace
 * (the path stays diagnostic) and the WRONG trade for arbitrary text: repo
 * names, source lines, prompts, commands, and API tokens all survive it.
 *
 * It is therefore safe on stack frames and exception messages — the closed set
 * of values `scrubSentryEvent` feeds it — and unsafe on log output, command
 * stderr, or anything else free-form.
 *
 * `redactSecrets` (above) additionally redacts TOKENS OF KNOWN SHAPES — cyboflow
 * cloud device/relay tokens (`cbd_`/`cbh_`/…), Bearer credentials, Bridge
 * pairing codes and Anthropic API keys — in the same exception messages,
 * event messages and breadcrumbs, and in the local bug-report error buffer.
 * That is defence in depth behind the rule that error messages never embed a
 * secret in the first place; it does NOT make arbitrary free-form text safe.
 *
 * Consequence for user-submitted bug reports: raw log text can never be made
 * safe by passing it through here. The bug reporter treats a log tail as
 * opt-in content the USER reviews before sending, rather than something an
 * automated pass can sanitize (see services/telemetry/bugReport.ts).
 */

/**
 * Scrub a Sentry error event in place and return it (or null to drop).
 * Generic over T so `beforeSend`'s concrete `ErrorEvent` type is preserved.
 */
export function scrubSentryEvent<T extends Event>(event: T): T | null {
  // Hostname leak.
  event.server_name = undefined;

  // These bags may carry prompts / PII — remove entirely.
  delete event.extra;
  delete event.user;

  // Reduce every stack-frame path to its basename so absolute paths / repo
  // layout never leave the machine.
  const values = event.exception?.values;
  if (values) {
    for (const value of values) {
      const frames = value.stacktrace?.frames;
      if (frames) {
        for (const frame of frames) {
          if (typeof frame.filename === 'string') {
            frame.filename = basename(frame.filename);
          }
          if (typeof frame.abs_path === 'string') {
            frame.abs_path = basename(frame.abs_path);
          }
          // NATIVE frames carry their path on `package` (the owning binary or
          // dylib) and leave filename/abs_path unset, so the two rules above
          // never reach them — minidump frames were shipping absolute paths
          // like '/Users/<name>/.nvm/.../bin/node' intact. Basename keeps the
          // whole diagnostic value (the module name is what identifies the
          // crashing binary, and what server-side grouping rules match on)
          // while dropping the home directory and toolchain layout.
          const nativeFrame = frame as FrameWithPackage;
          if (typeof nativeFrame.package === 'string') {
            nativeFrame.package = basename(nativeFrame.package);
          }
        }
      }

      // Exception messages may embed absolute home paths (and, defensively,
      // tokens of known shapes).
      if (typeof value.value === 'string') {
        value.value = redactSecrets(redactHomePath(value.value));
      }
    }
  }

  // Top-level message may embed absolute home paths.
  if (typeof event.message === 'string') {
    event.message = redactSecrets(redactHomePath(event.message));
  }

  // Breadcrumb messages attached to the event: same treatment.
  if (Array.isArray(event.breadcrumbs)) {
    for (const crumb of event.breadcrumbs) {
      if (typeof crumb.message === 'string') {
        crumb.message = redactSecrets(redactHomePath(crumb.message));
      }
    }
  }

  return event;
}

/**
 * Scrub a single breadcrumb. Console breadcrumbs are dropped entirely (they
 * contain code/prompts in cyboflow); otherwise the message is home-path
 * redacted. Returns null to DROP the breadcrumb.
 */
export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  if (breadcrumb.category === 'console') {
    return null;
  }

  if (typeof breadcrumb.message === 'string') {
    breadcrumb.message = redactHomePath(breadcrumb.message);
  }

  return breadcrumb;
}

/**
 * Electron `child-process-gone` reasons that describe a process we (or Chromium)
 * ENDED ON PURPOSE, as opposed to one that died. Chromium tears utility
 * processes down routinely — the Audio Service is stopped whenever nothing is
 * playing — and the Electron SDK stamps the reason onto the minidump event as
 * the `exit.reason` tag.
 *
 * Every other reason ('crashed', 'oom', 'abnormal-exit', 'launch-failed',
 * 'integrity-failure') stays reportable: those are deaths, and a utility process
 * dying unexpectedly is our problem even when the code that killed it is not.
 */
const DELIBERATE_EXIT_REASONS = new Set(['killed', 'clean-exit']);

/**
 * Whether a native event is the minidump of a process that was shut down
 * deliberately rather than one that crashed.
 *
 * WHY THIS IS A DROP AND NOT A TAG. `tagCrashSource` below deliberately tags
 * rather than discards, because the split it makes — our binary vs. an agent's
 * stray descendant — is genuinely ambiguous from `beforeSend`, and the
 * expensive mistake there is filing one of OUR crashes as noise. This predicate
 * is the opposite case: `exit.reason` is not ambiguous. A SIGTERM'd child
 * (Electron reports `reason: 'killed'`, `exitCode: 15`) did not fail — there is
 * no defect behind it and no volume ranking it should influence.
 *
 * Observed live as CYBOFLOW-APP-1V: three "crashes" that were the Audio Service
 * being stopped, each carrying a stack overflow inside macOS's own
 * `sourcekitdInProc` / Swift `dispatch_apply` — a captured-at-teardown stack
 * from OS code we never call, tagged `crash_source: app` because 'Utility' is a
 * process type we recognize.
 *
 * Scoped to native events: a JS error never carries `exit.reason`, and this must
 * not become a general-purpose drop.
 */
export function isDeliberateProcessTermination<T extends Event>(event: T): boolean {
  if (event.platform !== 'native') return false;
  const reason = event.tags?.['exit.reason'];
  return typeof reason === 'string' && DELIBERATE_EXIT_REASONS.has(reason);
}
