/**
 * projectSurfaceProbe — §A2 "modality from evidence"
 * (docs/proposals/runbook-optional-verification.md). Every fixture is a tmp dir
 * built per test; nothing outside it is read.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseBlockYaml,
  parseOpenStepPlist,
  probeProjectSurface,
  tagInferredApp,
  withInferredApp,
} from '../projectSurfaceProbe';
import { mergeRunbookIntoTask } from '../enqueueFromTask';
import {
  INFERRED_APP_KEY,
  parseVerificationTaskV1,
  taskJsonHasInferredApp,
} from '../../../../../shared/types/visualVerification';
import type { VerificationTaskV1 } from '../../../../../shared/types/visualVerification';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'surface-probe-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

interface PbxTarget {
  name: string;
  productType?: string;
  /** Per-configuration target build settings, keyed by config name. */
  configs: Record<string, Record<string, string>>;
}

/** A minimal but real-shaped pbxproj: one PBXProject, native targets, config lists and build configurations. */
function pbxproj(targets: PbxTarget[], projectSettings: Record<string, Record<string, string>> = {}): string {
  let seq = 0;
  const id = (): string => `A${String(++seq).padStart(23, '0')}`;
  const objects: string[] = [];
  const configList = (label: string, configs: Record<string, Record<string, string>>): string => {
    const ids = Object.entries(configs).map(([name, settings]) => {
      const cid = id();
      const body = Object.entries(settings)
        .map(([k, v]) => `\t\t\t\t${k} = ${/^[A-Za-z0-9_.]+$/.test(v) ? v : JSON.stringify(v)};`)
        .join('\n');
      objects.push(
        `\t\t${cid} /* ${name} */ = {\n\t\t\tisa = XCBuildConfiguration;\n\t\t\tbuildSettings = {\n${body}\n\t\t\t};\n\t\t\tname = ${name};\n\t\t};`,
      );
      return `${cid} /* ${name} */`;
    });
    const lid = id();
    objects.push(
      `\t\t${lid} /* Build configuration list for ${label} */ = {\n\t\t\tisa = XCConfigurationList;\n\t\t\tbuildConfigurations = (\n${ids.map((i) => `\t\t\t\t${i},`).join('\n')}\n\t\t\t);\n\t\t\tdefaultConfigurationName = Release;\n\t\t};`,
    );
    return lid;
  };
  const targetIds = targets.map((t) => {
    const tid = id();
    const lid = configList(`PBXNativeTarget "${t.name}"`, t.configs);
    objects.push(
      `\t\t${tid} /* ${t.name} */ = {\n\t\t\tisa = PBXNativeTarget;\n\t\t\tbuildConfigurationList = ${lid};\n\t\t\tbuildPhases = (\n\t\t\t);\n\t\t\tname = ${JSON.stringify(t.name)};\n\t\t\tproductName = ${JSON.stringify(t.name)};\n\t\t\tproductType = "${t.productType ?? 'com.apple.product-type.application'}";\n\t\t};`,
    );
    return tid;
  });
  const plid = configList('PBXProject "App"', Object.keys(projectSettings).length > 0 ? projectSettings : { Debug: {}, Release: {} });
  const pid = id();
  objects.push(
    `\t\t${pid} /* Project object */ = {\n\t\t\tisa = PBXProject;\n\t\t\tbuildConfigurationList = ${plid};\n\t\t\ttargets = (\n${targetIds.map((t) => `\t\t\t\t${t},`).join('\n')}\n\t\t\t);\n\t\t};`,
  );
  return `// !$*UTF8*$!\n{\n\tarchiveVersion = 1;\n\tclasses = {\n\t};\n\tobjectVersion = 56;\n\tobjects = {\n\n${objects.join('\n')}\n\t};\n\trootObject = ${pid} /* Project object */;\n}\n`;
}

const IOS_PROJECT = { Debug: { SDKROOT: 'iphoneos' }, Release: { SDKROOT: 'iphoneos' } };

function scheme(blueprint: string, buildable = `${blueprint}.app`): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion = "1500" version = "1.7">
   <BuildAction parallelizeBuildables = "YES">
      <BuildActionEntries>
         <BuildActionEntry buildForRunning = "YES">
            <BuildableReference
               BuildableIdentifier = "primary"
               BlueprintIdentifier = "A000"
               BuildableName = "${buildable}"
               BlueprintName = "${blueprint}"
               ReferencedContainer = "container:App.xcodeproj">
            </BuildableReference>
         </BuildActionEntry>
      </BuildActionEntries>
   </BuildAction>
