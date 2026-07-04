import { app, BrowserWindow, Tray, Menu, nativeImage, session, ipcMain, globalShortcut, screen, systemPreferences } from 'electron';
import { fileURLToPath } from 'url';
import path from 'path';
import { exec } from 'child_process';
import { uIOhook, UiohookKey } from 'uiohook-napi';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_URL = process.env.VITE_DEV_SERVER_URL;

app.commandLine.appendSwitch('use-fake-ui-for-media-stream', 'false');

let win = null;
let quickWin = null;
let tray = null;
let isQuitting = false;

// Quick-ask overlay (global ⌥Space, Spotlight-style)
const QUICK_WIDTH = 680;
const QUICK_SHORTCUT = 'Alt+Space';

function createQuickWindow() {
  quickWin = new BrowserWindow({
    width: QUICK_WIDTH,
    height: 96,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  // Float above everything, including other apps' fullscreen spaces
  quickWin.setAlwaysOnTop(true, 'screen-saver');
  quickWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  quickWin.on('blur', () => quickWin && quickWin.hide());
  quickWin.on('closed', () => { quickWin = null; });

  if (DEV_URL) {
    quickWin.loadURL(`${DEV_URL}#quick`);
  } else {
    quickWin.loadFile(path.join(__dirname, '../dist/index.html'), { hash: 'quick' });
  }
}

function toggleQuickAsk() {
  if (!quickWin || quickWin.isDestroyed()) createQuickWindow();
  if (quickWin.isVisible()) {
    quickWin.hide();
    return;
  }
  // Center on whichever display the cursor is on, ~20% from the top
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x, y, width, height } = display.workArea;
  quickWin.setPosition(
    Math.round(x + (width - QUICK_WIDTH) / 2),
    Math.round(y + height * 0.2),
    false
  );
  quickWin.show();
  quickWin.focus();
  quickWin.webContents.send('quick-shown');
}

ipcMain.on('quick-hide', () => { if (quickWin) quickWin.hide(); });

// Relay overlay exchanges to the main HUD so both windows share one conversation
ipcMain.on('quick-exchange', (_event, exchange) => {
  if (win && !win.isDestroyed()) win.webContents.send('quick-exchange', exchange);
});

// The renderer reports its content height so the transparent window never
// blocks clicks beyond the visible panel
ipcMain.on('quick-resize', (_event, contentHeight) => {
  if (!quickWin) return;
  const h = Math.max(80, Math.min(Math.round(contentHeight), 560));
  const [wx, wy] = quickWin.getPosition();
  quickWin.setBounds({ x: wx, y: wy, width: QUICK_WIDTH, height: h });
});

// Global push-to-talk: hold ⌥V anywhere, release to send
/* Uses uiohook-napi for system-wide key down/up events (Electron's
   globalShortcut has no key-release event, so it can't do hold-to-talk).
   Requires Input Monitoring permission on macOS:
   System Settings → Privacy & Security → Input Monitoring → enable Electron/Jarvis. */
let pttActive = false;
let pttHookRunning = false;

function pttSend(channel) {
  if (win && !win.isDestroyed()) win.webContents.send(channel);
}

function attachGlobalPttHook() {
  if (pttHookRunning) return;
  uIOhook.on('keydown', (e) => {
    if (e.keycode === UiohookKey.V && e.altKey && !pttActive) {
      pttActive = true;
      if (DEV_URL) console.log('[ptt] ⌥V down — recording');
      pttSend('ptt-down');
    }
  });
  uIOhook.on('keyup', (e) => {
    if (!pttActive) return;
    // Stop when either V or Option is released
    if (e.keycode === UiohookKey.V || e.keycode === UiohookKey.Alt || e.keycode === UiohookKey.AltRight) {
      pttActive = false;
      if (DEV_URL) console.log('[ptt] released — sending');
      pttSend('ptt-up');
    }
  });
  try {
    uIOhook.start();
    pttHookRunning = true;
    console.log('[ptt] global key hook running — hold ⌥V anywhere to talk');
  } catch (err) {
    console.warn('[ptt] global key hook failed to start:', err?.message ?? err);
  }
}

function startGlobalPtt() {
  // macOS: the key hook needs Accessibility trust. Asking explicitly forces the
  // app to appear in System Settings → Privacy & Security → Accessibility —
  // otherwise it may never show up in the list at all.
  if (process.platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(false)) {
    systemPreferences.isTrustedAccessibilityClient(true); // shows the macOS prompt + adds to list
    console.warn(
      '[ptt] Waiting for Accessibility permission — enable "Electron" in ' +
      'System Settings → Privacy & Security → Accessibility. No restart needed, checking every 2s…'
    );
    const poll = setInterval(() => {
      if (systemPreferences.isTrustedAccessibilityClient(false)) {
        clearInterval(poll);
        console.log('[ptt] Accessibility permission granted');
        attachGlobalPttHook();
      }
    }, 2000);
    poll.unref?.();
    return;
  }
  attachGlobalPttHook();
}

function createTray() {
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle('J');
  tray.setToolTip('J.A.R.V.I.S');

  const updateMenu = () => {
    const visible = win && win.isVisible();
    tray.setContextMenu(Menu.buildFromTemplate([
      {
        label: visible ? 'Hide Jarvis' : 'Show Jarvis',
        click: () => {
          if (!win) return;
          win.isVisible() ? win.hide() : (win.show(), win.focus());
          updateMenu();
        },
      },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]));
  };

  updateMenu();

  tray.on('click', () => {
    if (!win) return;
    win.isVisible() ? win.hide() : (win.show(), win.focus());
    updateMenu();
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#030A12',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  // Hide to tray when the user closes the window — but allow a real quit
  win.on('close', (e) => {
    if (isQuitting) return;
    e.preventDefault();
    win.hide();
  });

  // Always grant mic/camera permissions
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowed = ['media', 'microphone', 'camera', 'audioCapture', 'mediaKeySystem'];
    callback(allowed.includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    const allowed = ['media', 'microphone', 'camera', 'audioCapture', 'mediaKeySystem'];
    return allowed.includes(permission);
  });

  if (DEV_URL) {
    win.loadURL(DEV_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

// Handle open-app requests from renderer
ipcMain.handle('open-app', (_event, appName) => {
  return new Promise((resolve) => {
    // Sanitize: only allow alphanumeric, spaces, dots, hyphens
    const safe = appName.replace(/[^a-zA-Z0-9 .\-]/g, '').trim();
    if (!safe) return resolve({ ok: false, error: 'Invalid app name' });
    exec(`open -a "${safe}"`, (err) => {
      if (!err) return resolve({ ok: true });
      // Exact name failed — fuzzy-match against installed apps
      // (handles "Opera" → "Opera GX", "code" → "Visual Studio Code", etc.)
      exec('ls /Applications ~/Applications /System/Applications 2>/dev/null', (lsErr, out) => {
        if (lsErr) return resolve({ ok: false, error: err.message });
        const apps = out.split('\n').filter(l => l.endsWith('.app')).map(l => l.slice(0, -4));
        const q = safe.toLowerCase();
        const match =
          apps.find(a => a.toLowerCase() === q) ||
          apps.find(a => a.toLowerCase().startsWith(q)) ||
          apps.find(a => a.toLowerCase().includes(q)) ||
          apps.find(a => q.includes(a.toLowerCase()));
        if (!match) return resolve({ ok: false, error: `No installed application matches "${safe}"` });
        exec(`open -a "${match}"`, (e2) => {
          resolve(e2 ? { ok: false, error: e2.message } : { ok: true, opened: match });
        });
      });
    });
  });
});

function stopGlobalPtt() {
  if (!pttHookRunning) return;
  pttHookRunning = false;
  try { uIOhook.stop(); } catch { /* already stopped */ }
}

// Mark a real quit so the window 'close' handler stops hiding to tray
app.on('before-quit', () => {
  isQuitting = true;
  stopGlobalPtt(); // the uiohook native thread can keep a dead app alive
});

// Force a clean shutdown (Ctrl-C in the terminal, dev server exit, etc.)
function quitApp() {
  if (isQuitting) return;
  isQuitting = true;
  stopGlobalPtt();
  app.quit();
  // Hard-exit fallback in case something keeps the process alive.
  // Deliberately NOT unref'd — it must fire even if quit stalls.
  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGINT', quitApp);
process.on('SIGTERM', quitApp);
process.on('SIGHUP', quitApp);

// In dev, Electron is a child of the Vite dev server. If Vite dies (Ctrl-C),
// our parent pid changes (reparented to launchd) — quit instead of lingering.
if (DEV_URL) {
  const parentPid = process.ppid;
  setInterval(() => {
    if (process.ppid !== parentPid) quitApp();
  }, 1000).unref();
}

app.whenReady().then(() => {
  createWindow();
  createTray();
  createQuickWindow();
  startGlobalPtt();
  // Swallow ⌥V system-wide so holding it doesn't type "√√√…" into the focused
  // app — the uiohook listener above still receives the raw down/up events.
  if (!globalShortcut.register('Alt+V', () => {})) {
    console.warn('[ptt] could not reserve ⌥V — another app owns it; PTT still works but may type "√"');
  }
  if (!globalShortcut.register(QUICK_SHORTCUT, toggleQuickAsk)) {
    console.warn(`[quick-ask] could not register ${QUICK_SHORTCUT} — already taken by another app`);
  }
  app.on('activate', () => {
    if (win) { win.show(); win.focus(); }
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopGlobalPtt();
});

app.on('window-all-closed', () => {
  // On macOS, keep app running in tray — quit via tray menu
  if (process.platform !== 'darwin') app.quit();
});
