// organize-build.js
// After electron-builder finishes, this script moves the generated DMG/ZIP files
// into a version‑specific folder under dist/releases/, and archives any older
// release folders under dist/releases/olderreleases/.

const fs = require('fs');
const path = require('path');

// Load the package.json of the project (one level up)
const pkgPath = path.resolve(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const version = pkg.version;

const distDir = path.resolve(__dirname, '..', 'dist');
const releasesDir = path.join(distDir, 'releases');
const currentReleaseDir = path.join(releasesDir, version);
const olderReleasesDir = path.join(releasesDir, 'olderreleases');

// Ensure the directories exist
fs.mkdirSync(currentReleaseDir, { recursive: true });
fs.mkdirSync(olderReleasesDir, { recursive: true });

// Move the freshly built artifacts (DMG and ZIP) into the current version folder
const builtFiles = fs.readdirSync(distDir).filter(f => {
  const prefix = `LuxShift-${version}`;
  return (f.startsWith(prefix) && (f.endsWith('.dmg') || f.endsWith('.zip')));
});

builtFiles.forEach(file => {
  const src = path.join(distDir, file);
  const dest = path.join(currentReleaseDir, file);
  fs.renameSync(src, dest);
  console.log(`Moved ${file} → ${path.relative(distDir, dest)}`);
});

// Archive any existing release folders (that are not the current version
// and not the olderreleases container) into olderreleases/.
fs.readdirSync(releasesDir, { withFileTypes: true }).forEach(entry => {
  if (!entry.isDirectory()) return;
  const name = entry.name;
  if (name === version || name === 'olderreleases') return;
  const oldPath = path.join(releasesDir, name);
  const newPath = path.join(olderReleasesDir, name);
  // Move only if not already moved
  if (!fs.existsSync(newPath)) {
    fs.renameSync(oldPath, newPath);
    console.log(`Archived older release ${name} → olderreleases/${name}`);
  }
});

console.log('Release organization complete.');
