import { describe, it, expect, beforeEach } from 'vitest';
import { getSystemGroupByPreference, setSystemGroupByPreference } from '../systemGroupBy';

describe('system group-by preference', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to worktree when unset', () => {
    expect(getSystemGroupByPreference()).toBe('worktree');
  });

  it('round-trips both values', () => {
    setSystemGroupByPreference('process-type');
    expect(getSystemGroupByPreference()).toBe('process-type');
    setSystemGroupByPreference('worktree');
    expect(getSystemGroupByPreference()).toBe('worktree');
  });

  it('falls back to the default on an invalid stored value', () => {
    localStorage.setItem('cyboflow-system-group-by', 'nonsense');
    expect(getSystemGroupByPreference()).toBe('worktree');
  });

  it('migrates a value saved under the legacy Monitor key', () => {
    localStorage.setItem('cyboflow-monitor-group-by', 'process-type');
    expect(getSystemGroupByPreference()).toBe('process-type');
    expect(localStorage.getItem('cyboflow-monitor-group-by')).toBeNull();
    expect(localStorage.getItem('cyboflow-system-group-by')).toBe('process-type');
  });
});
