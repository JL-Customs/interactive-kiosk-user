const { app, BrowserWindow, ipcMain, Menu, session } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { pathToFileURL } = require('url');
const { autoUpdater } = require('electron-updater');

const UPDATE_INTERVAL_MS = 15 * 60 * 1000;

// ─── Linux / Raspberry Pi runtime knobs (set via environment) ───
// KIOSK=1        -> launch fullscreen, locked kiosk mode (production)
// DISABLE_GPU=1  -> turn off hardware acceleration (fixes black screen /
//                   WebGL crashes seen on some Pi GPU driver combos)
const KIOSK_MODE = process.env.KIOSK === '1' || process.argv.includes('--kiosk');

if (process.env.DISABLE_GPU === '1') {
  app.disableHardwareAcceleration();
}

// electron-updater can only self-update a packaged AppImage on Linux. When the
// app is run unpackaged (npm start) or installed as a .deb, skip the updater so
// it doesn't spam errors — there is simply nothing it can do in those modes.
function canAutoUpdate() {
  if (!app.isPackaged) return false;
  if (process.platform === 'linux') return Boolean(process.env.APPIMAGE);
  return true;
}

let logPath;
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try { if (logPath) fs.appendFileSync(logPath, line); } catch {}
}

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = false;

autoUpdater.on('checking-for-update',   () => log('Checking for update...'));
autoUpdater.on('update-available',      (i) => log(`Update available: v${i.version}`));
autoUpdater.on('update-not-available',  (i) => log(`Up to date: v${i.version}`));
autoUpdater.on('download-progress',     (p) => log(`Downloading: ${Math.round(p.percent)}%`));
autoUpdater.on('update-downloaded',     (i) => { log(`Update downloaded: v${i.version} — installing`); autoUpdater.quitAndInstall(true, true); });
autoUpdater.on('error',                 (e) => log(`Updater error: ${e.message}`));

function setupCache() {
  cacheDir = path.join(app.getPath('userData'), 'photo-cache');
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    autoHideMenuBar: true,
    backgroundColor: '#0d0f12',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    },
    // KIOSK_MODE locks the window fullscreen for the deployed touchscreen.
    // Without it the app runs in a normal window (handy for development).
    fullscreen: KIOSK_MODE,
    kiosk: KIOSK_MODE
  });

  mainWindow.removeMenu();
  mainWindow.loadFile('index.html');

  mainWindow.webContents.on('did-navigate', (event, url) => {
    if (!url.startsWith('file://') && !url.includes('jlcustoms-expert-kiosk')) {
      mainWindow.loadFile('home.html');
    }
  });

}

ipcMain.handle('log:write', (event, msg) => log(msg));

ipcMain.handle('window:toggle-fullscreen', () => {
  if (!mainWindow) return false;
  const nextState = !mainWindow.isFullScreen();
  mainWindow.setFullScreen(nextState);
  return nextState;
});

ipcMain.handle('window:get-fullscreen', () => {
  if (!mainWindow) return false;
  return mainWindow.isFullScreen();
});

ipcMain.handle('cache:save-metadata', (event, photos) => {
  const metadataPath = path.join(cacheDir, 'metadata.json');
  fs.writeFileSync(metadataPath, JSON.stringify(photos, null, 2));
});

ipcMain.handle('cache:load-metadata', () => {
  const metadataPath = path.join(cacheDir, 'metadata.json');
  if (!fs.existsSync(metadataPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  } catch {
    return null;
  }
});

ipcMain.handle('cache:download-photo', (event, { url, filename }) => {
  return new Promise((resolve) => {
    const localPath = path.join(cacheDir, filename);
    if (fs.existsSync(localPath)) {
      resolve(pathToFileURL(localPath).href);
      return;
    }

    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(localPath);
    proto.get(url, (response) => {
      response.pipe(file);
      file.on('finish', () => file.close(() => resolve(pathToFileURL(localPath).href)));
    }).on('error', () => {
      fs.unlink(localPath, () => {});
      resolve(null);
    });
  });
});

ipcMain.handle('cache:get-local-path', (event, filename) => {
  const localPath = path.join(cacheDir, filename);
  if (fs.existsSync(localPath)) {
    return pathToFileURL(localPath).href;
  }
  return null;
});

app.on('ready', () => {
  logPath = path.join(app.getPath('userData'), 'updater.log');
  log(`App started — version ${app.getVersion()}`);
  setupCache();
  Menu.setApplicationMenu(null);

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(true);
  });

  createWindow();

  if (canAutoUpdate()) {
    autoUpdater.checkForUpdates().catch((e) => log(`checkForUpdates error: ${e.message}`));
    setInterval(() => autoUpdater.checkForUpdates().catch((e) => log(`checkForUpdates error: ${e.message}`)), UPDATE_INTERVAL_MS);
  } else {
    log('Auto-update disabled (not a packaged AppImage on this platform).');
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});
