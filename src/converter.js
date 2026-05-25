const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { fetchArtwork } = require('./artwork');
const { setFreeformTags } = require('./mp4-tags');

const WORK_DIR = path.join(os.tmpdir(), 'flac-to-ipod');

// music-metadata is ESM-only; lazy-import so this module stays CJS.
let _mmPromise = null;
async function getMM() {
  if (!_mmPromise) _mmPromise = import('music-metadata');
  return _mmPromise;
}

function ensureWorkDir() {
  fs.mkdirSync(WORK_DIR, { recursive: true });
}

// Strip Windows-illegal chars but keep parens, apostrophes, commas, accents —
// these are common in music titles (e.g. "Hey Baby (Drop It to the Floor)").
function sanitizeForWindows(s) {
  return String(s)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

// Internal-only safe name for /tmp working files (used in ffmpeg paths).
function safeWorkName(filename) {
  const base = path.parse(filename).name;
  return base.replace(/[<>:"/\\|?*]+/g, '_').slice(0, 100).trim() || 'track';
}

// Final iPod filename: always derived from tag title when available,
// falls back to the source basename. Always `.m4a`.
function ipodFilename(srcFilename, tags) {
  let base = '';
  if (tags && tags.title) base = sanitizeForWindows(tags.title);
  if (!base) base = sanitizeForWindows(path.parse(srcFilename).name);
  if (!base) base = 'track';
  return `${base}.m4a`;
}

// If the chosen destination already exists, append " (2)", " (3)", … so we
// never silently overwrite a pre-existing iPod track.
function uniqueDest(destDir, baseName) {
  let candidate = path.join(destDir, baseName);
  if (!fs.existsSync(candidate)) return candidate;
  const parsed = path.parse(baseName);
  let i = 2;
  while (true) {
    candidate = path.join(destDir, `${parsed.name} (${i})${parsed.ext}`);
    if (!fs.existsSync(candidate)) return candidate;
    i++;
  }
}

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve({ stderr });
      else reject(new Error(`ffmpeg exited ${code}\n${stderr.slice(-1500)}`));
    });
  });
}

// ─── Metadata pass-through ────────────────────────────────────────────────
//
// FLAC Vorbis comments and M4A iTunes atoms don't share key names, and
// ffmpeg's mov muxer only auto-maps a subset (title, artist, album,
// album_artist, date, copyright). Everything else — track number, disc
// number, BPM, composer, genre, comment, custom IDs — gets dropped on
// transcode unless we pass it explicitly.
//
// Strategy:
//   1. Read full common tags from the source via music-metadata.
//   2. For tags ffmpeg's MP4 muxer recognises, pass via -metadata so it
//      writes the canonical iTunes atom (©nam, trkn, disk, tmpo, …).
//   3. For non-standard tags (ISRC, UPC, BARCODE, anything else worth
//      keeping), inject `----:com.apple.iTunes:KEY` freeform atoms with
//      src/mp4-tags.js after transcode.

async function readFullSourceTags(srcPath) {
  try {
    const { parseFile } = await getMM();
    const meta = await parseFile(srcPath, { duration: false, skipCovers: true });
    return { common: meta.common || {}, native: meta.native || {} };
  } catch {
    return { common: {}, native: {} };
  }
}

// Build ffmpeg -metadata args for the iTunes atoms ffmpeg's MP4 muxer knows
// how to emit. Music-metadata's `common` already normalises across Vorbis /
// ID3 / iTunes source formats, which is what makes this clean.
function buildMetadataArgs(common) {
  const args = [];
  const add = (k, v) => {
    if (v === null || v === undefined || v === '') return;
    args.push('-metadata', `${k}=${v}`);
  };
  add('title', common.title);
  add('artist', common.artist);
  add('album_artist', common.albumartist);
  add('album', common.album);
  add('date', common.year || common.date);
  add('comment', joinList(common.comment));
  add('genre', joinList(common.genre));
  add('composer', joinList(common.composer));
  add('copyright', common.copyright);
  add('grouping', common.grouping);
  add('description', common.description);
  if (common.track && common.track.no != null) {
    add('track', common.track.of ? `${common.track.no}/${common.track.of}` : `${common.track.no}`);
  }
  if (common.disk && common.disk.no != null) {
    add('disc', common.disk.of ? `${common.disk.no}/${common.disk.of}` : `${common.disk.no}`);
  }
  if (common.bpm) add('tmpo', String(Math.round(common.bpm)));
  if (common.compilation) add('compilation', '1');
  return args;
}

function joinList(v) {
  if (Array.isArray(v)) return v.filter(Boolean).join('; ');
  return v;
}

