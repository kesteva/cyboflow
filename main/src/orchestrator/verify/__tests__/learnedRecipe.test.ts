/**
 * learnedRecipe — the §A5 validation rules a reported explore recipe must
 * clear before anything is learned from it
 * (docs/proposals/runbook-optional-verification.md §A5 "Validation").
 * Each rule has a case that would be LEARNED without it.
 */
import { describe, it, expect } from 'vitest';
import { learnedRecipeCommands, tokenizeCommand, validateLearnedRecipe, type LearnedRecipeLeases } from '../learnedRecipe';
import type {
  AttestationSpec,
  VerificationModality,
  VerificationTaskV1,
} from '../../../../../shared/types/visualVerification';

const PACKAGE_JSON = JSON.stringify({ scripts: { build: 'vite build', preview: 'vite preview', 'dev:app': 'electron .' } });
const LEASED: LearnedRecipeLeases = { ports: [5173, 5174], udid: null, snapshotPath: '/private/tmp/cyboflow-verify-AbC/snapshot' };
const MOBILE_LEASED: LearnedRecipeLeases = { ports: [], udid: 'ABCDEF01-2345-6789-ABCD-EF0123456789', snapshotPath: null };

const WEB_SERVE = 'pnpm run preview --port ${PORT}';
const WEB_RECIPE = {
  build: ['pnpm run build'],
  serve: { cmd: WEB_SERVE },
  attestation: { kind: 'http-endpoint', urlPath: '/__cyboflow_verify__' },
};
const WEB_COMPOSED: Pick<VerificationTaskV1, 'serve' | 'app'> = { serve: { cmd: WEB_SERVE } };

const XCODEBUILD =
  'xcodebuild -project App.xcodeproj -scheme App -destination "platform=iOS Simulator,id=$VERIFY_SIM_UDID" -derivedDataPath "$VERIFY_DERIVED_DATA" CODE_SIGNING_ALLOWED=NO build';
const APP = { platform: 'ios-simulator', bundleId: 'com.example.app', scheme: 'App' } as const;
const MOBILE_RECIPE = {
  build: [XCODEBUILD],
  app: APP,
  attestation: { kind: 'bundle-identity', bundleId: 'com.example.app' },
};
const MOBILE_COMPOSED: Pick<VerificationTaskV1, 'serve' | 'app'> = { app: APP };

function web(
  recipe: unknown,
  over: {
    packageJsonRaw?: string | null;
    composed?: Pick<VerificationTaskV1, 'serve' | 'app'>;
    modality?: VerificationModality;
    verifiedChannel?: AttestationSpec['kind'] | null;
  } = {},
) {
  return validateLearnedRecipe({
    recipeJson: typeof recipe === 'string' ? recipe : JSON.stringify(recipe),
    modality: over.modality ?? 'web',
    verifiedChannel: over.verifiedChannel === undefined ? 'http-endpoint' : over.verifiedChannel,
    composed: over.composed ?? WEB_COMPOSED,
    packageJsonRaw: over.packageJsonRaw === undefined ? PACKAGE_JSON : over.packageJsonRaw,
    leased: LEASED,
  });
}

function mobile(recipe: unknown) {
  return validateLearnedRecipe({
    recipeJson: JSON.stringify(recipe),
    modality: 'mobile',
    verifiedChannel: 'bundle-identity',
    composed: MOBILE_COMPOSED,
    packageJsonRaw: null,
    leased: MOBILE_LEASED,
  });
}

function reason(result: ReturnType<typeof validateLearnedRecipe>): string {
  return result.ok ? '' : result.reason;
}

describe('validateLearnedRecipe — the channel the harness verified', () => {
  const { attestation: _omitted, ...WEB_RECIPE_NO_CHANNEL } = WEB_RECIPE;
  void _omitted;

  it('a serve-binding pass learns a recipe that records serve-binding', () => {
    const result = web({ ...WEB_RECIPE, attestation: { kind: 'serve-binding' } }, { verifiedChannel: 'serve-binding' });
    expect(reason(result)).toBe('');
    expect(result.ok && result.entry.attestation).toEqual({ kind: 'serve-binding' });
  });

  it('a serve-binding pass fills in serve-binding for a recipe with no attestation', () => {
    const result = web(WEB_RECIPE_NO_CHANNEL, { verifiedChannel: 'serve-binding' });
    expect(reason(result)).toBe('');
    expect(result.ok && result.entry.attestation).toEqual({ kind: 'serve-binding' });
  });

  it('a serve-binding pass refuses a recipe naming a nonce channel it never verified', () => {
    expect(reason(web(WEB_RECIPE, { verifiedChannel: 'serve-binding' }))).toMatch(
      /recipe attestation "http-endpoint" is not the channel the harness verified \("serve-binding"\)/,
    );
  });

  it('only a serve-binding pass fills in the channel: any other pass still needs the recipe to name it', () => {
    expect(reason(web(WEB_RECIPE_NO_CHANNEL))).toMatch(/attestation/);
  });

  it('never learns from a pass with no verified channel', () => {
    expect(reason(web(WEB_RECIPE, { verifiedChannel: null }))).toMatch(/no verified attestation channel/);
  });

  it('refuses a recipe naming a channel other than the verified one', () => {
    expect(reason(web(WEB_RECIPE, { verifiedChannel: 'dom-marker' }))).toMatch(/not the channel the harness verified/);
  });
});

