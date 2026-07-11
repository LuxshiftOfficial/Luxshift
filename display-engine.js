/**
 * LuxShift Display Engine
 *
 * Two systems running on a 60-second tick:
 *
 * 1. WIND-DOWN ENGINE
 *    Biological blue-light ramp starting 90 minutes before bedtime.
 *    Uses a non-linear curve — gentle at first, aggressive near bedtime.
 *    Controls system-wide Night Shift warmth + display brightness.
 *
 * 2. SUNLIGHT NOTIFICATION ENGINE
 *    Reminds the user to get outdoor sunlight at scientifically optimal times.
 *    Morning light sets the circadian clock. Afternoon light extends alertness.
 *    Notifications fire once per window per day.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const os = require('os');
const execFileAsync = promisify(execFile);

// Use bundled binary in production (inside app bundle),
// fall back to home directory for local dev
function getNightshiftBin() {
  // In a packaged Electron app, __dirname points inside the .app bundle
  const bundled = path.join(process.resourcesPath || __dirname, 'assets', 'nightshift-control');
  const dev = path.join(__dirname, 'assets', 'nightshift-control');
  const home = path.join(os.homedir(), 'nightshift-control');
  const fs = require('fs');
  if (fs.existsSync(bundled)) return bundled;
  if (fs.existsSync(dev)) return dev;
  return home;
}
const NIGHTSHIFT_BIN = getNightshiftBin();
const MIN_BRIGHTNESS = 0.35;

// Biological wind-down window — 90 minutes matches research on melatonin onset
const WIND_DOWN_MINUTES = 90;

// Sunlight windows (minutes from midnight)
// Morning: 6–10 AM — cortisol peak + circadian anchor
// Afternoon: 2–4 PM — extends alertness, buffers evening melatonin timing
const SUNLIGHT_WINDOWS = [
  { id: 'morning', startH: 6, endH: 10, label: 'morning sunlight', message: 'Step outside for 10–15 minutes of morning sunlight. This anchors your circadian clock and makes tonight\'s sleep more effective.' },
  { id: 'afternoon', startH: 14, endH: 16, label: 'afternoon sunlight', message: 'A short walk outside now helps extend your afternoon alertness and prepares your body for a natural wind-down tonight.' }
];

let _tickInterval = null;
let _win = null;
let _getPreferences = null;
let _getActiveSchedule = null;

// Track which sunlight notifications have fired today
const _sunlightFiredToday = new Set();
let _lastNotificationDate = null;

function startEngine(win, getPreferences, getActiveSchedule) {
  _win = win;
  _getPreferences = getPreferences;
  _getActiveSchedule = getActiveSchedule;

  runTick();
  _tickInterval = setInterval(runTick, 60 * 1000);
}

function stopEngine() {
  if (_tickInterval) {
    clearInterval(_tickInterval);
    _tickInterval = null;
  }
  applyNightShift(0);
}

async function runTick() {
  if (!_win || _win.isDestroyed()) return;

  const prefs = _getPreferences();
  const scheduleResult = _getActiveSchedule();
  const schedule = scheduleResult?.schedule || null;

  // Wind-down
  const state = computeWindDownState(prefs, schedule);
  pushStateToRenderer(state);
  await applyDisplayAdaptation(state.intensity);

  // Sunlight notifications (async — fetches weather)
  await checkSunlightNotifications(prefs, schedule);
}

// ── Wind-down ────────────────────────────────────────────────────────────────

function computeWindDownState(prefs, schedule) {
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  // Respect the user's saved wind-down lead time preference.
  // Fall back to the biological default (90 mins) if not set.
  const windDownMinutes = Number(prefs?.windDownMinutes) || WIND_DOWN_MINUTES;

  const bedtimeMinutes = resolveBedtimeMinutes(prefs, schedule);

  if (bedtimeMinutes === null) {
    return makeNormalState(windDownMinutes);
  }

  let minutesToBedtime = bedtimeMinutes - nowMinutes;

  // Handle midnight crossing
  if (minutesToBedtime < -(24 * 60 - windDownMinutes)) {
    minutesToBedtime += 24 * 60;
  }

  const bedtimeLabel = minutesToHHMM(bedtimeMinutes);

  // Past bedtime — keep Night Shift on for 30 min grace (so you can fall asleep),
  // then reset to normal so it's off when you wake up
  if (minutesToBedtime < 0 && minutesToBedtime >= -30) {
    return {
      intensity: 1.0,
      minutesToBedtime: 0,
      windDownMinutes,
      targetBrightness: MIN_BRIGHTNESS,
      phase: 'bedtime',
      bedtimeLabel
    };
  }

  // More than 30 mins past bedtime — you should be asleep, reset everything
  if (minutesToBedtime < -30) {
    return {
      intensity: 0,
      minutesToBedtime: null,
      windDownMinutes,
      targetBrightness: 1.0,
      phase: 'normal',
      bedtimeLabel
    };
  }

  if (minutesToBedtime > windDownMinutes) {
    return {
      intensity: 0,
      minutesToBedtime,
      windDownMinutes,
      targetBrightness: 1.0,
      phase: minutesToBedtime <= windDownMinutes + 15 ? 'approaching' : 'normal',
      bedtimeLabel
    };
  }

  // Non-linear biological curve:
  // Progress 0→1 through the wind-down window
  // Curve: easeInQuad — slow start, accelerates near bedtime
  // This means warmth stays subtle for the first 45 mins,
  // then ramps hard in the final 30 mins
  const progress = 1 - (minutesToBedtime / windDownMinutes);
  const intensity = progress * progress; // easeInQuad

  const targetBrightness = 1.0 - (intensity * (1.0 - MIN_BRIGHTNESS));

  return {
    intensity: parseFloat(intensity.toFixed(3)),
    minutesToBedtime,
    windDownMinutes,
    targetBrightness: parseFloat(targetBrightness.toFixed(3)),
    phase: 'winding-down',
    bedtimeLabel
  };
}

function resolveBedtimeMinutes(prefs, schedule) {
  if (schedule?.parsedBlocks?.length) {
    const sleepBlocks = schedule.parsedBlocks.filter(
      (b) => b.type === 'sleep' || b.type === 'unwind'
    );
    const starts = sleepBlocks
      .map((b) => b.start)
      .filter(Boolean)
      .map(parseHHMMtoMinutes)
      .filter((m) => m !== null);

    if (starts.length) return Math.max(...starts);

    if (schedule.endTime) {
      const m = parseHHMMtoMinutes(schedule.endTime);
      if (m !== null) return m;
    }
  }

  if (prefs?.bedtimeTarget) {
    return parseHHMMtoMinutes(prefs.bedtimeTarget);
  }

  return null;
}

// ── Display control ──────────────────────────────────────────────────────────

async function applyDisplayAdaptation(intensity) {
  if (process.platform !== 'darwin') return;

  if (intensity <= 0) {
    await applyNightShift(0);
    await setBrightness(1.0);
    return;
  }

  // Map intensity (0–1) to Night Shift strength (0.05–0.72)
  // Starts very subtle, caps at 0.72 to avoid the harsh full-amber
  const strength = parseFloat((0.05 + intensity * 0.67).toFixed(3));
  await applyNightShift(strength);

  // Brightness dims more gently — only starts dropping past 50% intensity
  const brightnessIntensity = Math.max(0, (intensity - 0.5) * 2);
  const targetBrightness = 1.0 - (brightnessIntensity * (1.0 - MIN_BRIGHTNESS));
  await setBrightness(targetBrightness);
}

async function applyNightShift(strength) {
  try {
    if (strength <= 0) {
      await execFileAsync(NIGHTSHIFT_BIN, ['off']);
    } else {
      await execFileAsync(NIGHTSHIFT_BIN, ['on', String(strength)]);
    }
  } catch (_) {
    // Binary not available — in-app overlay still works
  }
}

async function setBrightness(level) {
  const clamped = Math.max(MIN_BRIGHTNESS, Math.min(1.0, level));
  try {
    await execFileAsync('osascript', [
      '-e',
      `tell application "System Events" to tell process "SystemUIServer" to set value of slider 1 of menu bar item "Brightness" of menu bar 2 to ${clamped}`
    ]);
  } catch (_) {}
}

// ── Sunlight notifications ───────────────────────────────────────────────────
// Personalised to:
//   - User's actual wake time (from preferences)
//   - Local sunrise time (via SunCalc + saved location)
//   - Real-time weather (cloud cover, is_day from Open-Meteo)
//   - Active schedule (skip nudge if user is in a work block)

const SunCalc = require('suncalc');

// Cache weather so we don't hammer the API every tick
let _weatherCache = null;
let _weatherCacheTime = 0;
const WEATHER_CACHE_MS = 30 * 60 * 1000; // refresh every 30 mins

async function fetchWeather(coords) {
  const now = Date.now();
  if (_weatherCache && now - _weatherCacheTime < WEATHER_CACHE_MS) {
    return _weatherCache;
  }
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.latitude}&longitude=${coords.longitude}&current=cloudcover,is_day,weathercode&timezone=auto`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    _weatherCache = data?.current || null;
    _weatherCacheTime = now;
    return _weatherCache;
  } catch (_) {
    return null;
  }
}

function getSunriseSunset(coords) {
  if (!coords?.latitude || !coords?.longitude) return null;
  const times = SunCalc.getTimes(new Date(), coords.latitude, coords.longitude);
  return {
    sunriseMinutes: times.sunrise.getHours() * 60 + times.sunrise.getMinutes(),
    sunsetMinutes: times.sunset.getHours() * 60 + times.sunset.getMinutes(),
    goldenHourEndMinutes: times.goldenHourEnd.getHours() * 60 + times.goldenHourEnd.getMinutes()
  };
}

function getWeatherAdvice(weather) {
  if (!weather) return { canGoOut: true, qualifier: '', weatherNote: '' };

  const cloudcover = Number(weather.cloudcover ?? 0);
  const isDay = Number(weather.is_day ?? 1);
  const code = Number(weather.weathercode ?? 0);

  // WMO weather codes: 61-67 rain, 71-77 snow, 80-82 showers, 95+ storm
  const isRaining = (code >= 61 && code <= 67) || (code >= 80 && code <= 82) || code >= 95;
  const isSnowing = code >= 71 && code <= 77;

  if (!isDay) return { canGoOut: false, qualifier: 'after dark', weatherNote: 'Sun has set — wait for tomorrow morning.' };
  if (isRaining) return { canGoOut: false, qualifier: 'rainy', weatherNote: 'It is raining right now. Try to get light near a bright window instead.' };
  if (isSnowing) return { canGoOut: false, qualifier: 'snowy', weatherNote: 'Snowing outside — a bright window will help, or step out briefly if safe.' };
  if (cloudcover > 85) return { canGoOut: true, qualifier: 'overcast', weatherNote: 'Heavy cloud cover today — still go outside, overcast light still has circadian benefit, just stay out a bit longer (20 mins).' };
  if (cloudcover > 60) return { canGoOut: true, qualifier: 'partly cloudy', weatherNote: 'Partly cloudy — outdoor light still works well. Aim for 15 minutes.' };

  return { canGoOut: true, qualifier: 'clear', weatherNote: 'Good conditions — 10 minutes outside is enough.' };
}

async function checkSunlightNotifications(prefs, schedule) {
  if (!_win || _win.isDestroyed()) return;

  const now = new Date();
  const todayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  // Reset fired set at start of each new day
  if (_lastNotificationDate !== todayKey) {
    _sunlightFiredToday.clear();
    _lastNotificationDate = todayKey;
  }

  const coords = prefs?.preferredLocation || null;
  const wakeTarget = prefs?.wakeTarget || '07:30';
  const wakeMinutes = parseHHMMtoMinutes(wakeTarget) || 7 * 60 + 30;

  // Get sunrise for this location
  const sunTimes = coords ? getSunriseSunset(coords) : null;
  const sunriseMinutes = sunTimes?.sunriseMinutes ?? 6 * 60;
  const goldenHourEnd = sunTimes?.goldenHourEndMinutes ?? 8 * 60;

  // Morning window: starts at LATER of (wake time) or (sunrise)
  // Ends 2 hours after that start — prime cortisol window
  const morningStart = Math.max(wakeMinutes, sunriseMinutes);
  const morningEnd = morningStart + 120;

  // Afternoon window: 5–7 hours after wake (low-angle light, alertness extension)
  const afternoonStart = wakeMinutes + 5 * 60;
  const afternoonEnd = wakeMinutes + 7 * 60;

  // Fetch weather once for both checks
  const weather = coords ? await fetchWeather(coords) : null;
  const { canGoOut, qualifier, weatherNote } = getWeatherAdvice(weather);

  // ── Morning nudge ────────────────────────────────────────────────────────
  const morningId = `${todayKey}-morning`;
  if (
    !_sunlightFiredToday.has(morningId) &&
    nowMinutes >= morningStart &&
    nowMinutes <= morningEnd &&
    !isInWorkBlock(schedule, nowMinutes)
  ) {
    const isGoldenHour = nowMinutes <= goldenHourEnd;
    const goldenNote = isGoldenHour ? ' The golden hour light right now is especially powerful for circadian anchoring.' : '';

    const body = canGoOut
      ? `Step outside for 10–15 minutes now. Morning sunlight triggers your cortisol peak and locks in tonight's melatonin timing. ${weatherNote}${goldenNote}`
      : `${weatherNote} Try to sit near your brightest window for 15 minutes — even indirect morning light helps anchor your clock.`;

    sendSunlightNotification({
      id: morningId,
      title: `☀️ Morning sunlight${qualifier ? ' (' + qualifier + ')' : ''}`,
      body,
      canGoOut
    });
    _sunlightFiredToday.add(morningId);
  }

  // ── Afternoon nudge ──────────────────────────────────────────────────────
  const afternoonId = `${todayKey}-afternoon`;
  if (
    !_sunlightFiredToday.has(afternoonId) &&
    nowMinutes >= afternoonStart &&
    nowMinutes <= afternoonEnd &&
    !isInWorkBlock(schedule, nowMinutes)
  ) {
    const body = canGoOut
      ? `A 10-minute walk outside now extends your afternoon alertness and helps your melatonin rise at the right time tonight. ${weatherNote}`
      : `${weatherNote} Step near a bright window for a few minutes — your eyes need the light signal even if you cannot go outside.`;

    sendSunlightNotification({
      id: afternoonId,
      title: `🌤️ Afternoon light nudge${qualifier ? ' (' + qualifier + ')' : ''}`,
      body,
      canGoOut
    });
    _sunlightFiredToday.add(afternoonId);
  }
}

function isInWorkBlock(schedule, nowMinutes) {
  if (!schedule?.parsedBlocks?.length) return false;
  for (const block of schedule.parsedBlocks) {
    if (block.type !== 'work') continue;
    const start = parseHHMMtoMinutes(block.start);
    const end = parseHHMMtoMinutes(block.end);
    if (start !== null && end !== null && nowMinutes >= start && nowMinutes <= end) {
      return true;
    }
  }
  return false;
}

function sendSunlightNotification(payload) {
  if (!_win || _win.isDestroyed()) return;
  try {
    _win.webContents.send('luxshift:sunlight-nudge', payload);
  } catch (_) {}
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function pushStateToRenderer(state) {
  if (!_win || _win.isDestroyed()) return;
  try {
    _win.webContents.send('luxshift:winddown-state', state);
  } catch (_) {}
}

function parseHHMMtoMinutes(value) {
  if (!value || typeof value !== 'string') return null;
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

function minutesToHHMM(totalMinutes) {
  const normalized = ((totalMinutes % (24 * 60)) + 24 * 60) % (24 * 60);
  const h = Math.floor(normalized / 60);
  const m = normalized % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function makeNormalState(windDownMinutes) {
  return {
    intensity: 0,
    minutesToBedtime: null,
    windDownMinutes,
    targetBrightness: 1.0,
    phase: 'normal',
    bedtimeLabel: null
  };
}

function getCurrentState() {
  // Use the live preference + active-schedule getters bound at startEngine()
  // so the tray status, the post-save state refresh, and the renderer all
  // observe the real wind-down phase instead of a static "normal" snapshot.
  if (typeof _getPreferences !== 'function') {
    return makeNormalState(WIND_DOWN_MINUTES);
  }
  const scheduleResult = typeof _getActiveSchedule === 'function' ? _getActiveSchedule() : null;
  const schedule = scheduleResult?.schedule || null;
  return computeWindDownState(_getPreferences(), schedule);
}

module.exports = { startEngine, stopEngine, getCurrentState, applyNightShift };