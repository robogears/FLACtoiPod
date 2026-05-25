const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { extractEmbeddedArtwork } = require('./metadata');

// Canonical JFIF APP0 marker, 18 bytes total. Required by the iPod 5.5
// hardware JPEG decoder to recognise a bitstream as JPEG — without it the
// decoder silently shows blank artwork even if everything else is correct.
// Sharp / libjpeg-turbo don't emit this marker by default (and `withMetadata`
// emits an APP1 Exif instead), so we splice it in by hand right after SOI.
//
//   FF E0          APP0 marker
//   00 10          segment length = 16
//   4A 46 49 46 00 "JFIF" + NUL terminator
//   01 02          version 1.02
//   00             units = 0 (no absolute units)
//   00 01 00 01    Xdensity=1, Ydensity=1
//   00 00          no embedded thumbnail
const JFIF_APP0 = Buffer.from([
  0xFF, 0xE0,
  0x00, 0x10,
  0x4A, 0x46, 0x49, 0x46, 0x00,
  0x01, 0x02,
  0x00,
  0x00, 0x01,
  0x00, 0x01,
  0x00, 0x00,
]);

// "JFIF" + NUL — the identifier at bytes 6-10 of a JFIF APP0 segment. Held
// as a byte array so the source file has no embedded NUL byte (which would
// trip git's binary-file heuristic).
const JFIF_IDENT = Buffer.from([0x4A, 0x46, 0x49, 0x46, 0x00]);

function hasJfif(jpegBuf) {
  if (jpegBuf.length < 11) return false;
  if (jpegBuf[0] !== 0xFF || jpegBuf[1] !== 0xD8) return false;
  if (jpegBuf[2] !== 0xFF || jpegBuf[3] !== 0xE0) return false;
  return jpegBuf.subarray(6, 11).equals(JFIF_IDENT);
}

function ensureJfif(jpegBuf) {
  if (hasJfif(jpegBuf)) return jpegBuf;
  // Splice the APP0 right after SOI. Anything that was there (e.g. Exif
  // APP1) shifts down — multiple APP segments are valid; JFIF just needs
  // to be first.
  return Buffer.concat([jpegBuf.subarray(0, 2), JFIF_APP0, jpegBuf.subarray(2)]);
}

// Resize an image buffer to a 600x600 JPEG that the iPod 5.5 can display.
//   - 4:2:0 chroma (yuvj420p) — the hardware decoder rejects 4:2:2 / 4:4:4
//   - baseline (not progressive) — hardware decoders only do baseline
//   - JFIF APP0 marker present — see comment on JFIF_APP0 above
async function toIpodJpeg(inputBuffer, outPath) {
  const raw = await sharp(inputBuffer)
    .resize(600, 600, { fit: 'cover' })
    .jpeg({
      quality: 90,
      chromaSubsampling: '4:2:0',
      mozjpeg: false,
      progressive: false,
    })
    .toBuffer();
  fs.writeFileSync(outPath, ensureJfif(raw));
  return outPath;
}

// ─── Source-embedded artwork (preferred) ─────────────────────────────────

async function embeddedToIpodJpeg(srcPath, outPath) {
  const buf = await extractEmbeddedArtwork(srcPath);
  if (!buf) return null;
  try {
    await toIpodJpeg(buf, outPath);
    return outPath;
  } catch {
    return null;   // unreadable embedded image — caller falls back to iTunes
  }
}

// ─── iTunes Search fallback ──────────────────────────────────────────────

function searchTermFromFilename(filename) {
  let s = path.parse(filename).name;
  s = s.replace(/^\d+\s*[-–]\s*/, '');                  // "01 - " prefix
  s = s.replace(/\s*[\(\[][^\)\]]*[\)\]]/g, '');         // (feat. ...) [remix]
  s = s.replace(/[_\-]+/g, ' ');                          // separators
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function searchTermFromTags(tags) {
  if (!tags || !tags.title) return null;
  const title = tags.title.replace(/\s*[\(\[][^\)\]]*[\)\]]\s*$/g, '').trim() || tags.title;
  const artist = (tags.artist || '').trim();
  return artist ? `${artist} ${title}` : title;
}

async function searchITunes(term) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&limit=5`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`iTunes search failed: ${res.status}`);
  const data = await res.json();
  return data.results || [];
}

async function downloadBuffer(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Artwork download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function fetchFromITunes(filename, tags, outPath) {
  const term = searchTermFromTags(tags) || searchTermFromFilename(filename);
  if (!term) return { error: 'no search term available' };

  let results;
  try {
    results = await searchITunes(term);
  } catch (err) {
    return { error: err.message, term };
  }

  for (const r of results) {
    const artUrl = r.artworkUrl100;
    if (!artUrl) continue;
    const hiRes = artUrl.replace('100x100bb', '1000x1000bb');
    try {
      const buf = await downloadBuffer(hiRes);
      await toIpodJpeg(buf, outPath);
      return { path: outPath, term, source: `iTunes: ${r.trackName} — ${r.artistName}` };
    } catch {
      continue;
    }
  }
  return { error: 'no artwork found', term };
}

// ─── Orchestrator: embedded first, iTunes as fallback ────────────────────

async function fetchArtwork(srcPath, filename, tags, workDir) {
  const outPath = path.join(workDir, 'artwork_600.jpg');

  // 1) Try the picture embedded in the source file.
  if (srcPath) {
    const embedded = await embeddedToIpodJpeg(srcPath, outPath);
    if (embedded) {
      return { path: embedded, source: 'embedded' };
    }
  }

  // 2) Fall back to iTunes Search.
  return fetchFromITunes(filename, tags, outPath);
}

module.exports = { fetchArtwork, searchTermFromFilename, searchTermFromTags, toIpodJpeg };
