const input = document.getElementById('input');
const lateChangesInput = document.getElementById('lateChangesInput');
const preview = document.getElementById('preview');
const modeValue = document.getElementById('modeValue');
const envValue = document.getElementById('envValue');
const parseBtn = document.getElementById('parseBtn');
const fillBtn = document.getElementById('fillBtn');
const clearBtn = document.getElementById('clearBtn');
const retryEnvBtn = document.getElementById('retryEnvBtn');
const settingsHint = document.getElementById('settingsHint');
const bedtimeInput = document.getElementById('bedtimeInput');
const wakeInput = document.getElementById('wakeInput');
const windDownInput = document.getElementById('windDownInput');
const timeFormatInput = document.getElementById('timeFormatInput');
const locationSearchInput = document.getElementById('locationSearchInput');
const searchLocationBtn = document.getElementById('searchLocationBtn');
const saveSettingsBtn = document.getElementById('saveSettingsBtn');
const useDeviceLocationBtn = document.getElementById('useDeviceLocationBtn');
const locationResults = document.getElementById('locationResults');
const envHint = document.getElementById('envHint');
const settingsSummary = document.getElementById('settingsSummary');

const overlayEl = document.getElementById('luxshift-overlay');
const winddownBar = document.getElementById('winddown-bar');
const winddownLabel = document.getElementById('winddown-label');

const exampleText = 'My day starts at 9:00 AM. I have focused work until 12:30 PM, lunch after that, a football game I want to watch at 1:00 PM, then more work in the evening, and I expect everything to end by 11:00 PM.';
const exampleLateChange = 'Please move the afternoon around the football game and keep the updated timeline until the day ends.';
const appName = window.luxshiftAPI?.appName || 'LuxShift';
const platform = window.luxshiftAPI?.platform || 'unknown';

let environmentLoading = false;
let settingsSaving = false;
let windDownListener = null;
let sunlightListener = null;
let preferences = {
  bedtimeTarget: '00:30',
  wakeTarget: '07:30',
  windDownMinutes: 90,
  preferredLocationName: '',
  preferredLocation: null,
  timeFormat: '12h',
  timeFormatChosen: false
};

wireUI();
renderInitialState();
bootstrap();

async function parseScheduleViaProxy(text) {
  const response = await fetch('https://luxshift.onrender.com/parse-schedule', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data?.error || data?.details?.error || 'Proxy parsing failed.');
  }

  return {
    summary: data?.summary || '',
    blocks: Array.isArray(data?.blocks) ? data.blocks : [],
    confidence: typeof data?.confidence === 'number' ? data.confidence : 0.9,
    reasons: Array.isArray(data?.reasons) ? data.reasons : [],
    source: 'nvidia-proxy',
    unavailable: false
  };
}

function applyWindDownState(state) {
  if (!overlayEl || !winddownBar || !winddownLabel) return;

  const intensity = Number(state?.intensity ?? 0);
  const phase = state?.phase || 'normal';
  const minutesToBedtime = state?.minutesToBedtime ?? null;
  const bedtimeLabel = state?.bedtimeDisplay || state?.bedtimeLabel || null;
  const dimness = Number(state?.visualDimness ?? intensity * 0.62);
  const warmth = Number(state?.visualWarmth ?? intensity * 0.92);
  const softness = Number(state?.visualSoftness ?? intensity * 0.48);

  document.documentElement.style.setProperty('--lux-dimness', String(dimness));
  document.documentElement.style.setProperty('--lux-warmth', String(warmth));
  document.documentElement.style.setProperty('--lux-softness', String(softness));

  const backgroundDim = (0.02 + intensity * 0.18).toFixed(3);
  const overlayAlpha = (0.08 + intensity * 0.24).toFixed(3);
  const warmAlpha = (0.04 + intensity * 0.18).toFixed(3);

  if (intensity <= 0 || phase === 'normal') {
    overlayEl.style.background = 'transparent';
    overlayEl.style.opacity = '0';
    winddownBar.classList.remove('visible');
    document.body.classList.remove('winddown-active');
    modeValue.textContent = 'Normal';
    winddownLabel.textContent = '';
    document.documentElement.style.setProperty('--lux-dimness', '0');
    document.documentElement.style.setProperty('--lux-warmth', '0');
    document.documentElement.style.setProperty('--lux-softness', '0');
    return;
  }

  overlayEl.style.opacity = '1';
  overlayEl.style.background = `
    radial-gradient(circle at top center, rgba(255, 206, 150, ${warmAlpha}), transparent 52%),
    linear-gradient(180deg, rgba(255, 170, 80, ${overlayAlpha}) 0%, rgba(18, 10, 4, ${backgroundDim}) 100%)
  `;

  winddownBar.classList.add('visible');
  document.body.classList.add('winddown-active');

  if (phase === 'bedtime') {
    winddownLabel.textContent = `Bedtime reached${bedtimeLabel ? ` · target ${formatTimeFromHHMM(bedtimeLabel)}` : ''}`;
    modeValue.textContent = 'Bedtime reached';
  } else if (phase === 'winding-down' && minutesToBedtime !== null) {
    const mins = Math.max(0, Math.round(minutesToBedtime));
    const bedStr = bedtimeLabel ? ` · target ${formatTimeFromHHMM(bedtimeLabel)}` : '';
    winddownLabel.textContent = `Wind-down · ${mins}m to bedtime${bedStr}`;
    modeValue.textContent = `Winding down — ${mins}m to sleep`;
  } else if (phase === 'approaching') {
    winddownLabel.textContent = 'Bedtime approaching soon';
    modeValue.textContent = 'Approaching bedtime';
  } else {
    winddownLabel.textContent = 'Wind-down active';
    modeValue.textContent = 'Wind-down active';
  }
}

