const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (next) => ipcRenderer.invoke('config:set', next),
    pickFolder: (which) => ipcRenderer.invoke('config:pick-folder', which),
  },
  sync: {
    scan: () => ipcRenderer.invoke('sync:scan'),
    convert: (tracks) => ipcRenderer.invoke('sync:convert', tracks),
    cancel: () => ipcRenderer.invoke('sync:cancel'),
    delete: (fullPath) => ipcRenderer.invoke('sync:delete', fullPath),
  },
  shell: {
    openFolder: (fullPath) => ipcRenderer.invoke('shell:open-folder', fullPath),
    openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  },
  app: {
    version: () => ipcRenderer.invoke('app:version'),
  },
  updater: {
    check: () => ipcRenderer.invoke('update:check'),
    canSelfInstall: () => ipcRenderer.invoke('update:can-self-install'),
    download: (url) => ipcRenderer.invoke('update:download', url),
    apply: () => ipcRenderer.invoke('update:apply'),
  },
  replaygain: {
    plan: () => ipcRenderer.invoke('replaygain:plan'),
    run: (mode) => ipcRenderer.invoke('replaygain:run', { mode }),
    cancel: () => ipcRenderer.invoke('replaygain:cancel'),
  },
  on: (channel, handler) => {
    const allowed = new Set([
      'scan:progress',
      'convert:track-start',
      'convert:track-progress',
      'convert:track-done',
      'convert:cancelled',
      'update:available',
      'update:download-progress',
      'replaygain:progress',
    ]);
    if (!allowed.has(channel)) return () => {};
    const listener = (_e, payload) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
