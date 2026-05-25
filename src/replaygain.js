// Two-pass ReplayGain processor for the iPod Genres folder.
//
// Pass 1 (analyze): ffmpeg's ebur128 filter measures Integrated Loudness in
// LUFS plus the True Peak in dBFS. ReplayGain 2.0 reference is -18 LUFS; we
// compute track_gain = -18 - measured_lufs and track_peak = 10^(dbtp/20).
//
// Pass 2 (write): src/mp4-tags.js injects iTunes-style freeform atoms
// (`----:com.apple.iTunes:REPLAYGAIN_TRACK_GAIN` etc.) directly. No ffmpeg
// rewrite — ffmpeg silently drops freeform atoms, see project memory.
//
// History tracking: every successful write is recorded in a JSON file keyed by
// absolute path. Entries store mtime so re-converted files (different mtime)
// re-process automatically. "new" mode skips files whose history entry's mtime
// matches the on-disk mtime; everything else is treated as new (including
// files with pre-existing ReplayGain from another tool — we only trust OUR
// history).

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { setFreeformTags } = require('./mp4-tags');

const REFERENCE_LUFS = -18;
const AUDIO_EXT = '.m4a';

// ─── History persistence ─────────────────────────────────────────────────

function loadHistory(historyPath) {
  if (!historyPath) return {};
  try {
    const raw = fs.readFileSync(historyPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveHistory(historyPath, history) {
  if (!historyPath) return;
  try {
    fs.mkdirSync(path.dirname(historyPath), { recursive: true });
    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
  } catch (err) {
    console.warn('replaygain history save failed:', err.message);
  }
}

function fileMtime(filePath) {
  try { return fs.statSync(filePath).mtimeMs; }
  catch { return 0; }
}

// A file is "new" (needs processing) if:
//   - history has no entry for its path, OR
//   - the stored mtime doesn't match the file's current mtime (file changed
//     externally since we tagged it — likely a re-convert via Sync).
function isUnprocessed(history, filePath, currentMtime) {
  const entry = history[filePath];
  if (!entry) return true;
  return entry.mtime !== currentMtime;
}

// ─── Pass 1: measure ──────────────────────────────────────────────────────

function analyze(filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner',
      '-nostdin',
      '-i', filePath,
      '-map', '0:a:0',
      '-af', 'ebur128=peak=true',
      '-f', 'null', '-',
    ];
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`ffmpeg ebur128 exit ${code}\n${stderr.slice(-1000)}`));
      }
      const summary = stderr.split(/Summary:/i).pop() || stderr;
      const iMatch = summary.match(/I:\s+(-?\d+(?:\.\d+)?)\s*LUFS/);
      const peakMatch = summary.match(/Peak:\s+(-?\d+(?:\.\d+)?)\s*dBFS/);
      if (!iMatch || !peakMatch) {
        return reject(new Error('Could not parse ebur128 summary'));
      }
      resolve({
        integratedLufs: parseFloat(iMatch[1]),
        truePeakDb: parseFloat(peakMatch[1]),
      });
    });
  });
}

function computeReplayGain({ integratedLufs, truePeakDb }) {
  const trackGainDb = REFERENCE_LUFS - integratedLufs;
  const trackPeakLinear = Math.pow(10, truePeakDb / 20);
  const gainStr = `${trackGainDb >= 0 ? '+' : ''}${trackGainDb.toFixed(2)} dB`;
  const peakStr = trackPeakLinear.toFixed(6);
  return { gainStr, peakStr, trackGainDb, trackPeakLinear };
}

// ─── Pass 2: write metadata via the freeform atom injector ────────────────

function writeReplayGain(filePath, gainStr, peakStr) {
  setFreeformTags(filePath, {
    REPLAYGAIN_TRACK_GAIN: gainStr,
    REPLAYGAIN_TRACK_PEAK: peakStr,
    REPLAYGAIN_ALBUM_GAIN: '',
    REPLAYGAIN_ALBUM_PEAK: '',
  });
}

// ─── Walk + orchestrate ───────────────────────────────────────────────────

