//
/**
 * LuxShift – Main Process
 *
 * This version delegates all wind‑down calculations, Night Shift control,
 * brightness adjustments, and sunlight‑nudge logic to the dedicated
 * `display-engine.js` module. The renderer continues to receive the same IPC
 * events (`luxshift:winddown-state` and `luxshift:sunlight-nudge`) so no UI
 * changes are required.
 */

const {
  app,
  BrowserWindow,
  ipcMain,
  Notification,
  Tray,
  Menu,
  nativeImage,
  dialog,
  shell,
  systemPreferences
} = require('electron');

const path = require('path');
const PreferencesStore = require('electron-store').default;
const {
  getActiveSchedule,
  saveActiveSchedule,
  clearActiveSchedule,
  archiveExpiredActiveSchedule
} = require('./schedule-store.js');

// ---- Display Engine ---------------------------------------------------------
const displayEngine = require('./display-engine.js'); // <-- new import
// -----------------------------------------------------------------------------

const GITHUB_REPO = 'LuxshiftOfficial/Luxshift';

let preferencesStore;
let mainWindow = null;
let tray = null;
let lastWindDownSnapshot = null;
let isQuitting = false;

// -----------------------------------------------------------------------------
// Default preferences (unchanged)
const DEFAULT_PREFERENCES = {
  bedtimeTarget: '00:30',
  wakeTarget: '07:30',
  windDownMinutes: 90,
  preferredLocationName: '',
  preferredLocation: null,
  timeFormat: '12h',
  timeFormatChosen: false
};
// -----------------------------------------------------------------------------

function getTrayIcon() {
  const templatePath = path.join(__dirname, 'assets', 'tray-iconTemplate.png');
  const alternatePath = path.join(__dirname, 'assets', 'tray-icon.png');

  for (const iconPath of [templatePath, alternatePath]) {
    try {
      const image = nativeImage.createFromPath(iconPath);
      if (!image.isEmpty()) return image.resize({ width: 18, height: 18 });
    } catch (_) {}
  }

  const svg = `
    <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
      <rect x="2" y="2" width="14" height="14" rx="4" fill="white"/>
      <path d="M6 5.4h1.5v5.1h4.7V12H6V5.4Z" fill="black"/>
    </svg>
  `.trim();

  return nativeImage.createFromDataURL(
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  );
}