</Scheme>
`;
}

describe('probeProjectSurface — XcodeGen project.yml', () => {
  it('an iOS application target with a literal bundle id → ios-app, scheme = the target name', async () => {
    write(
      'project.yml',
      `name: Distractodo
options:
  bundleIdPrefix: com.example # ignored: the target sets its own
targets:
  Distractodo:
    type: application
    platform: iOS
    sources: [Distractodo]
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: "com.example.distractodo"
  DistractodoTests:
    type: bundle.unit-test
    platform: iOS
`,
    );
    await expect(probeProjectSurface(root)).resolves.toMatchObject({
      kind: 'ios-app',
      source: 'xcodegen',
      app: { platform: 'ios-simulator', bundleId: 'com.example.distractodo', scheme: 'Distractodo' },
    });
  });

  it("no PRODUCT_BUNDLE_IDENTIFIER → XcodeGen's own default, <bundleIdPrefix>.<target>", async () => {
    write(
      'project.yml',
      `options:
  bundleIdPrefix: com.example
targets:
  Widgets:
    type: application
    platform: iOS
`,
    );
    const result = await probeProjectSurface(root);
    expect(result).toMatchObject({ kind: 'ios-app', app: { bundleId: 'com.example.Widgets', scheme: 'Widgets' } });
  });

  it('a non-literal bundle id is INCONCLUSIVE', async () => {
    write(
      'project.yml',
      `targets:
  App:
    type: application
    platform: iOS
    settings:
      PRODUCT_BUNDLE_IDENTIFIER: $(BASE_ID).app
`,
    );
    const result = await probeProjectSurface(root);
    expect(result.kind).toBe('inconclusive');
    expect(result.detail).toContain('$(BASE_ID).app');
  });

  it('a ${...} expansion is INCONCLUSIVE too', async () => {
    write(
      'project.yml',
      `targets:
  App:
    type: application
    platform: iOS
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: \${BUNDLE_ID}
`,
    );
    await expect(probeProjectSurface(root)).resolves.toMatchObject({ kind: 'inconclusive' });
  });

  it('several iOS app targets with DIFFERENT ids are INCONCLUSIVE', async () => {
    write(
      'project.yml',
      `targets:
  App:
    type: application
    platform: iOS
    settings:
      PRODUCT_BUNDLE_IDENTIFIER: com.example.app
  Companion:
    type: application
    platform: iOS
    settings:
      PRODUCT_BUNDLE_IDENTIFIER: com.example.companion
`,
    );
    const result = await probeProjectSurface(root);
    expect(result.kind).toBe('inconclusive');
    expect(result.detail).toContain('different bundle ids');
  });

  it('configurations that disagree on the id are INCONCLUSIVE', async () => {
    write(
      'project.yml',
      `targets:
  App:
    type: application
    platform: iOS
    settings:
      configs:
        Debug:
          PRODUCT_BUNDLE_IDENTIFIER: com.example.app.debug
        Release:
          PRODUCT_BUNDLE_IDENTIFIER: com.example.app
`,
    );
    await expect(probeProjectSurface(root)).resolves.toMatchObject({ kind: 'inconclusive' });
  });

  it('an id that could come from a template the probe does not read is INCONCLUSIVE, never the prefix guess', async () => {
    write(
      'project.yml',
      `options:
  bundleIdPrefix: com.example
targets:
  App:
    type: application
    platform: iOS
    templates:
      - SharedApp
`,
    );
    await expect(probeProjectSurface(root)).resolves.toMatchObject({ kind: 'inconclusive' });
  });

  it('a macOS application target is not an iOS surface → none', async () => {
    write(
      'project.yml',
      `targets:
  Mac:
    type: application
    platform: macOS
    settings:
      PRODUCT_BUNDLE_IDENTIFIER: com.example.mac
`,
    );
    await expect(probeProjectSurface(root)).resolves.toMatchObject({ kind: 'none' });
  });

  it("takes the scheme from a committed project's shared xcschemes when one builds the target", async () => {
    write(
      'project.yml',
      `targets:
  App:
    type: application
    platform: iOS
    settings:
      PRODUCT_BUNDLE_IDENTIFIER: com.example.app
