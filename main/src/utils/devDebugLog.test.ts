import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';

vi.mock('fs', () => ({
  appendFileSync: vi.fn(),
}));

import * as fs from 'fs';
import { getDevDebugLogPath, appendDevDebugLog, formatConsoleArgs } from './devDebugLog';

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

describe('formatConsoleArgs', () => {
  it('joins multiple string arguments with single spaces', () => {
    expect(formatConsoleArgs(['hello', 'world', 'foo'])).toBe('hello world foo');
  });

  it('JSON-stringifies plain objects with 2-space indent', () => {
    const obj = { a: 1, b: 'two' };
    const result = formatConsoleArgs([obj]);
    expect(result).toBe(JSON.stringify(obj, null, 2));
  });

  it('renders Error instances as `Error: {message}\\nStack: {stack}`', () => {
    const err = new Error('something went wrong');
    const result = formatConsoleArgs([err]);
    expect(result).toBe(`Error: ${err.message}\nStack: ${err.stack}`);
  });

  it('handles circular-structure objects without throwing', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => formatConsoleArgs([circular])).not.toThrow();
    expect(formatConsoleArgs([circular])).toContain('[Object with circular structure:');
  });

  it('handles null and undefined via String()', () => {
    expect(formatConsoleArgs([null, undefined])).toBe('null undefined');
  });

  it('mixes strings, numbers, and objects correctly', () => {
    const result = formatConsoleArgs(['count:', 42, { ok: true }]);
    expect(result).toBe(`count: 42 ${JSON.stringify({ ok: true }, null, 2)}`);
  });
});
