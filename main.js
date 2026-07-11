const {
  app,
  BrowserWindow,
  ipcMain,
  Notification,
  Tray,
  Menu,
  nativeImage,
  dialog,
  shell
} = require('electron');

const path = require('path');
const PreferencesStore = require('electron-store').default;
const {
  getActiveSchedule,
  saveActiveSchedule,
  clearActiveSchedule,
  archiveExpiredActiveSchedule
} = require('./schedule-store.js');

const GITHUB_REPO = 'LuxshiftOfficial/Luxshift';

let preferencesStore;
let mainWindow = null;
let tray = null;
let windDownInterval = null;
let lastWindDownSnapshot = null;
let lastSunlightNudgeAt = 0;
let isQuitting = false;

const DEFAULT_PREFERENCES = {
  bedtimeTarget: '00:30',
  wakeTarget: '07:30',
  windDownMinutes: 90,
  preferredLocationName: '',
  preferredLocation: null,
  timeFormat: '12h',
  timeFormatChosen: false
};

function getTrayIcon() {
  const templatePath = path.join(__dirname, 'assets', 'tray-iconTemplate.png');
  const alternatePath = path.join(__dirname, 'assets', 'tray-icon.png');

  for (const iconPath of [templatePath, alternatePath]) {
    try {
      const image = nativeImage.createFromPath(iconPath);
      if (!image.isEmpty()) return image.resize({ width: 18, height: 18 });
    } catch (_error) {}
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
          body: 'LuxShift moved to the menu bar so wind-down support can continue.'
        }).show();
      } catch (_error) {}
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

function showMainWindow() {
  const win = createWindow();

  if (win.isMinimized()) {
    win.restore();
  }

  win.show();
  win.focus();
  return win;
}

function hideMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
  }
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

function parseHHMM(value) {
  const normalized = normalizeHHMM(value, null);
  if (!normalized) return null;

  const [hours, minutes] = normalized.split(':').map(Number);
  return hours * 60 + minutes;
}

function formatClockLabel(hhmm, use24h = false) {
  const normalized = normalizeHHMM(hhmm, null);
  if (!normalized) return '';

  const [hours, minutes] = normalized.split(':').map(Number);

  if (use24h) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }

  const period = hours >= 12 ? 'PM' : 'AM';
  const displayHours = hours % 12 === 0 ? 12 : hours % 12;

  return `${displayHours}:${String(minutes).padStart(2, '0')} ${period}`;
}

function resolveBedtimeMinutes(prefs, schedule) {
  const scheduleBlocks = Array.isArray(schedule?.parsedBlocks)
    ? schedule.parsedBlocks
    : [];

  const sleepStarts = scheduleBlocks
    .filter((block) => block?.type === 'sleep' || block?.type === 'unwind')
    .map((block) => parseHHMM(block?.start))
    .filter((value) => value !== null);

  if (sleepStarts.length) {
    return Math.max(...sleepStarts);
  }

  const scheduleEnd = parseHHMM(schedule?.endTime);
  if (scheduleEnd !== null) {
    return scheduleEnd;
  }

  return parseHHMM(prefs?.bedtimeTarget);
}