// -----------------------------------------------------------------------------
// Window & Tray management (unchanged apart from start‑engine hook)
function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1180,
    minHeight: 760,
    title: 'LuxShift',
    backgroundColor: '#08111f',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('close', (event) => {
    if (isQuitting) return;

    event.preventDefault();
    mainWindow.hide();

    if (Notification.isSupported()) {
      try {
        new Notification({
          title: 'LuxShift is still running',
          body: 'LuxShift moved to the menu bar so wind‑down support can continue.'
        }).show();
      } catch (_) {}
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

// -----------------------------------------------------------------------------
// Tray UI (unchanged)
function showMainWindow() {
  const win = createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return win;
}
function hideMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
}
function toggleMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
    hideMainWindow();
    return;
  }
  showMainWindow();
}
function getAllWindows() {
  return BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
}
function broadcast(channel, payload) {
  for (const win of getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

// -----------------------------------------------------------------------------
// Preference handling (unchanged)
function getPreferences() {
  return {
    ...DEFAULT_PREFERENCES,
    ...(preferencesStore?.store || {})
  };
}
function normalizeHHMM(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return fallback;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return fallback;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return fallback;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}
function normalizeLocation(value) {
  if (!value || typeof value !== 'object') return null;
  const latitude = Number(value.latitude);
  const longitude = Number(value.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return {
    id: typeof value.id === 'string' ? value.id : `${latitude},${longitude}`,
    name: String(value.name || '').trim(),
    latitude,
    longitude,
    timezone: typeof value.timezone === 'string' ? value.timezone : null,
    country: typeof value.country === 'string' ? value.country : null,
    admin1: typeof value.admin1 === 'string' ? value.admin1 : null
  };
}
function buildSafePreferences(payload = {}) {
  const current = getPreferences();
  const requestedLocation =
    payload?.preferredLocation === null
      ? null
      : normalizeLocation(payload?.preferredLocation) || current.preferredLocation;

  return {
    bedtimeTarget: normalizeHHMM(payload?.bedtimeTarget, current.bedtimeTarget),
    wakeTarget: normalizeHHMM(payload?.wakeTarget, current.wakeTarget),
    windDownMinutes: Math.min(
      180,
      Math.max(
        15,
        Number.isFinite(Number(payload?.windDownMinutes))
          ? Number(payload.windDownMinutes)
          : current.windDownMinutes
      )
    ),
    preferredLocationName:
      typeof payload?.preferredLocationName === 'string'
        ? payload.preferredLocationName.trim()
        : current.preferredLocationName,
    preferredLocation: requestedLocation,
    timeFormat: payload?.timeFormat === '24h' ? '24h' : '12h',
    timeFormatChosen: Boolean(payload?.timeFormatChosen ?? current.timeFormatChosen)
  };
}

// -----------------------------------------------------------------------------
// Permission helpers (unchanged)
function hasAccessibilityPermission() {
  if (process.platform !== 'darwin') return true;
  try {
    return systemPreferences.isTrustedAccessibilityClient(false);
  } catch (_) {
    return false;
  }
}
function requestAccessibilityPermission() {
  if (process.platform !== 'darwin') return;
  try {
    systemPreferences.isTrustedAccessibilityClient(true);
  } catch (_) {}
}
async function openAccessibilitySettings() {
  try {
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
  } catch (_) {
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security');
  }
}
let _permissionPollInterval = null;
function startPermissionPolling(win) {
  if (_permissionPollInterval) return;
  _permissionPollInterval = setInterval(() => {
    if (!win || win.isDestroyed()) {
      clearInterval(_permissionPollInterval);
      _permissionPollInterval = null;
      return;
    }
    const hasPermission = hasAccessibilityPermission();
    win.webContents.send('luxshift:permission-status', { accessibility: hasPermission });
    if (hasPermission) {
      clearInterval(_permissionPollInterval);
      _permissionPollInterval = null;
    }
  }, 2000);
}

// -----------------------------------------------------------------------------
// App lifecycle ---------------------------------------------------------------
app.whenReady().then(async () => {
  app.setName('LuxShift');

  preferencesStore = new PreferencesStore({
    name: 'luxshift-preferences',
    cwd: app.getPath('userData'),
    defaults: DEFAULT_PREFERENCES
  });

  // Archive any expired schedule first
  archiveExpiredActiveSchedule();

  // -----------------------------------------------------------
  // **Start the background display engine**
  // -----------------------------------------------------------
  // The engine receives three callbacks:
  //   1️⃣ getPreferences – current user prefs (incl. wind‑down lead time)
  //   2️⃣ getActiveSchedule – the schedule the user is currently working on
  //   3️⃣ an Electron BrowserWindow instance for IPC
  // -----------------------------------------------------------
  const win = createWindow(); // ensure the window exists before the engine starts
  displayEngine.startEngine(win, getPreferences, getActiveSchedule);
  // -----------------------------------------------------------

  // Create the tray UI (still useful for quick access)
  createTray();

  // Background update check (unchanged)
  checkForUpdates(false).catch(() => {});

  // Re‑open the main window when the dock icon is clicked (macOS)
  app.on('activate', showMainWindow);
});

app.on('before-quit', () => {
  isQuitting = true;
  // Gracefully stop the display engine
  displayEngine.stopEngine();
});
app.on('window-all-closed', (event) => {
  event.preventDefault(); // keep app alive in the tray
});

// -----------------------------------------------------------------------------
// IPC handlers (unchanged – only permission‑related ones kept)
// -----------------------------------------------------------------------------
// Preferences
ipcMain.handle('luxshift:get-preferences', async () => getPreferences());
ipcMain.handle('luxshift:save-preferences', async (_event, payload) => {
  const next = buildSafePreferences(payload);
  preferencesStore.set(next);
  // Force a fresh wind‑down broadcast so the UI updates immediately.
  // The display engine will pick up the new prefs on its next tick.
  return {
    ok: true,
    preferences: getPreferences(),
    windDownState: await displayEngine.getCurrentState()
  };
});

// Schedule store
ipcMain.handle('luxshift:get-active-schedule', async () => getActiveSchedule());
ipcMain.handle('luxshift:save-active-schedule', async (_event, payload) => {
  const result = saveActiveSchedule(payload);
  // The display engine reads the schedule directly on its next tick,
  // so we just acknowledge success here.
  return result;
});
ipcMain.handle('luxshift:clear-active-schedule', async () => {
  const result = clearActiveSchedule();
  return result;
});
ipcMain.handle('luxshift:archive-expired-schedule', async () => {
  const result = archiveExpiredActiveSchedule();
  return result;
});

// Wind-down state
// Lets the renderer render the overlay immediately on startup and right
// after saving preferences, instead of waiting up to 60s for the next
// display-engine tick. Matches the getWindDownState bridge in preload.js.
ipcMain.handle('luxshift:get-winddown-state', async () => displayEngine.getCurrentState());

// Location / environment & notifications (unchanged)
ipcMain.handle('luxshift:search-location', async (_event, query) => {
  const search = String(query || '').trim();
  if (search.length < 2) {
    return { ok: false, error: 'Please enter at least 2 characters.' };
  }
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(search)}&count=6&language=en&format=json`;
    const response = await fetch(url);
    if (!response.ok) {
      return { ok: false, error: `Location search failed (${response.status}).` };
    }
    const data = await response.json();
    const results = Array.isArray(data?.results)
      ? data.results.map((item) => ({
          id: `${item.latitude},${item.longitude}`,
          name: item.name || '',
          admin1: item.admin1 || '',
          country: item.country || '',
          latitude: item.latitude,
          longitude: item.longitude,
          timezone: item.timezone || null
        }))
      : [];
    return { ok: true, results };
  } catch (error) {
    return { ok: false, error: error?.message || 'Location search failed.' };
  }
});

ipcMain.handle('luxshift:get-environment', async (_event, coords) => {
  const latitude = Number(coords?.latitude);
  const longitude = Number(coords?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { ok: false, error: 'Valid latitude and longitude are required.' };
  }
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}&current=temperature_2m,apparent_temperature,cloud_cover,precipitation,weather_code,is_day&timezone=auto&forecast_days=1`;
    const response = await fetch(url);
    if (!response.ok) {
      return { ok: false, error: `Environment lookup failed (${response.status}).` };
    }
    const data = await response.json();
    const current = data?.current || {};
    return {
      ok: true,
      weather: {
        temperature2m: current.temperature_2m,
        apparentTemperature: current.apparent_temperature,
        cloudcover: current.cloud_cover,
        precipitation: current.precipitation,
        weatherCode: current.weather_code,
        isday: current.is_day
      },
      environment: {
        latitude,
        longitude,
        timezone: data?.timezone || null,
        current
      }
    };
  } catch (error) {
    return { ok: false, error: error?.message || 'Environment lookup failed.' };
  }
});

ipcMain.handle('luxshift:notify', async (_event, payload) => {
  if (!Notification.isSupported()) {
    return { ok: false, error: 'Notifications are not supported on this device.' };
  }
  try {
    new Notification({
      title: String(payload?.title || 'LuxShift').trim() || 'LuxShift',
      body: String(payload?.body || '').trim()
    }).show();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || 'Notification failed.' };
  }
});

