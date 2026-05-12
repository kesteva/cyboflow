/**
 * Post-sign cleanup hook for electron-builder.
 *
 * Responsibility: strips JAR files from @anthropic-ai/claude-code/vendor/ so
 * that unsigned native code inside JARs does not block macOS Gatekeeper.
 *
 * Notarization is delegated to electron-builder's built-in hook (controlled by
 * build.mac.notarize in package.json). This script does NOT invoke the
 * notarization toolchain directly.
 */

const path = require('path');
const fs = require('fs');

exports.default = async function(context) {
  const { appOutDir, packager } = context;

  if (packager.platform.name !== 'mac') {
    return;
  }

  // Check if we have signing certificates (useful for debugging dev builds)
  const hasSigningCredentials = process.env.CSC_LINK || process.env.CSC_KEY_PASSWORD;
  if (!hasSigningCredentials) {
    console.log('AfterSign: No signing credentials found');
  }

  console.log('AfterSign: notarization is handled by electron-builder built-in hook; this script only performs post-sign cleanup');
  console.log('AfterSign: Starting JAR cleanup process...');
  console.log('AfterSign: appOutDir =', appOutDir);
  console.log('AfterSign: productName =', packager.appInfo.productName);

  const appPath = path.join(appOutDir, `${packager.appInfo.productName}.app`);
  console.log('AfterSign: appPath =', appPath);

  // Try multiple possible paths for the claude-code module
  const possiblePaths = [
    path.join(appPath, 'Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-code'),
    path.join(appPath, 'Contents/Resources/app/node_modules/@anthropic-ai/claude-code'),
    path.join(appPath, 'Contents/Resources/node_modules/@anthropic-ai/claude-code')
  ];

  let claudeCodePath = null;
  for (const testPath of possiblePaths) {
    console.log('AfterSign: Checking path:', testPath);
    if (fs.existsSync(testPath)) {
      claudeCodePath = testPath;
      console.log('AfterSign: Found Claude Code at:', claudeCodePath);
      break;
    }
  }

  if (!claudeCodePath) {
    console.log('AfterSign: Claude Code path not found in any of the expected locations');
    return;
  }

  // Remove ALL JAR files from the vendor directory since they may contain unsigned native code
  const vendorPath = path.join(claudeCodePath, 'vendor');
  if (fs.existsSync(vendorPath)) {
    console.log('AfterSign: Removing all JAR files from vendor directory...');

    function removeJarsRecursively(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          removeJarsRecursively(fullPath);
        } else if (entry.name.endsWith('.jar')) {
          console.log('AfterSign: Removing JAR:', fullPath);
          fs.unlinkSync(fullPath);
        }
      }
    }

    removeJarsRecursively(vendorPath);
  }

  console.log('AfterSign: JAR cleanup complete');
};
