const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cm', {
  onData: (cb) => ipcRenderer.on('pty:data', (_e, data) => cb(data)),
  onConfig: (cb) => ipcRenderer.on('terminal:config', (_e, cfg) => cb(cfg)),
  onFocus: (cb) => ipcRenderer.on('terminal:focus', () => cb()),
  onDivider: (cb) => ipcRenderer.on('terminal:divider', (_e, show) => cb(show)),
  write: (data) => ipcRenderer.send('pty:write', data),
  resize: (cols, rows) => ipcRenderer.send('pty:resize', cols, rows),
  title: (title) => ipcRenderer.send('terminal:title', title),
  osc: (code, payload) => ipcRenderer.send('terminal:osc', code, payload),
  bell: () => ipcRenderer.send('terminal:bell'),
  appearance: (mode) => ipcRenderer.send('terminal:appearance', mode),
  dragDivider: (screenX) => ipcRenderer.send('layout:drag', screenX),
  ready: () => ipcRenderer.send('terminal:ready'),
  debug: (msg) => ipcRenderer.send('terminal:debug', msg),
  dropText: (data) => ipcRenderer.invoke('terminal:drop', data),
});
