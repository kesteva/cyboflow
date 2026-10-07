/**
 * ConnectorError — the one error type a persistent-agent connector throws. The core classifies every
 * connector failure by `kind` (shared CONNECTOR_ERROR_KINDS), and the tRPC router maps it by `name` +
 * structural fields (it may not import this file).
 *
 * MESSAGE HYGIENE: `message` is built from fixed text plus the HTTP status and the server's error code
 * ONLY — never a response body, a parse-error message, a URL query or a header. Parse failures are wrapped
 * without a `cause`. Messages reach logs, Sentry and the renderer.
 */
import {
  CONNECTOR_ERROR_KINDS,
  type ConnectorErrorKind,
} from '../../../../shared/types/persistentAgents';

export { CONNECTOR_ERROR_KINDS };
export type { ConnectorErrorKind };

export interface ConnectorErrorOptions {
  httpStatus?: number | null;
  code?: string | null;
  retryAfterMs?: number | null;
  maybeDelivered?: boolean;
  cause?: unknown;
}

export class ConnectorError extends Error {
  readonly kind: ConnectorErrorKind;
  readonly httpStatus: number | null;
  /** Server error code, e.g. 'stale_epoch'. */
  readonly code: string | null;
  readonly retryAfterMs: number | null;
  /** True when the request may have reached the server (timeout after send, reset mid-response). */
  readonly maybeDelivered: boolean;

  constructor(kind: ConnectorErrorKind, message: string, opts: ConnectorErrorOptions = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'ConnectorError';
    this.kind = kind;
    this.httpStatus = opts.httpStatus ?? null;
    this.code = opts.code ?? null;
    this.retryAfterMs = opts.retryAfterMs ?? null;
    this.maybeDelivered = opts.maybeDelivered ?? false;
  }
}

/**
 * Anything thrown that is not a ConnectorError becomes {kind:'retryable', maybeDelivered:true} with the
 * original kept as `cause` (callers report it via captureSeamError).
 */
export function asConnectorError(err: unknown): ConnectorError {
  if (err instanceof ConnectorError) return err;
  return new ConnectorError('retryable', 'Unexpected connector failure', { maybeDelivered: true, cause: err });
}
