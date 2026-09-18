/**
 * Unit tests for the portable-runbook CONTRACT + its content address
 * (docs/proposals/verification-setup-flow.md §5.2 seam 3 + §5.3):
 * `shared/types/verifyRunbook.ts`'s `parseVerifyRunbookV1` validator and
 * `runbookHash.ts`'s `canonicalRunbookJson` / `runbookPortableHash`.
 *
 * The load-bearing property under test is the one the pin depends on:
 * FORMATTING NOISE MUST NOT RE-KEY A RUNBOOK, but any SEMANTIC change must.
 * If key order or whitespace changed the hash, every commit that touched the
 * file with a different serializer would invalidate every outstanding pin and
 * demote every proven record for a change that altered nothing about how the
 * project is stood up.
 */
import { describe, it, expect } from 'vitest';
import {
  parseVerifyRunbookV1,
  VERIFY_RUNBOOK_RELATIVE_PATH,
  VERIFY_RUNBOOK_MODALITIES,
  isVerifyRunbookModality,
  type VerifyRunbookV1,
} from '../../../../../shared/types/verifyRunbook';
import { canonicalRunbookJson, runbookPortableHash } from '../runbookHash';

/** A minimal but complete two-modality runbook — the shape the setup flow derives. */
function baseRunbook(): VerifyRunbookV1 {
  return {
    version: 1,
    modalities: {
      web: {
        build: ['pnpm build:renderer'],
        serve: { cmd: 'pnpm dev --port ${PORT}', readyWhen: { urlPath: '/', timeoutMs: 60000 } },
        attestation: { kind: 'http-endpoint', urlPath: '/__cyboflow_verify__' },
        notes: 'vite dev server; strictPort relaxed for verify builds',
      },
      'cdp-app': {
        serve: { cmd: 'electron . --remote-debugging-port=${PORT}', attach: 'cdp' },
        attestation: { kind: 'cdp-token', expression: 'window.__CYBOFLOW_BUILD__', expected: 'abc123' },
      },
    },
    levers: { portEnv: 'VERIFY_PORT', dataDirEnv: 'CYBOFLOW_DIR', cdpPortFlag: '--remote-debugging-port' },
  };
}

/** A valid single-modality MOBILE runbook — app block + matching bundle-identity. */
function mobileRunbook(): VerifyRunbookV1 {
  return {
    version: 1,
    modalities: {
      mobile: {
        build: ['xcodebuild -scheme Demo -destination "generic/platform=iOS Simulator" -derivedDataPath "$VERIFY_DERIVED_DATA" build'],
        app: {
          platform: 'ios-simulator',
          bundleId: 'com.example.demo',
          scheme: 'Demo',
        },
        attestation: { kind: 'bundle-identity', bundleId: 'com.example.demo' },
      },
    },
    levers: { simUdidEnv: 'VERIFY_SIM_UDID', derivedDataEnv: 'VERIFY_DERIVED_DATA' },
  };
}