describe('validateLearnedRecipe — accepted recipes', () => {
  it('a web recipe of declared scripts serving the verbatim composed command is learned', () => {
    const result = web(WEB_RECIPE);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entry.serve?.cmd).toBe(WEB_SERVE);
  });

  it('a mobile recipe of one allowlisted, levered xcodebuild invocation is learned', () => {
    const result = mobile(MOBILE_RECIPE);
    expect(reason(result)).toBe('');
    expect(result.ok).toBe(true);
  });

  it("keeps the recipe's own levers, else falls back to the explore lever source", () => {
    const own = web({ ...WEB_RECIPE, levers: { portEnv: 'PORT' } });
    expect(own.ok && own.levers).toEqual({ portEnv: 'PORT' });
    const fallback = validateLearnedRecipe({
      recipeJson: JSON.stringify({ ...WEB_RECIPE, serve: { cmd: 'pnpm run dev:app', attach: 'cdp' } }),
      modality: 'cdp-app',
      verifiedChannel: 'http-endpoint',
      composed: { serve: { cmd: 'pnpm run dev:app', attach: 'cdp' } },
      packageJsonRaw: PACKAGE_JSON,
      leased: LEASED,
      fallbackLevers: { dataDirEnv: 'CYBOFLOW_DIR' },
    });
    expect(fallback.ok && fallback.levers).toEqual({ dataDirEnv: 'CYBOFLOW_DIR' });
  });
});

