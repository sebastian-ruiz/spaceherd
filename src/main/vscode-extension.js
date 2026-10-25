// Installs spaceherd's own VS Code extension (src/vscode-extension) into the
// local VS Code server, which loads user extensions from
// <server data dir>/extensions and lists them in extensions.json there.
// Rewritten when spaceherd ships a different copy; a VS Code window picks it
// up when it next loads.

const fs = require('fs');
const os = require('os');
const path = require('path');

const SOURCE = path.join(__dirname, '..', 'vscode-extension');
const FILES = ['package.json', 'extension.js'];
const MANIFEST = JSON.parse(fs.readFileSync(path.join(SOURCE, 'package.json'), 'utf8'));
const ID = `${MANIFEST.publisher}.${MANIFEST.name}`;
const FOLDER = `${ID}-${MANIFEST.version}`;

// Where `code serve-web` keeps its data unless told otherwise.
function defaultServerDataDir() {
  return process.env.VSCODE_AGENT_FOLDER || path.join(os.homedir(), '.vscode-server');
}

function installVSCodeExtension(serverDataDir = defaultServerDataDir()) {
  const extensionsDir = path.join(serverDataDir, 'extensions');
  const dir = path.join(extensionsDir, FOLDER);
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const file of FILES) {
      const text = fs.readFileSync(path.join(SOURCE, file), 'utf8');
      const target = path.join(dir, file);
      if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== text) fs.writeFileSync(target, text);
    }
    register(extensionsDir, dir);
  } catch (err) {
    console.warn('installing the VS Code extension:', err.message);
  }
}

// Lists this version in extensions.json, dropping other versions of it.
// VS Code ignores extension folders that aren't listed there.
function register(extensionsDir, dir) {
  const file = path.join(extensionsDir, 'extensions.json');
  let entries = [];
  try {
    entries = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // Missing or unreadable: start a new list.
  }
  if (!Array.isArray(entries)) entries = [];
  const mine = (e) => e?.identifier?.id?.toLowerCase() === ID;
  if (entries.some((e) => mine(e) && e.version === MANIFEST.version && e.relativeLocation === FOLDER)) return;
  for (const old of entries.filter(mine)) {
    if (old.relativeLocation && old.relativeLocation !== FOLDER) {
      fs.rmSync(path.join(extensionsDir, old.relativeLocation), { recursive: true, force: true });
    }
  }
  entries = entries.filter((e) => !mine(e));
  entries.push({
    identifier: { id: ID },
    version: MANIFEST.version,
    location: { $mid: 1, path: uriPath(dir), scheme: 'file' },
    relativeLocation: FOLDER,
    metadata: { installedTimestamp: Date.now(), source: 'vsix', pinned: true },
  });
  // Replaced in one step: the server may be reading it.
  const tmp = `${file}.spaceherd-tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries));
  fs.renameSync(tmp, file);
}

// A file URI's path: C:\x becomes /C:/x on Windows.
function uriPath(file) {
  const p = file.split(path.sep).join('/');
  return p.startsWith('/') ? p : '/' + p;
}

module.exports = { installVSCodeExtension };
