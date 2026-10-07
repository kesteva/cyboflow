import { describe, it, expect } from 'vitest';
import { defaultDeviceName, isValidDeviceName } from '../deviceName';

describe('defaultDeviceName', () => {
  it('drops the domain from a hostname', () => {
    expect(defaultDeviceName('Krishnas-MBP.local', 'darwin')).toBe('Krishnas-MBP');
  });

  it('strips control characters and collapses whitespace', () => {
    expect(defaultDeviceName('My\u0000 \u0007Mac\t  Pro', 'darwin')).toBe('My Mac Pro');
  });

  it('falls back to a platform label when the hostname is empty', () => {
    expect(defaultDeviceName('', 'darwin')).toBe('cyboflow on macOS');
    expect(defaultDeviceName('.local', 'win32')).toBe('cyboflow on Windows');
    expect(defaultDeviceName('\u0001', 'linux')).toBe('cyboflow on Linux');
    expect(defaultDeviceName('', 'freebsd')).toBe('cyboflow on freebsd');
  });

  it('caps the name at 100 characters', () => {
    expect(defaultDeviceName('a'.repeat(150), 'darwin')).toHaveLength(100);
  });
});

describe('isValidDeviceName', () => {
  it('accepts 1..100 printable characters', () => {
    expect(isValidDeviceName('Work laptop')).toBe(true);
    expect(isValidDeviceName('a'.repeat(100))).toBe(true);
  });

  it('rejects empty, blank, too long and control characters', () => {
    expect(isValidDeviceName('')).toBe(false);
    expect(isValidDeviceName('   ')).toBe(false);
    expect(isValidDeviceName('a'.repeat(101))).toBe(false);
    expect(isValidDeviceName('bad\nname')).toBe(false);
    expect(isValidDeviceName('bad\u007fname')).toBe(false);
  });
});
