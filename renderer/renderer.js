const $ = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);

const state = {
  scan: null,
  selectedAdds: new Set(),
  selectedDeletes: new Set(),
  converting: false,
  trackUI: new Map(),
  deleteUI: new Map(),
  genreMasters: new Map(),   // genre -> master checkbox input
};

// ─── Settings / paths ────────────────────────────────────────────────────

async function refreshPathsSummary() {
  const cfg = await window.api.config.get();
  $('brand-paths').textContent = `${cfg.musicRoot}  →  ${cfg.ipodGenresRoot}`;
  $('cfg-music').value = cfg.musicRoot;
  $('cfg-ipod').value = cfg.ipodGenresRoot;
}

function openModal(id) { $(id).hidden = false; }
function closeModal(id) { $(id).hidden = true; }

$('settings-btn').addEventListener('click', () => openModal('settings-modal'));
$$('[data-close]').forEach((el) => {
  el.addEventListener('click', () => closeModal(el.dataset.close));
});
$$('.modal-backdrop').forEach((bd) => {
  bd.addEventListener('click', (e) => {
    if (e.target === bd) bd.hidden = true;
  });
});

$('pick-music').addEventListener('click', async () => {
  await window.api.config.pickFolder('musicRoot');
  refreshPathsSummary();
});
$('pick-ipod').addEventListener('click', async () => {
  await window.api.config.pickFolder('ipodGenresRoot');
  refreshPathsSummary();
});

// ─── Sync scan ───────────────────────────────────────────────────────────

$('btn-sync').addEventListener('click', runScan);

async function runScan() {
  if (state.converting) return;
  const btn = $('btn-sync');
  btn.disabled = true;
  btn.classList.add('spinning');
  setStatus('Scanning…');
  $('sync-summary').innerHTML = 'Reading tags…';

  const res = await window.api.sync.scan();
  btn.disabled = false;
  btn.classList.remove('spinning');

  if (!res.ok) {
    setStatus(`Scan failed: ${res.error}`);
    $('sync-summary').innerHTML = `<strong>Error:</strong> ${escapeHtml(res.error)}`;
    return;
  }

  state.scan = res;
  state.selectedAdds = new Set(res.adds.map(keyOf));     // adds default to all-checked
  state.selectedDeletes = new Set();                      // deletes default to none-checked (safer)
  state.trackUI = new Map();
  state.deleteUI = new Map();
  state.genreMasters = new Map();
  renderResults();

  const a = res.adds.length;
  const d = res.deletes.length;
  if (a === 0 && d === 0) {
    $('sync-summary').innerHTML = `<strong>All in sync.</strong> ${res.musicCount} source · ${res.ipodCount} iPod · ${res.durationMs}ms`;
  } else {
    $('sync-summary').innerHTML = `<strong>${a}</strong> add${a===1?'':'s'} · <strong>${d}</strong> delete${d===1?'':'s'} · ${res.durationMs}ms`;
  }
  setStatus('Ready.');
}

function keyOf(track) { return `${track.genre}/${track.fname}`; }

// Display title comes from tags when available, else filename without ext.
function displayTitle(track) {
  if (track.tags && track.tags.title) return track.tags.title;
  return track.fname.replace(/\.[^.]+$/, '');
}
function displayArtist(track) {
  return (track.tags && track.tags.artist) || '';
}