`,
    );
    write('App.xcodeproj/xcshareddata/xcschemes/App Dev.xcscheme', scheme('App'));
    write('App.xcodeproj/xcshareddata/xcschemes/Other.xcscheme', scheme('OtherTarget'));
    await expect(probeProjectSurface(root)).resolves.toMatchObject({ kind: 'ios-app', app: { scheme: 'App Dev' } });
  });
});

describe('probeProjectSurface — project.pbxproj', () => {
  it('an application target whose SDKROOT is iphoneos (inherited from the project) → ios-app', async () => {
    write(
      'App.xcodeproj/project.pbxproj',
      pbxproj(
        [
          {
            name: 'Distractodo',
            configs: {
              Debug: { PRODUCT_BUNDLE_IDENTIFIER: 'com.example.distractodo' },
              Release: { PRODUCT_BUNDLE_IDENTIFIER: 'com.example.distractodo' },
            },
          },
          {
            name: 'DistractodoTests',
            productType: 'com.apple.product-type.bundle.unit-test',
            configs: { Debug: { PRODUCT_BUNDLE_IDENTIFIER: 'com.example.tests' } },
          },
        ],
        IOS_PROJECT,
      ),
    );
    await expect(probeProjectSurface(root)).resolves.toMatchObject({
      kind: 'ios-app',
      source: 'pbxproj',
      app: { platform: 'ios-simulator', bundleId: 'com.example.distractodo', scheme: 'Distractodo' },
    });
  });

  it('prefers a shared scheme named after the target over another one that builds it', async () => {
    write(
      'App.xcodeproj/project.pbxproj',
      pbxproj([{ name: 'App', configs: { Debug: { PRODUCT_BUNDLE_IDENTIFIER: 'com.example.app' } } }], IOS_PROJECT),
    );
    write('App.xcodeproj/xcshareddata/xcschemes/App Staging.xcscheme', scheme('App'));
    write('App.xcodeproj/xcshareddata/xcschemes/App.xcscheme', scheme('App'));
    await expect(probeProjectSurface(root)).resolves.toMatchObject({ app: { scheme: 'App' } });
  });

  it('a target-level SDKROOT = macosx is not iOS → none', async () => {
    write(
      'Mac.xcodeproj/project.pbxproj',
      pbxproj([{ name: 'Mac', configs: { Debug: { SDKROOT: 'macosx', PRODUCT_BUNDLE_IDENTIFIER: 'com.example.mac' } } }]),
    );
    await expect(probeProjectSurface(root)).resolves.toMatchObject({ kind: 'none' });
  });

  it('a PRODUCT_BUNDLE_IDENTIFIER with $( is INCONCLUSIVE', async () => {
    write(
      'App.xcodeproj/project.pbxproj',
      pbxproj([{ name: 'App', configs: { Debug: { PRODUCT_BUNDLE_IDENTIFIER: '$(BASE_ID).app' } } }], IOS_PROJECT),
    );
    await expect(probeProjectSurface(root)).resolves.toMatchObject({ kind: 'inconclusive' });
  });

  it('two app targets with different ids are INCONCLUSIVE', async () => {
    write(
      'App.xcodeproj/project.pbxproj',
      pbxproj(
        [
          { name: 'App', configs: { Debug: { PRODUCT_BUNDLE_IDENTIFIER: 'com.example.app' } } },
          { name: 'Clip', configs: { Debug: { PRODUCT_BUNDLE_IDENTIFIER: 'com.example.clip' } } },
        ],
        IOS_PROJECT,
      ),
    );
    await expect(probeProjectSurface(root)).resolves.toMatchObject({ kind: 'inconclusive' });
  });

  it('finds a project one directory down (ios/) and never reads a Pods project', async () => {
    write(
      'ios/App.xcodeproj/project.pbxproj',
      pbxproj([{ name: 'App', configs: { Debug: { PRODUCT_BUNDLE_IDENTIFIER: 'com.example.rn' } } }], IOS_PROJECT),
    );
    write(
      'Pods/Pods.xcodeproj/project.pbxproj',
      pbxproj([{ name: 'PodApp', configs: { Debug: { PRODUCT_BUNDLE_IDENTIFIER: 'org.cocoapods.x' } } }], IOS_PROJECT),
    );
    await expect(probeProjectSurface(root)).resolves.toMatchObject({ kind: 'ios-app', app: { bundleId: 'com.example.rn' } });
  });

  it('an unparseable pbxproj is INCONCLUSIVE, not a throw', async () => {
    write('App.xcodeproj/project.pbxproj', '// !$*UTF8*$!\n{ objects = { broken');
    await expect(probeProjectSurface(root)).resolves.toMatchObject({ kind: 'inconclusive' });
  });
});

describe('probeProjectSurface — no evidence', () => {
  it('a web project → none', async () => {
    write('package.json', '{"name":"web","scripts":{"dev":"vite"}}');
    await expect(probeProjectSurface(root)).resolves.toMatchObject({ kind: 'none' });
  });

  it('a path that does not exist → none (fail-soft)', async () => {
    await expect(probeProjectSurface(join(root, 'missing'))).resolves.toMatchObject({ kind: 'none' });
  });
});

describe('parsers', () => {
  it('parseOpenStepPlist reads quoted strings, bare paths and nested collections, skipping comments', () => {
    expect(
      parseOpenStepPlist('// !$*UTF8*$!\n{ a = "x \\"y\\""; /* c */ b = ( p/q.swift, 2, ); c = { d = e; }; }'),
    ).toEqual({ a: 'x "y"', b: ['p/q.swift', '2'], c: { d: 'e' } });
    expect(parseOpenStepPlist('{ a = b }')).toBeNull();
  });

  it('parseBlockYaml keeps sequences opaque and strips comments outside quotes', () => {
    const doc = parseBlockYaml('a: "x # not a comment" # comment\nb:\n  - one\n  - two\nc:\n  d: e\n');
    expect(doc).toEqual({
      kind: 'map',
      entries: new Map([
        ['a', { kind: 'scalar', value: 'x # not a comment' }],
        ['b', { kind: 'seq' }],
        ['c', { kind: 'map', entries: new Map([['d', { kind: 'scalar', value: 'e' }]]) }],
      ]),
    });
  });
});

describe('the engine-only inferred tag', () => {
  const task: VerificationTaskV1 = {
    version: 1,
    summary: 's',
    build: ['xcodebuild build'],
    modality: 'native-screen',
    behaviors: [],
  };
  const app = { platform: 'ios-simulator' as const, bundleId: 'com.example.app', scheme: 'App' };

  it('withInferredApp stamps mobile + the tagged app block, and the tag survives JSON', () => {
    const inferred = withInferredApp(task, app);
    expect(inferred.modality).toBe('mobile');
    expect(inferred.app).toMatchObject(app);
    const json = JSON.stringify(inferred);
    expect(taskJsonHasInferredApp(json)).toBe(true);
    expect(taskJsonHasInferredApp(JSON.stringify({ ...task, app }))).toBe(false);
    expect(taskJsonHasInferredApp(null)).toBe(false);
    expect(taskJsonHasInferredApp('not json')).toBe(false);
  });

  it('the wire parser DROPS the tag, so a composer can never claim an inferred block', () => {
    const wire = { ...task, app: { ...app, [INFERRED_APP_KEY]: true } };
    const parsed = parseVerificationTaskV1(wire);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.task.app).toEqual(app);
    expect(taskJsonHasInferredApp(JSON.stringify(parsed.task))).toBe(false);
  });

  it("a proven runbook's app block supersedes an inferred one WHOLE, so the tag never outlives the guess", () => {
    const runbookApp = { platform: 'ios-simulator' as const, bundleId: 'com.example.real', scheme: 'Real' };
    const merged = mergeRunbookIntoTask(withInferredApp(task, app), {
      build: ['xcodebuild -scheme Real build'],
      app: runbookApp,
      attestation: { kind: 'bundle-identity', bundleId: runbookApp.bundleId },
    });
    expect(merged.app).toEqual(runbookApp);
    expect(taskJsonHasInferredApp(JSON.stringify(merged))).toBe(false);
  });

  it('tagInferredApp does not mutate its input', () => {
    const copy = { ...app };
    tagInferredApp(copy);
    expect(copy).toEqual(app);
  });
});
