// Vortex Video for Windows: a small Electron shell around https://vortex-video.pages.dev.
// Closing the window keeps Vortex in the tray so friends can still ring you; Quit is in the tray menu.
const { app, BrowserWindow, Tray, Menu, Notification, nativeImage, shell, session, desktopCapturer, ipcMain } = require('electron');
const path = require('path');

const ORIGIN = 'https://vortex-video.pages.dev';
const ICON = path.join(__dirname, 'build', 'icon.png');
let win = null, tray = null, quitting = false;

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => show());
app.setAppUserModelId('dev.pages.vortex_video.desktop');

function show() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function ours(url) {
  try { return new URL(url).origin === ORIGIN; } catch { return false; }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 380, minHeight: 560,
    backgroundColor: '#07070C', title: 'Vortex Video', icon: ICON, autoHideMenuBar: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  win.once('ready-to-show', () => win.show());
  win.loadURL(ORIGIN + '/');
  // links to other sites open in the normal browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!ours(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!ours(url)) { e.preventDefault(); shell.openExternal(url); } });
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (tray && !app.vxToldTray) {
      app.vxToldTray = true;
      new Notification({ title: 'Vortex Video is still running', body: 'Friends can still call you. Quit from the tray icon.', icon: ICON }).show();
    }
  });
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip('Vortex Video');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Vortex Video', click: show },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', show);
}

app.whenReady().then(() => {
  const ses = session.defaultSession;
  // camera, mic, notifications, screen share and fullscreen for Vortex only
  const allowed = new Set(['media', 'notifications', 'display-capture', 'fullscreen', 'clipboard-sanitized-write', 'clipboard-read', 'speaker-selection', 'geolocation', 'window-management']);
  ses.setPermissionRequestHandler((wc, perm, cb, details) => cb(allowed.has(perm) && ours(details.requestingUrl || wc.getURL())));
  ses.setPermissionCheckHandler((wc, perm, origin) => allowed.has(perm) && ours(origin));
  // "Share screen" shares the main screen (with system audio); Windows has no built-in picker for Electron
  ses.setDisplayMediaRequestHandler((req, cb) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((s) => cb(s.length ? { video: s[0], audio: 'loopback' } : {})).catch(() => cb({}));
  });

  ipcMain.on('vx:version', (e) => { e.returnValue = app.getVersion(); });
  ipcMain.on('vx:show', show);
  ipcMain.on('vx:ring', (e, name) => {
    if (!win || (win.isVisible() && win.isFocused())) return;
    const n = new Notification({ title: `${name} is calling`, body: 'Click to answer in Vortex Video', icon: ICON, urgency: 'critical' });
    n.on('click', show);
    n.show();
    win.flashFrame(true);
    if (!win.isVisible()) { win.showInactive(); }
  });
  ipcMain.on('vx:ring-stop', () => { if (win) win.flashFrame(false); });

  createWindow();
  createTray();
});

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { /* stays in the tray */ });
