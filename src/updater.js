// In-app updater for the NSIS-installed Windows build and the arm64 DMG macOS
// build. Architecture lifted from Z:\global .md\updater.md (the cross-project
// reference doc).
//
// IMPORTANT: the unauthenticated GitHub API only returns releases from PUBLIC
// repos. While the repo is private, every call here resolves to a soft failure
// (no update notice). Flip the repo to public on GitHub when you want updates
// to start working — no code change required.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { spawn } = require('child_process');
const { app, shell } = require('electron');

const REPO_OWNER = 'robogears';
const REPO_NAME = 'FLACtoiPod';

// Windows asset substring → flac-to-ipod-setup.exe.
// macOS asset substring   → flac-to-ipod-mac-arm64.dmg.
const ASSET_SUBSTR_WIN = 'setup.exe';
const ASSET_SUBSTR_MAC = 'mac-arm64.dmg';

let _pendingUpdatePath = null;

// ─── Fetch latest release ────────────────────────────────────────────────

function fetchLatestRelease() {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.github.com',
      path: `/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`,
      method: 'GET',
      headers: {
        'User-Agent': `flac-to-ipod/${app.getVersion()}`,
        'Accept': 'application/vnd.github+json',
      },
      timeout: 10_000,
    }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// Strict numeric-segment compare so "0.1.10" beats "0.1.2".
function isNewerVersion(remote, current) {
  const r = String(remote).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const c = String(current).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(r.length, c.length);
  for (let i = 0; i < len; i++) {
    const a = r[i] || 0, b = c[i] || 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return false;
}

async function getUpdateStatus() {
  const release = await fetchLatestRelease();
  if (!release || !release.tag_name) {
    return { status: 'error', message: 'Could not reach GitHub' };
  }
  if (!isNewerVersion(release.tag_name, app.getVersion())) {
    return { status: 'up-to-date', version: app.getVersion() };
  }
  const wantedSubstr = process.platform === 'darwin' ? ASSET_SUBSTR_MAC
                     : process.platform === 'win32'  ? ASSET_SUBSTR_WIN
                     : null;
  let downloadUrl = release.html_url;
  if (wantedSubstr) {
    const asset = (release.assets || []).find((a) => a.name && a.name.includes(wantedSubstr));
    if (asset && asset.browser_download_url) downloadUrl = asset.browser_download_url;
  }
  return {
    status: 'available',
    version: release.tag_name,
    downloadUrl,
    releaseUrl: release.html_url,
  };
}

// ─── Self-install capability ─────────────────────────────────────────────

function canSelfInstall() {
  if (!app.isPackaged) return false;
  return process.platform === 'win32' || process.platform === 'darwin';
}

// ─── Streamed download with progress ─────────────────────────────────────

function downloadToFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const fetch = (u, redirects = 0) => {
      const req = https.request(u, {
        method: 'GET',
        headers: { 'User-Agent': `flac-to-ipod/${app.getVersion()}` },
      }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
          res.resume();
          return fetch(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
        }
        const total = parseInt(res.headers['content-length'] || '0', 10) || 0;
        let downloaded = 0;
        const out = fs.createWriteStream(destPath);
        res.on('data', (chunk) => {
          downloaded += chunk.length;
          if (onProgress) onProgress(downloaded, total);
        });
        res.pipe(out);
        out.on('finish', () => out.close(resolve));
        out.on('error', reject);
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(60_000, () => { req.destroy(new Error('Download timed out')); });
      req.end();
    };
    fetch(url);
  });
}

// ─── macOS: mount DMG + extract .app ─────────────────────────────────────

function mountAndExtractMacDmg(dmgPath) {
  return new Promise((resolve, reject) => {
    const ts = Date.now();
    const mountPoint = path.join(os.tmpdir(), `app-mount-${ts}`);
    const stagingDir = path.join(os.tmpdir(), `app-update-${ts}`);
    try { fs.mkdirSync(stagingDir, { recursive: true }); } catch {}

    const detach = () => {
      try { spawn('hdiutil', ['detach', '-quiet', mountPoint], { stdio: 'ignore' }).unref(); } catch {}
    };

    const attach = spawn('hdiutil',
      ['attach', '-nobrowse', '-quiet', '-mountpoint', mountPoint, dmgPath],
      { stdio: 'ignore' });
    attach.on('error', reject);
    attach.on('close', (code) => {
      if (code !== 0) return reject(new Error(`hdiutil attach exit ${code}`));
      let appName;
      try { appName = fs.readdirSync(mountPoint).find((n) => n.endsWith('.app')); }
      catch (e) { detach(); return reject(new Error(`Read mount: ${e.message}`)); }
      if (!appName) { detach(); return reject(new Error('No .app in DMG')); }

      const sourceApp = path.join(mountPoint, appName);
      const destApp = path.join(stagingDir, appName);
      const cp = spawn('ditto', [sourceApp, destApp], { stdio: 'ignore' });
      cp.on('error', (err) => { detach(); reject(err); });
      cp.on('close', (cpCode) => {
        detach();
        if (cpCode !== 0) return reject(new Error(`ditto exit ${cpCode}`));
        resolve(destApp);
      });
    });
  });
}

// ─── Download orchestrator ───────────────────────────────────────────────

