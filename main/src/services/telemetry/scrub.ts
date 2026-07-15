import type { Event, Breadcrumb } from '@sentry/electron/main';

/**
 * Privacy scrubbing for Sentry payloads.
 *
 * cyboflow handles user source code, absolute file paths, repo names, and LLM
 * prompts. None of that may ever leave the machine. These helpers run in
 * Sentry's `beforeSend` / `beforeBreadcrumb` hooks to strip:
 *   - server/host names
 *   - the `extra` and `user` bags (may carry prompts / PII)
 *   - directory components of stack-frame paths (basename only)
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
function redactHomePath(input: string): string {
  return input.replace(/(?:\/Users|\/home)\/[^/\s]+\//g, '~/');
}

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
        }
      }

      // Exception messages may embed absolute home paths.
      if (typeof value.value === 'string') {
        value.value = redactHomePath(value.value);
      }
    }
  }

  // Top-level message may embed absolute home paths.
  if (typeof event.message === 'string') {
    event.message = redactHomePath(event.message);
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
