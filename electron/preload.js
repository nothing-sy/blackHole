const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('blackhole', {
  trashPaths: (paths) => ipcRenderer.invoke('trash-paths', paths),
  getTrashSize: () => ipcRenderer.invoke('get-trash-size'),
  emptyTrash: () => ipcRenderer.invoke('empty-trash'),
  applyWindowSize: (size) => ipcRenderer.invoke('apply-window-size', size),
  getWindowMetrics: () => ipcRenderer.invoke('get-window-metrics'),
  setIgnoreMouse: (ignore) => ipcRenderer.invoke('set-ignore-mouse', ignore),
  setPosition: (x, y) => ipcRenderer.invoke('set-position', x, y),
  getCursorPoint: () => ipcRenderer.invoke('get-cursor-point'),
  showContextMenu: () => ipcRenderer.invoke('show-context-menu'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  onTrashEmptied: (cb) => {
    const handler = (_e, result) => cb(result);
    ipcRenderer.on('trash-emptied', handler);
    return () => ipcRenderer.removeListener('trash-emptied', handler);
  },
  getPathForFile: (file) => {
    try {
      if (webUtils && typeof webUtils.getPathForFile === 'function') {
        return webUtils.getPathForFile(file);
      }
    } catch {
      /* fall through */
    }
    return file?.path || '';
  },
});
