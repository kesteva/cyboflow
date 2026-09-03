/**
 * The cmd.exe command-line builder.
 *
 * The contract worth pinning is the quote handling. Node's own argv quoting
 * escapes an inner `"` as `\"`, which cmd.exe does not recognise, so any
 * command carrying a quote arrives mangled unless the whole line is passed as
 * one verbatim argument.
 */
import { describe, it, expect } from 'vitest';

import { cmdCommandLine, cmdExeInvocation, quoteForCmd } from '../win32CmdLine';

describe('quoteForCmd', () => {
  it('leaves a plain token alone', () => {
    expect(quoteForCmd('npx')).toBe('npx');
    expect(quoteForCmd('C:\\tools\\git.exe')).toBe('C:\\tools\\git.exe');
  });

  it('quotes a token carrying a space or a cmd metacharacter', () => {
    expect(quoteForCmd('C:\\Program Files\\git.exe')).toBe('"C:\\Program Files\\git.exe"');
    expect(quoteForCmd('a&b')).toBe('"a&b"');
    expect(quoteForCmd('a|b')).toBe('"a|b"');
    expect(quoteForCmd('say"hi"')).toBe('"say"hi""');
  });
});

describe('cmdCommandLine', () => {
  it('joins tokens, quoting only the ones that need it', () => {
    expect(cmdCommandLine(['npx', 'playwright', 'install'])).toBe('npx playwright install');
    expect(cmdCommandLine(['C:\\Program Files\\d.cmd', 'stop'])).toBe(
      '"C:\\Program Files\\d.cmd" stop',
    );
  });
});

describe('cmdExeInvocation', () => {
  it('passes the whole line as one argument inside an outer quote pair', () => {
    const inv = cmdExeInvocation('npx playwright install');
    expect(inv.args).toEqual(['/d', '/s', '/c', '"npx playwright install"']);
    // /s makes cmd strip exactly the first and last quote of the /c string.
    expect(inv.windowsVerbatimArguments).toBe(true);
  });

  it('carries an embedded quote through untouched', () => {
    // The case Node's argv quoting breaks: it would emit \" here, and cmd.exe
    // treats a backslash before a quote as a literal backslash.
    const inv = cmdExeInvocation('pnpm run build --flag="a b"');
    expect(inv.args[3]).toBe('"pnpm run build --flag="a b""');
    expect(inv.args[3]).not.toContain('\\"');
  });

  it('honours comspec when the environment sets one', () => {
    const original = process.env.comspec;
    try {
      process.env.comspec = 'C:\\Windows\\System32\\cmd.exe';
      expect(cmdExeInvocation('dir').command).toBe('C:\\Windows\\System32\\cmd.exe');
      delete process.env.comspec;
      expect(cmdExeInvocation('dir').command).toBe('cmd.exe');
    } finally {
      if (original === undefined) delete process.env.comspec;
      else process.env.comspec = original;
    }
  });
});
