# What's new in v0.1.3

A focused patch for the lingering blank-artwork bug. v0.1.2's chroma fix landed correctly (`yuvj420p`) but artwork was still showing blank on iPod 5.5 because Sharp / libjpeg-turbo silently omits the **JFIF APP0 marker** — the `FF E0 ... JFIF\0` identifier that iPod's hardware JPEG decoder uses to recognise the bitstream. Without it, the decoder bails even when chroma, dimensions, and atom placement are correct.

## Fix
- `toIpodJpeg` now injects a canonical 18-byte JFIF APP0 marker (`FF E0 00 10 "JFIF\0" 01 02 00 00 01 00 01 00 00`) immediately after Sharp's SOI byte. Output JPEG headers now begin `FF D8 FF E0 00 10 4A 46 49 46 ...` — exactly what the hardware decoder expects.
- Explicit `progressive: false` added to the Sharp JPEG config (belt-and-suspenders: hardware decoders only handle baseline JPEG anyway, but make the intent explicit).
- Empirically verified end-to-end: real FLAC → convertOne → extract embedded JPEG → JFIF marker present, `pix_fmt: yuvj420p`, ffmpeg's `-c:v copy` mux passes the bytes through unchanged.

## What this means for existing tracks
- The fix only applies to **newly converted** tracks.
- Tracks already on your iPod from v0.1.1 or v0.1.2 still have broken artwork (no JFIF marker and/or wrong chroma). To fix them: delete + re-sync them through the app.
- A one-click "fix artwork on existing iPod tracks" feature could be added in a future release — open an issue if you'd find it useful.

---

# Install

- **Windows**: download `flac-to-ipod-setup.exe`, double-click. NSIS installer drops the app at `%LOCALAPPDATA%\Programs\FLAC to iPod\`. SmartScreen may warn on first launch — "More info" → "Run anyway".
- **macOS (Apple Silicon)**: download `flac-to-ipod-mac-arm64.dmg`, mount, drag into `/Applications/`. First launch: right-click → Open to bypass Gatekeeper.

If you're on v0.1.2, the in-app **Update** pill in the topbar will detect this release and self-install with one click. Users on v0.1.1 still need a one-time manual install (that version has no updater code).

## Requirements

- Source library organized as `<root>/<Genre>/track.{flac,mp3,wav,m4a,aac}`.
- iPod-side destination with `.m4a` files; genre folders are created on demand.
- Internet only required for the iTunes Search artwork fallback. Files with embedded artwork work fully offline.
- For ReplayGain playback: a player that reads iTunes-freeform `----:com.apple.iTunes:REPLAYGAIN_*` atoms (Rockbox, foobar2000, MusicBee).

---

**Full Changelog**: https://github.com/robogears/FLACtoiPod/compare/v0.1.2...v0.1.3
