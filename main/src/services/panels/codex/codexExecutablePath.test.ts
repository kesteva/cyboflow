import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  prependCodexPathToEnvironment,
  resolveCodexExecutablePath,
  type CodexExecutableFileSystem,
  type CodexExecutableResolverDependencies,
  type CodexExecutableTarget,
  type CodexPackageResolver,
} from './codexExecutablePath';

interface HarnessOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  isPackaged?: boolean;
  resourcesPath?: string;
  target?: CodexExecutableTarget;
  platformPackage?: string;
  entrypoint?: string;
  manifest?: unknown;
  manifestText?: string;
  statSync?: CodexExecutableFileSystem['statSync'];
  accessSync?: CodexExecutableFileSystem['accessSync'];
}

const CODEX_PACKAGE_JSON = path.join(
  '/virtual',
  '.pnpm',
  '@openai+codex@0.143.0',
  'node_modules',
  '@openai',
  'codex',
  'package.json',
);

function stats(kind: 'file' | 'directory'): ReturnType<CodexExecutableFileSystem['statSync']> {
  return {
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'directory',
  };
}

function createHarness(options: HarnessOptions = {}): {
  dependencies: CodexExecutableResolverDependencies;
  packageResolver: CodexPackageResolver & {
    resolvePackageJson: ReturnType<typeof vi.fn>;
  };
  fileSystem: CodexExecutableFileSystem & {
    readFileSync: ReturnType<typeof vi.fn>;
    statSync: ReturnType<typeof vi.fn>;
    accessSync: ReturnType<typeof vi.fn>;
  };
  platformPackageJson: string;
} {
  const platform = options.platform ?? 'darwin';
  const arch = options.arch ?? 'arm64';
  const target = options.target ?? 'aarch64-apple-darwin';
  const platformPackage = options.platformPackage ?? '@openai/codex-darwin-arm64';
  const entrypoint = options.entrypoint ?? 'bin/codex';
  const platformPackageJson = path.join('/virtual', 'native', platformPackage, 'package.json');
  const manifest = options.manifest ?? {
    layoutVersion: 1,
    version: '0.143.0',
    target,
    variant: 'codex',
    entrypoint,
    resourcesDir: 'codex-resources',
    pathDir: 'codex-path',
  };

  const resolvePackageJson = vi.fn(
    (packageName: string, _fromPackageJsonPath?: string): string => {
      if (packageName === '@openai/codex') return CODEX_PACKAGE_JSON;
      if (packageName === platformPackage) return platformPackageJson;
      throw new Error(`unexpected package: ${packageName}`);
    },
  );
  const readFileSync = vi.fn(() => options.manifestText ?? JSON.stringify(manifest));
  const statSync = vi.fn(
    options.statSync
      ?? ((filePath: string) => (
        filePath.endsWith('codex-path') ? stats('directory') : stats('file')
      )),
  );
  const accessSync = vi.fn(options.accessSync ?? (() => undefined));
  const packageResolver = { resolvePackageJson };
  const fileSystem = { readFileSync, statSync, accessSync };

  return {
    dependencies: {
      fs: fileSystem,
      process: { platform, arch, resourcesPath: options.resourcesPath ?? '/App/Resources' },
      packageResolver,
      isPackaged: options.isPackaged ?? false,
    },
    packageResolver,
    fileSystem,
    platformPackageJson,
  };
}

