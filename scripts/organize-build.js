// organize-build.js
// After electron-builder finishes, this script files every versioned release
// artifact (DMG/ZIP + their blockmaps) out of the flat dist/ root into:
//
//   dist/releases/<current-version>/        ← files for the CURRENT release
//   dist/releases/olderreleases/<version>/ ← files for every older release
//
// so the dist root stays tidy: one folder for the current release and one
// folder holding all the older releases. Build intermediates (mac-universal/,
// builder-debug.yml, etc.) are left in place.

const fs = require('fs');
const path = require('path');

const distDir = path.resolve(__dirname, '..', 'dist');
const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));
const currentVersion = pkg.version;

const releasesDir = path.join(distDir, 'releases');
const olderReleasesDir = path.join(releasesDir, 'olderreleases');

// LuxShift-<x.y.z>-universal.dmg | .zip | *.blockmap
const RELEASE_FILE = /^LuxShift-(\d+\.\d+\.\d+)-.*\.(dmg|zip|blockmap)$/;

if (!fs.existsSync(distDir)) {
  console.log('No dist directory found — nothing to organize.');
  process.exit(0);
}

fs.mkdirSync(releasesDir, { recursive: true });
fs.mkdirSync(olderReleasesDir, { recursive: true });

const releaseFiles = fs
  .readdirSync(distDir)
  .filter((name) => {
    const full = path.join(distDir, name);
    return fs.statSync(full).isFile() && RELEASE_FILE.test(name);
  })
  .sort();

let currentCount = 0;
let olderCount = 0;

for (const file of releaseFiles) {
  const version = file.match(RELEASE_FILE)[1];
  const isCurrent = version === currentVersion;
  const targetDir = isCurrent
    ? path.join(releasesDir, version)
    : path.join(olderReleasesDir, version);

  fs.mkdirSync(targetDir, { recursive: true });

  const src = path.join(distDir, file);
  const dest = path.join(targetDir, file);

  if (fs.existsSync(dest)) {
    // Artifact already organized (e.g., a re-run): drop the stray duplicate
    // at the root instead of clobbering the archived copy.
    try { fs.unlinkSync(src); } catch (_) {}
    continue;
  }

  fs.renameSync(src, dest);
  console.log(
    `${isCurrent ? 'current' : 'older  '} ${file} → ${path.relative(distDir, dest)}`
  );
  if (isCurrent) currentCount++; else olderCount++;
}

// Tidy any now-empty older per-version folders.
if (fs.existsSync(olderReleasesDir)) {
  for (const entry of fs.readdirSync(olderReleasesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(olderReleasesDir, entry.name);
    if (fs.readdirSync(dir).length === 0) {
      try { fs.rmdirSync(dir); } catch (_) {}
    }
  }
}

console.log(`Current release: ${currentCount} artifact(s) → dist/releases/${currentVersion}/`);
console.log(`Older releases : ${olderCount} artifact(s) → dist/releases/olderreleases/`);
console.log('Release organization complete.');
