const path = require('path');
const sharp = require('sharp');
const { extractEmbeddedArtwork } = require('./metadata');

// Resize an image buffer to a 600x600 JPEG that the iPod 5.5 can display.
// The hardware JPEG decoder only handles 4:2:0 chroma subsampling — higher
// subsampling rates (4:2:2, 4:4:4) are silently rejected and the artwork
// renders blank on the device. Verified via ffprobe: this config produces
// `pix_fmt: yuvj420p`.
async function toIpodJpeg(inputBuffer, outPath) {
  await sharp(inputBuffer)
    .resize(600, 600, { fit: 'cover' })
    .jpeg({
      quality: 90,
      chromaSubsampling: '4:2:0',
      mozjpeg: false,
    })
    .toFile(outPath);
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
