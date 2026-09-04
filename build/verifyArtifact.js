/**
 * artifactBuildCompleted hook for electron-builder — the distributable-level
 * size floor.
 *
 * build/afterSign.js verifies the .app, but it runs BEFORE the DMG and ZIP are
 * produced, so it cannot see them. The 215K-stub release shipped exactly there:
 * a plausible .app, a distributable that contained essentially nothing. This
 * hook fires once per produced artifact and fails the build when a `.dmg` or
 * `.zip` comes out below the floor.
 *
 * On Windows the same stub class applies to the NSIS installer, so `.exe`
 * artifacts are held to their own floor — lower than the mac one, because NSIS
 * compresses far harder than a DMG. build/afterSign.js also verifies the
 * win-unpacked layout on Windows; this hook is the only check that sees the
 * finished NSIS installer.
 *
 * `.dmg`/`.zip`/`.exe` are the only checked extensions. The other artifacts
 * electron-builder emits alongside them — `.blockmap`, `latest*.yml` — are
 * metadata that is legitimately tiny.
 *
 * A thrown error here fails the build: app-builder-lib's AsyncEventEmitter
 * awaits user hooks without a try/catch (out/util/asyncEventEmitter.js), so the
 * rejection propagates out of the packaging run.
 *
 * Escape hatch: CYBOFLOW_SKIP_BUNDLE_CHECKS=1 skips the check, loudly — the
 * same switch build/afterSign.js honors.
 */

const path = require('path');
const fs = require('fs');

/** Real per-arch DMGs are ~130-200 MB; a stub is three orders smaller. */
const DEFAULT_MIN_ARTIFACT_BYTES = 100 * 1024 * 1024;
/**
 * Windows floor: NSIS compresses Electron's ~250 MB runtime to a fraction, so
 * the bar sits lower than the mac floor yet still orders of magnitude above
 * any stub.
 */
const DEFAULT_MIN_WIN_ARTIFACT_BYTES = 50 * 1024 * 1024;

const SKIP_ENV_VAR = 'CYBOFLOW_SKIP_BUNDLE_CHECKS';

const VERIFIED_EXTENSIONS = ['.dmg', '.zip', '.exe'];

/** Is this produced artifact a distributable whose size we can hold to a floor? */
function shouldVerifyArtifact(file) {
  if (typeof file !== 'string' || file.length === 0) return false;
  return VERIFIED_EXTENSIONS.includes(path.extname(file).toLowerCase());
}

function formatBytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Check one artifact against the floor. Returns a failure message, or null when
 * the artifact is fine or is not the kind of file this hook judges.
 */
function verifyArtifactFile(file, minBytes = DEFAULT_MIN_ARTIFACT_BYTES) {
  if (!shouldVerifyArtifact(file)) return null;

  if (!fs.existsSync(file)) {
    return `the produced artifact does not exist on disk: ${file}`;
  }

  const bytes = fs.statSync(file).size;
  if (bytes < minBytes) {
    return (
      `${path.basename(file)} is only ${formatBytes(bytes)} (floor is ` +
      `${formatBytes(minBytes)}) — that is a stub, not a shippable ` +
      `distributable: ${file}`
    );
  }
  return null;
}

exports.default = async function(context) {
  const { file, packager } = context;

  const platformName = packager && packager.platform && packager.platform.name;
  const isMac = platformName === 'mac';
  // electron-builder's Platform.WINDOWS.name is 'windows'; 'win' is its
  // buildConfigurationKey. Accept both, as afterSign does.
  const isWin = platformName === 'windows' || platformName === 'win';
  if (!isMac && !isWin) {
    return;
  }

  if (!shouldVerifyArtifact(file)) {
    return;
  }

  if (process.env[SKIP_ENV_VAR] === '1') {
    console.warn('ArtifactBuildCompleted: ============================================================');
    console.warn(`ArtifactBuildCompleted: ${SKIP_ENV_VAR}=1 — SKIPPING the size floor for ${file}.`);
    console.warn('ArtifactBuildCompleted: Do not ship an artifact produced with this set.');
    console.warn('ArtifactBuildCompleted: ============================================================');
    return;
  }

  const failure = verifyArtifactFile(file, isWin ? DEFAULT_MIN_WIN_ARTIFACT_BYTES : DEFAULT_MIN_ARTIFACT_BYTES);
  if (failure) {
    throw new Error(`ArtifactBuildCompleted: ${failure}`);
  }

  console.log(
    `ArtifactBuildCompleted: ${path.basename(file)} passed the size floor ` +
      `(${formatBytes(fs.statSync(file).size)})`
  );
};

exports._helpers = {
  DEFAULT_MIN_ARTIFACT_BYTES,
  DEFAULT_MIN_WIN_ARTIFACT_BYTES,
  SKIP_ENV_VAR,
  VERIFIED_EXTENSIONS,
  shouldVerifyArtifact,
  verifyArtifactFile,
};
