# What's new in v0.1.5

A small polish release on top of the verified-working v0.1.4 build. Brings a dedicated app icon and a proper in-repo design doc.

## App icon
- Custom logo replaces the generic Electron atom across the installer, Start Menu shortcut, desktop shortcut, taskbar, alt-tab thumbnail (Windows) and Finder / Dock / app-switcher (macOS).
- iPod 5G silhouette with click wheel; audio waveform shown inside the screen. Pure monochrome — matches the in-app design system and the broader `robogears` family aesthetic.
- Source SVG lives at [`build/icon.svg`](build/icon.svg) as the single source of truth; PNG is rendered from it via `sharp`. electron-builder auto-generates `.ico` (Windows) and `.icns` (macOS) at build time.
- Topbar mark in the app updated to a simplified 24×24 variant of the same logo (waveform detail dropped at small sizes).

## Project docs
- [`CLAUDE.md`](CLAUDE.md) added to the repo — authoritative architecture + conventions doc for any future contributor (human or AI). Covers tech stack, repo layout, data flows, the iPod 5.5 hardware-decoder constraints, ffmpeg quirks (including the asar/spawn `bin-path.js` pattern), state persistence, anti-patterns, and known gaps.

---

# Install

- **Windows**: download `flac-to-ipod-setup.exe`, double-click. NSIS installer drops the app at `%LOCALAPPDATA%\Programs\FLAC to iPod\`. SmartScreen may warn on first launch — "More info" → "Run anyway".
- **macOS (Apple Silicon)**: download `flac-to-ipod-mac-arm64.dmg`, mount, drag into `/Applications/`. First launch: right-click → Open to bypass Gatekeeper.

The in-app **Update** pill in the topbar will self-install this release on next launch from any v0.1.2+ build.

## Requirements

- Source library organized as `<root>/<Genre>/track.{flac,mp3,wav,m4a,aac}`.
- iPod-side destination with `.m4a` files; genre folders are created on demand.
- Internet only required for the iTunes Search artwork fallback. Files with embedded artwork work fully offline.
- For ReplayGain playback: a player that reads iTunes-freeform `----:com.apple.iTunes:REPLAYGAIN_*` atoms (Rockbox, foobar2000, MusicBee).

---

**Full Changelog**: https://github.com/robogears/FLACtoiPod/compare/v0.1.4...v0.1.5