function formatTimeFromHHMM(hhmm) {
  if (!hhmm) return '';
  const normalized = normalizeTo24Hour(hhmm);
  if (!normalized) return hhmm;
  return formatTimeForHumans(normalized);
}

function showSunlightBanner(payload) {
  const existing = document.getElementById('sunlight-banner');
  if (existing) existing.remove();

  const banner = document.createElement('div');
  banner.id = 'sunlight-banner';
  banner.style.cssText = `
    position: fixed;
    bottom: 24px;
    right: 24px;
    z-index: 10001;
    background: linear-gradient(135deg, rgba(255,200,50,0.15), rgba(255,160,20,0.1));
    border: 1px solid rgba(255,200,50,0.3);
    border-radius: 14px;
    padding: 16px 20px;
    max-width: 320px;
    backdrop-filter: blur(12px);
    color: #ffe4a0;
    font-size: 0.85rem;
    line-height: 1.5;
    box-shadow: 0 8px 32px rgba(0,0,0,0.4);
  `;

  const goOutIcon = payload?.canGoOut === false ? '🪟' : '🚶';
  const actionLabel = payload?.canGoOut === false ? 'Stay near window' : 'Morning light';

  banner.innerHTML = `
    <div style="font-weight:700;font-size:0.95rem;margin-bottom:6px">${escapeHtml(payload?.title || 'Morning light reminder')}</div>
    <div style="opacity:0.85;line-height:1.55">${escapeHtml(payload?.body || 'Try to get some natural light soon after waking.')}</div>
    <div style="margin-top:12px;display:flex;gap:8px;align-items:center">
      <button type="button" data-close-banner="true" style="
        background:rgba(255,200,50,0.2);border:1px solid rgba(255,200,50,0.3);
        color:#ffe4a0;border-radius:8px;padding:6px 14px;cursor:pointer;font-size:0.82rem;font-weight:600">
        ${goOutIcon} ${actionLabel}
      </button>
      <button type="button" data-close-banner="true" style="
        background:transparent;border:none;color:rgba(255,220,100,0.55);
        cursor:pointer;font-size:0.8rem;padding:6px 8px">
        Dismiss
      </button>
    </div>
  `;

  banner.addEventListener('click', (event) => {
    if (event.target?.matches?.('[data-close-banner="true"]')) {
      banner.remove();
    }
  });

  document.body.appendChild(banner);
  setTimeout(() => {
    if (banner.parentNode) banner.remove();
  }, 30000);
}

async function bootstrap() {
  await loadPreferences();
  bindRealtimeListeners();
  await fetchInitialWindDownState();
  await restoreActiveScheduleIfAvailable();
  startEnvironmentLoad();
  await checkPermissionsOnStartup();
}

