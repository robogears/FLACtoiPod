// Resolve paths to native binaries shipped via npm (ffmpeg-static, etc.) so
// `spawn()` can actually find them in a packaged Electron build.
//
// In a packaged build, `require('ffmpeg-static')` returns a path inside
// `app.asar`. Electron's fs patches let `require()` and `fs.existsSync()` see
// into the asar, but `spawn()` goes through the raw OS exec syscall and fails
// with ENOENT. The package.json#build.asarUnpack list extracts the real binary
// files to `app.asar.unpacked/` next to the asar; this helper rewrites the
// require()'d path to point there.
//
// In dev mode (`npm start`), the path doesn't contain 'app.asar' so the
// replacement is a no-op.

'use strict';

function unpacked(modulePath) {
  return modulePath ? modulePath.replace('app.asar', 'app.asar.unpacked') : modulePath;
}

module.exports = {
  unpacked,
  ffmpegPath: unpacked(require('ffmpeg-static')),
};