// Freeform atoms for fields with no native iTunes equivalent. Always written
// after transcode via the mp4-tags injector (ffmpeg's MP4 muxer drops freeform
// keys silently — see project memory).
function freeformExtras(common) {
  const out = {};
  const list = (v) => Array.isArray(v) ? v.filter(Boolean).join('; ') : v;
  if (common.isrc && common.isrc.length) out.ISRC = list(common.isrc);
  if (common.barcode) out.BARCODE = String(common.barcode);
  if (common.catalognumber && common.catalognumber.length) out.CATALOGNUMBER = list(common.catalognumber);
  if (common.label && common.label.length) out.LABEL = list(common.label);
  if (common.releasecountry) out.RELEASECOUNTRY = common.releasecountry;
  if (common.media) out.MEDIA = common.media;
  if (common.originaldate) out.ORIGINALDATE = common.originaldate;
  if (common.originalyear) out.ORIGINALYEAR = String(common.originalyear);
  if (common.musicbrainz_trackid) out.MUSICBRAINZ_TRACKID = common.musicbrainz_trackid;
  if (common.musicbrainz_albumid) out.MUSICBRAINZ_ALBUMID = common.musicbrainz_albumid;
  if (common.musicbrainz_artistid && common.musicbrainz_artistid.length) {
    out.MUSICBRAINZ_ARTISTID = list(common.musicbrainz_artistid);
  }
  return out;
}

// ─── Step 1: transcode ────────────────────────────────────────────────────
// Strip existing artwork (-vn), encode to 320 kbps AAC, preserve the source
// sample rate (no `-ar` flag), write the standard-iTunes-atom metadata.
async function transcodeAudio(srcPath, outPath, common) {
  const metaArgs = buildMetadataArgs(common || {});
  await runFFmpeg([
    '-y',
    '-i', srcPath,
    '-vn',
    '-c:a', 'aac',
    '-b:a', '320k',
    '-map_metadata', '0',     // explicit: copy global metadata from input 0
    ...metaArgs,
    '-movflags', '+faststart',
    outPath,
  ]);
  return outPath;
}

// ─── Step 3: embed artwork ────────────────────────────────────────────────
async function embedArtwork(audioPath, artPath, outPath) {
  await runFFmpeg([
    '-y',
    '-i', audioPath,
    '-i', artPath,
    '-map', '0:a',
    '-map', '1:v',
    '-c:a', 'copy',
    '-c:v', 'copy',
    '-map_metadata', '0',
    '-disposition:v', 'attached_pic',
    '-movflags', '+faststart',
    outPath,
  ]);
  return outPath;
}

async function muxNoArt(audioPath, outPath) {
  fs.copyFileSync(audioPath, outPath);
  return outPath;
}

// Convert one track and copy it to the iPod destination.
async function convertOne({ srcPath, srcFilename, srcTags, destGenreDir, onProgress }) {
  ensureWorkDir();
  const safe = safeWorkName(srcFilename);
  const noArtPath = path.join(WORK_DIR, `noart_${safe}.m4a`);
  const finalPath = path.join(WORK_DIR, `final_${safe}.m4a`);

  // Pull rich tags from source — scanner only has {title, artist, album}.
  const full = await readFullSourceTags(srcPath);
  // Merge what scanner sent (canonical for matching) with the full set.
  const common = { ...full.common, ...(srcTags || {}) };

  onProgress?.({ step: 'transcode' });
  await transcodeAudio(srcPath, noArtPath, common);

  onProgress?.({ step: 'artwork' });
  const art = await fetchArtwork(srcPath, srcFilename, srcTags, WORK_DIR);

  if (art && art.path) {
    onProgress?.({ step: 'embed', artworkFrom: art.source });
    await embedArtwork(noArtPath, art.path, finalPath);
  } else {
    onProgress?.({ step: 'embed', artworkWarning: art?.error || 'no artwork' });
    await muxNoArt(noArtPath, finalPath);
  }

  // Inject any non-standard tags ffmpeg can't write (ISRC, UPC, MusicBrainz IDs).
  const extras = freeformExtras(common);
  if (Object.keys(extras).length) {
    try { setFreeformTags(finalPath, extras); } catch {}
  }

  onProgress?.({ step: 'copy' });
  fs.mkdirSync(destGenreDir, { recursive: true });
  const wantedName = ipodFilename(srcFilename, srcTags);
  const destPath = uniqueDest(destGenreDir, wantedName);
  fs.copyFileSync(finalPath, destPath);

  try { fs.unlinkSync(noArtPath); } catch {}
  try { fs.unlinkSync(finalPath); } catch {}

  return {
    destPath,
    destName: path.basename(destPath),
    artwork: art && art.path ? { source: art.source } : { warning: art?.error || 'no artwork' },
  };
}

module.exports = { convertOne, WORK_DIR, ipodFilename, sanitizeForWindows };