async function checkPermissionsOnStartup() {
  if (!window.luxshiftAPI?.checkPermissions) return;
  try {
    const { accessibility } = await window.luxshiftAPI.checkPermissions();
    if (!accessibility) {
      showPermissionOnboarding();
    }
  } catch (_) {}
}

function showPermissionOnboarding() {
  const overlay = document.getElementById('permission-onboarding');
  if (overlay) overlay.classList.add('visible');
}

function hidePermissionOnboarding() {
  const overlay = document.getElementById('permission-onboarding');
  if (overlay) overlay.classList.remove('visible');
}

function bindRealtimeListeners() {
  if (window.luxshiftAPI?.onWindDownState) {
    windDownListener = window.luxshiftAPI.onWindDownState((state) => {
      applyWindDownState(state);
    });
  }

  if (window.luxshiftAPI?.onSunlightNudge) {
    sunlightListener = window.luxshiftAPI.onSunlightNudge((payload) => {
      if (window.luxshiftAPI?.notify) {
        window.luxshiftAPI.notify({
          title: payload?.title,
          body: payload?.body
        }).catch(() => {});
      }
      showSunlightBanner(payload);
    });
  }

  if (window.luxshiftAPI?.onPermissionStatus) {
    window.luxshiftAPI.onPermissionStatus((payload) => {
      if (payload?.accessibility) {
        // Show granted message then auto-close onboarding after 2 seconds
        const grantedMsg = document.getElementById('onboarding-granted-msg');
        const openBtn = document.getElementById('onboarding-open-settings-btn');
        if (grantedMsg) grantedMsg.style.display = 'flex';
        if (openBtn) openBtn.style.display = 'none';
        setTimeout(() => hidePermissionOnboarding(), 2000);
      }
    });
  }

  window.addEventListener('beforeunload', () => {
    if (window.luxshiftAPI?.removeWindDownListener) {
      window.luxshiftAPI.removeWindDownListener(windDownListener);
    }
    if (window.luxshiftAPI?.removeSunlightNudgeListener) {
      window.luxshiftAPI.removeSunlightNudgeListener(sunlightListener);
    }
  });
}

async function fetchInitialWindDownState() {
  if (!window.luxshiftAPI?.getWindDownState) return;
  try {
    const state = await window.luxshiftAPI.getWindDownState();
    applyWindDownState(state);
  } catch (_error) {}
}

function wireUI() {
  fillBtn?.addEventListener('click', () => {
    input.value = exampleText;
    lateChangesInput.value = exampleLateChange;
    input.focus();
  });

  clearBtn?.addEventListener('click', async () => {
    input.value = '';
    lateChangesInput.value = '';
    try {
      await window.luxshiftAPI?.clearActiveSchedule?.();
    } catch (_error) {}
    renderEmptyPreview();
    modeValue.textContent = 'Idle';
    settingsHint.textContent = 'Cleared current plan.';
  });

  parseBtn?.addEventListener('click', handleParse);
  retryEnvBtn?.addEventListener('click', () => startEnvironmentLoad(true));
  saveSettingsBtn?.addEventListener('click', saveSettings);
  searchLocationBtn?.addEventListener('click', searchManualLocation);
  useDeviceLocationBtn?.addEventListener('click', clearManualLocationAndReload);

  // Permission onboarding — wired in the renderer so the buttons are not
  // blocked by the Content-Security-Policy (script-src 'self' forbids the
  // inline handlers that were here before).
  const onboardingOpenSettingsBtn = document.getElementById('onboarding-open-settings-btn');
  const onboardingSkipBtn = document.getElementById('onboarding-skip-btn');
  onboardingOpenSettingsBtn?.addEventListener('click', async () => {
    try { await window.luxshiftAPI?.requestAccessibility?.(); } catch (_) {}
  });
  onboardingSkipBtn?.addEventListener('click', () => {
    document.getElementById('permission-onboarding')?.classList.remove('visible');
  });

  locationSearchInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      searchManualLocation();
    }
  });

  locationSearchInput?.addEventListener('input', () => {
    if (!locationSearchInput.value.trim()) {
      clearLocationResults();
    }
  });
}