function renderResults() {
  $('results').hidden = false;
  $('adds-count').textContent = state.scan.adds.length;
  $('deletes-count').textContent = state.scan.deletes.length;

  // ─── Adds (grouped by genre, with per-genre master checkbox) ───
  const addsBody = $('adds-body');
  addsBody.innerHTML = '';
  if (state.scan.adds.length === 0) {
    addsBody.innerHTML = '<p class="empty">No new tracks to add.</p>';
  } else {
    const genres = Object.keys(state.scan.addsByGenre).sort();
    for (const genre of genres) {
      const group = document.createElement('div');
      group.className = 'genre-group';

      const header = document.createElement('label');
      header.className = 'genre-header';
      header.innerHTML = `
        <input type="checkbox" />
        <span class="genre-label-text">${escapeHtml(genre)} · ${state.scan.addsByGenre[genre].length}</span>
      `;
      const masterInput = header.querySelector('input');
      state.genreMasters.set(genre, masterInput);
      masterInput.addEventListener('change', () => toggleGenre(genre, masterInput.checked));
      group.appendChild(header);

      for (const track of state.scan.addsByGenre[genre]) {
        const k = keyOf(track);
        const row = makeTrackRow(track, k, state.selectedAdds, () => {
          updateAddsCount();
          updateGenreMaster(genre);
        });
        state.trackUI.set(k, row);
        group.appendChild(row);
      }

      updateGenreMaster(genre);
      addsBody.appendChild(group);
    }
  }

  // ─── Deletes (flat, no grouping — usually few) ───
  const delBody = $('deletes-body');
  delBody.innerHTML = '';
  if (state.scan.deletes.length === 0) {
    delBody.innerHTML = '<p class="empty">No stale tracks on iPod.</p>';
  } else {
    for (const track of state.scan.deletes) {
      const k = keyOf(track);
      const row = makeTrackRow(track, k, state.selectedDeletes, () => updateDeletesCount(), { showGenre: true });
      state.deleteUI.set(k, row);
      delBody.appendChild(row);
    }
  }

  updateAddsCount();
  updateDeletesCount();
}

// Shared row factory — used for both adds and deletes.
function makeTrackRow(track, k, selectionSet, onChange, opts = {}) {
  const { showGenre = false } = opts;
  const row = document.createElement('label');
  row.className = 'qi';
  const checked = selectionSet.has(k) ? 'checked' : '';
  const artist = displayArtist(track);
  const title = displayTitle(track);
  const genrePill = showGenre ? `<span class="qi-genre">${escapeHtml(track.genre)}</span>` : '';

  row.innerHTML = `
    <input type="checkbox" ${checked} />
    ${genrePill}
    <div class="qi-info">
      <div class="qi-title" title="${escapeHtml(track.path)}">${escapeHtml(title)}</div>
      ${artist ? `<div class="qi-artist">${escapeHtml(artist)}</div>` : ''}
    </div>
    <span class="qi-status"></span>
  `;
  row.querySelector('input').addEventListener('change', (e) => {
    if (e.target.checked) selectionSet.add(k);
    else selectionSet.delete(k);
    onChange();
  });
  return row;
}

function updateAddsCount() {
  $('selected-count').textContent = state.selectedAdds.size;
  $('btn-add-selected').disabled = state.selectedAdds.size === 0 || state.converting;
}
function updateDeletesCount() {
  $('deletes-selected-count').textContent = state.selectedDeletes.size;
  $('btn-delete-selected').disabled = state.selectedDeletes.size === 0;
}

// Sync a genre's master checkbox with the actual selection state of its tracks.
// Three states: all → checked, none → unchecked, mixed → indeterminate.
function updateGenreMaster(genre) {
  const master = state.genreMasters.get(genre);
  if (!master) return;
  const tracks = state.scan.addsByGenre[genre] || [];
  let selected = 0;
  for (const t of tracks) {
    if (state.selectedAdds.has(keyOf(t))) selected++;
  }
  if (selected === 0) {
    master.checked = false;
    master.indeterminate = false;
  } else if (selected === tracks.length) {
    master.checked = true;
    master.indeterminate = false;
  } else {
    master.checked = false;
    master.indeterminate = true;
  }
}

// Check/uncheck every track in a genre at once.
function toggleGenre(genre, shouldCheck) {
  const tracks = state.scan.addsByGenre[genre] || [];
  for (const t of tracks) {
    const k = keyOf(t);
    if (shouldCheck) state.selectedAdds.add(k);
    else state.selectedAdds.delete(k);
    const row = state.trackUI.get(k);
    if (row) row.querySelector('input').checked = shouldCheck;
  }
  updateGenreMaster(genre);
  updateAddsCount();
}