function computeWindDownState(now = new Date()) {
  const prefs = getPreferences();
  const activeScheduleResult = getActiveSchedule();
  const schedule = activeScheduleResult?.schedule || null;

  const windDownMinutes = Number(prefs.windDownMinutes) || 90;
  const bedtimeMinutes = resolveBedtimeMinutes(prefs, schedule);
  const bedtimeLabel = formatClockLabel(
    prefs.bedtimeTarget,
    prefs.timeFormat === '24h'
  );

  if (bedtimeMinutes === null) {
    return {
      intensity: 0,
      minutesToBedtime: null,
      windDownMinutes,
      targetBrightness: 1,
      phase: 'normal',
      bedtimeLabel: null,
      bedtimeDisplay: 'Not set'
    };
  }

  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  let minutesToBedtime = bedtimeMinutes - nowMinutes;

  if (minutesToBedtime < -(24 * 60 - windDownMinutes)) {
    minutesToBedtime += 24 * 60;
  }

  if (minutesToBedtime < 0 && minutesToBedtime >= -30) {
    return {
      intensity: 1,
      minutesToBedtime: 0,
      windDownMinutes,
      targetBrightness: 0.35,
      phase: 'bedtime',
      bedtimeLabel: prefs.bedtimeTarget,
      bedtimeDisplay: bedtimeLabel
    };
  }

  if (minutesToBedtime < -30) {
    return {
      intensity: 0,
      minutesToBedtime: null,
      windDownMinutes,
      targetBrightness: 1,
      phase: 'normal',
      bedtimeLabel: prefs.bedtimeTarget,
      bedtimeDisplay: bedtimeLabel
    };
  }

  if (minutesToBedtime > windDownMinutes) {
    return {
      intensity: 0,
      minutesToBedtime,
      windDownMinutes,
      targetBrightness: 1,
      phase: minutesToBedtime <= windDownMinutes + 15 ? 'approaching' : 'normal',
      bedtimeLabel: prefs.bedtimeTarget,
      bedtimeDisplay: bedtimeLabel
    };
  }

  const progress = 1 - minutesToBedtime / windDownMinutes;
  const intensity = Number((progress * progress).toFixed(3));

  return {
    intensity,
    minutesToBedtime,
    windDownMinutes,
    targetBrightness: Number((1 - intensity * 0.65).toFixed(3)),
    phase: 'winding-down',
    bedtimeLabel: prefs.bedtimeTarget,
    bedtimeDisplay: bedtimeLabel
  };
}

function windDownChanged(next, previous) {
  if (!previous) return true;

  return (
    next.phase !== previous.phase ||
    next.minutesToBedtime !== previous.minutesToBedtime ||
    Math.abs(next.intensity - previous.intensity) >= 0.01
  );
}

function maybeEmitSunlightNudge(state) {
  if (state?.phase !== 'bedtime') return;

  const now = Date.now();
  if (now - lastSunlightNudgeAt < 10 * 60 * 60 * 1000) return;

  const prefs = getPreferences();
  const hasLocation = Boolean(
    prefs.preferredLocation?.latitude &&
    prefs.preferredLocation?.longitude
  );

  lastSunlightNudgeAt = now;

  broadcast('luxshift:sunlight-nudge', {
    title: 'Tomorrow morning light reminder',
    body: hasLocation
      ? 'Try to get natural light soon after waking to support tonight’s sleep schedule.'
      : 'Try to get natural light soon after waking. Add a saved location for more contextual nudges.',
    canGoOut: true,
    emittedAt: new Date(now).toISOString()
  });
}

function updateTrayMenu(state = null) {
  if (!tray) return;

  const current = state || lastWindDownSnapshot || computeWindDownState();

  const status =
    current.minutesToBedtime === null
      ? 'No bedtime set'
      : current.minutesToBedtime <= 0
        ? 'Bedtime reached'
        : `${Math.round(current.minutesToBedtime)}m to bedtime`;

  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Open LuxShift',
        click: showMainWindow
      },
      {
        label: mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()
          ? 'Hide Window'
          : 'Show Window',
        click: toggleMainWindow
      },
      { type: 'separator' },
      {
        label: `Mode: ${current.phase}`,
        enabled: false
      },
      {
        label: `Status: ${status}`,
        enabled: false
      },
      {
        label: `Bedtime: ${current.bedtimeDisplay || 'Not set'}`,
        enabled: false
      },
      { type: 'separator' },
      {
        label: 'Check for Updates…',
        click: () => checkForUpdates(true)
      },
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
      ? 'LuxShift • Wind-down'
      : current.phase === 'bedtime'
        ? 'LuxShift • Bedtime'
        : 'LuxShift';

  tray.setToolTip(title);
}

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

async function publishWindDownState(force = false) {
  const state = computeWindDownState();

  if (force || windDownChanged(state, lastWindDownSnapshot)) {
    lastWindDownSnapshot = state;
    broadcast('luxshift:winddown-state', state);
    updateTrayMenu(state);
    maybeEmitSunlightNudge(state);
  }

  return state;
}