async function downloadUpdate(url, onProgress) {
  if (!canSelfInstall()) return { ok: false, error: 'Not supported on this platform / dev mode' };
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return { ok: false, error: 'Invalid URL' };

  const ext = process.platform === 'darwin' ? '.dmg' : '.exe';
  const destPath = path.join(os.tmpdir(), `flac-to-ipod-update-${Date.now()}${ext}`);
  try {
    await downloadToFile(url, destPath, onProgress);
    _pendingUpdatePath = process.platform === 'darwin'
      ? await mountAndExtractMacDmg(destPath)
      : destPath;
    return { ok: true, path: _pendingUpdatePath };
  } catch (e) {
    try { fs.unlinkSync(destPath); } catch {}
    return { ok: false, error: e.message };
  }
}

// ─── Apply update (spawn relauncher, then quit) ──────────────────────────

function applyUpdate() {
  if (!_pendingUpdatePath) return { ok: false, error: 'No pending update' };

  if (process.platform === 'win32') {
    // NSIS oneClick: silent install with --updated marker, NSIS detects + kills
    // the running app, replaces files in %LOCALAPPDATA%\Programs\..., and
    // relaunches via runAfterFinish: true.
    try {
      const child = spawn(_pendingUpdatePath, ['/S', '--updated'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      setTimeout(() => app.quit(), 200);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  if (process.platform === 'darwin') {
    try {
      // Detect translocation: a quarantined .app launched from outside
      // /Applications/ runs from a read-only AppTranslocation shadow.
      const runningAppBundle = app.getPath('exe').replace(/\/Contents\/MacOS\/[^/]+$/, '');
      const isTranslocated = runningAppBundle.includes('/AppTranslocation/');
      const targetAppBundle = isTranslocated
        ? path.join('/Applications', app.getName() + '.app')
        : runningAppBundle;

      const ts = Date.now();
      const scriptPath = path.join(os.tmpdir(), `flac-to-ipod-update-${ts}.sh`);
      const logDir = path.join(os.homedir(), 'Library', 'Logs', app.getName());
      try { fs.mkdirSync(logDir, { recursive: true }); } catch {}
      const logPath = path.join(logDir, `update-${ts}.log`);

      const attemptLogPath = path.join(logDir, 'attempts.log');
      try {
        fs.appendFileSync(attemptLogPath,
          `[${new Date().toISOString()}] applyUpdate\n  pid: ${process.pid}\n  new: ${_pendingUpdatePath}\n  target: ${targetAppBundle}\n  log: ${logPath}\n`);
      } catch {}

      const script = [
        '#!/bin/bash',
        `LOG="${logPath}"`,
        '# Stage 1: re-exec into a fully detached background subshell',
        'if [ "$1" != "--daemonized" ]; then',
        '    nohup "$0" --daemonized "$@" </dev/null >/dev/null 2>&1 &',
        '    disown',
        '    exit 0',
        'fi',
        'shift',
        'exec >>"$LOG" 2>&1',
        'set -x',
        'echo "=== update script started $(date) ==="',
        'trap "" HUP TERM',
        'PID=$1',
        `NEW_APP="${_pendingUpdatePath}"`,
        `TARGET="${targetAppBundle}"`,
        'BACKUP="${TARGET}.bak"',
        'echo "PID=$PID NEW=$NEW_APP TARGET=$TARGET"',
        'for i in $(seq 1 30); do',
        '    if ! ps -p $PID > /dev/null 2>&1; then echo "Parent gone after ${i}s"; break; fi',
        '    sleep 1',
        'done',
        'xattr -dr com.apple.quarantine "$NEW_APP" 2>/dev/null || true',
        'if [ -d "$TARGET" ]; then',
        '    rm -rf "$BACKUP" 2>/dev/null',
        '    if ! mv "$TARGET" "$BACKUP"; then',
        '        echo "ERROR: could not back up existing TARGET (permission?). Aborting."',
        '        rm -f "$0"',
        '        exit 1',
        '    fi',
        'fi',
        'if mv "$NEW_APP" "$TARGET"; then',
        '    codesign --force --deep --sign - "$TARGET" 2>&1 || true',
        '    rm -rf "$BACKUP" 2>/dev/null',
        '    open "$TARGET"',
        'else',
        '    echo "ERROR: mv NEW->TARGET failed. Rolling back."',
        '    [ -d "$BACKUP" ] && [ ! -d "$TARGET" ] && mv "$BACKUP" "$TARGET"',
        '    [ -d "$TARGET" ] && open "$TARGET"',
        'fi',
        'echo "=== script finished $(date) ==="',
        'rm -f "$0"',
        '',
      ].join('\n');
      fs.writeFileSync(scriptPath, script);
      fs.chmodSync(scriptPath, 0o755);

      const child = spawn('/bin/bash', [scriptPath, String(process.pid)], {
        detached: true,
        stdio: 'ignore',
      });
      child.on('error', (err) => {
        try { fs.appendFileSync(attemptLogPath, `  SPAWN ERROR: ${err.message}\n`); } catch {}
      });
      child.unref();
      setTimeout(() => app.quit(), 500);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  return { ok: false, error: 'Unsupported platform' };
}

// ─── Launch-time check ───────────────────────────────────────────────────

async function checkForUpdatesAndNotify(mainWindow) {
  const result = await getUpdateStatus();
  if (result.status === 'available' && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:available', {
      version: result.version,
      downloadUrl: result.downloadUrl,
      releaseUrl: result.releaseUrl,
    });
  }
  return result;
}

function openExternal(url) {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
}

module.exports = {
  getUpdateStatus,
  canSelfInstall,
  downloadUpdate,
  applyUpdate,
  checkForUpdatesAndNotify,
  openExternal,
};