function refreshAllGenreMasters() {
  for (const genre of state.genreMasters.keys()) updateGenreMaster(genre);
}

$('select-all-adds').addEventListener('click', () => {
  if (!state.scan) return;
  state.selectedAdds = new Set(state.scan.adds.map(keyOf));
  for (const cb of $$('.col-adds .qi input[type="checkbox"]')) cb.checked = true;
  refreshAllGenreMasters();
  updateAddsCount();
});
$('select-none-adds').addEventListener('click', () => {
  state.selectedAdds.clear();
  for (const cb of $$('.col-adds .qi input[type="checkbox"]')) cb.checked = false;
  refreshAllGenreMasters();
  updateAddsCount();
});
$('select-all-deletes').addEventListener('click', () => {
  if (!state.scan) return;
  state.selectedDeletes = new Set(state.scan.deletes.map(keyOf));
  for (const cb of $$('.col-deletes input[type="checkbox"]')) cb.checked = true;
  updateDeletesCount();
});
$('select-none-deletes').addEventListener('click', () => {
  state.selectedDeletes.clear();
  for (const cb of $$('.col-deletes input[type="checkbox"]')) cb.checked = false;
  updateDeletesCount();
});

// ─── Convert ─────────────────────────────────────────────────────────────

$('btn-add-selected').addEventListener('click', startConvert);
$('btn-cancel').addEventListener('click', () => window.api.sync.cancel());

async function startConvert() {
  if (!state.scan || state.selectedAdds.size === 0) return;
  const tracks = state.scan.adds.filter((a) => state.selectedAdds.has(keyOf(a)));

  state.converting = true;
  $('btn-add-selected').disabled = true;
  $('btn-sync').disabled = true;
  $('progress').hidden = false;
  $('progress-fill').style.width = '0%';
  $('progress-title').textContent = `Converting 0 / ${tracks.length}`;
  $('progress-meta').textContent = '—';
  $('convert-log').innerHTML = '';

  for (const t of tracks) {
    const row = state.trackUI.get(keyOf(t));
    if (row) {
      row.querySelector('.qi-status').textContent = 'queued';
      row.classList.remove('done', 'failed', 'warn');
    }
  }

  setStatus(`Converting ${tracks.length} track${tracks.length===1?'':'s'}…`);
  const result = await window.api.sync.convert(tracks);

  state.converting = false;
  $('btn-sync').disabled = false;
  updateAddsCount();

  if (result.cancelled) {
    setStatus(`Cancelled after ${result.results.length} of ${tracks.length}.`);
    $('progress-title').textContent = 'Cancelled.';
  } else {
    const ok = result.results.filter((r) => r.ok).length;
    const fail = result.results.length - ok;
    setStatus(`Done. ${ok} succeeded${fail ? `, ${fail} failed` : ''}.`);
    $('progress-title').textContent = `Done. ${ok} succeeded${fail ? `, ${fail} failed` : ''}.`;
  }
}

window.api.on('scan:progress', ({ phase, done, total, sublabel }) => {
  if (phase === 'tags') {
    const pct = total ? Math.round((done / total) * 100) : 0;
    const sub = sublabel ? ` (${sublabel})` : '';
    $('sync-summary').innerHTML = `Reading tags <strong>${done} / ${total}</strong>${sub} · ${pct}%`;
    setStatus(`Reading tags ${done} / ${total}…`);
  } else if (phase === 'diff') {
    $('sync-summary').innerHTML = 'Comparing libraries…';
  }
});

window.api.on('convert:track-start', ({ index, total, track }) => {
  $('progress-title').textContent = `Converting ${index + 1} / ${total}`;
  $('progress-meta').textContent = `${track.genre} / ${track.fname}`;
  const row = state.trackUI.get(keyOf(track));
  if (row) row.querySelector('.qi-status').textContent = '…';
});

