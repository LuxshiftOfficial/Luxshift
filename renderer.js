// Debug: confirm API bridge presence
if (window.luxshiftAPI) {
  console.log('✅ luxshiftAPI is available');
} else {
  console.warn('⚠️ luxshiftAPI is MISSING – UI actions will be inert');
}

// Attach debug logs to key buttons (optional; will be removed in future releases)
const _debugAttach = (id, name) => {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener('click', () => console.log(`Button ${name} clicked`));
  }
};
_debugAttach('parseBtn', 'Parse');
_debugAttach('fillBtn', 'Fill');
_debugAttach('clearBtn', 'Clear');
_debugAttach('saveSettingsBtn', 'Save Settings');
_debugAttach('searchLocationBtn', 'Search Location');
_debugAttach('useDeviceLocationBtn', 'Use Device Location');
