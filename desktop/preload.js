// The only bridge between the website and Windows: bring the window forward and flash the
// taskbar when a friend calls while Vortex is minimized to the tray.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vortexDesktop', {
  platform: 'windows',
  ring: (name) => ipcRenderer.send('vx:ring', String(name || 'A friend').slice(0, 40)),
  stopRing: () => ipcRenderer.send('vx:ring-stop'),
  show: () => ipcRenderer.send('vx:show'),
});