// Update checks (unchanged)
ipcMain.handle('luxshift:check-for-updates', async () => {
  await checkForUpdates(true);
  return { ok: true };
});

// Permission IPC (unchanged)
ipcMain.handle('luxshift:check-permissions', async () => ({
  accessibility: hasAccessibilityPermission()
}));
ipcMain.handle('luxshift:request-accessibility', async () => {
  requestAccessibilityPermission();
  if (mainWindow && !mainWindow.isDestroyed()) {
    startPermissionPolling(mainWindow);
    await openAccessibilitySettings();
  }
  return { ok: true };
});
ipcMain.handle('luxshift:open-accessibility-settings', async () => {
  await openAccessibilitySettings();
  if (mainWindow && !mainWindow.isDestroyed()) startPermissionPolling(mainWindow);
  return { ok: true };
});

// -----------------------------------------------------------------------------
// Update check helper (unchanged)
async function checkForUpdates(showFeedback = false) {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      { headers: { Accept: 'application/vnd.github+json' } }
    );
    if (!response.ok) throw new Error(`GitHub release lookup failed (${response.status}).`);
    const release = await response.json();
    const latestVersion = release?.tag_name || release?.name;
    const currentVersion = app.getVersion();

    if (!latestVersion) {
      if (showFeedback) {
        await dialog.showMessageBox({
          type: 'info',
          title: 'LuxShift Updates',
          message: 'Could not determine the latest version right now.'
        });
      }
      return;
    }
    if (compareVersions(latestVersion, currentVersion) <= 0) {
      if (showFeedback) {
        await dialog.showMessageBox({
          type: 'info',
          title: 'LuxShift Updates',
          message: `You’re up to date (v${currentVersion}).`
        });
      }
      return;
    }
    const result = await dialog.showMessageBox({
      type: 'info',
      title: 'Update available',
      message: `A new version of LuxShift is available (${latestVersion}).`,
      detail: 'Download the newest release to update LuxShift.',
      buttons: ['Download Update', 'Later'],
      defaultId: 0,
      cancelId: 1
    });
    if (result.response === 0) {
      await shell.openExternal(release?.html_url ?? `https://github.com/${GITHUB_REPO}/releases/latest`);
    }
  } catch (error) {
    if (showFeedback) {
      await dialog.showMessageBox({
        type: 'error',
        title: 'LuxShift Updates',
        message: 'Could not check for updates.',
        detail: error?.message || 'Please check your internet connection and try again.'
      });
    }
  }
}