function renderInitialState() {
  renderEmptyPreview();
  modeValue.textContent = 'Idle';
  envValue.textContent = `App: ${appName} • Platform: ${platform} • Environment not loaded yet`;
  envHint.textContent = 'The app remains usable even if location is slow.';
  settingsHint.textContent = 'Saved settings let LuxShift interpret your schedule relative to your usual routine.';
  clearLocationResults();
  clearSettingsSummary();
}

async function loadPreferences() {
  const loaded = await window.luxshiftAPI.getPreferences();
  preferences = { ...preferences, ...loaded };
  applyPreferencesToForm(preferences);
}

async function restoreActiveScheduleIfAvailable() {
  const response = await window.luxshiftAPI.getActiveSchedule();
  if (!response?.ok || !response.schedule) return;

  const schedule = response.schedule;

  if (schedule.rawPlanText) input.value = schedule.rawPlanText;
  if (schedule.lateChangesText) lateChangesInput.value = schedule.lateChangesText;

  renderParseResult({
    ...schedule,
    blocks: Array.isArray(schedule.parsedBlocks) ? schedule.parsedBlocks : []
  });

  modeValue.textContent = 'Current schedule ready';
}

function applyPreferencesToForm(prefs) {
  bedtimeInput.value = prefs.bedtimeTarget || '00:30';
  wakeInput.value = prefs.wakeTarget || '07:30';
  windDownInput.value = String(prefs.windDownMinutes || 90);
  timeFormatInput.value = prefs.timeFormat || '12h';
  locationSearchInput.value = prefs.preferredLocationName || '';
}

function getPreferencesFromForm() {
  return {
    bedtimeTarget: bedtimeInput.value || preferences.bedtimeTarget || '00:30',
    wakeTarget: wakeInput.value || preferences.wakeTarget || '07:30',
    windDownMinutes: Number(windDownInput.value || preferences.windDownMinutes || 90),
    preferredLocationName: locationSearchInput.value.trim(),
    preferredLocation: preferences.preferredLocation || null,
    timeFormat: timeFormatInput.value === '24h' ? '24h' : '12h',
    timeFormatChosen: true
  };
}

function renderEmptyPreview() {
  preview.innerHTML = `
    <div class="timeline-empty">
      <div class="timeline-empty-icon">!</div>
      <strong>Your night timeline will appear here.</strong>
      <p>Add your plan for tonight and LuxShift will turn it into a visual sequence of blocks.</p>
    </div>
  `;
}

function clearLocationResults() {
  locationResults.innerHTML = '';
}

function clearSettingsSummary() {
  settingsSummary.innerHTML = '';
}

async function saveSettings() {
  settingsSaving = true;
  saveSettingsBtn.disabled = true;

  const formPrefs = getPreferencesFromForm();
  preferences = { ...preferences, ...formPrefs };

  const response = await window.luxshiftAPI.savePreferences(formPrefs);

  settingsSaving = false;
  saveSettingsBtn.disabled = false;

  if (response?.ok) {
    preferences = response.preferences;
    applyPreferencesToForm(preferences);
    settingsHint.textContent = 'Settings saved.';
    await fetchInitialWindDownState();
    startEnvironmentLoad(true);
  } else {
    settingsHint.textContent = 'Could not save settings.';
  }
}

async function searchManualLocation() {
  const query = locationSearchInput.value.trim();

  if (query.length < 2) {
    settingsHint.textContent = 'Type at least 2 characters to search for a place.';
    clearLocationResults();
    return;
  }

  settingsHint.textContent = 'Searching locations…';
  clearLocationResults();

  const response = await window.luxshiftAPI.searchLocation(query);

  if (!response?.ok) {
    settingsHint.textContent = response?.error || 'Location search failed.';
    clearLocationResults();
    return;
  }

  if (!response.results.length) {
    settingsHint.textContent = 'No matching locations found.';
    clearLocationResults();
    return;
  }

  settingsHint.textContent = 'Choose a location below.';
  locationResults.innerHTML = response.results
    .map(
      (item, index) =>
        `<button class="location-option" type="button" data-index="${index}"><span>${escapeHtml(item.name)}</span><small>${escapeHtml([item.admin1, item.country].filter(Boolean).join(', '))}</small></button>`
    )
    .join('');

  Array.from(locationResults.querySelectorAll('.location-option')).forEach((button, index) => {
    button.addEventListener('click', async () => {
      const location = response.results[index];
      preferences.preferredLocation = location;
      preferences.preferredLocationName = location.name;
      locationSearchInput.value = location.name;

      const save = await window.luxshiftAPI.savePreferences(getPreferencesFromForm());

      if (save?.ok) {
        preferences = save.preferences;
        settingsHint.textContent = `Saved ${formatLocationLabel(location)} as your manual location.`;
        clearLocationResults();
        startEnvironmentLoad(true);
      } else {
        settingsHint.textContent = 'Could not save manual location.';
      }
    });
  });
}

