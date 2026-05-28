# FLAC to iPod — CLAUDE.md

> **This file is authoritative for the current Electron app.** Earlier versions of this file documented a Python/bash design that ran inside a Claude sandbox; that design has been entirely replaced. Don't reinstate `KNOWN_SAME` sets, `bindfs` workarounds, or the `sync_scan2.py` pattern — those are dead.

A Windows-native Electron desktop app that syncs a master music library (FLAC / MP3 / WAV / M4A) into an iPod-formatted folder of 320 kbps AAC `.m4a` files with iPod 5.5-compatible artwork. The target device is a Rockbox-flashed iPod 5.5G that the user hand-manages via Dropbox.

**Verified working on real hardware as of v0.1.4** — artwork displays on the iPod, audio plays back correctly, ReplayGain tags are read by Rockbox. Earlier versions had layered bugs (v0.1.1–v0.1.2: wrong JPEG chroma + missing JFIF marker → blank art; v0.1.1–v0.1.3: `ffmpeg-static` path inside `app.asar` → ENOENT on every conversion in packaged builds). All fixed.

---

## Tech stack

| | |
|---|---|
| Runtime | Electron 33 (Chromium + Node 20, CommonJS) |
| Audio transcode | `ffmpeg-static` (bundled binary, ~80 MB) |
| Audio probe | `ffprobe-static` |
| Image processing | `sharp` 0.33 (libvips/libjpeg-turbo) |
| Tag reading | `music-metadata` 11.x (ESM, loaded via `await import()`) |
| Tag writing | hand-rolled MP4 atom toolkit in `src/mp4-tags.js` |
| Packaging | `electron-builder` 26 — NSIS oneClick on Windows, arm64 DMG on macOS |

No frontend framework — vanilla HTML + CSS + JS in `renderer/`. No bundler.

---

## Repository layout

```
.github/workflows/release.yml    CI: builds Win NSIS + Mac DMG on tag push, drafts release
build/after-pack.js              electron-builder hook: ad-hoc codesigns macOS .app
main.js                          Electron main process — windowing + IPC handlers
preload.js                       contextBridge exposing window.api.{config,sync,replaygain,updater,...}
src/
  scanner.js                     Library scan + add/delete diff (tag-based)
  metadata.js                    music-metadata wrapper, tag cache, embedded-art extraction
  artwork.js                     Sharp pipeline → 600×600 JPEG with JFIF + 4:2:0 chroma
  converter.js                   ffmpeg transcode + metadata + artwork + freeform extras
  mp4-tags.js                    Pure-Node iTunes-freeform atom writer (writes ----:com.apple.iTunes:*)
  replaygain.js                  EBU R128 ebur128 measurement → REPLAYGAIN_TRACK_* freeform atoms
  updater.js                     GitHub releases poll + NSIS/DMG self-install
  normalize.js                   Filename canonicalisation (Unicode-aware) — fallback for missing tags
  bin-path.js                    Rewrites native-binary paths from app.asar → app.asar.unpacked at runtime
renderer/
  index.html                     Markup
  styles.css                     Pure-black design tokens lifted from robogearsDownloader
  renderer.js                    Renderer state machine, event handlers, IPC consumers
RELEASE_NOTES.md                 Replaced wholesale on each ship per `Z:\global .md\ship.md`
README.md                        User-facing summary
```

---

## Core data flows

### 1. Sync scan ([src/scanner.js](src/scanner.js))

**Matching is tag-based**, not filename-based. Each audio file contributes up to 4 keys to a match index:

1. `normalize(tags.title)` — primary
2. `normalize("${tags.artist} ${tags.title}")` — disambiguates same-title songs across artists
3. `normalize(filename)` — fallback when tags missing
4. `stripArtistPrefix(filename)` — handles "01 - Artist - Title.flac" → "title"

Music-side index and iPod-side index are built. A music file is a "true add" if **none** of its keys appears in the iPod index. A file is a "true delete" if the opposite. There is no `KNOWN_SAME` override list — the dual-key + tag-based matching does the work.

Tag reads are cached at `userData/metadata-cache.json`, keyed by absolute path + mtime. Cold scan over ~1,200 files: ~900 ms. Warm scan: ~50 ms.

### 2. Conversion ([src/converter.js](src/converter.js))

For each track the user adds:

