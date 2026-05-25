# What's new in v0.1.1

First public build. A native Electron app that mirrors a master music library into an iPod-formatted Genres folder, with metadata-aware matching and iPod 5.5-compatible artwork.

## Sync
- Tag-based scanning: matches by `title` and `artist + title` from embedded metadata, not just filename — so messy source names like `00 - jaŸ-z - ni__as in paris.flac` correctly match `Niggas In Paris.m4a` on the iPod.
- Filename fallback (normalize + strip-artist) for files with missing tags.
- Per-file tag cache keyed by `path + mtime` in userData — cold scan ≈900 ms over 1,200 files, warm scan ≈50 ms.
- Two-column UI with checkboxes, grouped by genre on the adds side. Per-genre master checkboxes with tri-state indeterminate. Bulk delete on the deletes side with confirmation modal previewing up to 5 entries.

## Conversion
- 320 kbps CBR AAC at 44.1 kHz via bundled `ffmpeg-static` — no system ffmpeg needed.
- **Embedded artwork preferred** — pulls the picture from the source file's tags first, falls back to iTunes Search only if none is embedded. Faster and more accurate than network lookup.
- Artwork resized to 600×600 RGB JPEG at 4:4:4 chroma via `sharp` (not ffmpeg — ffmpeg's MJPEG encoder emits YUV which iPod 5.5 renders blank).
- Output filename derived from `tags.title` (sanitized for Windows), never the source filename. Collision-safe via `(2)`, `(3)` suffixes — no silent overwrites.
- Real-time progress in the renderer: per-track status badges (`transcoding`, `artwork`, `embedding`, `copying`) and a scrolling activity log with arrow notation when source ≠ destination filename.

## UI
- Dark theme matching the robogears family — pure black palette, white primary buttons, Inter / Segoe UI stack, blur-backdrop modals.

---

# Install

- **Windows**: download `flac-to-ipod-setup.exe`, double-click. NSIS one-click installer drops the app at `%LOCALAPPDATA%\Programs\FLAC to iPod\` (per-user, no admin). Desktop + Start Menu shortcuts. SmartScreen may warn on first launch — click "More info" → "Run anyway".
- **macOS (Apple Silicon)**: download `flac-to-ipod-mac-arm64.dmg`, mount, drag the app into `/Applications/`. First launch needs right-click → Open to bypass Gatekeeper's unidentified-developer warning.

Configuration (paths to your Music and iPod Genres folders) is persisted at the standard Electron `userData` location (`%APPDATA%\FLAC to iPod\` on Windows, `~/Library/Application Support/FLAC to iPod/` on macOS).

## Requirements

- A source library organized as `<root>/<Genre>/track.flac` (or `.mp3`, `.wav`, `.m4a`, `.aac`).
- An iPod-side destination folder structured the same way, with `.m4a` files. Genre folders are created on demand.
- Internet only required for the iTunes Search artwork fallback. Files with embedded artwork (most FLAC/MP3 from a tagging tool) work fully offline.

---

**Full Changelog**: https://github.com/robogears/FLACtoiPod/commits/v0.1.1