async function clearManualLocationAndReload() {
  const formPrefs = getPreferencesFromForm();
  const response = await window.luxshiftAPI.savePreferences({
    ...formPrefs,
    preferredLocationName: '',
    preferredLocation: null
  });

  if (response?.ok) {
    preferences = response.preferences;
    locationSearchInput.value = '';
    clearLocationResults();
    settingsHint.textContent = 'Manual location cleared. LuxShift will try device location.';
    startEnvironmentLoad(true);
  } else {
    settingsHint.textContent = 'Could not clear manual location.';
  }
}

function startEnvironmentLoad(isManualRetry = false) {
  if (environmentLoading) return;

  environmentLoading = true;
  retryEnvBtn.disabled = true;
  envValue.textContent = isManualRetry
    ? `App: ${appName} • Platform: ${platform} • Retrying environment lookup…`
    : `App: ${appName} • Platform: ${platform} • Loading environment in background…`;
  envHint.textContent = preferences.preferredLocation ? 'Using saved location.' : 'Trying device location first.';

  setTimeout(() => {
    loadEnvironment().finally(() => {
      environmentLoading = false;
      retryEnvBtn.disabled = false;
    });
  }, 0);
}

async function loadEnvironment() {
  try {
    let coords = null;

    if (preferences.preferredLocation?.latitude && preferences.preferredLocation?.longitude) {
      coords = {
        latitude: preferences.preferredLocation.latitude,
        longitude: preferences.preferredLocation.longitude
      };
    } else if (navigator.geolocation) {
      const position = await getCurrentPositionAsync({
        enableHighAccuracy: false,
        timeout: 25000,
        maximumAge: 300000
      });

      coords = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude
      };
    }

    if (!coords) {
      envValue.textContent = `App: ${appName} • Platform: ${platform} • No location source available`;
      envHint.textContent = 'Search for a city in Settings to provide environment context.';
      return;
    }

    const sun = window.luxshiftAPI?.getSunData
      ? window.luxshiftAPI.getSunData({
          ...coords,
          use24h: preferences.timeFormat === '24h'
        })
      : null;

    const env = window.luxshiftAPI?.getEnvironment
      ? await window.luxshiftAPI.getEnvironment(coords)
      : { ok: false, error: 'Bridge unavailable' };

    if (!env.ok) {
      envValue.textContent = `App: ${appName} • Platform: ${platform} • Weather failed`;
      envHint.textContent = 'Location resolved, but weather lookup failed.';
      return;
    }

    const weatherSummary = formatWeather(env.weather);
    envValue.textContent = sun
      ? `App: ${appName} • Platform: ${platform} • ${weatherSummary} • ${sun.summary}`
      : `App: ${appName} • Platform: ${platform} • ${weatherSummary}`;
    envHint.textContent = 'Environment loaded successfully.';
  } catch (_error) {
    envValue.textContent = `App: ${appName} • Platform: ${platform} • Location unavailable`;
    envHint.textContent = 'Use Settings to search for a city if device location is slow or unavailable.';
  }
}

function getCurrentPositionAsync(options) {
  return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, options));
}

