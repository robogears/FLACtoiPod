const fs = require('fs');
const path = require('path');

// music-metadata is ESM-only on v11+, so we lazy-import it.
let _mmPromise = null;
async function getMM() {
  if (!_mmPromise) _mmPromise = import('music-metadata');
  return _mmPromise;
}

let cache = {};        // { absPath: { mtime, title, artist, album } }
let cachePath = '';
let dirty = false;

function init(filePath) {
  cachePath = filePath;
  try {
    cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } catch {
    cache = {};
  }
}

async function getTags(fullPath) {
  let mtime = 0;
  try { mtime = fs.statSync(fullPath).mtimeMs; } catch {}

  const cached = cache[fullPath];
  if (cached && cached.mtime === mtime) return cached;

  let tags = { title: null, artist: null, album: null };
  try {
    const { parseFile } = await getMM();
    const meta = await parseFile(fullPath, { duration: false, skipCovers: true });
    tags = {
      title: (meta.common.title || '').trim() || null,
      artist: (meta.common.artist || '').trim() || null,
      album: (meta.common.album || '').trim() || null,
    };
  } catch {
    // unreadable tags — leave nulls so caller falls back to filename
  }

  cache[fullPath] = { mtime, ...tags };
  dirty = true;
  return cache[fullPath];
}

// Drop entries for files we didn't see in the latest scan, then write to disk.
function flush(seenPaths) {
  if (!cachePath) return;
  if (seenPaths instanceof Set) {
    for (const k of Object.keys(cache)) {
      if (!seenPaths.has(k)) {
        delete cache[k];
        dirty = true;
      }
    }
  }
  if (!dirty) return;
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(cache));
    dirty = false;
  } catch (err) {
    console.warn('metadata cache flush failed:', err.message);
  }
}

// Run an async fn over items with a concurrency cap.
async function mapConcurrent(items, fn, concurrency = 8) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// Pull the embedded cover art (if any) out of an audio file. Returns a raw
// image Buffer (typically JPEG/PNG) or null if the file has no picture.
// Bypasses the tag cache — this is a per-conversion read, not a scan-time one.
async function extractEmbeddedArtwork(fullPath) {
  try {
    const { parseFile } = await getMM();
    const meta = await parseFile(fullPath, { duration: false });
    const pics = meta.common.picture;
    if (!pics || pics.length === 0) return null;
    // Prefer "Cover (front)" when present; otherwise take the first picture.
    const front = pics.find((p) => /front/i.test(p.type || '')) || pics[0];
    return front && front.data ? Buffer.from(front.data) : null;
  } catch {
    return null;
  }
}

module.exports = { init, getTags, flush, mapConcurrent, extractEmbeddedArtwork };