// -----------------------------------------------------------------------------
// Version comparison helper (unchanged)
function parseVersionParts(version) {
  return String(version || '0.0.0')
    .replace(/^v/i, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
}
function compareVersions(a, b) {
  const aParts = parseVersionParts(a);
  const bParts = parseVersionParts(b);
  const length = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < length; i++) {
    const diff = (aParts[i] || 0) - (bParts[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

// -----------------------------------------------------------------------------
// Tray creation (unchanged)
function createTray() {
  if (tray) return tray;
  tray = new Tray(getTrayIcon());
  tray.setIgnoreDoubleClickEvents(true);
  tray.on('click', toggleMainWindow);
  tray.on('right-click', () => {
    updateTrayMenu();
    tray.popUpContextMenu();
  });
  updateTrayMenu();
  return tray;
}
function updateTrayMenu(state = null) {
  if (!tray) return;
  const current = state || lastWindDownSnapshot || displayEngine.getCurrentState();
  const status =
    current.minutesToBedtime === null
      ? 'No bedtime set'
      : current.minutesToBedtime <= 0
        ? 'Bedtime reached'
        : `${Math.round(current.minutesToBedtime)}m to bedtime`;

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open LuxShift', click: showMainWindow },
      {
        label: mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()
          ? 'Hide Window'
          : 'Show Window',
        click: toggleMainWindow
      },
      { type: 'separator' },
      { label: `Mode: ${current.phase}`, enabled: false },
      { label: `Status: ${status}`, enabled: false },
      { label: `Bedtime: ${current.bedtimeDisplay || 'Not set'}`, enabled: false },
      { type: 'separator' },
      { label: 'Check for Updates…', click: () => checkForUpdates(true) },
      { type: 'separator' },
      {
        label: 'Quit LuxShift',
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ])
  );

  const title =
    current.phase === 'winding-down'
      ? 'LuxShift • Wind‑down'
      : current.phase === 'bedtime'
        ? 'LuxShift • Bedtime'
        : 'LuxShift';
  tray.setToolTip(title);
}
