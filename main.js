const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { scan } = require('./src/scanner');
const { convertOne } = require('./src/converter');
const metadata = require('./src/metadata');
const updater = require('./src/updater');
const replaygain = require('./src/replaygain');

const DEFAULT_CONFIG = {
  musicRoot: 'Z:\\Dropbox\\Music',
  ipodGenresRoot: 'Z:\\Dropbox\\iPod Music\\Genres',
};

let cfg = { ...DEFAULT_CONFIG };
let configPath = '';
let replaygainHistoryPath = '';
let cancelRequested = false;
let replaygainCancelRequested = false;
let mainWindow = null;

function loadConfig() {
  configPath = path.join(app.getPath('userData'), 'config.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    cfg = { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    // first run — leave defaults
  }
}

function saveConfig() {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 500,
    backgroundColor: '#16161a',
    title: 'FLAC → iPod',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile('renderer/index.html');
}

app.whenReady().then(() => {
  loadConfig();
  metadata.init(path.join(app.getPath('userData'), 'metadata-cache.json'));
  replaygainHistoryPath = path.join(app.getPath('userData'), 'replaygain-history.json');
  createWindow();
  // Fire-and-forget launch-time update check. Silent on failure (no network,
  // private repo, rate-limit) so it never interrupts startup.
  setTimeout(() => {
    updater.checkForUpdatesAndNotify(mainWindow).catch(() => {});
  }, 1500);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------- IPC ----------------

ipcMain.handle('config:get', () => cfg);

ipcMain.handle('config:set', (_e, next) => {
  cfg = { ...cfg, ...next };
  saveConfig();
  return cfg;
});

ipcMain.handle('config:pick-folder', async (_e, which) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: which === 'musicRoot' ? 'Pick Music source folder' : 'Pick iPod Genres folder',
  });
  if (result.canceled || !result.filePaths[0]) return null;
  cfg[which] = result.filePaths[0];
  saveConfig();
  return cfg;
});

ipcMain.handle('sync:scan', async (event) => {
  try {
    const t0 = Date.now();
    const result = await scan(cfg.musicRoot, cfg.ipodGenresRoot, (progress) => {
      event.sender.send('scan:progress', progress);
    });
    return { ok: true, ...result, durationMs: Date.now() - t0 };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('sync:cancel', () => {
  cancelRequested = true;
  return true;
});

ipcMain.handle('sync:convert', async (event, tracks) => {
  cancelRequested = false;
  const results = [];
  for (let i = 0; i < tracks.length; i++) {
    if (cancelRequested) {
      event.sender.send('convert:cancelled', { completed: results.length, total: tracks.length });
      return { ok: false, cancelled: true, results };
    }
    const t = tracks[i];
    const destDir = path.join(cfg.ipodGenresRoot, t.genre);

    event.sender.send('convert:track-start', { index: i, total: tracks.length, track: t });

    try {
      const out = await convertOne({
        srcPath: t.path,
        srcFilename: t.fname,
        srcTags: t.tags,
        destGenreDir: destDir,
        onProgress: (info) => {
          event.sender.send('convert:track-progress', { index: i, total: tracks.length, ...info });
        },
      });
      const entry = { ok: true, track: t, ...out };
      results.push(entry);
      event.sender.send('convert:track-done', { index: i, total: tracks.length, ...entry });
    } catch (err) {
      const entry = { ok: false, track: t, error: err.message };
      results.push(entry);
      event.sender.send('convert:track-done', { index: i, total: tracks.length, ...entry });
    }
  }
  return { ok: true, results };
});

ipcMain.handle('sync:delete', async (_e, fullPath) => {
  try {
    fs.unlinkSync(fullPath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('shell:open-folder', (_e, fullPath) => {
  shell.openPath(fullPath);
  return true;
});

// ─── Updater IPC ──────────────────────────────────────────────────────

ipcMain.handle('app:version', () => app.getVersion());

ipcMain.handle('update:check', async (event) => {
  const result = await updater.getUpdateStatus();
  if (result.status === 'available' && mainWindow && !mainWindow.isDestroyed()) {
    event.sender.send('update:available', {
      version: result.version,
      downloadUrl: result.downloadUrl,
      releaseUrl: result.releaseUrl,
    });
  }
  return result;
});

ipcMain.handle('update:can-self-install', () => updater.canSelfInstall());

ipcMain.handle('update:download', async (event, url) => {
  return updater.downloadUpdate(url, (downloaded, total) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      event.sender.send('update:download-progress', { downloaded, total });
    }
  });
});

ipcMain.handle('update:apply', () => updater.applyUpdate());

ipcMain.handle('shell:open-external', (_e, url) => {
  updater.openExternal(url);
  return true;
});

// ─── ReplayGain IPC ───────────────────────────────────────────────────

ipcMain.handle('replaygain:plan', () => {
  try {
    return { ok: true, ...replaygain.planFiles(cfg.ipodGenresRoot, replaygainHistoryPath) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('replaygain:run', async (event, opts = {}) => {
  const mode = opts.mode === 'new' ? 'new' : 'all';
  replaygainCancelRequested = false;
  try {
    const result = await replaygain.processAll(cfg.ipodGenresRoot, {
      mode,
      historyPath: replaygainHistoryPath,
      onProgress: (p) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          event.sender.send('replaygain:progress', p);
        }
      },
      shouldCancel: () => replaygainCancelRequested,
    });
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('replaygain:cancel', () => {
  replaygainCancelRequested = true;
  return true;
});
