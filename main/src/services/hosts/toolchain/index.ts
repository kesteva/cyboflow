/** Toolchain module (spec A5): resolve local sources per arch, hash them into a manifest, push it to a host. */
export * from './types';
export {
  externalRequires,
  isSelfContainedMcpBundle,
  resolveToolchainSources,
  type ResolvedCodexSource,
  type ResolvedToolchainSources,
  type ToolchainResolverDeps,
} from './toolchainResolver';
export {
  buildToolchainManifest,
  computeToolchainHash,
  defaultToolchainHasher,
  InvalidToolchainFileError,
  listToolchainSources,
  serializeToolchainManifest,
  ToolchainHasher,
  type BuildToolchainManifestOptions,
  type BuiltToolchain,
  type ToolchainHashFs,
} from './toolchainHash';
export {
  InvalidToolchainRootError,
  pushToolchain,
  remoteToolchainPaths,
  ToolchainPushError,
  type PushToolchainInput,
  type PushToolchainResult,
  type RemoteToolchainPaths,
  type ToolchainPushStep,
} from './toolchainPusher';
