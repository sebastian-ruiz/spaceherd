// App configuration and state under ~/.config/spaceherd.

const fs = require('fs');
const os = require('os');
const path = require('path');

// The app was called code-manager before; move its files over once.
function migrateDir(oldPath, newPath) {
  if (fs.existsSync(newPath) || !fs.existsSync(oldPath)) return;
  try {
    fs.renameSync(oldPath, newPath);
  } catch (err) {
    console.warn(`Could not move ${oldPath} to ${newPath}: ${err.message}`);
  }
}

const DIR = process.env.SPACEHERD_DIR || path.join(os.homedir(), '.config', 'spaceherd');
if (!process.env.SPACEHERD_DIR) migrateDir(path.join(os.homedir(), '.config', 'code-manager'), DIR);
const CONFIG_PATH = path.join(DIR, 'config.json');
const STATE_PATH = path.join(DIR, 'state.json');

const DEFAULT_CONFIG = {
  // Command that starts the herdr TUI in the left pane.
  herdr: { command: 'herdr', args: [] },
  machines: [
    {
      id: 'local',
      type: 'local',
      // Hostnames herdr shows for this machine in its window title.
      hostnames: [os.hostname()],
      vscodePort: 47800,
    },
    // SSH machines are documented in README.md.
  ],
  // "machineId:workspaceLabel" -> folder, wins over the pinned folder.
  folderOverrides: {},
  maxLiveViews: 6,
  // Written into VS Code's user settings in every view, for settings that
  // VS Code reads only from there (see src/main/vscode-settings.js). These
  // win over changes made in VS Code.
  vscodeUserSettings: { 'window.menuBarVisibility': 'classic' },
  terminalWidth: 0.42,
  terminal: {
    fontFamily: 'MesloLGS NF, JetBrainsMono Nerd Font, Menlo, monospace',
    fontSize: 13,
    macOptionIsMeta: false,
  },
};

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value, mode = 0o644) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode });
}

function loadConfig() {
  ensureDir();
  if (!fs.existsSync(CONFIG_PATH)) writeJson(CONFIG_PATH, DEFAULT_CONFIG);
  const user = readJson(CONFIG_PATH, {});
  return {
    ...DEFAULT_CONFIG,
    ...user,
    herdr: { ...DEFAULT_CONFIG.herdr, ...user.herdr },
    terminal: { ...DEFAULT_CONFIG.terminal, ...user.terminal },
  };
}

// Pinned folders per space, so a `cd` inside a pane doesn't move VS Code.
const state = {
  data: null,
  load() {
    this.data = readJson(STATE_PATH, { pinnedFolders: {} });
    return this;
  },
  getPinned(key) {
    return this.data.pinnedFolders[key];
  },
  setPinned(key, folder) {
    this.data.pinnedFolders[key] = folder;
    writeJson(STATE_PATH, this.data);
  },
  get(key, fallback) {
    return this.data[key] ?? fallback;
  },
  set(key, value) {
    this.data[key] = value;
    writeJson(STATE_PATH, this.data);
  },
};

// Timestamped log lines, enabled with SPACEHERD_DEBUG=1.
const debug = process.env.SPACEHERD_DEBUG ? (...args) => console.log(Date.now(), ...args) : () => {};

module.exports = {
  debug,
  migrateDir,
  DIR,
  CONFIG_PATH,
  loadConfig,
  state,
};
