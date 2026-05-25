const fs = require('fs');
const path = require('path');
const { normalize, stripArtistPrefix } = require('./normalize');
const meta = require('./metadata');

const SKIP = new Set(['Albums', 'SpotiFLAC (might be ass)']);
const EXTS = new Set(['.mp3', '.flac', '.wav', '.m4a', '.aac']);

function isAudio(name) {
  return EXTS.has(path.extname(name).toLowerCase());
}

// Walk a library root and collect every audio file. Returns [{ genre, fname, path }, ...].
function listAudio(rootDir, opts = {}) {
  const { allowSubdirs = true, skipFolders = new Set() } = opts;
  const out = [];

  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return { files: [], missing: true };
    throw err;
  }

  for (const genreEntry of entries) {
    if (!genreEntry.isDirectory()) continue;
    if (genreEntry.name.startsWith('.')) continue;
    if (skipFolders.has(genreEntry.name)) continue;

    const genre = genreEntry.name;
    const genrePath = path.join(rootDir, genre);
    let inner;
    try {
      inner = fs.readdirSync(genrePath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const sub of inner) {
      if (sub.isDirectory() && allowSubdirs) {
        let leaves;
        try {
          leaves = fs.readdirSync(path.join(genrePath, sub.name), { withFileTypes: true });
        } catch { continue; }
        for (const leaf of leaves) {
          if (!leaf.isFile() || !isAudio(leaf.name)) continue;
          out.push({ genre, fname: leaf.name, path: path.join(genrePath, sub.name, leaf.name) });
        }
      } else if (sub.isFile() && isAudio(sub.name)) {
        out.push({ genre, fname: sub.name, path: path.join(genrePath, sub.name) });
      }
    }
  }
  return { files: out, missing: false };
}

// Build the set of match keys for a single file:
//   - normalized title (from tags) — primary
//   - normalized "artist title" (from tags) — disambiguates same-titled songs
//   - normalized filename (with extension stripped)
//   - filename with leading track-number and "artist - " prefix stripped
// All keys are lowercase, accent-preserved, whitespace-collapsed.
function keysFor(fname, tags) {
  const keys = new Set();
  const nn = normalize(fname);
  const ns = stripArtistPrefix(fname);
  if (nn) keys.add(nn);
  if (ns) keys.add(ns);

  if (tags) {
    if (tags.title) {
      const t = normalize(tags.title);
      if (t) keys.add(t);
      if (tags.artist) {
        const at = normalize(`${tags.artist} ${tags.title}`);
        if (at) keys.add(at);
      }
    }
  }
  return keys;
}

async function indexLibrary(files, onProgress) {
  // map<key, { genre, fname, path }>  — same value can live under multiple keys
  const byKey = new Map();
  // [{ entry, keys: Set<string> }]    — original entries with their own key sets
  const entries = [];

  let done = 0;
  await meta.mapConcurrent(files, async (entry) => {
    const tags = await meta.getTags(entry.path);
    const keys = keysFor(entry.fname, tags);
    entries.push({ ...entry, tags, keys });
    for (const k of keys) byKey.set(k, entry);
    done++;
    if (onProgress && (done % 25 === 0 || done === files.length)) {
      onProgress({ done, total: files.length });
    }
  }, 8);

  return { byKey, entries };
}

function diff(musicEntries, ipodByKey, musicByKey, ipodEntries) {
  const adds = [];
  const seenAdds = new Set();
  for (const e of musicEntries) {
    if (seenAdds.has(e.path)) continue;
    let found = false;
    for (const k of e.keys) {
      if (ipodByKey.has(k)) { found = true; break; }
    }
    if (!found) {
      seenAdds.add(e.path);
      adds.push({ genre: e.genre, fname: e.fname, path: e.path, tags: e.tags });
    }
  }

  const deletes = [];
  const seenDels = new Set();
  for (const e of ipodEntries) {
    if (seenDels.has(e.path)) continue;
    let found = false;
    for (const k of e.keys) {
      if (musicByKey.has(k)) { found = true; break; }
    }
    if (!found) {
      seenDels.add(e.path);
      deletes.push({ genre: e.genre, fname: e.fname, path: e.path, tags: e.tags });
    }
  }

  return { adds, deletes };
}

async function scan(musicRoot, ipodGenresRoot, onProgress) {
  const musicList = listAudio(musicRoot, { allowSubdirs: true, skipFolders: SKIP });
  if (musicList.missing) throw new Error(`Music folder not found: ${musicRoot}`);
  const ipodList = listAudio(ipodGenresRoot, { allowSubdirs: false });
  if (ipodList.missing) throw new Error(`iPod folder not found: ${ipodGenresRoot}`);

  const totalFiles = musicList.files.length + ipodList.files.length;
  let scanned = 0;
  const bump = (incr) => {
    scanned += incr;
    if (onProgress) onProgress({ phase: 'tags', done: scanned, total: totalFiles });
  };

  const music = await indexLibrary(musicList.files, ({ done, total }) => {
    if (onProgress) onProgress({ phase: 'tags', done: scanned + done, total: totalFiles, sublabel: 'source library' });
  });
  scanned += musicList.files.length;

  const ipod = await indexLibrary(ipodList.files, ({ done, total }) => {
    if (onProgress) onProgress({ phase: 'tags', done: scanned + done, total: totalFiles, sublabel: 'iPod library' });
  });
  scanned += ipodList.files.length;

  if (onProgress) onProgress({ phase: 'diff', done: scanned, total: totalFiles });

  const { adds, deletes } = diff(music.entries, ipod.byKey, music.byKey, ipod.entries);

  // group adds by genre for the UI
  const addsByGenre = {};
  for (const a of adds) {
    (addsByGenre[a.genre] ||= []).push(a);
  }

  // flush metadata cache, dropping entries for files that disappeared
  const seenPaths = new Set([
    ...musicList.files.map((f) => f.path),
    ...ipodList.files.map((f) => f.path),
  ]);
  meta.flush(seenPaths);

  return {
    adds,
    addsByGenre,
    deletes,
    musicCount: musicList.files.length,
    ipodCount: ipodList.files.length,
  };
}

module.exports = { scan, listAudio, keysFor, diff };
