import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';

vi.mock('fs', () => ({
  appendFileSync: vi.fn(),
}));

import * as fs from 'fs';
import { getDevDebugLogPath, appendDevDebugLog } from './devDebugLog';

// Derive expected filenames from the helper itself so there is no second copy
// of the filename literal in this file (keeping AC2: single-source for filenames).
const frontendPath = getDevDebugLogPath('frontend');
const backendPath = getDevDebugLogPath('backend');

describe('getDevDebugLogPath', () => {
  it('returns the frontend debug log path under process.cwd()', () => {
    expect(frontendPath).toBe(path.join(process.cwd(), path.basename(frontendPath)));
    expect(path.basename(frontendPath)).toMatch(/^cyboflow-.*-debug\.log$/);
    expect(path.dirname(frontendPath)).toBe(process.cwd());
  });
  it('returns the backend debug log path under process.cwd()', () => {
    expect(backendPath).toBe(path.join(process.cwd(), path.basename(backendPath)));
    expect(path.basename(backendPath)).toMatch(/^cyboflow-.*-debug\.log$/);
    expect(path.dirname(backendPath)).toBe(process.cwd());
  });
  it('frontend and backend paths are distinct', () => {
    expect(frontendPath).not.toBe(backendPath);
  });
});

describe('appendDevDebugLog', () => {
  beforeEach(() => {
    vi.mocked(fs.appendFileSync).mockClear();
    vi.mocked(fs.appendFileSync).mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes a formatted line to the frontend file', () => {
    appendDevDebugLog('frontend', 'log', 'FRONTEND', 'hello');
    expect(fs.appendFileSync).toHaveBeenCalledOnce();
    const [calledPath, calledLine] = vi.mocked(fs.appendFileSync).mock.calls[0];
    expect(calledPath).toBe(frontendPath);
    expect(calledLine).toMatch(/^\[.*\] \[FRONTEND LOG\] hello\n$/);
  });

  it('writes a formatted line to the backend file with the correct level uppercased', () => {
    appendDevDebugLog('backend', 'error', 'BACKEND', 'oops');
    const [calledPath, calledLine] = vi.mocked(fs.appendFileSync).mock.calls[0];
    expect(calledPath).toBe(backendPath);
    expect(calledLine).toMatch(/^\[.*\] \[BACKEND ERROR\] oops\n$/);
  });

  it('swallows appendFileSync errors and calls originalConsole.error if provided', () => {
    vi.mocked(fs.appendFileSync).mockImplementation(() => { throw new Error('boom'); });
    const errSpy = vi.fn();
    expect(() => appendDevDebugLog('frontend', 'log', 'X', 'm', { error: errSpy })).not.toThrow();
    expect(errSpy).toHaveBeenCalled();
  });
});
