// electron-builder afterPack hook: ad-hoc sign the macOS .app so Apple Silicon
// Gatekeeper doesn't show "damaged and can't be opened". Without ANY signature
// (even ad-hoc), arm64 macOS refuses to run the binary. With an ad-hoc signature
// the user gets the standard "unidentified developer" warning, which they can
// bypass via right-click → Open.
//
// Runs on the macOS runner only (codesign is macOS-native).
'use strict';

const path = require('path');
const { execSync } = require('child_process');

exports.default = async function afterPack(context) {
    if (context.electronPlatformName !== 'darwin') return;

    const appName = context.packager.appInfo.productFilename + '.app';
    const appPath = path.join(context.appOutDir, appName);

    console.log(`[afterPack] Ad-hoc signing ${appPath}`);
    execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' });
    console.log(`[afterPack] Done.`);
};
