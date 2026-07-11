const { contextBridge, ipcRenderer } = require('electron');
const SunCalc = require('suncalc');

function formatClock(date, use24h = false) {
  return new Date(date).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    hour12: !use24h
  });
}

function getSunData({ latitude, longitude, use24h = false }) {
  const safeLatitude = Number(latitude);
  const safeLongitude = Number(longitude);

  if (!Number.isFinite(safeLatitude) || !Number.isFinite(safeLongitude)) {
    return null;
  }

  const now = new Date();
  const position = SunCalc.getPosition(now, safeLatitude, safeLongitude);
  const times = SunCalc.getTimes(now, safeLatitude, safeLongitude);

  const altitudeDeg = (position.altitude * 180 / Math.PI).toFixed(1);
  const sunrise = formatClock(times.sunrise, use24h);
  const sunset = formatClock(times.sunset, use24h);

  let phase = 'Night';

  if (position.altitude > 20 * Math.PI / 180) {
    phase = 'High daylight';
  } else if (position.altitude > 0) {
    phase = 'Daylight';
  } else if (position.altitude > -6 * Math.PI / 180) {
    phase = 'Twilight';
  }

  return {
    phase,
    altitudeDeg,
    sunrise,
    sunset,
    summary: `Sun: ${phase}, altitude ${altitudeDeg}°, sunrise ${sunrise}, sunset ${sunset}`
  };
}

contextBridge.exposeInMainWorld('luxshiftAPI', {
  appName: 'LuxShift',
  platform: process.platform,

  getPreferences: () => ipcRenderer.invoke('luxshift:get-preferences'),
  savePreferences: (payload) => ipcRenderer.invoke('luxshift:save-preferences', payload),

  searchLocation: (query) => ipcRenderer.invoke('luxshift:search-location', query),
  getEnvironment: (coords) => ipcRenderer.invoke('luxshift:get-environment', coords),

  notify: (payload) => ipcRenderer.invoke('luxshift:notify', payload),

  getActiveSchedule: () => ipcRenderer.invoke('luxshift:get-active-schedule'),
  saveActiveSchedule: (payload) => ipcRenderer.invoke('luxshift:save-active-schedule', payload),
  clearActiveSchedule: () => ipcRenderer.invoke('luxshift:clear-active-schedule'),
  archiveExpiredSchedule: () => ipcRenderer.invoke('luxshift:archive-expired-schedule'),

  getWindDownState: () => ipcRenderer.invoke('luxshift:get-winddown-state'),

  onWindDownState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('luxshift:winddown-state', listener);
    return listener;
  },

  removeWindDownListener: (listener) => {
    if (listener) {
      ipcRenderer.removeListener('luxshift:winddown-state', listener);
    }
  },

  onSunlightNudge: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('luxshift:sunlight-nudge', listener);
    return listener;
  },

  removeSunlightNudgeListener: (listener) => {
    if (listener) {
      ipcRenderer.removeListener('luxshift:sunlight-nudge', listener);
    }
  },

  getSunData
});