window.api.on('convert:track-progress', ({ step }) => {
  const labels = { transcode: 'transcoding', artwork: 'artwork', embed: 'embedding', copy: 'copying' };
  const head = $('progress-meta').textContent.split('  [')[0];
  $('progress-meta').textContent = `${head}  [${labels[step] || step}]`;
});

window.api.on('convert:track-done', ({ index, total, ok, track, error, artwork, destName }) => {
  const pct = ((index + 1) / total) * 100;
  $('progress-fill').style.width = `${pct}%`;

  const row = state.trackUI.get(keyOf(track));
  const li = document.createElement('li');
  if (ok) {
    const noArt = artwork && artwork.warning;
    li.className = noArt ? 'warn' : 'ok';
    const arrow = destName && destName !== track.fname ? `  →  ${destName}` : '';
    const artNote = noArt ? `  (no artwork: ${artwork.warning})` : '';
    li.textContent = `✓ ${track.genre} / ${track.fname}${arrow}${artNote}`;
    if (row) {
      row.classList.add(noArt ? 'warn' : 'done');
      row.querySelector('.qi-status').textContent = noArt ? 'added (no art)' : 'added';
    }
  } else {
    li.className = 'err';
    li.textContent = `✗ ${track.genre} / ${track.fname}: ${error}`;
    if (row) {
      row.classList.add('failed');
      row.querySelector('.qi-status').textContent = 'failed';
    }
  }
  $('convert-log').appendChild(li);
  $('convert-log').scrollTop = $('convert-log').scrollHeight;
});

// ─── Delete (single + bulk) ─────────────────────────────────────────────

$('btn-delete-selected').addEventListener('click', () => {
  if (!state.scan || state.selectedDeletes.size === 0) return;
  const tracks = state.scan.deletes.filter((d) => state.selectedDeletes.has(keyOf(d)));
  confirmBulkDelete(tracks);
});

let pendingDelete = null;   // { tracks: [...], rowEls: [...] }

function confirmBulkDelete(tracks) {
  const rowEls = tracks.map((t) => state.deleteUI.get(keyOf(t))).filter(Boolean);
  pendingDelete = { tracks, rowEls };
  if (tracks.length === 1) {
    const t = tracks[0];
    const name = displayTitle(t);
    $('confirm-msg').innerHTML = `Delete <strong>${escapeHtml(t.genre)}</strong> / <span class="filename">${escapeHtml(name)}</span>?`;
  } else {
    const previewCount = Math.min(5, tracks.length);
    const previewList = tracks.slice(0, previewCount)
      .map((t) => `<div class="filename">· ${escapeHtml(t.genre)} / ${escapeHtml(displayTitle(t))}</div>`)
      .join('');
    const more = tracks.length > previewCount ? `<div class="filename" style="opacity:0.6;">…and ${tracks.length - previewCount} more</div>` : '';
    $('confirm-msg').innerHTML = `Delete <strong>${tracks.length}</strong> tracks from iPod?${previewList}${more}`;
  }
  openModal('confirm-modal');
}

$('confirm-cancel').addEventListener('click', () => {
  pendingDelete = null;
  closeModal('confirm-modal');
});
$('confirm-ok').addEventListener('click', async () => {
  if (!pendingDelete) return closeModal('confirm-modal');
  const { tracks, rowEls } = pendingDelete;
  closeModal('confirm-modal');
  pendingDelete = null;

  let ok = 0;
  let fail = 0;
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    setStatus(`Deleting ${i + 1} / ${tracks.length}…`);
    const res = await window.api.sync.delete(t.path);
    if (res.ok) {
      ok++;
      const row = rowEls[i];
      if (row) row.remove();
      state.scan.deletes = state.scan.deletes.filter((d) => d.path !== t.path);
      state.selectedDeletes.delete(keyOf(t));
      state.deleteUI.delete(keyOf(t));
    } else {
      fail++;
    }
  }

  $('deletes-count').textContent = state.scan.deletes.length;
  updateDeletesCount();
  if (state.scan.deletes.length === 0) {
    $('deletes-body').innerHTML = '<p class="empty">No stale tracks on iPod.</p>';
  }
  setStatus(`Deleted ${ok}${fail ? `, ${fail} failed` : ''}.`);
});

