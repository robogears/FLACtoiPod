const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { fetchArtwork } = require('./artwork');

const WORK_DIR = path.join(os.tmpdir(), 'flac-to-ipod');

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

// Step 1 — strip existing artwork, transcode to 320kbps AAC at 44.1kHz.
async function transcodeAudio(srcPath, outPath) {
  await runFFmpeg([
    '-y',
    '-i', srcPath,
    '-vn',
    '-c:a', 'aac',
    '-b:a', '320k',
    '-ar', '44100',
    '-movflags', '+faststart',
    outPath,
  ]);
  return outPath;
}

// Step 3 — pass-through mux of pre-encoded audio + pre-encoded RGB JPEG.
async function embedArtwork(audioPath, artPath, outPath) {
  await runFFmpeg([
    '-y',
    '-i', audioPath,
    '-i', artPath,
    '-map', '0:a',
    '-map', '1:v',
    '-c:a', 'copy',
    '-c:v', 'copy',
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

  onProgress?.({ step: 'transcode' });
  await transcodeAudio(srcPath, noArtPath);

  onProgress?.({ step: 'artwork' });
  const art = await fetchArtwork(srcPath, srcFilename, srcTags, WORK_DIR);

  if (art && art.path) {
    onProgress?.({ step: 'embed', artworkFrom: art.source });
    await embedArtwork(noArtPath, art.path, finalPath);
  } else {
    onProgress?.({ step: 'embed', artworkWarning: art?.error || 'no artwork' });
    await muxNoArt(noArtPath, finalPath);
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
