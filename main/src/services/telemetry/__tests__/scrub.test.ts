import { describe, it, expect } from 'vitest';
import type { Event, Breadcrumb } from '@sentry/electron/main';
import { scrubSentryEvent, scrubBreadcrumb } from '../scrub';

describe('scrubSentryEvent', () => {
  function makeEvent(): Event {
    return {
      message: 'failed reading /Users/alice/secret-repo/src/file.ts',
      server_name: 'alices-macbook.local',
      extra: { prompt: 'write me a function that...' },
      user: { id: 'alice', email: 'alice@example.com' },
      exception: {
        values: [
          {
            type: 'Error',
            value: 'ENOENT at /Users/alice/secret-repo/config.json',
            stacktrace: {
              frames: [
                {
                  filename: '/Users/alice/secret-repo/src/file.ts',
                  abs_path: '/Users/alice/secret-repo/src/file.ts',
                },
                {
                  filename: 'C:\\Users\\bob\\repo\\index.ts',
                  abs_path: 'C:\\Users\\bob\\repo\\index.ts',
                },
              ],
            },
          },
        ],
      },
    };
  }

  it('reduces stack-frame paths to basenames', () => {
    const scrubbed = scrubSentryEvent(makeEvent());
    const frames = scrubbed?.exception?.values?.[0]?.stacktrace?.frames;
    expect(frames?.[0].filename).toBe('file.ts');
    expect(frames?.[0].abs_path).toBe('file.ts');
    // Windows-style separators also collapse to basename.
    expect(frames?.[1].filename).toBe('index.ts');
    expect(frames?.[1].abs_path).toBe('index.ts');
  });

  it('redacts absolute home paths in message and exception value', () => {
    const scrubbed = scrubSentryEvent(makeEvent());
    expect(scrubbed?.message).not.toContain('/Users/alice');
    expect(scrubbed?.message).toContain('~/');
    const value = scrubbed?.exception?.values?.[0]?.value ?? '';
    expect(value).not.toContain('/Users/alice');
    expect(value).toContain('~/');
  });

  it('removes server_name, extra, and user', () => {
    const scrubbed = scrubSentryEvent(makeEvent());
    expect(scrubbed?.server_name).toBeUndefined();
    expect(scrubbed?.extra).toBeUndefined();
    expect(scrubbed?.user).toBeUndefined();
  });

  it('returns the same (mutated) event instance', () => {
    const event = makeEvent();
    const scrubbed = scrubSentryEvent(event);
    expect(scrubbed).toBe(event);
  });
});

describe('scrubBreadcrumb', () => {
  it('drops console breadcrumbs (they contain code/prompts)', () => {
    const breadcrumb: Breadcrumb = {
      category: 'console',
      message: 'console.log("user prompt: write code")',
    };
    expect(scrubBreadcrumb(breadcrumb)).toBeNull();
  });

  it('keeps a non-console breadcrumb and redacts home paths', () => {
    const breadcrumb: Breadcrumb = {
      category: 'navigation',
      message: 'opened /Users/alice/secret-repo/file.ts',
    };
    const result = scrubBreadcrumb(breadcrumb);
    expect(result).not.toBeNull();
    expect(result?.message).not.toContain('/Users/alice');
    expect(result?.message).toContain('~/');
  });

  it('returns a non-console breadcrumb without a message unchanged', () => {
    const breadcrumb: Breadcrumb = { category: 'ui.click' };
    const result = scrubBreadcrumb(breadcrumb);
    expect(result).toBe(breadcrumb);
  });
});