async function handleParse() {
  if (settingsSaving) return;

  const baseText = input.value.trim();
  const lateChanges = lateChangesInput.value.trim();

  if (!baseText && !lateChanges) {
    renderEmptyPreview();
    modeValue.textContent = 'Waiting for input';
    return;
  }

  preview.innerHTML = `
    <div class="timeline-loading">
      <div class="timeline-loading-line"></div>
      <div class="timeline-loading-line short"></div>
    </div>
  `;
  modeValue.textContent = 'Parsing your current schedule';

  const parseText = [
    baseText ? `Current plan: ${baseText}` : '',
    lateChanges ? `Late changes or updates: ${lateChanges}` : '',
    `Usual sleep target: ${preferences.bedtimeTarget}`,
    `Usual wake target: ${preferences.wakeTarget}`
  ]
    .filter(Boolean)
    .join('\n\n');

  try {
    const result = await parseScheduleViaProxy(parseText);
    renderParseResult(result);
    await persistCurrentSchedule(result);
  } catch (error) {
    preview.innerHTML = `
      <div class="timeline-empty">
        <div class="timeline-empty-icon">!</div>
        <strong>LuxShift could not build the timeline.</strong>
        <p>${escapeHtml(error?.message || 'An unknown parsing issue occurred.')}</p>
      </div>
    `;
    modeValue.textContent = 'Parse unavailable';
  }
}

async function persistCurrentSchedule(result) {
  const saveResponse = await window.luxshiftAPI.saveActiveSchedule({
    rawPlanText: input.value.trim(),
    lateChangesText: lateChangesInput.value.trim(),
    summary: result?.summary || '',
    parsedBlocks: Array.isArray(result?.blocks) ? result.blocks : [],
    confidence: Number(result?.confidence ?? 0),
    reasons: Array.isArray(result?.reasons) ? result.reasons : [],
    source: result?.source || 'ai',
    unavailable: Boolean(result?.unavailable)
  });

  if (saveResponse?.ok) {
    const activeSchedule = saveResponse.schedule;
    const endLabel = activeSchedule.endTime
      ? formatTimeForHumans(activeSchedule.endTime)
      : 'the end of the saved plan';
    settingsHint.textContent = `Saved current schedule. LuxShift will remember it until ${endLabel}.`;
  } else {
    settingsHint.textContent = 'Parsed successfully, but could not save the current schedule.';
  }
}

function renderParseResult(result) {
  const blocks = Array.isArray(result?.blocks) ? result.blocks : [];
  const reasons = Array.isArray(result?.reasons) ? result.reasons : [];
  const summary = result?.summary || '';

  if (!blocks.length) {
    preview.innerHTML = `
      <div class="timeline-empty">
        <div class="timeline-empty-icon">!</div>
        <strong>I could not turn that into a timeline yet.</strong>
        <p>${escapeHtml(reasons[0] || 'Try adding a clearer plan with times and an ending, for example Start at 9 AM and finish by 11 PM.')}</p>
      </div>
    `;
    modeValue.textContent = 'Waiting for more schedule detail';
    return;
  }

  const normalizedBlocks = blocks.map(normalizeBlockForDisplay).sort(compareBlocks);
  const nextAnchor = inferTimelineAnchor(normalizedBlocks);
  const notesMarkup = reasons.length
    ? `<div class="timeline-notes"><p class="timeline-notes-title">Current plan notes</p><ul>${reasons.slice(0, 3).map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul></div>`
    : '';

  preview.innerHTML = `
    <section class="timeline-shell">
      <div class="timeline-header">
        <div>
          <p class="timeline-kicker">Current saved schedule</p>
          <h3>${escapeHtml(summary || 'Structured day plan')}</h3>
        </div>
        <div class="timeline-meta">
          <span class="timeline-pill">${normalizedBlocks.length} blocks</span>
        </div>
      </div>

      <div class="timeline-overview">
        <div class="timeline-overview-card">
          <span class="timeline-overview-label">Schedule starts</span>
          <strong>${escapeHtml(findScheduleStart(normalizedBlocks) || 'Unknown')}</strong>
        </div>
        <div class="timeline-overview-card">
          <span class="timeline-overview-label">Schedule ends</span>
          <strong>${escapeHtml(findScheduleEnd(normalizedBlocks) || 'Unknown')}</strong>
        </div>
        <div class="timeline-overview-card">
          <span class="timeline-overview-label">Focus blocks</span>
          <strong>${escapeHtml(countBlockTypes(normalizedBlocks) || 'Mixed')}</strong>
        </div>
        <div class="timeline-overview-card">
          <span class="timeline-overview-label">Status</span>
          <strong>Saved</strong>
        </div>
      </div>

      ${nextAnchor ? `<div class="timeline-anchor"><span class="timeline-anchor-dot"></span><span>Next anchor ${escapeHtml(nextAnchor)}</span></div>` : ''}
      <div class="timeline-list">${normalizedBlocks.map((block, index) => renderTimelineBlock(block, index, normalizedBlocks.length)).join('')}</div>
      ${notesMarkup}
    </section>
  `;

  modeValue.textContent = 'Current schedule ready';
}