describe('verifyRunbook contract', () => {
  it('pins the committed portable path and the declarable modality set', () => {
    expect(VERIFY_RUNBOOK_RELATIVE_PATH).toBe('.cyboflow/verify-runbook.json');
    // 'mobile' (iOS Simulator on xcodebuild + simctl) IS declarable.
    expect([...VERIFY_RUNBOOK_MODALITIES]).toEqual(['web', 'cdp-app', 'native-screen', 'mobile']);
    expect(VERIFY_RUNBOOK_MODALITIES).toHaveLength(4);
    expect(isVerifyRunbookModality('mobile')).toBe(true);
    expect(isVerifyRunbookModality('cdp-app')).toBe(true);
    expect(isVerifyRunbookModality('ios')).toBe(false);
  });

  it('accepts a well-formed runbook and rebuilds it field-by-field', () => {
    const parsed = parseVerifyRunbookV1(baseRunbook());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.runbook.version).toBe(1);
    expect(Object.keys(parsed.runbook.modalities).sort()).toEqual(['cdp-app', 'web']);
    expect(parsed.runbook.modalities['cdp-app']?.serve?.attach).toBe('cdp');
    expect(parsed.runbook.levers?.portEnv).toBe('VERIFY_PORT');
  });

  it('drops unknown extra keys rather than letting them ride into the hash', () => {
    const withExtras = {
      ...baseRunbook(),
      futureField: 'from a newer release',
      modalities: {
        web: {
          ...baseRunbook().modalities.web,
          somethingNew: 42,
        },
      },
    };
    const parsed = parseVerifyRunbookV1(withExtras);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect('futureField' in parsed.runbook).toBe(false);
    expect('somethingNew' in (parsed.runbook.modalities.web ?? {})).toBe(false);
  });

  it('rejects a non-object root, a wrong version, and a non-object modalities map', () => {
    expect(parseVerifyRunbookV1(null)).toEqual({ ok: false, error: 'root: expected an object' });
    expect(parseVerifyRunbookV1([])).toEqual({ ok: false, error: 'root: expected an object' });
    expect(parseVerifyRunbookV1({ version: 2, modalities: {} })).toEqual({
      ok: false,
      error: 'version: expected literal 1',
    });
    expect(parseVerifyRunbookV1({ version: 1, modalities: 'web' })).toEqual({
      ok: false,
      error: 'modalities: expected an object',
    });
  });

  it('requires at least one KNOWN modality key', () => {
    expect(parseVerifyRunbookV1({ version: 1, modalities: {} })).toEqual({
      ok: false,
      error: 'modalities: expected at least one of web|cdp-app|native-screen|mobile',
    });
    // The literal is JOINED from the const, so it widened with it.
    expect(parseVerifyRunbookV1({ version: 1, modalities: { nope: {} } })).toEqual({
      ok: false,
      error: `modalities: expected at least one of ${VERIFY_RUNBOOK_MODALITIES.join('|')}`,
    });
  });

  describe('the mobile modality (iOS Simulator — xcodebuild + simctl)', () => {
    it('accepts a mobile-only runbook with an app block and a matching bundle-identity', () => {
      const parsed = parseVerifyRunbookV1(mobileRunbook());
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(Object.keys(parsed.runbook.modalities)).toEqual(['mobile']);
      expect(parsed.runbook.modalities.mobile?.app).toEqual({
        platform: 'ios-simulator',
        bundleId: 'com.example.demo',
        scheme: 'Demo',
      });
      expect(parsed.runbook.modalities.mobile?.attestation).toEqual({
        kind: 'bundle-identity',
        bundleId: 'com.example.demo',
      });
      // Lever NAMES round-trip (never values).
      expect(parsed.runbook.levers).toEqual({
        simUdidEnv: 'VERIFY_SIM_UDID',
        derivedDataEnv: 'VERIFY_DERIVED_DATA',
      });
    });

    it('round-trips an optional relative productGlob and rejects an escaping one', () => {
      const rb = mobileRunbook();
      rb.modalities.mobile = {
        ...rb.modalities.mobile!,
        app: { ...rb.modalities.mobile!.app!, productGlob: 'Build/Products/Debug-iphonesimulator/Demo.app' },
      };
      const ok = parseVerifyRunbookV1(rb);
      expect(ok.ok).toBe(true);
      if (ok.ok) {
        expect(ok.runbook.modalities.mobile?.app?.productGlob).toBe(
          'Build/Products/Debug-iphonesimulator/Demo.app',
        );
      }

      for (const bad of ['/abs/Demo.app', '~/Demo.app', 'Build/../../Demo.app', '   ']) {
        const rejected = parseVerifyRunbookV1({
          ...mobileRunbook(),
          modalities: {
            mobile: {
              ...mobileRunbook().modalities.mobile!,
              app: { ...mobileRunbook().modalities.mobile!.app!, productGlob: bad },
            },
          },
        });
        expect(rejected).toEqual({
          ok: false,
          error:
            "modalities[\"mobile\"].app.productGlob: expected a non-empty relative path (no leading '/', no '~', no '..' segment)",
        });
      }
    });

    it('requires an app block on the mobile entry', () => {
      expect(
        parseVerifyRunbookV1({
          version: 1,
          modalities: {
            mobile: { attestation: { kind: 'bundle-identity', bundleId: 'com.example.demo' } },
          },
        }),
      ).toEqual({ ok: false, error: 'modalities["mobile"].app: required on the mobile modality' });
    });

    it('rejects a serve block on the mobile entry (no port, nothing to attach to)', () => {
      const rb = mobileRunbook();
      rb.modalities.mobile = { ...rb.modalities.mobile!, serve: { cmd: 'pnpm dev --port ${PORT}' } };
      expect(parseVerifyRunbookV1(rb)).toEqual({
        ok: false,
        error:
          'modalities["mobile"].serve: not valid on the mobile modality (a simulator run has no port to serve on — use app)',
      });
    });

    it('pins the mobile attestation to bundle-identity', () => {
      const rb = mobileRunbook();
      rb.modalities.mobile = {
        ...rb.modalities.mobile!,
        attestation: { kind: 'window-identity', titlePattern: 'Demo', app: 'Demo' },
      };
      expect(parseVerifyRunbookV1(rb)).toEqual({
        ok: false,
        error: "modalities[\"mobile\"].attestation.kind: expected 'bundle-identity' on the mobile modality",
      });
    });

    it('requires the attested bundle id to equal the launched one', () => {
      const rb = mobileRunbook();
      rb.modalities.mobile = {
        ...rb.modalities.mobile!,
        attestation: { kind: 'bundle-identity', bundleId: 'com.example.OTHER' },
      };
      expect(parseVerifyRunbookV1(rb)).toEqual({
        ok: false,
        error: 'modalities["mobile"].attestation.bundleId: must equal modalities["mobile"].app.bundleId',
      });
    });

    it('rejects a malformed app block field-by-field, path-named', () => {
      const bad = (app: unknown) =>
        parseVerifyRunbookV1({
          version: 1,
          modalities: {
            mobile: { app, attestation: { kind: 'bundle-identity', bundleId: 'com.example.demo' } },
          },
        });
      expect(bad('nope')).toEqual({ ok: false, error: 'modalities["mobile"].app: expected an object' });
      expect(bad({ platform: 'android-emulator', bundleId: 'x', scheme: 'y' })).toEqual({
        ok: false,
        error: "modalities[\"mobile\"].app.platform: expected the string 'ios-simulator'",
      });
      expect(bad({ platform: 'ios-simulator', bundleId: '  ', scheme: 'Demo' })).toEqual({
        ok: false,
        error: 'modalities["mobile"].app.bundleId: expected non-empty string',
      });
      expect(bad({ platform: 'ios-simulator', bundleId: 'com.example.demo', scheme: 7 })).toEqual({
        ok: false,
        error: 'modalities["mobile"].app.scheme: expected non-empty string',
      });
    });

    it('rejects an app block on a NON-mobile entry', () => {
      expect(
        parseVerifyRunbookV1({
          version: 1,
          modalities: {
            web: {
              app: { platform: 'ios-simulator', bundleId: 'com.example.demo', scheme: 'Demo' },
              attestation: { kind: 'file-identity' },
            },
          },
        }),
      ).toEqual({ ok: false, error: 'modalities["web"].app: app is only valid on the mobile modality' });
    });

    it('leaves non-mobile entries byte-identical (no app, serve and attestation unconstrained)', () => {
      const parsed = parseVerifyRunbookV1(baseRunbook());
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.runbook.modalities.web?.app).toBeUndefined();
      expect(parsed.runbook.modalities['cdp-app']?.app).toBeUndefined();
      expect(parsed.runbook.modalities.web?.attestation).toEqual({
        kind: 'http-endpoint',
        urlPath: '/__cyboflow_verify__',
      });
    });
  });

  it('requires an attestation on every declared modality (§7.1 — no attestation, no pass)', () => {
    const missing = parseVerifyRunbookV1({
      version: 1,
      modalities: { web: { serve: { cmd: 'pnpm dev' } } },
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error).toContain('modalities["web"].attestation: required');

    const malformed = parseVerifyRunbookV1({
      version: 1,
      modalities: { web: { attestation: { kind: 'http-endpoint' } } },
    });
    expect(malformed.ok).toBe(false);
    if (malformed.ok) return;
    expect(malformed.error).toContain('modalities["web"].attestation: malformed');

    const unknownKind = parseVerifyRunbookV1({
      version: 1,
      modalities: { web: { attestation: { kind: 'vibes' } } },
    });
    expect(unknownKind.ok).toBe(false);
    if (unknownKind.ok) return;
    expect(unknownKind.error).toContain('"vibes"');
  });

  it('names the offending path on a malformed serve / build / viewport', () => {
    const badCmd = parseVerifyRunbookV1({
      version: 1,
      modalities: { web: { serve: { cmd: '  ' }, attestation: { kind: 'file-identity' } } },
    });
    expect(badCmd).toEqual({
      ok: false,
      error: 'modalities["web"].serve.cmd: expected non-empty string',
    });

    const badAttach = parseVerifyRunbookV1({
      version: 1,
      modalities: {
        'cdp-app': { serve: { cmd: 'electron .', attach: 'websocket' }, attestation: { kind: 'file-identity' } },
      },
    });
    expect(badAttach.ok).toBe(false);
    if (badAttach.ok) return;
    expect(badAttach.error).toContain('modalities["cdp-app"].serve.attach');

    const badBuild = parseVerifyRunbookV1({
      version: 1,
      modalities: { web: { build: ['ok', 7], attestation: { kind: 'file-identity' } } },
    });
    expect(badBuild).toEqual({
      ok: false,
      error: 'modalities["web"].build: expected an array of strings',
    });

    const badViewport = parseVerifyRunbookV1({
      version: 1,
      modalities: {
        'native-screen': {
          viewports: [{ width: 0, height: 800 }],
          attestation: { kind: 'window-identity', titlePattern: 'Cyboflow', app: 'Cyboflow' },
        },
      },
    });
    expect(badViewport).toEqual({
      ok: false,
      error: 'modalities["native-screen"].viewports[0].width: expected positive finite number',
    });
  });

  it('does NOT lint dependency-mutating build commands (§5.3 — runner-enforced, not linted)', () => {
    // The runner rejects these at execution time, over EVERY composed task
    // (runbook-sourced and agent-composed alike). A validator here could only
    // cover one of those sources and would create the illusion of coverage.
    const parsed = parseVerifyRunbookV1({
      version: 1,
      modalities: { web: { build: ['pnpm install', 'pnpm rebuild better-sqlite3'], attestation: { kind: 'file-identity' } } },
    });
    expect(parsed.ok).toBe(true);
  });

  it('rejects a non-string lever name', () => {
    expect(
      parseVerifyRunbookV1({
        version: 1,
        modalities: { web: { attestation: { kind: 'file-identity' } } },
        levers: { portEnv: 4521 },
      }),
    ).toEqual({ ok: false, error: 'levers.portEnv: expected string' });

    for (const field of ['simUdidEnv', 'derivedDataEnv'] as const) {
      expect(
        parseVerifyRunbookV1({
          version: 1,
          modalities: { web: { attestation: { kind: 'file-identity' } } },
          levers: { [field]: 12 },
        }),
      ).toEqual({ ok: false, error: `levers.${field}: expected string` });
    }
  });
});

