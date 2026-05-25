# What's new in v0.1.4

**Critical bug fix.** v0.1.1, v0.1.2, and v0.1.3 were all non-functional after install — every conversion attempt failed with `spawn ...\app.asar\node_modules\ffmpeg-static\ffmpeg.exe ENOENT`. The bug was invisible during development because `npm start` runs without asar packaging.

## Fix
- `require('ffmpeg-static')` in a packaged Electron build returns a path inside `app.asar`. Even though `node_modules/ffmpeg-static/**/*` was correctly listed in `asarUnpack` (so the binary IS extracted to `app.asar.unpacked/`), Node's `spawn()` syscall can't see into asar archives. New `src/bin-path.js` rewrites the path string at runtime via `.replace('app.asar', 'app.asar.unpacked')`. No-op in dev; redirects to the real binary in packaged builds.
- All ffmpeg invocations in `src/converter.js` (transcode + artwork embed) and `src/replaygain.js` (ebur128 measurement) go through the shared resolver.

## What this means for prior versions
- Anyone on v0.1.1, v0.1.2, or v0.1.3 who installed the NSIS / DMG build has an app that couldn't run conversions at all.
- **v0.1.4 is the first build where conversions actually work in production.** Two layered fixes (v0.1.3's JFIF marker, v0.1.4's asar path) only become testable on real hardware starting here.
- Existing tracks on your iPod from earlier versions still have broken artwork — delete + re-sync them through the now-working app.

---

# Install

- **Windows**: download `flac-to-ipod-setup.exe`, double-click. NSIS installer drops the app at `%LOCALAPPDATA%\Programs\FLAC to iPod\`. SmartScreen may warn on first launch — "More info" → "Run anyway".
- **macOS (Apple Silicon)**: download `flac-to-ipod-mac-arm64.dmg`, mount, drag into `/Applications/`. First launch: right-click → Open to bypass Gatekeeper.

The in-app **Update** pill in the topbar will self-install future releases. Users on v0.1.1 still need a one-time manual install (that version has no updater code).

## Requirements

- Source library organized as `<root>/<Genre>/track.{flac,mp3,wav,m4a,aac}`.
- iPod-side destination with `.m4a` files; genre folders are created on demand.
- Internet only required for the iTunes Search artwork fallback. Files with embedded artwork work fully offline.
- For ReplayGain playback: a player that reads iTunes-freeform `----:com.apple.iTunes:REPLAYGAIN_*` atoms (Rockbox, foobar2000, MusicBee).

---

**Full Changelog**: https://github.com/robogears/FLACtoiPod/compare/v0.1.3...v0.1.4
