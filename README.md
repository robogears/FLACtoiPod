# FLAC to iPod

Desktop sync tool that mirrors a master music library (FLAC / MP3 / WAV / M4A) into an iPod-formatted Genres folder of 320 kbps AAC `.m4a` files with iPod 5.5-compatible artwork.

## How it works

- **Tag-based matching.** Scans both libraries by embedded metadata (`title`, `artist`) — not just filename — so messy source names like `00 - jaŸ-z - ni__as in paris.flac` correctly match the corresponding `Niggas In Paris.m4a` on the iPod. Filename heuristics are a fallback.
- **Embedded artwork preferred.** Pulls album art from the source file's tags via [`music-metadata`](https://github.com/Borewit/music-metadata). Falls back to iTunes Search API only if the source has no embedded picture. Resized to 600×600 JPEG at 4:2:0 chroma via [`sharp`](https://sharp.pixelplumbing.com/) — the iPod 5.5 hardware JPEG decoder only accepts 4:2:0; higher subsampling rates render as blank artwork.
- **Title-based output names.** Converted files are named from `tags.title`, sanitized for Windows. Collision-safe (`(2)`, `(3)` suffixes).
- **Read-only on the source.** Original library is never modified; only the destination receives new `.m4a` files.

## UI

Two-column layout — Adds on the left (grouped by genre, per-genre master checkboxes), Deletes on the right (flat, with bulk-delete confirmation). Live progress per track with status badges and a scrolling activity log.

## Build

```bash
npm install
npm start            # dev launch
npm run build:win    # NSIS installer
npm run build:mac    # arm64 DMG
```

Bundled binaries via `ffmpeg-static` — no system ffmpeg required.

## License

MIT