// ─── Helpers ─────────────────────────────────────────────────────────────

function setStatus(text) { $('statusbar').textContent = text; }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ─── Updater ─────────────────────────────────────────────────────────────

const updater = {
  state: 'idle',          // idle | downloading | restarting
  payload: null,          // { version, downloadUrl, releaseUrl }
  surfaceReady: false,
  pending: null,          // queued payload if it arrives before init finishes
  selfInstall: false,
};

async function initUpdater() {
  const version = await window.api.app.version();
  $('brand-version').textContent = `v${version}`;
  $('update-status').textContent = `Current version: v${version}`;

  updater.selfInstall = await window.api.updater.canSelfInstall().catch(() => false);
  updater.surfaceReady = true;
  if (updater.pending) {
    applyUpdatePayload(updater.pending);
    updater.pending = null;
  }
}

function applyUpdatePayload(payload) {
  updater.payload = payload;
  const pill = $('brand-update-pill');
  pill.hidden = false;
  pill.textContent = `Update ${payload.version}`;
  pill.disabled = false;
}

window.api.on('update:available', (payload) => {
  if (!updater.surfaceReady) { updater.pending = payload; return; }
  if (updater.state !== 'idle') return;
  applyUpdatePayload(payload);
});

$('brand-update-pill').addEventListener('click', async () => {
  if (updater.state !== 'idle' || !updater.payload) return;
  const pill = $('brand-update-pill');

  if (!updater.selfInstall) {
    window.api.shell.openExternal(updater.payload.releaseUrl);
    return;
  }

  updater.state = 'downloading';
  pill.disabled = true;
  pill.textContent = 'Starting…';

  const r = await window.api.updater.download(updater.payload.downloadUrl);
  if (!r || !r.ok) {
    updater.state = 'idle';
    pill.disabled = false;
    pill.textContent = 'Download failed — retry';
    return;
  }

  // One-click flow: immediately apply once downloaded.
  pill.textContent = 'Restarting…';
  updater.state = 'restarting';
  await window.api.updater.apply();
});

window.api.on('update:download-progress', ({ downloaded, total }) => {
  if (updater.state !== 'downloading') return;
  const pill = $('brand-update-pill');
  if (total > 0) {
    pill.textContent = `Downloading ${Math.floor((downloaded / total) * 100)}%`;
  } else {
    pill.textContent = `Downloading ${(downloaded / 1024 / 1024).toFixed(1)} MB`;
  }
});

// Settings → Check for updates
$('check-updates-btn').addEventListener('click', async () => {
  const btn = $('check-updates-btn');
  const status = $('update-status');
  btn.disabled = true;
  const prevText = btn.textContent;
  btn.textContent = 'Checking…';
  status.className = 'auth-status';

  const result = await window.api.updater.check();

  if (result.status === 'available') {
    status.textContent = `${result.version} available!`;
    status.className = 'auth-status ok';
  } else if (result.status === 'up-to-date') {
    status.textContent = `Up to date ✓  (v${result.version})`;
    status.className = 'auth-status ok';
  } else {
    status.textContent = result.message || 'Check failed';
    status.className = 'auth-status bad';
  }

  setTimeout(() => {
    btn.textContent = prevText;
    btn.disabled = false;
  }, 2500);
});

// ─── Auto ReplayGain ─────────────────────────────────────────────────────

const replaygain = {
  running: false,
};

$('replaygain-btn').addEventListener('click', openReplayGainChooser);
$('rg-cancel').addEventListener('click', () => {
  $('rg-cancel').disabled = true;
  $('rg-cancel').textContent = 'Cancelling…';
  window.api.replaygain.cancel();
});
$('rg-choose-new').addEventListener('click', () => startReplayGain('new'));
$('rg-choose-all').addEventListener('click', () => startReplayGain('all'));