1. **Read full source tags** via `music-metadata` (richer than the {title, artist} the scanner cached).
2. **Transcode**: `ffmpeg -vn -c:a aac -b:a 320k -map_metadata 0 -metadata <iTunes-recognised keys> -movflags +faststart`. **Sample rate is NOT forced** — the source rate passes through. Standard iTunes atoms (title, artist, album, track, disc, tmpo, composer, genre, copyright, comment, grouping) are written via `-metadata`.
3. **Get artwork**: `src/artwork.js` → `fetchArtwork()`. Prefers the source file's embedded picture (`music-metadata.common.picture[0].data`). Falls back to iTunes Search using `${artist} ${title}` as the query. Output is always 600×600 JPEG with JFIF APP0 + 4:2:0 chroma — see iPod constraints below.
4. **Embed**: `ffmpeg -i audio.m4a -i art.jpg -map 0:a -map 0:v? -map 1:v -c:a copy -c:v copy -disposition:v attached_pic -map_metadata 0`.
5. **Inject freeform extras**: `src/mp4-tags.js → setFreeformTags()` adds `----:com.apple.iTunes:ISRC`, `UPC`, `BARCODE`, `LABEL`, `CATALOGNUMBER`, MusicBrainz IDs, etc. — anything ffmpeg can't write natively.
6. **Copy to iPod**: `fs.copyFileSync` to `<ipodGenresRoot>/<genre>/<title>.m4a`. Filename derived from `tags.title` (sanitized for Windows), with `(2)`, `(3)` suffixes if a collision exists.

Source files are **read-only** throughout — never moved, never modified.

### 3. Auto ReplayGain ([src/replaygain.js](src/replaygain.js))

Triggered by the topbar button → modal chooser (Process new / Process all) → progress overlay.

Per-file, two passes:

1. **Measure**: `ffmpeg -af ebur128=peak=true -f null -` → parse the Summary block for `I:` (integrated LUFS) and `Peak:` (true peak dBFS). Compute `gain = -18 - LUFS` (ReplayGain 2.0 reference) and `peak = 10^(dBTP/20)`.
2. **Write**: `src/mp4-tags.js → setFreeformTags()` injects `REPLAYGAIN_TRACK_GAIN` and `REPLAYGAIN_TRACK_PEAK` atoms in-place. **No ffmpeg rewrite** — the atom toolkit handles `stco`/`co64` chunk-offset patching when moov grows. Album-level RG keys are cleared by writing them as empty strings.

History persisted at `userData/replaygain-history.json` keyed by absolute path. Each entry: `{ mtime, processedAt, gain, peak }`. Mode `'new'` filters to files whose entry's mtime ≠ current mtime (or that have no entry).

### 4. In-app updater ([src/updater.js](src/updater.js))

On `app.whenReady` + 1.5 s delay: fetch `GET api.github.com/repos/robogears/FLACtoiPod/releases/latest` (unauthenticated → requires the repo to be public). Numeric-segment version compare. If newer: send `update:available` IPC → renderer shows pulsing pill in the topbar.

Click pill → one-shot flow:
- **Windows**: download `flac-to-ipod-setup.exe`, `spawn(setup.exe, ['/S', '--updated'])` detached, `app.quit()`. NSIS handles the process-kill/replace/relaunch itself.
- **macOS**: download `.dmg`, `hdiutil attach` + `ditto` extract, write a bash script that double-forks via `nohup ... & disown` for SIGHUP immunity, waits for parent pid, strips quarantine, swaps the bundle in `/Applications/`, re-codesigns ad-hoc, `open`s the new app.

Settings modal has a manual "Check for updates" button mirroring the same flow.

---

## iPod 5.5 hardware decoder constraints

**Verified on real hardware in v0.1.4** — these all have to be true together for artwork to display. Empirically discovered across multiple ship cycles. If artwork breaks again, audit all five:

| Constraint | Where enforced |
|---|---|
| JPEG chroma must be 4:2:0 (`yuvj420p`) | `src/artwork.js` → `chromaSubsampling: '4:2:0'` |
| JFIF APP0 marker must be present (`FF E0 ... JFIF\0 ...`) | `src/artwork.js` → `ensureJfif()` splices it in (Sharp silently omits it) |
| Baseline JPEG only (no progressive/multi-scan) | `src/artwork.js` → `progressive: false` |
| Image stored in MP4 `covr` atom with `attached_pic` disposition | `src/converter.js` → `embedArtwork` ffmpeg invocation |
| Dimensions ≤ ~1024×1024 (we use 600×600) | `src/artwork.js` → `.resize(600, 600)` |

