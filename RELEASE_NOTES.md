# What's new in v0.1.2

A big follow-up to the initial release: fixed the blank-artwork bug on iPod 5.5, added an in-app updater, added a one-click Auto ReplayGain feature, and tightened up metadata pass-through so converted tracks carry more of their original tags.

## iPod artwork fix
- **Cover art now displays on iPod 5.5.** v0.1.1 was emitting JPEGs at 4:4:4 chroma subsampling (`yuvj444p`), which the iPod's hardware decoder silently rejects — the symptom was blank album art on every track. The pipeline now produces 4:2:0 (`yuvj420p`), verified via `ffprobe`. Tracks already on your iPod from v0.1.1 still have broken artwork; delete + re-sync them through the app to fix.

## Auto ReplayGain
- New **Auto ReplayGain** button in the topbar. Analyzes every iPod track with `ffmpeg`'s `ebur128` filter and writes ReplayGain 2.0 tags (`REPLAYGAIN_TRACK_GAIN`, `REPLAYGAIN_TRACK_PEAK`) as iTunes-style freeform atoms — readable by Rockbox, foobar2000, MusicBee.
- Pre-flight modal asks **Process new** (only tracks the app hasn't tagged yet) or **Process all**, with live counts.
- Per-track history at `userData/replaygain-history.json` keyed by path + mtime, so re-converted tracks auto-flag as needing re-tagging.
- Full-screen progress overlay with live readouts and Cancel.
- Written via a small pure-Node MP4 atom toolkit in `src/mp4-tags.js`. ffmpeg's MP4 muxer silently drops freeform iTunes atoms even with `-movflags +use_metadata_tags`, so the toolkit walks the box tree itself, appends `----:com.apple.iTunes:KEY` atoms, and patches `stco` / `co64` chunk offsets so audio still plays.

## In-app updater
- App checks GitHub on launch for newer releases (1.5 s delay so it doesn't block boot). When one's found, a pulsing **Update** pill appears in the topbar; one click downloads + auto-installs + relaunches.
- Settings → **Check for updates** button for manual checks with live status feedback.
- Windows: NSIS silent self-install (`/S --updated`). macOS: streamed DMG download → `hdiutil` mount → `ditto` extract → double-fork bash relauncher with quarantine strip + ad-hoc re-codesign + App Translocation detection.
- *Requires the GitHub repo to be public* — uses unauthenticated `/releases/latest`, which 404s on private repos.

## Better metadata pass-through
- **Source sample rate preserved.** Was hard-coded to 44.1 kHz, now passes through whatever the source has (44.1 / 48 / 96 / 192 kHz).
- **Embedded artwork is preferred.** Pulls the picture from the source file's embedded tags first via `music-metadata`; iTunes Search now only fires when the source has no embedded art. Faster, more accurate, works offline for tagged libraries.
- More tags now travel from FLAC → M4A: track number, disc number, BPM, composer, genre, comment, copyright, grouping — written via `-metadata` with the iTunes atom mapping ffmpeg knows about.
- Non-standard fields land via freeform atoms: ISRC, UPC / BARCODE, label, catalog number, MusicBrainz IDs, release country, media type, original release date.

## UI improvements
- **Per-genre master checkboxes** in the Adds column — three-state (all / none / indeterminate). One click sweeps an entire genre on or off.
- **Bulk delete** on the Deletes column: checkboxes, "Select all" / "None", confirmation modal that previews up to 5 entries.
- Column footers align cleanly so the Add/Delete buttons no longer get clipped by the statusbar.
- Track rows show real title (from tags) + muted artist line — matches the `robogears-downloader` queue-item style.
- New track filename rule: output `.m4a` is named from `tags.title`, sanitized for Windows, with collision-safe `(2)`, `(3)` suffixes (no silent overwrites).

---

# Install

- **Windows**: download `flac-to-ipod-setup.exe`, double-click. NSIS one-click installer drops the app at `%LOCALAPPDATA%\Programs\FLAC to iPod\` (per-user, no admin). Desktop + Start Menu shortcuts.
- **macOS (Apple Silicon)**: download `flac-to-ipod-mac-arm64.dmg`, mount, drag into `/Applications/`. First launch: right-click → Open to bypass Gatekeeper's unidentified-developer warning.

**One-time manual install for v0.1.1 users.** v0.1.1 has no auto-updater code, so it can't auto-detect this release. Download the installer above and install over your existing copy. From v0.1.2 onward, updates auto-apply via the in-app pill.

User config (paths, scan cache, ReplayGain history) lives at `%APPDATA%\flac-to-ipod\` on Windows and `~/Library/Application Support/flac-to-ipod/` on macOS — never bundled or shipped.

## Requirements

- Source library organized as `<root>/<Genre>/track.{flac,mp3,wav,m4a,aac}`.
- iPod-side destination with `.m4a` files; genre folders are created on demand.
- Internet only required for the iTunes Search artwork fallback. Files with embedded artwork (most FLAC/MP3 from a tagging tool) work fully offline.
- For ReplayGain playback: a player that reads iTunes freeform `----:com.apple.iTunes:REPLAYGAIN_*` atoms (Rockbox, foobar2000, MusicBee). Apple's stock iPod firmware reads `iTunNORM` instead — out of scope here.

---

**Full Changelog**: https://github.com/robogears/FLACtoiPod/compare/v0.1.1...v0.1.2
