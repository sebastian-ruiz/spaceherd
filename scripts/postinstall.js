// Runs after `npm install`.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');

// node-pty's prebuilt macOS spawn-helper ships without its executable bit.
// On Linux node-pty builds from source and there is none.
const prebuilds = path.join(root, 'node_modules', 'node-pty', 'prebuilds');
for (const dir of fs.existsSync(prebuilds) ? fs.readdirSync(prebuilds) : []) {
  const helper = path.join(prebuilds, dir, 'spawn-helper');
  if (dir.startsWith('darwin-') && fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
}

// The macOS menu bar and Dock show the bundle's name, not app.setName(), and
// `npm start` runs node_modules' Electron.app. Rename it, then re-sign it
// (ad hoc, as it ships), since Info.plist is covered by the signature.
// Electron downloads its binary the first time its path is asked for, not
// on install, so asking for it here also fetches it.
if (process.platform === 'darwin') {
  const executable = require('electron');
  const bundle = executable.slice(0, executable.indexOf('.app') + 4);
  const plist = path.join(bundle, 'Contents', 'Info.plist');
  for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} Spaceherd`, plist]);
  }
  execFileSync('codesign', ['--force', '--sign', '-', bundle]);
}
