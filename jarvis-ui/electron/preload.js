const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openApp: (appName) => ipcRenderer.invoke('open-app', appName),
  // Quick-ask overlay (global ⌥Space panel)
  hideQuickAsk: () => ipcRenderer.send('quick-hide'),
  resizeQuickAsk: (height) => ipcRenderer.send('quick-resize', height),
  onQuickShown: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('quick-shown', handler);
    return () => ipcRenderer.removeListener('quick-shown', handler);
  },
  // Overlay → main HUD conversation sync
  sendQuickExchange: (exchange) => ipcRenderer.send('quick-exchange', exchange),
  onQuickExchange: (cb) => {
    const handler = (_event, exchange) => cb(exchange);
    ipcRenderer.on('quick-exchange', handler);
    return () => ipcRenderer.removeListener('quick-exchange', handler);
  },
  // Global push-to-talk (hold ⌥V anywhere, even when Jarvis isn't focused)
  onPttDown: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('ptt-down', handler);
    return () => ipcRenderer.removeListener('ptt-down', handler);
  },
  onPttUp: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('ptt-up', handler);
    return () => ipcRenderer.removeListener('ptt-up', handler);
  },
});