async function openReplayGainChooser() {
  if (replaygain.running || state.converting) return;

  // Pre-flight: count files + how many are new.
  $('replaygain-btn').disabled = true;
  setStatus('Scanning iPod folder…');
  const plan = await window.api.replaygain.plan();
  $('replaygain-btn').disabled = false;
  setStatus('Ready.');

  if (!plan.ok) {
    setStatus(`ReplayGain plan failed: ${plan.error}`);
    return;
  }
  if (plan.total === 0) {
    setStatus('No m4a files in iPod folder to process.');
    return;
  }

  $('rg-new-count').textContent = plan.newCount;
  $('rg-all-count').textContent = plan.total;
  $('rg-choose-new').disabled = plan.newCount === 0;
  $('rg-chooser-summary').innerHTML = plan.newCount === 0
    ? `All <strong>${plan.total}</strong> tracks already tagged by this app.`
    : `Found <strong>${plan.newCount}</strong> new track${plan.newCount === 1 ? '' : 's'}; <strong>${plan.alreadyProcessed}</strong> already tagged.`;

  openModal('rg-chooser');
}

async function startReplayGain(mode) {
  closeModal('rg-chooser');
  if (replaygain.running || state.converting) return;
  replaygain.running = true;

  $('replaygain-btn').disabled = true;
  $('btn-sync').disabled = true;
  $('rg-overlay').hidden = false;
  $('rg-meta').textContent = mode === 'new' ? 'Scanning new tracks…' : 'Scanning iPod folder…';
  $('rg-stats').textContent = '0 / 0';
  $('rg-progress-fill').style.width = '0%';
  $('rg-cancel').disabled = false;
  $('rg-cancel').textContent = 'Cancel';
  setStatus(`Auto ReplayGain running (${mode})…`);

  const result = await window.api.replaygain.run(mode);

  replaygain.running = false;
  $('replaygain-btn').disabled = false;
  $('btn-sync').disabled = false;
  $('rg-overlay').hidden = true;

  if (!result.ok) {
    setStatus(`Auto ReplayGain failed: ${result.error}`);
    return;
  }
  const { total, ok, failed, cancelled, errors } = result;
  const modeLabel = result.mode === 'new' ? 'new tracks' : 'all tracks';
  if (cancelled) {
    setStatus(`Auto ReplayGain (${modeLabel}) cancelled — ${ok} of ${total} tagged.`);
  } else if (total === 0) {
    setStatus(`Auto ReplayGain — no tracks to process.`);
  } else if (failed > 0) {
    setStatus(`Auto ReplayGain (${modeLabel}) done — ${ok} tagged, ${failed} failed (${errors.slice(0, 2).map((e) => e.file).join(', ')}${errors.length > 2 ? '…' : ''}).`);
  } else {
    setStatus(`Auto ReplayGain (${modeLabel}) done — ${ok} of ${total} tagged.`);
  }
}

window.api.on('replaygain:progress', (p) => {
  if (!replaygain.running) return;
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  $('rg-progress-fill').style.width = `${pct}%`;
  $('rg-stats').textContent = `${p.done} / ${p.total}  (${pct}%)`;

  if (p.phase === 'analyzing' && p.current) {
    $('rg-meta').textContent = `Analyzing  ${p.current.genre} / ${p.current.name}`;
  } else if (p.phase === 'writing' && p.current) {
    $('rg-meta').textContent = `Writing ${p.gain}  ${p.current.genre} / ${p.current.name}`;
  } else if (p.phase === 'cancelled') {
    $('rg-meta').textContent = 'Cancelling…';
  } else if (p.phase === 'done') {
    $('rg-meta').textContent = 'Finishing up…';
  } else if (p.phase === 'error-file' && p.current) {
    $('rg-meta').textContent = `Skipped  ${p.current.genre} / ${p.current.name}  (${p.error})`;
  }
});

refreshPathsSummary();
initUpdater();
