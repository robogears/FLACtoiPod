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
  },
  on: (channel, handler) => {
    const allowed = new Set([
      'scan:progress',
      'convert:track-start',
      'convert:track-progress',
      'convert:track-done',
      'convert:cancelled',
    ]);
    if (!allowed.has(channel)) return () => {};
    const listener = (_e, payload) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
