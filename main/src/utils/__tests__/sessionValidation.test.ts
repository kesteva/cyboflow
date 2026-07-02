/**
 * Behavioral tests for the session/panel validation helpers
 * (main/src/utils/sessionValidation.ts).
 *
 * The module reaches two singletons — `databaseService` (getSession) and
 * `panelManager` (getPanel) — which are module-mocked so the validators run in
 * the host-Node test env. Each validator is exercised at its valid/invalid
 * boundary per the batch spec.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({
  getSession: vi.fn(),
}));
const panelMock = vi.hoisted(() => ({
  getPanel: vi.fn(),
}));

vi.mock('../../services/database', () => ({ databaseService: dbMock }));
vi.mock('../../services/panelManager', () => ({ panelManager: panelMock }));

import {
  validateSessionExists,
  validatePanelSessionOwnership,
  validatePanelExists,
  validateSessionIsActive,
  validateEventContext,
  validatePanelEventContext,
  createValidationError,
} from '../sessionValidation';

type SessionRow = { id: string; archived?: boolean; status?: string };
type PanelRow = { id: string; sessionId: string };

function session(overrides: Partial<SessionRow> & { id: string }): SessionRow {
  return { archived: false, status: 'running', ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('validateSessionExists', () => {
  it('rejects an empty session id before hitting the DB', () => {
    const r = validateSessionExists('');
    expect(r.valid).toBe(false);
    expect(r.error).toBe('Session ID is required');
    expect(dbMock.getSession).not.toHaveBeenCalled();
  });

  it('rejects a missing session', () => {
    dbMock.getSession.mockReturnValue(undefined);
    const r = validateSessionExists('s1');
    expect(r.valid).toBe(false);
    expect(r.error).toBe('Session s1 not found');
  });

  it('rejects an archived session', () => {
    dbMock.getSession.mockReturnValue(session({ id: 's1', archived: true }));
    const r = validateSessionExists('s1');
    expect(r.valid).toBe(false);
    expect(r.error).toBe('Session s1 is archived');
  });

  it('accepts a live, non-archived session', () => {
    dbMock.getSession.mockReturnValue(session({ id: 's1' }));
    const r = validateSessionExists('s1');
    expect(r.valid).toBe(true);
    expect(r.sessionId).toBe('s1');
  });
});

describe('validatePanelSessionOwnership', () => {
  it('requires both a panel id and session id', () => {
    expect(validatePanelSessionOwnership('', 's1').valid).toBe(false);
    expect(validatePanelSessionOwnership('p1', '').valid).toBe(false);
  });

  it('propagates a session-validation failure (and keeps the panelId)', () => {
    dbMock.getSession.mockReturnValue(undefined);
    const r = validatePanelSessionOwnership('p1', 's1');
    expect(r.valid).toBe(false);
    expect(r.error).toBe('Session s1 not found');
    expect(r.panelId).toBe('p1');
    expect(panelMock.getPanel).not.toHaveBeenCalled();
  });

  it('rejects a panel owned by a different session', () => {
    dbMock.getSession.mockReturnValue(session({ id: 's1' }));
    panelMock.getPanel.mockReturnValue({ id: 'p1', sessionId: 'other' } as PanelRow);
    const r = validatePanelSessionOwnership('p1', 's1');
    expect(r.valid).toBe(false);
    expect(r.error).toContain('belongs to session other, not s1');
  });

  it('accepts a panel that belongs to the expected session', () => {
    dbMock.getSession.mockReturnValue(session({ id: 's1' }));
    panelMock.getPanel.mockReturnValue({ id: 'p1', sessionId: 's1' } as PanelRow);
    const r = validatePanelSessionOwnership('p1', 's1');
    expect(r.valid).toBe(true);
    expect(r.panelId).toBe('p1');
    expect(r.sessionId).toBe('s1');
  });
});

describe('validatePanelExists', () => {
  it('rejects an empty panel id and a missing panel', () => {
    expect(validatePanelExists('').valid).toBe(false);
    panelMock.getPanel.mockReturnValue(undefined);
    expect(validatePanelExists('p1').valid).toBe(false);
  });

  it('returns the owning sessionId on success', () => {
    panelMock.getPanel.mockReturnValue({ id: 'p1', sessionId: 's9' } as PanelRow);
    const r = validatePanelExists('p1');
    expect(r.valid).toBe(true);
    expect(r.sessionId).toBe('s9');
  });
});

describe('validateSessionIsActive', () => {
  it('rejects an archived-status session', () => {
    dbMock.getSession.mockReturnValue(session({ id: 's1', status: 'archived' }));
    const r = validateSessionIsActive('s1');
    expect(r.valid).toBe(false);
    expect(r.error).toContain('cannot receive operations');
  });

  it('accepts a running session', () => {
    dbMock.getSession.mockReturnValue(session({ id: 's1', status: 'running' }));
    expect(validateSessionIsActive('s1').valid).toBe(true);
  });
});

describe('validateEventContext', () => {
  it('with no expected session requires a sessionId field then validates it', () => {
    expect(validateEventContext({}).valid).toBe(false);
    dbMock.getSession.mockReturnValue(session({ id: 's1' }));
    const r = validateEventContext({ sessionId: 's1' });
    expect(r.valid).toBe(true);
  });

  it('rejects an event whose sessionId mismatches the expected session', () => {
    const r = validateEventContext({ sessionId: 'sX' }, 's1');
    expect(r.valid).toBe(false);
    expect(r.error).toContain('does not match expected s1');
  });

  it('accepts a matching event and validates the session exists', () => {
    dbMock.getSession.mockReturnValue(session({ id: 's1' }));
    expect(validateEventContext({ sessionId: 's1' }, 's1').valid).toBe(true);
  });
});

describe('validatePanelEventContext', () => {
  it('requires a panelId field when a panel context is expected', () => {
    const r = validatePanelEventContext({ sessionId: 's1' }, 'p1', 's1');
    expect(r.valid).toBe(false);
    expect(r.error).toContain('must contain panelId');
  });

  it('rejects a mismatched panelId', () => {
    const r = validatePanelEventContext({ panelId: 'pX' }, 'p1', 's1');
    expect(r.valid).toBe(false);
    expect(r.error).toContain('does not match expected p1');
  });

  it('validates ownership when both panel and session are expected', () => {
    dbMock.getSession.mockReturnValue(session({ id: 's1' }));
    panelMock.getPanel.mockReturnValue({ id: 'p1', sessionId: 's1' } as PanelRow);
    const r = validatePanelEventContext({ panelId: 'p1' }, 'p1', 's1');
    expect(r.valid).toBe(true);
  });

  it('falls back to plain event/session validation with no panel expectation', () => {
    dbMock.getSession.mockReturnValue(session({ id: 's1' }));
    expect(validatePanelEventContext({ sessionId: 's1' }, undefined, 's1').valid).toBe(true);
  });

  it('errors when the event carries neither panelId nor sessionId and nothing is expected', () => {
    const r = validatePanelEventContext({});
    expect(r.valid).toBe(false);
    expect(r.error).toBe('Event must contain either panelId or sessionId');
  });
});

describe('createValidationError', () => {
  it('maps a failed validation to a {success:false,error} response', () => {
    expect(createValidationError({ valid: false, error: 'nope' })).toEqual({
      success: false,
      error: 'nope',
    });
  });

  it('substitutes a default message when none is present', () => {
    expect(createValidationError({ valid: false })).toEqual({
      success: false,
      error: 'Validation failed',
    });
  });
});
