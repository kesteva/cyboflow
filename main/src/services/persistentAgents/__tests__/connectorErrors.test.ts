import { describe, it, expect } from 'vitest';
import { asConnectorError, ConnectorError, CONNECTOR_ERROR_KINDS } from '../connectorErrors';
import { CONNECTOR_ERROR_KINDS as SHARED_KINDS } from '../../../../../shared/types/persistentAgents';

describe('ConnectorError', () => {
  it("is named 'ConnectorError' and carries its structural fields", () => {
    const err = new ConnectorError('rate_limited', 'relay request failed: HTTP 429 rate_limited', {
      httpStatus: 429, code: 'rate_limited', retryAfterMs: 5_000,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ConnectorError');
    expect(err.kind).toBe('rate_limited');
    expect(err.httpStatus).toBe(429);
    expect(err.code).toBe('rate_limited');
    expect(err.retryAfterMs).toBe(5_000);
    expect(err.maybeDelivered).toBe(false);
  });

  it('defaults optional fields to null / false', () => {
    const err = new ConnectorError('permanent', 'nope');
    expect(err.httpStatus).toBeNull();
    expect(err.code).toBeNull();
    expect(err.retryAfterMs).toBeNull();
    expect(err.maybeDelivered).toBe(false);
  });

  it('re-exports the shared kind list', () => {
    expect(CONNECTOR_ERROR_KINDS).toBe(SHARED_KINDS);
  });
});

describe('asConnectorError', () => {
  it('returns a ConnectorError unchanged', () => {
    const err = new ConnectorError('not_found', 'gone', { httpStatus: 404 });
    expect(asConnectorError(err)).toBe(err);
  });

  it('wraps an unknown value as retryable + maybeDelivered and keeps cause', () => {
    const original = new TypeError('socket hang up');
    const wrapped = asConnectorError(original);
    expect(wrapped).toBeInstanceOf(ConnectorError);
    expect(wrapped.name).toBe('ConnectorError');
    expect(wrapped.kind).toBe('retryable');
    expect(wrapped.maybeDelivered).toBe(true);
    expect(wrapped.cause).toBe(original);
    expect(wrapped.message).toBe('Unexpected connector failure');
  });

  it('wraps a non-Error throw too', () => {
    const wrapped = asConnectorError('boom');
    expect(wrapped.kind).toBe('retryable');
    expect(wrapped.cause).toBe('boom');
  });
});