function normalizeBlockForDisplay(block) {
  const normalized = { ...block };

  if (!normalized.start || !normalized.end) {
    const pair = extractTimeRangeFromText(normalized.timeLabel);
    if (pair?.start && !normalized.start) normalized.start = pair.start;
    if (pair?.end && !normalized.end) normalized.end = pair.end;

    if (!normalized.start) {
      const singleTime = extractSingleTimeFromText(normalized.timeLabel);
      if (singleTime) normalized.start = singleTime;
    }
  }

  normalized.start = normalizeTo24Hour(normalized.start) || normalized.start;
  normalized.end = normalizeTo24Hour(normalized.end) || normalized.end;

  return normalized;
}

function renderTimelineBlock(block, index, total) {
  const tone = getBlockTone(block.type);
  const title = block.title || 'Schedule block';
  const note = block.note || 'Parsed from your description.';
  const timeLabel = buildTimeLabel(block);

  return `
    <article class="timeline-item tone-${escapeHtml(tone.name)}">
      <div class="timeline-rail">
        <span class="timeline-node"></span>
        ${index < total - 1 ? '<span class="timeline-line"></span>' : ''}
      </div>
      <div class="timeline-card">
        <div class="timeline-card-top">
          <div class="timeline-time">${escapeHtml(timeLabel)}</div>
          <div class="timeline-badges">
            <span class="timeline-type-badge">${escapeHtml(tone.label)}</span>
          </div>
        </div>
        <h4>${escapeHtml(title)}</h4>
        <p>${escapeHtml(note)}</p>
      </div>
    </article>
  `;
}

function compareBlocks(a, b) {
  const aValue = timeToSortableValue(a?.start, a?.end, a?.timeLabel, 10000);
  const bValue = timeToSortableValue(b?.start, b?.end, b?.timeLabel, 10001);
  return aValue - bValue;
}

function timeToSortableValue(start, end, label, fallback) {
  const candidate = normalizeTo24Hour(start) || normalizeTo24Hour(end) || extractSingleTimeFromText(label);
  if (!candidate) return fallback;

  const [hours, minutes] = candidate.split(':').map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return fallback;

  return hours * 60 + minutes;
}

function extractTimeRangeFromText(text) {
  if (typeof text !== 'string') return null;

  const direct24hRange = text.match(/(\d{1,2}:\d{2})\s*(?:-|to|until|–|—)\s*(\d{1,2}:\d{2})/i);
  if (direct24hRange) {
    return {
      start: normalizeTo24Hour(direct24hRange[1]),
      end: normalizeTo24Hour(direct24hRange[2])
    };
  }

  const ampmRange = text.match(/(\d{1,2}(?::\d{2})?\s*[AP]M)\s*(?:-|to|until|–|—)\s*(\d{1,2}(?::\d{2})?\s*[AP]M)/i);
  if (ampmRange) {
    return {
      start: normalizeTo24Hour(ampmRange[1]),
      end: normalizeTo24Hour(ampmRange[2])
    };
  }

  return null;
}

function extractSingleTimeFromText(text) {
  if (typeof text !== 'string') return null;

  const direct24h = text.match(/\b(\d{1,2}:\d{2})\b/);
  if (direct24h) return normalizeTo24Hour(direct24h[1]);

  const ampm = text.match(/\b(\d{1,2}(?::\d{2})?\s*[AP]M)\b/i);
  if (ampm) return normalizeTo24Hour(ampm[1]);

  return null;
}