describe('resolveCodexExecutablePath', () => {
  it.each<{
    platform: NodeJS.Platform;
    arch: string;
    target: CodexExecutableTarget;
    platformPackage: string;
    entrypoint: string;
  }>([
    {
      platform: 'linux',
      arch: 'x64',
      target: 'x86_64-unknown-linux-musl',
      platformPackage: '@openai/codex-linux-x64',
      entrypoint: 'bin/codex',
    },
    {
      platform: 'linux',
      arch: 'arm64',
      target: 'aarch64-unknown-linux-musl',
      platformPackage: '@openai/codex-linux-arm64',
      entrypoint: 'bin/codex',
    },
    {
      platform: 'android',
      arch: 'x64',
      target: 'x86_64-unknown-linux-musl',
      platformPackage: '@openai/codex-linux-x64',
      entrypoint: 'bin/codex',
    },
    {
      platform: 'android',
      arch: 'arm64',
      target: 'aarch64-unknown-linux-musl',
      platformPackage: '@openai/codex-linux-arm64',
      entrypoint: 'bin/codex',
    },
    {
      platform: 'darwin',
      arch: 'x64',
      target: 'x86_64-apple-darwin',
      platformPackage: '@openai/codex-darwin-x64',
      entrypoint: 'bin/codex',
    },
    {
      platform: 'darwin',
      arch: 'arm64',
      target: 'aarch64-apple-darwin',
      platformPackage: '@openai/codex-darwin-arm64',
      entrypoint: 'bin/codex',
    },
    {
      platform: 'win32',
      arch: 'x64',
      target: 'x86_64-pc-windows-msvc',
      platformPackage: '@openai/codex-win32-x64',
      entrypoint: 'bin/codex.exe',
    },
    {
      platform: 'win32',
      arch: 'arm64',
      target: 'aarch64-pc-windows-msvc',
      platformPackage: '@openai/codex-win32-arm64',
      entrypoint: 'bin/codex.exe',
    },
  ])(
    'uses the Codex 0.143.0 native package for $platform/$arch',
    ({ platform, arch, target, platformPackage, entrypoint }) => {
      const harness = createHarness({ platform, arch, target, platformPackage, entrypoint });

      const result = resolveCodexExecutablePath(harness.dependencies);
      const targetRoot = path.join(
        path.dirname(harness.platformPackageJson),
        'vendor',
        target,
      );

      expect(harness.packageResolver.resolvePackageJson).toHaveBeenNthCalledWith(
        1,
        '@openai/codex',
      );
      expect(harness.packageResolver.resolvePackageJson).toHaveBeenNthCalledWith(
        2,
        platformPackage,
        CODEX_PACKAGE_JSON,
      );
      expect(result).toEqual({
        executablePath: path.join(targetRoot, entrypoint),
        pathDir: path.join(targetRoot, 'codex-path'),
        version: '0.143.0',
        target,
      });
    },
  );

  it('resolves packaged binaries only from app.asar.unpacked/node_modules', () => {
    const resourcesPath = '/Applications/Cyboflow.app/Contents/Resources';
    const harness = createHarness({ isPackaged: true, resourcesPath });

    const result = resolveCodexExecutablePath(harness.dependencies);
    const packageRoot = path.join(
      resourcesPath,
      'app.asar.unpacked',
      'node_modules',
      '@openai/codex-darwin-arm64',
    );
    const targetRoot = path.join(packageRoot, 'vendor', 'aarch64-apple-darwin');

    expect(harness.packageResolver.resolvePackageJson).not.toHaveBeenCalled();
    expect(harness.fileSystem.readFileSync).toHaveBeenCalledWith(
      path.join(targetRoot, 'codex-package.json'),
      'utf8',
    );
    expect(result.executablePath).toBe(path.join(targetRoot, 'bin/codex'));
    expect(result.pathDir).toBe(path.join(targetRoot, 'codex-path'));
  });

  it.each([
    ['malformed JSON', undefined, '{not-json', /malformed JSON/],
    ['layout version', { layoutVersion: 2 }, undefined, /layoutVersion must be 1/],
    ['package version', { version: '0.144.0' }, undefined, /version must be 0\.143\.0/],
    ['target', { target: 'x86_64-apple-darwin' }, undefined, /target must be aarch64-apple-darwin/],
    ['entrypoint', { entrypoint: '../codex' }, undefined, /entrypoint must be bin\/codex/],
    ['PATH directory', { pathDir: '../bin' }, undefined, /pathDir must be codex-path/],
  ])('rejects an invalid %s manifest', (_name, manifestPatch, manifestText, expected) => {
    const validManifest = {
      layoutVersion: 1,
      version: '0.143.0',
      target: 'aarch64-apple-darwin',
      entrypoint: 'bin/codex',
      pathDir: 'codex-path',
      ...(manifestPatch as Record<string, unknown> | undefined),
    };
    const harness = createHarness({ manifest: validManifest, manifestText });

    expect(() => resolveCodexExecutablePath(harness.dependencies)).toThrow(expected as RegExp);
  });

  it.each([
    ['freebsd', 'x64'],
    ['darwin', 'ia32'],
  ] as const)('rejects unsupported %s/%s without resolving a package', (platform, arch) => {
    const harness = createHarness({ platform, arch });

    expect(() => resolveCodexExecutablePath(harness.dependencies)).toThrow(
      `Unsupported Codex platform: ${platform} (${arch})`,
    );
    expect(harness.packageResolver.resolvePackageJson).not.toHaveBeenCalled();
  });

  it('rejects a missing executable', () => {
    const harness = createHarness({
      statSync: (filePath) => {
        if (filePath.includes(`${path.sep}bin${path.sep}`)) throw new Error('ENOENT');
        return stats('directory');
      },
    });

    expect(() => resolveCodexExecutablePath(harness.dependencies)).toThrow(
      /Codex executable is missing.*ENOENT/,
    );
  });

  it('rejects an entrypoint that is not a regular file', () => {
    const harness = createHarness({
      statSync: (filePath) => (
        filePath.endsWith('codex-path') ? stats('directory') : stats('directory')
      ),
    });

    expect(() => resolveCodexExecutablePath(harness.dependencies)).toThrow(
      /Codex executable is not a regular file/,
    );
  });

  it('rejects a non-executable entrypoint', () => {
    const harness = createHarness({
      accessSync: (filePath) => {
        if (filePath.includes(`${path.sep}bin${path.sep}`)) throw new Error('EACCES');
      },
    });

    expect(() => resolveCodexExecutablePath(harness.dependencies)).toThrow(
      /Codex executable is not executable.*EACCES/,
    );
  });

  it('rejects a missing or invalid PATH directory', () => {
    const harness = createHarness({
      statSync: (filePath) => {
        if (filePath.endsWith('codex-path')) throw new Error('ENOENT');
        return stats('file');
      },
    });

    expect(() => resolveCodexExecutablePath(harness.dependencies)).toThrow(
      /Codex PATH directory is missing.*ENOENT/,
    );
  });

  it('does not fall back to a command name when package resolution fails', () => {
    const harness = createHarness();
    harness.packageResolver.resolvePackageJson.mockImplementation(() => {
      throw new Error('package missing');
    });

    expect(() => resolveCodexExecutablePath(harness.dependencies)).toThrow(
      /Cannot resolve Codex native package.*package missing/,
    );
  });
});

describe('prependCodexPathToEnvironment', () => {
  it('prepends to PATH without mutating the input environment', () => {
    const environment = { PATH: '/usr/local/bin:/usr/bin', HOME: '/home/user' };

    const result = prependCodexPathToEnvironment(environment, '/codex/codex-path', 'linux');

    expect(result).toEqual({
      PATH: '/codex/codex-path:/usr/local/bin:/usr/bin',
      HOME: '/home/user',
    });
    expect(environment.PATH).toBe('/usr/local/bin:/usr/bin');
  });

  it('preserves the existing Windows Path key casing and delimiter', () => {
    const result = prependCodexPathToEnvironment(
      { Path: 'C:\\Windows\\System32', SYSTEMROOT: 'C:\\Windows' },
      'C:\\Codex\\codex-path',
      'win32',
    );

    expect(result.Path).toBe('C:\\Codex\\codex-path;C:\\Windows\\System32');
    expect(result).not.toHaveProperty('PATH');
  });

  it('creates PATH without a trailing delimiter when no PATH key exists', () => {
    expect(prependCodexPathToEnvironment({}, '/codex/codex-path', 'darwin')).toEqual({
      PATH: '/codex/codex-path',
    });
  });
});
