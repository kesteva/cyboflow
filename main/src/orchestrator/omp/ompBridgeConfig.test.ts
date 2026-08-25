/**
 * Tests for `resolveOmpBridgeCommandConfig` — the fail-closed bridge config.
 *
 * The command path must never silently authorize: any missing or unusable
 * field resolves to `undefined` (no adapter → stub → `unavailable`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveOmpBridgeCommandConfig } from './ompBridgeConfig';

const URL = 'http://127.0.0.1:53138';

/**
 * A real 0600 token file. The source file itself will not do: the resolver
 * enforces owner-only permissions, and a checked-out .ts is world-readable.
 */
let tokenFile: string;
let tokenDir: string;
/** Same content, but group/world-readable — a credential we must refuse. */
let looseTokenFile: string;

beforeAll(() => {
  tokenDir = mkdtempSync(join(tmpdir(), 'omp-bridge-token-'));
  tokenFile = join(tokenDir, 'token');
  writeFileSync(tokenFile, 'bearer-value\n');
  chmodSync(tokenFile, 0o600);
  looseTokenFile = join(tokenDir, 'token-loose');
  writeFileSync(looseTokenFile, 'bearer-value\n');
  chmodSync(looseTokenFile, 0o644);
});

afterAll(() => {
  rmSync(tokenDir, { recursive: true, force: true });
});
const ENV_KEYS = ['OMP_BRIDGE_URL', 'OMP_BRIDGE_TOKEN_FILE', 'OMP_BRIDGE_SESSION_ID'] as const;

function withEnv(overrides: Record<string, string | undefined>): () => void {
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const key of ENV_KEYS) {
      const original = saved.get(key);
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  };
}

describe('resolveOmpBridgeCommandConfig', () => {
  it('resolves a full config from env', () => {
    const restore = withEnv({
      OMP_BRIDGE_URL: URL,
      OMP_BRIDGE_TOKEN_FILE: tokenFile,
      OMP_BRIDGE_SESSION_ID: 'sess-a',
    });
    try {
      const config = resolveOmpBridgeCommandConfig();
      expect(config).toBeDefined();
      expect(config?.url).toBe(URL);
      expect(config?.sessionId).toBe('sess-a');
    } finally {
      restore();
    }
  });

  it('returns undefined when the token file is missing', () => {
    const restore = withEnv({
      OMP_BRIDGE_URL: URL,
      OMP_BRIDGE_TOKEN_FILE: '/nonexistent/bridge-token',
      OMP_BRIDGE_SESSION_ID: 'sess-a',
    });
    try {
      expect(resolveOmpBridgeCommandConfig()).toBeUndefined();
    } finally {
      restore();
    }
  });

  it('returns undefined when any env field is absent', () => {
    const restore = withEnv({ OMP_BRIDGE_URL: URL });
    try {
      expect(resolveOmpBridgeCommandConfig()).toBeUndefined();
    } finally {
      restore();
    }
  });

  it('rejects a non-loopback URL', () => {
    const restore = withEnv({
      OMP_BRIDGE_URL: 'http://evil.example.com',
      OMP_BRIDGE_TOKEN_FILE: tokenFile,
      OMP_BRIDGE_SESSION_ID: 'sess-a',
    });
    try {
      expect(resolveOmpBridgeCommandConfig()).toBeUndefined();
    } finally {
      restore();
    }
  });

  it('rejects a session id containing a slash', () => {
    const restore = withEnv({
      OMP_BRIDGE_URL: URL,
      OMP_BRIDGE_TOKEN_FILE: tokenFile,
      OMP_BRIDGE_SESSION_ID: 'a/b',
    });
    try {
      expect(resolveOmpBridgeCommandConfig()).toBeUndefined();
    } finally {
      restore();
    }
  });
});

describe('resolveOmpBridgeCommandConfig — loopback enforcement', () => {
  /**
   * The config carries a bearer token that the client sends to whatever host
   * resolves here, so "loopback only" has to mean the parsed hostname. A
   * `startsWith('http://127.0.0.1')` test reads the same but accepts any
   * registrable domain that merely BEGINS with those characters.
   */
  const SPOOFED = [
    'http://127.0.0.1.evil.example/mcp',
    'http://localhost.attacker.tld/mcp',
    'http://127.0.0.1x:9000',
    'http://notlocalhost:9000',
  ];

  for (const url of SPOOFED) {
    it(`refuses a non-loopback host that only looks like one: ${url}`, () => {
      const restore = withEnv({
        OMP_BRIDGE_URL: url,
        OMP_BRIDGE_TOKEN_FILE: tokenFile,
        OMP_BRIDGE_SESSION_ID: 'sess-a',
      });
      try {
        expect(resolveOmpBridgeCommandConfig()).toBeUndefined();
      } finally {
        restore();
      }
    });
  }

  for (const url of ['http://127.0.0.1:53138', 'http://localhost:53138', 'http://[::1]:53138']) {
    it(`accepts the genuine loopback host ${url}`, () => {
      const restore = withEnv({
        OMP_BRIDGE_URL: url,
        OMP_BRIDGE_TOKEN_FILE: tokenFile,
        OMP_BRIDGE_SESSION_ID: 'sess-a',
      });
      try {
        expect(resolveOmpBridgeCommandConfig()?.url).toBe(url);
      } finally {
        restore();
      }
    });
  }

  it('refuses https even to loopback — a bridge with a certificate is a proxy', () => {
    const restore = withEnv({
      OMP_BRIDGE_URL: 'https://127.0.0.1:53138',
      OMP_BRIDGE_TOKEN_FILE: tokenFile,
      OMP_BRIDGE_SESSION_ID: 'sess-a',
    });
    try {
      expect(resolveOmpBridgeCommandConfig()).toBeUndefined();
    } finally {
      restore();
    }
  });

  it('refuses a malformed URL rather than throwing', () => {
    const restore = withEnv({
      OMP_BRIDGE_URL: 'not-a-url',
      OMP_BRIDGE_TOKEN_FILE: tokenFile,
      OMP_BRIDGE_SESSION_ID: 'sess-a',
    });
    try {
      expect(resolveOmpBridgeCommandConfig()).toBeUndefined();
    } finally {
      restore();
    }
  });
});

describe('resolveOmpBridgeCommandConfig — token file permissions', () => {
  it.skipIf(process.platform === 'win32')(
    'refuses a group/world-readable token file',
    () => {
      const restore = withEnv({
        OMP_BRIDGE_URL: URL,
        OMP_BRIDGE_TOKEN_FILE: looseTokenFile,
        OMP_BRIDGE_SESSION_ID: 'sess-a',
      });
      try {
        // Reading it anyway would hand the bridge's authority to every local
        // account; fail closed instead.
        expect(resolveOmpBridgeCommandConfig()).toBeUndefined();
      } finally {
        restore();
      }
    },
  );

  it('accepts an owner-only token file and carries its trimmed contents', () => {
    const restore = withEnv({
      OMP_BRIDGE_URL: URL,
      OMP_BRIDGE_TOKEN_FILE: tokenFile,
      OMP_BRIDGE_SESSION_ID: 'sess-a',
    });
    try {
      expect(resolveOmpBridgeCommandConfig()?.token).toBe('bearer-value');
    } finally {
      restore();
    }
  });
});