function normalizeTo24Hour(value) {
  if (!value || typeof value !== 'string') return null;

  const trimmed = value.trim().toUpperCase();

  const direct = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (direct) {
    const hours = Number(direct[1]);
    const minutes = Number(direct[2]);

    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;

    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }

  const ampm = trimmed.match(/^(\d{1,2})(?::(\d{2}))?\s*([AP]M)$/);
  if (!ampm) return null;

  let hours = Number(ampm[1]);
  const minutes = Number(ampm[2] || '00');
  const meridiem = ampm[3];

  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours < 1 || hours > 12 || minutes < 0 || minutes > 59) return null;

  if (meridiem === 'AM' && hours === 12) hours = 0;
  if (meridiem === 'PM' && hours !== 12) hours += 12;

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function buildTimeLabel(block) {
  const start = block?.start ? formatTimeForHumans(block.start) : null;
  const end = block?.end ? formatTimeForHumans(block.end) : null;

  if (start && end) return `${start} — ${end}`;
  if (start) return `${start} onward`;
  if (end) return `Until ${end}`;

  const parsedRange = extractTimeRangeFromText(block?.timeLabel);
  if (parsedRange?.start && parsedRange?.end) {
    return `${formatTimeForHumans(parsedRange.start)} — ${formatTimeForHumans(parsedRange.end)}`;
  }

  const parsedSingle = extractSingleTimeFromText(block?.timeLabel);
  if (parsedSingle) return formatTimeForHumans(parsedSingle);

  return block?.timeLabel?.trim() || 'Time being inferred';
}

function inferTimelineAnchor(blocks) {
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const upcoming = blocks.find((block) => timeToSortableValue(block?.start, block?.end, block?.timeLabel, 10000) >= nowMinutes);

  if (!upcoming) return null;
  return `${buildTimeLabel(upcoming)} • ${upcoming.title || 'Upcoming block'}`;
}

function countBlockTypes(blocks) {
  const counts = blocks.reduce((acc, block) => {
    const key = block?.type || 'general';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const parts = Object.entries(counts).map(([key, count]) => `${capitalize(key)} ${count}`);
  return parts.join(', ');
}

function findScheduleStart(blocks) {
  const first = [...blocks].sort(compareBlocks).find((block) => block?.start || block?.timeLabel);
  if (!first) return null;
  return first.start ? formatTimeForHumans(first.start) : buildTimeLabel(first);
}

function findScheduleEnd(blocks) {
  const candidates = blocks
    .map((block) => normalizeTo24Hour(block?.end) || normalizeTo24Hour(block?.start) || null)
    .filter(Boolean)
    .sort();

  if (!candidates.length) return null;
  return formatTimeForHumans(candidates[candidates.length - 1]);
}

function getBlockTone(type) {
  switch (type) {
    case 'work':
      return { name: 'work', label: 'Work' };
    case 'unwind':
      return { name: 'unwind', label: 'Unwind' };
    case 'sleep':
      return { name: 'sleep', label: 'Sleep' };
    case 'wake':
      return { name: 'wake', label: 'Wake' };
    case 'break':
      return { name: 'break', label: 'Break' };
    case 'leisure':
      return { name: 'leisure', label: 'Leisure' };
    case 'meal':
      return { name: 'break', label: 'Meal' };
    case 'exercise':
      return { name: 'leisure', label: 'Exercise' };
    case 'study':
      return { name: 'work', label: 'Study' };
    case 'personal':
      return { name: 'general', label: 'Personal' };
    case 'commute':
      return { name: 'general', label: 'Commute' };
    case 'other':
      return { name: 'general', label: 'General' };
    default:
      return { name: 'general', label: 'General' };
  }
}

function formatWeather(weather) {
  if (!weather) return 'Weather unavailable';
  const temp = Number.isFinite(Number(weather.temperature2m)) ? `Temp ${Math.round(Number(weather.temperature2m))}C` : 'Temp n/a';
  const clouds = Number.isFinite(Number(weather.cloudcover)) ? `Clouds ${Math.round(Number(weather.cloudcover))}%` : 'Clouds n/a';
  const daylight = Number(weather.isday) === 1 ? 'Daylight' : 'Night';
  return `${temp}, ${clouds}, ${daylight}`;
}

function formatLocationLabel(location) {
  if (!location) return 'Unknown location';
  return [location.name, location.admin1, location.country].filter(Boolean).join(', ');
}

function formatTimeForHumans(value) {
  const normalized = normalizeTo24Hour(value);
  if (!normalized) return value || 'Unknown';

  const [rawHours, rawMinutes] = normalized.split(':');
  const hours = Number(rawHours);
  const minutes = Number(rawMinutes);
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);

  return date.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    hour12: preferences.timeFormat !== '24h'
  });
}

function capitalize(value) {
  if (!value) return '';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}