function collectM4aFiles(rootDir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(rootDir, { withFileTypes: true }); }
  catch (err) {
    if (err.code === 'ENOENT') return out;
    throw err;
  }
  for (const genre of entries) {
    if (!genre.isDirectory() || genre.name.startsWith('.')) continue;
    const gpath = path.join(rootDir, genre.name);
    let inner;
    try { inner = fs.readdirSync(gpath, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of inner) {
      if (!entry.isFile()) continue;
      if (path.extname(entry.name).toLowerCase() !== AUDIO_EXT) continue;
      out.push({
        path: path.join(gpath, entry.name),
        name: entry.name,
        genre: genre.name,
        mtime: fileMtime(path.join(gpath, entry.name)),
      });
    }
  }
  return out;
}

// Pre-flight: read the iPod folder, load history, return counts for the UI.
// Also prunes history entries whose files no longer exist on disk (so the
// "already-processed" count stays accurate over time).
function planFiles(rootDir, historyPath) {
  const history = loadHistory(historyPath);
  const files = collectM4aFiles(rootDir);
  const onDiskPaths = new Set(files.map((f) => f.path));

  let prunedHistory = false;
  for (const key of Object.keys(history)) {
    if (!onDiskPaths.has(key)) {
      delete history[key];
      prunedHistory = true;
    }
  }
  if (prunedHistory) saveHistory(historyPath, history);

  let newCount = 0;
  let alreadyProcessed = 0;
  for (const f of files) {
    if (isUnprocessed(history, f.path, f.mtime)) newCount++;
    else alreadyProcessed++;
  }
  return { total: files.length, newCount, alreadyProcessed };
}

async function processAll(rootDir, {
  mode = 'all',          // 'all' | 'new'
  historyPath = null,    // path to userData/replaygain-history.json
  onProgress,
  shouldCancel,
} = {}) {
  const history = loadHistory(historyPath);
  const allFiles = collectM4aFiles(rootDir);

  const files = mode === 'new'
    ? allFiles.filter((f) => isUnprocessed(history, f.path, f.mtime))
    : allFiles;

  const results = {
    mode,
    total: files.length,
    totalInLibrary: allFiles.length,
    ok: 0,
    failed: 0,
    cancelled: false,
    errors: [],
  };

  onProgress?.({ phase: 'start', done: 0, total: files.length, mode });

  for (let i = 0; i < files.length; i++) {
    if (shouldCancel && shouldCancel()) {
      results.cancelled = true;
      onProgress?.({ phase: 'cancelled', done: i, total: files.length });
      break;
    }
    const f = files[i];
    onProgress?.({ phase: 'analyzing', done: i, total: files.length, current: f });
    try {
      const measurement = await analyze(f.path);
      const rg = computeReplayGain(measurement);
      onProgress?.({
        phase: 'writing',
        done: i,
        total: files.length,
        current: f,
        gain: rg.gainStr,
      });
      await writeReplayGain(f.path, rg.gainStr, rg.peakStr);
      // Record in history — capture mtime AFTER write so future runs compare
      // against the post-write mtime (which is what fs.stat will see).
      history[f.path] = {
        mtime: fileMtime(f.path),
        processedAt: Date.now(),
        gain: rg.gainStr,
        peak: rg.peakStr,
      };
      results.ok++;
      onProgress?.({
        phase: 'done-file',
        done: i + 1,
        total: files.length,
        current: f,
        gain: rg.gainStr,
      });
    } catch (err) {
      results.failed++;
      results.errors.push({ file: f.name, genre: f.genre, error: err.message });
      onProgress?.({
        phase: 'error-file',
        done: i + 1,
        total: files.length,
        current: f,
        error: err.message,
      });
    }
  }

  // Persist history once at the end (success / cancel / error). If we crashed
  // mid-batch, the on-disk tags are correct but the history misses some
  // entries — next "new" run would re-tag those (a no-op write) and then
  // record them. Safe.
  saveHistory(historyPath, history);

  onProgress?.({ phase: 'done', done: files.length, total: files.length });
  return results;
}

module.exports = {
  analyze,
  computeReplayGain,
  writeReplayGain,
  processAll,
  planFiles,
  collectM4aFiles,
  loadHistory,
  saveHistory,
  isUnprocessed,
  REFERENCE_LUFS,
};