describe('runbookHash', () => {
  it('canonicalizes to sorted keys at every depth, preserving array order', () => {
    const json = canonicalRunbookJson(baseRunbook());
    const reparsed: unknown = JSON.parse(json);
    expect(typeof json).toBe('string');
    // Top level: modalities < version alphabetically, levers first.
    expect(json.indexOf('"levers"')).toBeLessThan(json.indexOf('"modalities"'));
    expect(json.indexOf('"modalities"')).toBeLessThan(json.indexOf('"version"'));
    // Round-trips to an equal value (canonicalization reorders, never rewrites).
    expect(reparsed).toEqual(baseRunbook());
  });

  it('is INVARIANT to key order — reformatting the committed file never re-keys it', () => {
    const a = baseRunbook();
    // Same content, every object literal written in a different key order.
    const b: VerifyRunbookV1 = {
      levers: { cdpPortFlag: '--remote-debugging-port', dataDirEnv: 'CYBOFLOW_DIR', portEnv: 'VERIFY_PORT' },
      modalities: {
        'cdp-app': {
          attestation: { expected: 'abc123', expression: 'window.__CYBOFLOW_BUILD__', kind: 'cdp-token' },
          serve: { attach: 'cdp', cmd: 'electron . --remote-debugging-port=${PORT}' },
        },
        web: {
          notes: 'vite dev server; strictPort relaxed for verify builds',
          attestation: { urlPath: '/__cyboflow_verify__', kind: 'http-endpoint' },
          serve: { readyWhen: { timeoutMs: 60000, urlPath: '/' }, cmd: 'pnpm dev --port ${PORT}' },
          build: ['pnpm build:renderer'],
        },
      },
      version: 1,
    };
    expect(canonicalRunbookJson(a)).toBe(canonicalRunbookJson(b));
    expect(runbookPortableHash(a)).toBe(runbookPortableHash(b));
  });

  it('changes on ANY semantic change — command, attestation, lever, or modality set', () => {
    const base = runbookPortableHash(baseRunbook());
    expect(base).toMatch(/^[0-9a-f]{64}$/);

    const changedCmd = baseRunbook();
    changedCmd.modalities.web = {
      ...(changedCmd.modalities.web ?? { attestation: { kind: 'file-identity' } }),
      serve: { cmd: 'pnpm dev --port ${PORT} --host' },
    };
    expect(runbookPortableHash(changedCmd)).not.toBe(base);

    const changedAttestation = baseRunbook();
    changedAttestation.modalities['cdp-app'] = {
      serve: { cmd: 'electron . --remote-debugging-port=${PORT}', attach: 'cdp' },
      attestation: { kind: 'cdp-token', expression: 'window.__CYBOFLOW_BUILD__', expected: 'def456' },
    };
    expect(runbookPortableHash(changedAttestation)).not.toBe(base);

    const changedLever = baseRunbook();
    changedLever.levers = { ...changedLever.levers, portEnv: 'PORT' };
    expect(runbookPortableHash(changedLever)).not.toBe(base);

    const droppedModality = baseRunbook();
    delete droppedModality.modalities['cdp-app'];
    expect(runbookPortableHash(droppedModality)).not.toBe(base);
  });

  it('changes when build-step ORDER changes (a step list is a sequence, not a set)', () => {
    const a = baseRunbook();
    a.modalities.web = { ...(a.modalities.web ?? { attestation: { kind: 'file-identity' } }), build: ['one', 'two'] };
    const b = baseRunbook();
    b.modalities.web = { ...(b.modalities.web ?? { attestation: { kind: 'file-identity' } }), build: ['two', 'one'] };
    expect(runbookPortableHash(a)).not.toBe(runbookPortableHash(b));
  });

  it('is stable across calls (no ambient state folded into the digest)', () => {
    expect(runbookPortableHash(baseRunbook())).toBe(runbookPortableHash(baseRunbook()));
  });
});