**Verification recipe** when a fix lands:

```js
const buf = fs.readFileSync(pathToM4a);
// extract JPEG via ffmpeg -c:v copy, then:
buf.slice(0, 11).toString('hex')  // should start ffd8ffe000104a464946 00
const info = ffprobeJson(pathToM4a);
info.streams.find(s => s.codec_type === 'video').pix_fmt  // should be 'yuvj420p'
```

But empirical-byte-checks alone aren't sufficient — see "Dev mode is not packaged mode" below. v0.1.1–v0.1.3 had correct bytes in dev tests but couldn't reach ffmpeg in packaged builds. Always test the final installed artifact end-to-end before declaring victory.

---

## ffmpeg quirks that bit us

These are pre-baked into the code. Do not "fix" them without re-verifying empirically.

1. **`-metadata KEY=VALUE` only writes a fixed whitelist of iTunes atoms.** Custom freeform keys are silently dropped. `-movflags +use_metadata_tags` writes the strings but as non-standard atom types, which Rockbox/foobar2000 don't recognise. → Use `src/mp4-tags.js` for any non-standard tag.
2. **MP4 muxer drops the `tmpo` (BPM) atom during the embed-artwork remux step**, even though it's written correctly by the transcode step. Known unfixed gap.
3. **ffmpeg's MJPEG encoder emits YUV** colour space, not RGB, even with quality 100. That's why we use Sharp for image processing and ffmpeg `-c:v copy` for the mux (preserving Sharp's output exactly).
4. **`-c:v copy` is essential** in the embed step. Re-encoding the JPEG via ffmpeg would re-introduce 4:4:4 chroma and strip the JFIF marker.
5. **Dev mode is not packaged mode (the v0.1.4 lesson).** `require('ffmpeg-static')` returns a path *inside* `app.asar` in a packaged build, but Node's `spawn()` syscall can't see into asar archives — even though `fs.existsSync()` returns true via Electron's fs patches. v0.1.1–v0.1.3 all shipped with this bug and were completely non-functional after install; only `npm start` testing hid it. Fix: **all spawns of native binaries go through `src/bin-path.js`** which does `.replace('app.asar', 'app.asar.unpacked')` at runtime. If you add a new `require('something-static')`, route it through `bin-path.js` and add it to `package.json#build.asarUnpack`.

---

## ReplayGain tag format

Rockbox / foobar2000 / MusicBee read MP4 ReplayGain from iTunes-freeform atoms at this exact path:

```
moov.udta.meta.ilst.----.{mean=com.apple.iTunes, name=REPLAYGAIN_TRACK_GAIN, data=<UTF-8>}
moov.udta.meta.ilst.----.{mean=com.apple.iTunes, name=REPLAYGAIN_TRACK_PEAK, data=<UTF-8>}
```

`src/mp4-tags.js` writes exactly this structure. The Apple-firmware iPod uses `iTunNORM` instead — out of scope; the target is Rockbox.

Gain value format: `"-6.10 dB"` / `"+1.50 dB"` (signed, 2 decimals, space + "dB"). Peak format: linear sample value as 6-decimal string, e.g. `"1.059254"`.

---

## State persistence (userData)

`app.getPath('userData')` resolves to:
- Windows: `%APPDATA%\flac-to-ipod\`
- macOS: `~/Library/Application Support/flac-to-ipod/`

Files we maintain:
| File | Purpose |
|---|---|
| `config.json` | `{ musicRoot, ipodGenresRoot }` — user-chosen paths |
| `metadata-cache.json` | Tag cache keyed by absolute path → `{ mtime, title, artist, album }` |
| `replaygain-history.json` | Per-file RG history → `{ mtime, processedAt, gain, peak }` |

None of these are bundled in the installer — they're created on first run, on the user's machine. All three are in `.gitignore` defensively.

---

## UI design tokens

Lifted from [robogearsDownloader](Z:\robogearsDownloader) — pure-black palette, white primary buttons (no colored accents), Inter / Segoe UI font, 11px uppercase labels with 1.2px letter-spacing, blur-backdrop modals, slim 8px scrollbars. See `renderer/styles.css` top section for the full token set.

---

## Build & release

**Cardinal rule** from [`Z:\global .md\ship.md`](Z:\global .md\ship.md): never ship proactively. Only act on explicit user authorization ("ship", "ship v0.X.Y", "release", "push it", or close paraphrase). For ordinary code changes: make the edit, syntax-check, stop.

### The exact ship sequence (from `Z:\global .md\ship.md`)

1. Bump patch version in `package.json`.
2. **Overwrite** `RELEASE_NOTES.md` entirely with the new release body. Strict 4-part format: `# What's new in vX.Y.Z` → sub-section bullets → `# Install` → `## Requirements` → `**Full Changelog**: https://github.com/robogears/FLACtoiPod/compare/vPREV...vCURR`.
3. Stage files explicitly (no `git add -A` — protects against `.env` leakage). Commit with multi-line message ending in `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
4. `git push origin main`. Then `git tag -a vX.Y.Z -m "vX.Y.Z"`. Then `git push origin vX.Y.Z` (this is what triggers CI).
5. `gh run watch <id> --exit-status` blocks until CI finishes.
6. **Verify body length** — `softprops/action-gh-release@v2` leaves the body empty on *every* release in this repo (guaranteed, not flake). Fix with `gh release edit vX.Y.Z --notes-file RELEASE_NOTES.md`, then re-check.
7. Release stays as a **draft** — user reviews and publishes manually.

### CI ([.github/workflows/release.yml](.github/workflows/release.yml))

Two parallel build jobs (Windows + macOS) → one release job that downloads both artifacts and creates the draft release via softprops.

Known non-fatal warnings: Node 20 deprecation notices on `actions/checkout@v4`, `actions/setup-node@v4`, etc. Can be bumped to `@v5` versions in a future patch.

---

## Anti-patterns — do not do

- **Don't try to write iTunes-freeform atoms with ffmpeg.** They're silently dropped. Use `src/mp4-tags.js`.
- **Don't reinstate 4:4:4 chroma** "for image quality". iPod 5.5 won't render it (verified v0.1.4).
- **Don't strip the JFIF APP0 marker** or use `progressive: true` in the JPEG config (verified v0.1.4).
- **Don't `require('some-static-binary')` directly and pass the result to `spawn()`.** In a packaged build the path resolves inside `app.asar` and ENOENTs. Route every native-binary path through `src/bin-path.js` and list the package in `package.json#build.asarUnpack`.
- **Don't reinstate `KNOWN_SAME` / `KNOWN_SAME_IPOD`** from the historical design. Tag-based matching makes them unnecessary, and they were a maintenance trap.
- **Don't add a `-ar 44100` flag to the transcode** — sample rate is now intentionally preserved from source.
- **Don't auto-bump versions, commit, push, or tag.** Only on explicit user "ship".
- **Don't include `node_modules/` in commits.** It's huge and already in `.gitignore`.

---

## Reference docs (cross-project)

- [`Z:\global .md\ship.md`](Z:\global .md\ship.md) — release process. Read before any ship action.
- [`Z:\global .md\updater.md`](Z:\global .md\updater.md) — Electron auto-updater architecture. This app implements it; consult when modifying `src/updater.js`.

---

## Known gaps (not yet fixed)

- **BPM / `tmpo` atom dropped during embedArtwork remux.** The transcode step writes it correctly; the subsequent ffmpeg mux of audio + artwork via `-c copy + -map_metadata 0` strips it. Need to investigate whether moving the artwork embed into the transcode step (single ffmpeg pass) fixes it, or whether to add BPM to the freeform-extras pipeline instead.
- **No "fix artwork on existing iPod tracks" feature.** When `src/artwork.js` is updated, only newly-converted tracks benefit. A topbar button that walks the iPod folder and re-processes each track's existing embedded JPEG through the corrected pipeline would close that gap.
- **Auto-updater requires public GitHub repo.** `/releases/latest` 404s unauthenticated on private repos. Either flip the repo to public when releases should propagate, or add token-based auth (which would need to be bundled in the app — security concern).

---

## Project-specific Claude memory

Saved to `~/.claude/projects/Z--FLACtoiPod/memory/`. Relevant entries:

- `project_sync_architecture.md` — why we use tag-based matching + tag-derived filenames (historical context)
- `project_mp4_freeform_atoms.md` — the ffmpeg-can't-write-freeform-atoms finding + pointer to `src/mp4-tags.js`
- `feedback_design_continuity.md` — pure-black palette + white primaries; lift design tokens from robogearsDownloader/MusicSorter
- `feedback_verify_before_implement.md` — empirically test external prompts; verify the full surface, not just one named variable
- `reference_global_md.md` — pointer to `Z:\global .md\`

These are loaded automatically into context at session start via `MEMORY.md`.