describe('validateLearnedRecipe — rejections (nothing learned)', () => {
  it('unparseable / non-object / schema-invalid recipes', () => {
    expect(reason(web('{"build": ['))).toMatch(/not valid JSON/);
    expect(reason(web('["x"]'))).toMatch(/not an object/);
    expect(reason(web({ serve: { cmd: WEB_SERVE } }))).toMatch(/attestation/);
  });

  it('native-screen is never learned', () => {
    expect(reason(web(WEB_RECIPE, { modality: 'native-screen' }))).toMatch(/pinned-only/);
  });

  it('the dependency guard', () => {
    expect(reason(web({ ...WEB_RECIPE, build: ['pnpm install'] }))).toMatch(/mutates dependencies/);
  });

  it('a leased port is matched by numeric value, not spelling (review F5)', () => {
    expect(reason(web({ ...WEB_RECIPE, build: ['pnpm run build --port 05173'] }))).toMatch(/leased port 5173/);
    expect(reason(web({ ...WEB_RECIPE, build: ['pnpm run build --port +5173'] }))).toMatch(/leased port 5173/);
    expect(reason(web({ ...WEB_RECIPE, build: ['pnpm run build --port=+005174'] }))).toMatch(/leased port 5174/);
    // A different number that merely contains the digits is not the lease.
    expect(reason(web({ ...WEB_RECIPE, build: ['pnpm run build --port 51730'] }))).toBe('');
  });

  it('a literal leased port, UDID or snapshot path, or any absolute path', () => {
    expect(reason(web({ ...WEB_RECIPE, build: ['pnpm run build --port 5174'] }))).toMatch(/leased port 5174/);
    expect(reason(web({ ...WEB_RECIPE, build: ['pnpm run build --out /private/tmp/cyboflow-verify-AbC/snapshot/dist'] }))).toMatch(
      /snapshot path/,
    );
    expect(reason(web({ ...WEB_RECIPE, build: ['pnpm run build --outDir=/var/tmp/out'] }))).toMatch(/absolute path/);
    expect(reason(web({ ...WEB_RECIPE, build: ['pnpm run build --dir ~/out'] }))).toMatch(/absolute path/);
    const withUdid = { ...MOBILE_RECIPE, build: [XCODEBUILD.replace('$VERIFY_SIM_UDID', MOBILE_LEASED.udid ?? '')] };
    expect(reason(mobile(withUdid))).toMatch(/UDID/);
  });

  it('lever rules: a lever the binder would drop or that names the execution environment', () => {
    expect(reason(web({ ...WEB_RECIPE, levers: { portEnv: 'PATH' } }))).toMatch(/levers.portEnv/);
    expect(reason(web({ ...WEB_RECIPE, levers: { dataDirEnv: 'VERIFY_PORT' } }))).toMatch(/levers.dataDirEnv/);
  });

  it('web/cdp-app: validateDraftedRunbook against the snapshot package.json', () => {
    expect(reason(web({ ...WEB_RECIPE, build: ['pnpm run compile'] }))).toMatch(/does not declare/);
    expect(reason(web(WEB_RECIPE, { packageJsonRaw: null }))).toMatch(/could not be read/);
  });

  it("web/cdp-app: the serve must be the composed serve the harness verified, in the modality's attach form", () => {
    expect(reason(web({ ...WEB_RECIPE, serve: { cmd: 'pnpm run preview' } }))).toMatch(/verbatim composed serve/);
    expect(reason(web(WEB_RECIPE, { composed: {} }))).toMatch(/verbatim composed serve/);
    expect(reason(web({ ...WEB_RECIPE, serve: { cmd: WEB_SERVE, attach: 'cdp' } }))).toMatch(/attach/);
  });

  it('mobile: not a single xcodebuild invocation', () => {
    expect(reason(mobile({ ...MOBILE_RECIPE, build: [`${XCODEBUILD} && echo done`] }))).toMatch(/single invocation/);
    expect(reason(mobile({ ...MOBILE_RECIPE, build: ['swift build'] }))).toMatch(/not an xcodebuild/);
    expect(reason(mobile({ ...MOBILE_RECIPE, build: [] }))).toMatch(/must carry/);
  });

  it('mobile: only allowlisted options — no build-setting overrides', () => {
    expect(reason(mobile({ ...MOBILE_RECIPE, build: [`${XCODEBUILD} INFOPLIST_FILE=Other.plist`] }))).toMatch(/not an allowed/);
    expect(reason(mobile({ ...MOBILE_RECIPE, build: [`${XCODEBUILD} -xcconfig x.xcconfig`] }))).toMatch(/not an allowed/);
    expect(reason(mobile({ ...MOBILE_RECIPE, build: [XCODEBUILD.replace(' build', ' archive')] }))).toMatch(/not an allowed/);
  });

  it('mobile: $VERIFY_DERIVED_DATA only as the -derivedDataPath / -clonedSourcePackagesDirPath value', () => {
    const elsewhere = `${XCODEBUILD} -project "$VERIFY_DERIVED_DATA/App.xcodeproj"`;
    expect(reason(mobile({ ...MOBILE_RECIPE, build: [elsewhere] }))).toMatch(/may appear only/);
    const clonedOutside = `${XCODEBUILD} -clonedSourcePackagesDirPath SourcePackages`;
    expect(reason(mobile({ ...MOBILE_RECIPE, build: [clonedOutside] }))).toMatch(/must be under/);
    const clonedInside = `${XCODEBUILD} -clonedSourcePackagesDirPath "$VERIFY_DERIVED_DATA/SourcePackages"`;
    expect(mobile({ ...MOBILE_RECIPE, build: [clonedInside] }).ok).toBe(true);
  });

  it('mobile: -project / -workspace name the snapshot itself — no expansion, no absolute path, no ".." (review F2)', () => {
    const withProject = (value: string) => ({ ...MOBILE_RECIPE, build: [XCODEBUILD.replace('-project App.xcodeproj', `-project ${value}`)] });
    expect(reason(mobile(withProject('"$HOME/Developer/Other/App.xcodeproj"')))).toMatch(/-project expands the environment/);
    expect(reason(mobile(withProject('"${HOME}"/Developer/Other/App.xcodeproj')))).toMatch(/-project expands the environment/);
    expect(reason(mobile(withProject('"`pwd`/Other/App.xcodeproj"')))).toMatch(/not a single invocation/);
    expect(reason(mobile(withProject("'$HOME/Other/App.xcodeproj'")))).toMatch(/-project expands the environment/);
    expect(reason(mobile(withProject('~/Developer/Other/App.xcodeproj')))).toMatch(/absolute path/);
    expect(reason(mobile(withProject('../../x.xcodeproj')))).toMatch(/-project traverses out/);
    const workspace = XCODEBUILD.replace('-project App.xcodeproj', '-workspace ios/../../Other.xcworkspace');
    expect(reason(mobile({ ...MOBILE_RECIPE, build: [workspace] }))).toMatch(/-workspace traverses out/);
    // The legitimate forms still pass: a relative project / workspace inside the snapshot.
    expect(reason(mobile(withProject('ios/App.xcodeproj')))).toBe('');
    const okWorkspace = XCODEBUILD.replace('-project App.xcodeproj', '-workspace "ios/App.xcworkspace"');
    expect(reason(mobile({ ...MOBILE_RECIPE, build: [okWorkspace] }))).toBe('');
  });

  it('mobile: -derivedDataPath is exactly the lever; -clonedSourcePackagesDirPath stays beneath it (review F2)', () => {
    const withDerived = (value: string) => ({
      ...MOBILE_RECIPE,
      build: [XCODEBUILD.replace('-derivedDataPath "$VERIFY_DERIVED_DATA"', `-derivedDataPath ${value}`)],
    });
    expect(reason(mobile(withDerived('"$VERIFY_DERIVED_DATA/../Shared"')))).toMatch(/-derivedDataPath traverses out/);
    expect(reason(mobile(withDerived('"$VERIFY_DERIVED_DATA/sub"')))).toMatch(/-derivedDataPath must be exactly/);
    expect(reason(mobile(withDerived('"$HOME/$VERIFY_DERIVED_DATA"')))).toMatch(/-derivedDataPath must be exactly/);
    expect(reason(mobile(withDerived('$VERIFY_DERIVED_DATA')))).toBe('');
    expect(reason(mobile(withDerived('"${VERIFY_DERIVED_DATA}"')))).toBe('');

    const cloned = (value: string) => ({ ...MOBILE_RECIPE, build: [`${XCODEBUILD} -clonedSourcePackagesDirPath ${value}`] });
    expect(reason(mobile(cloned('"$VERIFY_DERIVED_DATA/../Shared"')))).toMatch(/-clonedSourcePackagesDirPath traverses out/);
    expect(reason(mobile(cloned('"$HOME/x/$VERIFY_DERIVED_DATA"')))).toMatch(/-clonedSourcePackagesDirPath must be under/);
    expect(reason(mobile(cloned('"$VERIFY_DERIVED_DATA/$HOME"')))).toMatch(/-clonedSourcePackagesDirPath must be under/);
    expect(reason(mobile(cloned('"$VERIFY_DERIVED_DATAX/pkgs"')))).toMatch(/-clonedSourcePackagesDirPath must be under/);
    expect(reason(mobile(cloned('"$VERIFY_DERIVED_DATA"')))).toBe('');
    expect(reason(mobile(cloned('"${VERIFY_DERIVED_DATA}/SourcePackages/cache"')))).toBe('');
  });

  it('mobile: checkMobileBuildIsolation (a missing CODE_SIGNING_ALLOWED=NO)', () => {
    expect(reason(mobile({ ...MOBILE_RECIPE, build: [XCODEBUILD.replace(' CODE_SIGNING_ALLOWED=NO', '')] }))).toMatch(
      /CODE_SIGNING_ALLOWED=NO/,
    );
  });

  it('mobile: the bundle id must be the attested one', () => {
    const other = {
      ...MOBILE_RECIPE,
      app: { ...APP, bundleId: 'com.example.other' },
      attestation: { kind: 'bundle-identity', bundleId: 'com.example.other' },
    };
    expect(reason(mobile(other))).toMatch(/attested bundle id/);
  });
});

describe('helpers', () => {
  it('tokenizeCommand honours quotes and refuses an unbalanced one', () => {
    expect(tokenizeCommand(`a "b c" 'd e' f=g`)).toEqual(['a', 'b c', 'd e', 'f=g']);
    expect(tokenizeCommand('a "b')).toBeNull();
  });

  it('learnedRecipeCommands lists build, serve and the mobile stand-up', () => {
    expect(learnedRecipeCommands({ build: ['b'], serve: { cmd: 's' }, attestation: { kind: 'http-endpoint', urlPath: '/' } })).toEqual(['b', 's']);
    expect(learnedRecipeCommands({ app: APP, attestation: { kind: 'bundle-identity', bundleId: 'com.example.app' } })).toEqual([
      '(install + launch com.example.app, scheme App)',
    ]);
  });
});