function startWindDownEngine() {
  if (windDownInterval) {
    clearInterval(windDownInterval);
  }

  publishWindDownState(true).catch(() => {});

  windDownInterval = setInterval(() => {
    publishWindDownState(false).catch(() => {});
  }, 60 * 1000);
}

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

  for (let index = 0; index < length; index += 1) {
    const difference = (aParts[index] || 0) - (bParts[index] || 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }

  return 0;
}

async function checkForUpdates(showFeedback = false) {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      {
        headers: {
          Accept: 'application/vnd.github+json'
        }
      }
    );

    if (!response.ok) {
      throw new Error(`GitHub release lookup failed (${response.status}).`);
    }

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
      await shell.openExternal(
        release?.html_url ||
        `https://github.com/${GITHUB_REPO}/releases/latest`
      );
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

async function searchLocation(query) {
  const search = String(query || '').trim();

  if (search.length < 2) {
    return { ok: false, error: 'Please enter at least 2 characters.' };
  }

  try {
    const url =
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(search)}` +
      '&count=6&language=en&format=json';

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
    return {
      ok: false,
      error: error?.message || 'Location search failed.'
    };
  }
}

async function getEnvironment(coords) {
  const latitude = Number(coords?.latitude);
  const longitude = Number(coords?.longitude);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { ok: false, error: 'Valid latitude and longitude are required.' };
  }

  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(latitude)}` +
      `&longitude=${encodeURIComponent(longitude)}` +
      '&current=temperature_2m,apparent_temperature,cloud_cover,precipitation,weather_code,is_day' +
      '&timezone=auto&forecast_days=1';

    const response = await fetch(url);

    if (!response.ok) {
      return {
        ok: false,
        error: `Environment lookup failed (${response.status}).`
      };
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
    return {
      ok: false,
      error: error?.message || 'Environment lookup failed.'
    };
  }
}

app.whenReady().then(async () => {
  app.setName('LuxShift');

  preferencesStore = new PreferencesStore({
    name: 'luxshift-preferences',
    cwd: app.getPath('userData'),
    defaults: DEFAULT_PREFERENCES
  });

  archiveExpiredActiveSchedule();
  createWindow();
  createTray();
  startWindDownEngine();

  checkForUpdates(false).catch(() => {});

  app.on('activate', showMainWindow);
});

app.on('before-quit', () => {
  isQuitting = true;

  if (windDownInterval) {
    clearInterval(windDownInterval);
    windDownInterval = null;
  }
});

app.on('window-all-closed', (event) => {
  event.preventDefault();
});

ipcMain.handle('luxshift:get-preferences', async () => getPreferences());

ipcMain.handle('luxshift:save-preferences', async (_event, payload) => {
  const next = buildSafePreferences(payload);
  preferencesStore.set(next);

  const windDownState = await publishWindDownState(true);

  return {
    ok: true,
    preferences: getPreferences(),
    windDownState
  };
});

ipcMain.handle('luxshift:search-location', async (_event, query) => {
  return searchLocation(query);
});

ipcMain.handle('luxshift:get-environment', async (_event, coords) => {
  return getEnvironment(coords);
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
    return {
      ok: false,
      error: error?.message || 'Notification failed.'
    };
  }
});

ipcMain.handle('luxshift:get-active-schedule', async () => {
  return getActiveSchedule();
});

ipcMain.handle('luxshift:save-active-schedule', async (_event, payload) => {
  const result = saveActiveSchedule(payload);
  await publishWindDownState(true);
  return result;
});

ipcMain.handle('luxshift:clear-active-schedule', async () => {
  const result = clearActiveSchedule();
  await publishWindDownState(true);
  return result;
});

ipcMain.handle('luxshift:archive-expired-schedule', async () => {
  const result = archiveExpiredActiveSchedule();
  await publishWindDownState(true);
  return result;
});

ipcMain.handle('luxshift:get-winddown-state', async () => {
  return publishWindDownState(true);
});

ipcMain.handle('luxshift:check-for-updates', async () => {
  await checkForUpdates(true);
  return { ok: true };
});