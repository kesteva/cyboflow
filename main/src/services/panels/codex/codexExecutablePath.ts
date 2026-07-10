import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { app } from 'electron';

export const CODEX_EXECUTABLE_VERSION = '0.143.0' as const;

export type CodexExecutableTarget =
  | 'x86_64-unknown-linux-musl'
  | 'aarch64-unknown-linux-musl'
  | 'x86_64-apple-darwin'
  | 'aarch64-apple-darwin'
  | 'x86_64-pc-windows-msvc'
  | 'aarch64-pc-windows-msvc';

export interface ResolvedCodexExecutable {
  executablePath: string;
  pathDir: string;
  version: typeof CODEX_EXECUTABLE_VERSION;
  target: CodexExecutableTarget;
}

interface FileStatsLike {
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface CodexExecutableFileSystem {
  readFileSync(filePath: string, encoding: 'utf8'): string;
  statSync(filePath: string): FileStatsLike;
  accessSync(filePath: string, mode: number): void;
}

export interface CodexExecutableProcess {
  platform: NodeJS.Platform;
  arch: string;
  resourcesPath?: string;
}

export interface CodexPackageResolver {
  resolvePackageJson(packageName: string, fromPackageJsonPath?: string): string;
}

export interface CodexExecutableResolverDependencies {
  fs?: CodexExecutableFileSystem;
  process?: CodexExecutableProcess;
  packageResolver?: CodexPackageResolver;
  isPackaged?: boolean;
}

interface TargetDefinition {
  target: CodexExecutableTarget;
  platformPackage: string;
  entrypoint: string;
}

interface ValidatedManifest {
  entrypoint: string;
  pathDir: string;
}

const TARGET_BY_PLATFORM_ARCH: Readonly<Record<string, TargetDefinition>> = {
  'linux-x64': {
    target: 'x86_64-unknown-linux-musl',
    platformPackage: '@openai/codex-linux-x64',
    entrypoint: 'bin/codex',
  },
  'linux-arm64': {
    target: 'aarch64-unknown-linux-musl',
    platformPackage: '@openai/codex-linux-arm64',
    entrypoint: 'bin/codex',
  },
  'android-x64': {
    target: 'x86_64-unknown-linux-musl',
    platformPackage: '@openai/codex-linux-x64',
    entrypoint: 'bin/codex',
  },
  'android-arm64': {
    target: 'aarch64-unknown-linux-musl',
    platformPackage: '@openai/codex-linux-arm64',
    entrypoint: 'bin/codex',
  },
  'darwin-x64': {
    target: 'x86_64-apple-darwin',
    platformPackage: '@openai/codex-darwin-x64',
    entrypoint: 'bin/codex',
  },
  'darwin-arm64': {
    target: 'aarch64-apple-darwin',
    platformPackage: '@openai/codex-darwin-arm64',
    entrypoint: 'bin/codex',
  },
  'win32-x64': {
    target: 'x86_64-pc-windows-msvc',
    platformPackage: '@openai/codex-win32-x64',
    entrypoint: 'bin/codex.exe',
  },
  'win32-arm64': {
    target: 'aarch64-pc-windows-msvc',
    platformPackage: '@openai/codex-win32-arm64',
    entrypoint: 'bin/codex.exe',
  },
};

const DEFAULT_FILE_SYSTEM: CodexExecutableFileSystem = {
  readFileSync: (filePath, encoding) => fs.readFileSync(filePath, encoding),
  statSync: (filePath) => fs.statSync(filePath),
  accessSync: (filePath, mode) => fs.accessSync(filePath, mode),
};

const DEFAULT_PACKAGE_RESOLVER: CodexPackageResolver = {
  resolvePackageJson: (packageName, fromPackageJsonPath) => {
    const packageRequire = createRequire(fromPackageJsonPath ?? __filename);
    return packageRequire.resolve(`${packageName}/package.json`);
  },
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function targetFor(platform: NodeJS.Platform, arch: string): TargetDefinition {
  const definition = TARGET_BY_PLATFORM_ARCH[`${platform}-${arch}`];
  if (!definition) {
    throw new Error(`Unsupported Codex platform: ${platform} (${arch})`);
  }
  return definition;
}

function resolvePlatformPackageJson(
  definition: TargetDefinition,
  dependencies: Required<Pick<CodexExecutableResolverDependencies, 'isPackaged' | 'packageResolver'>> & {
    process: CodexExecutableProcess;
  },
): string {
  if (dependencies.isPackaged) {
    const resourcesPath = dependencies.process.resourcesPath;
    if (!resourcesPath) {
      throw new Error('Cannot resolve packaged Codex executable: process.resourcesPath is unavailable');
    }
    return path.join(
      resourcesPath,
      'app.asar.unpacked',
      'node_modules',
      definition.platformPackage,
      'package.json',
    );
  }

  try {
    const codexPackageJson = dependencies.packageResolver.resolvePackageJson('@openai/codex');
    return dependencies.packageResolver.resolvePackageJson(
      definition.platformPackage,
      codexPackageJson,
    );
  } catch (error) {
    throw new Error(
      `Cannot resolve Codex native package ${definition.platformPackage} through @openai/codex: ${errorMessage(error)}`,
    );
  }
}

function invalidManifest(manifestPath: string, detail: string): never {
  throw new Error(`Invalid Codex package manifest at ${manifestPath}: ${detail}`);
}

function readManifest(
  fileSystem: CodexExecutableFileSystem,
  manifestPath: string,
  definition: TargetDefinition,
): ValidatedManifest {
  let contents: string;
  try {
    contents = fileSystem.readFileSync(manifestPath, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read Codex package manifest at ${manifestPath}: ${errorMessage(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    return invalidManifest(manifestPath, `malformed JSON: ${errorMessage(error)}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return invalidManifest(manifestPath, 'expected a JSON object');
  }

  const manifest = parsed as Record<string, unknown>;
  if (manifest.layoutVersion !== 1) {
    return invalidManifest(manifestPath, 'layoutVersion must be 1');
  }
  if (manifest.version !== CODEX_EXECUTABLE_VERSION) {
    return invalidManifest(
      manifestPath,
      `version must be ${CODEX_EXECUTABLE_VERSION}`,
    );
  }
  if (manifest.target !== definition.target) {
    return invalidManifest(manifestPath, `target must be ${definition.target}`);
  }
  if (manifest.entrypoint !== definition.entrypoint) {
    return invalidManifest(manifestPath, `entrypoint must be ${definition.entrypoint}`);
  }
  if (manifest.pathDir !== 'codex-path') {
    return invalidManifest(manifestPath, 'pathDir must be codex-path');
  }

  return {
    entrypoint: definition.entrypoint,
    pathDir: 'codex-path',
  };
}

function requireExecutableFile(
  fileSystem: CodexExecutableFileSystem,
  executablePath: string,
): void {
  let stats: FileStatsLike;
  try {
    stats = fileSystem.statSync(executablePath);
  } catch (error) {
    throw new Error(`Codex executable is missing at ${executablePath}: ${errorMessage(error)}`);
  }
  if (!stats.isFile()) {
    throw new Error(`Codex executable is not a regular file: ${executablePath}`);
  }
  try {
    fileSystem.accessSync(executablePath, fs.constants.X_OK);
  } catch (error) {
    throw new Error(`Codex executable is not executable at ${executablePath}: ${errorMessage(error)}`);
  }
}

function requirePathDirectory(
  fileSystem: CodexExecutableFileSystem,
  pathDir: string,
): void {
  let stats: FileStatsLike;
  try {
    stats = fileSystem.statSync(pathDir);
  } catch (error) {
    throw new Error(`Codex PATH directory is missing at ${pathDir}: ${errorMessage(error)}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`Codex PATH directory is not a directory: ${pathDir}`);
  }
  try {
    fileSystem.accessSync(pathDir, fs.constants.X_OK);
  } catch (error) {
    throw new Error(`Codex PATH directory is not accessible at ${pathDir}: ${errorMessage(error)}`);
  }
}

export function resolveCodexExecutablePath(
  overrides: CodexExecutableResolverDependencies = {},
): ResolvedCodexExecutable {
  const processDependency = overrides.process ?? process;
  const packageResolver = overrides.packageResolver ?? DEFAULT_PACKAGE_RESOLVER;
  const fileSystem = overrides.fs ?? DEFAULT_FILE_SYSTEM;
  const isPackaged = overrides.isPackaged ?? app.isPackaged;
  const definition = targetFor(processDependency.platform, processDependency.arch);
  const packageJsonPath = resolvePlatformPackageJson(definition, {
    isPackaged,
    packageResolver,
    process: processDependency,
  });
  const targetRoot = path.join(path.dirname(packageJsonPath), 'vendor', definition.target);
  const manifestPath = path.join(targetRoot, 'codex-package.json');
  const manifest = readManifest(fileSystem, manifestPath, definition);
  const executablePath = path.join(targetRoot, manifest.entrypoint);
  const pathDir = path.join(targetRoot, manifest.pathDir);

  requireExecutableFile(fileSystem, executablePath);
  requirePathDirectory(fileSystem, pathDir);

  return {
    executablePath,
    pathDir,
    version: CODEX_EXECUTABLE_VERSION,
    target: definition.target,
  };
}

export function prependCodexPathToEnvironment(
  environment: NodeJS.ProcessEnv,
  pathDir: string,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  const existingPath = environment[pathKey];
  const delimiter = platform === 'win32' ? ';' : ':';

  return {
    ...environment,
    [pathKey]: existingPath ? `${pathDir}${delimiter}${existingPath}` : pathDir,
  };
}
