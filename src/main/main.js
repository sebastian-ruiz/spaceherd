const path = require('path');
const { execFileSync } = require('child_process');
const { app, BrowserWindow, WebContentsView, Menu, ipcMain } = require('electron');
const { loadConfig, state, CONFIG_PATH, debug, migrateDir } = require('./config');
const { createMachine, herdrSavedMachines } = require('./machines');
const { VSCodeViews } = require('./vscode-views');
const { Spaces } = require('./spaces');
const { Attention } = require('./attention');
const { HerdrPty } = require('./pty');
const { forwardsToVSCode, asInputEvent, chord } = require('./shortcuts');

app.setName('spaceherd');
// Electron data (VS Code's per-machine state, cookies) lived under the old
// app name; move it before anything opens it.
// SPACEHERD_DIR isolates everything, including this.
if (process.env.SPACEHERD_DIR) {
  app.setPath('userData', path.join(process.env.SPACEHERD_DIR, 'electron'));
} else {
  const userData = path.join(app.getPath('appData'), 'spaceherd');
  migrateDir(path.join(app.getPath('appData'), 'Code Manager'), userData);
  app.setPath('userData', userData);
}

// Apps started from Finder get a minimal PATH. Take PATH from a login shell
// so `herdr`, `code` and `ssh` resolve the same way as in a terminal.
function shellEnv() {
  const env = { ...process.env };
  try {
    const out = execFileSync(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf "__CM__%s__CM__" "$PATH"'], {
      timeout: 5000,
      encoding: 'utf8',
    });
    const m = out.match(/__CM__(.*)__CM__/);
    if (m) env.PATH = m[1];
  } catch (err) {
    console.warn('Could not read PATH from login shell:', err.message);
  }
  return env;
}

let win, terminalView, views, spaces, attention, herdrPty, machines;
let config;

function layout() {
  if (!win) return;
  const { width, height } = win.getContentBounds();
  const termWidth = Math.round(width * state.get('terminalWidth', config.terminalWidth));
  terminalView.setBounds({ x: 0, y: 0, width: termWidth, height });
  views.setBounds({ x: termWidth, y: 0, width: width - termWidth, height });
}

// Keyboard focus follows what the user last clicked or typed in. VS Code
// focuses itself when a view loads; if the user was working in herdr, focus
// goes straight back, so the next click in herdr acts instead of refocusing.
const focusIntent = { target: 'terminal', vscodeInputAt: 0 };

const isUserInput = (input) => input.type === 'mouseDown' || input.type === 'rawKeyDown';

function focusTerminal() {
  focusIntent.target = 'terminal';
  terminalView.webContents.focus();
  terminalView.webContents.send('terminal:focus');
}

function focusVSCode() {
  focusIntent.target = 'vscode';
  views.focus();
}

function guardVSCodeFocus(webContents) {
  webContents.on('input-event', (_e, input) => {
    if (!isUserInput(input)) return;
    debug('vscode', input.type);
    focusIntent.target = 'vscode';
    focusIntent.vscodeInputAt = Date.now();
  });
  // A click's input event can arrive just after the focus event, so decide
  // a moment later.
  webContents.on('focus', () => {
    setTimeout(() => {
      if (focusIntent.target === 'terminal' && Date.now() - focusIntent.vscodeInputAt > 300) focusTerminal();
    }, 50);
  });
}

function startHerdr() {
  const send = (d) => terminalView.webContents.send('pty:data', d);
  herdrPty = new HerdrPty({
    command: config.herdr.command,
    args: config.herdr.args,
    env: shellEnv.cached,
    onData: send,
    onExit: (code) => {
      send(`\r\n\x1b[2m[herdr exited (${code}). Press any key to reattach.]\x1b[0m\r\n`);
      herdrPty.waitingForKey = true;
    },
  });
  herdrPty.start();
}

function buildMenu() {
  const template = [
    { role: 'appMenu' },
    {
      // Only clipboard roles: undo/redo/select-all accelerators would steal
      // those keys from VS Code's own keybindings.
      label: 'Edit',
      submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Focus Terminal', accelerator: 'Ctrl+Cmd+Left', click: focusTerminal },
        { label: 'Focus VS Code', accelerator: 'Ctrl+Cmd+Right', click: focusVSCode },
        { type: 'separator' },
        { label: 'Pin VS Code Folder to Focused Pane', click: () => spaces.repinToFocusedPane() },
        { label: 'Reload VS Code View', click: () => views.reload() },
        { type: 'separator' },
        { label: 'Open Config File', click: () => require('electron').shell.openPath(CONFIG_PATH) },
        { label: 'Terminal Developer Tools', click: () => terminalView.webContents.openDevTools({ mode: 'detach' }) },
        { label: 'VS Code Developer Tools', click: () => views.activeWebContents()?.openDevTools({ mode: 'detach' }) },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1680,
    height: 1000,
    backgroundColor: '#181818',
    title: 'spaceherd',
    // The first click after switching apps acts too, e.g. on herdr's sidebar.
    acceptFirstMouse: true,
  });

  terminalView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'terminal.js'),
      sandbox: true,
      contextIsolation: true,
    },
  });
  terminalView.setBackgroundColor('#181818');
  win.contentView.addChildView(terminalView);
  terminalView.webContents.loadFile(path.join(__dirname, '..', 'renderer', 'terminal.html'));
  terminalView.webContents.on('input-event', (_e, input) => {
    if (input.type === 'mouseDown' || input.type === 'mouseUp') debug(`terminal ${input.type}`, input.x, input.y);
    if (isUserInput(input)) focusIntent.target = 'terminal';
  });
  // VS Code's shortcuts work from herdr, as from VS Code's own terminal. Only
  // the key press is replayed: focus moves first, so VS Code gets the release
  // itself (Ctrl+Tab's picker opens the editor when Ctrl is let go).
  terminalView.webContents.on('before-input-event', (event, input) => {
    const target = views.activeWebContents();
    if (!target || !forwardsToVSCode(input)) return;
    debug('forward to vscode', chord(input));
    event.preventDefault();
    focusVSCode();
    target.sendInputEvent(asInputEvent(input));
  });
  terminalView.webContents.on('focus', () => debug('terminal view focused'));
  terminalView.webContents.on('blur', () => debug('terminal view blurred'));

  views = new VSCodeViews(win, { maxLive: config.maxLiveViews, onViewCreated: guardVSCodeFocus });
  layout();
  win.on('resize', layout);
  win.on('closed', () => { win = null; });

  machines = config.machines.map((def) => createMachine(def, { env: shellEnv.cached }));
  spaces = new Spaces({ machines, views, config, state });
  spaces.on('changed', (target) => {
    win?.setTitle(target ? `${target.workspace.label} — ${target.machine.id}` : 'spaceherd');
  });
  attention = new Attention({
    machines,
    onActivate: (target) => {
      if (!win) return;
      win.show();
      win.focus();
      if (target) target.machine.herdr.request('workspace.focus', { workspace_id: target.workspaceId }).catch(() => {});
      focusTerminal();
    },
  });
  for (const m of machines) m.start();
  syncHerdrMachines();
  setInterval(syncHerdrMachines, 15000);
}

// Adds SSH machines saved in herdr that the config doesn't list. Each gets a
// stable local port, so its VS Code state (kept per origin) survives restarts.
async function syncHerdrMachines() {
  const ports = state.get('machinePorts', {});
  for (const def of await herdrSavedMachines(shellEnv.cached)) {
    if (machines.some((m) => m.id === def.id)) continue;
    if (!ports[def.id]) {
      const used = [...machines.map((m) => m.vscodePort), ...Object.values(ports)];
      ports[def.id] = Math.max(47800, ...used) + 1;
      state.set('machinePorts', ports);
    }
    const machine = createMachine({ ...def, vscodePort: ports[def.id] }, { env: shellEnv.cached });
    machines.push(machine);
    spaces.watch(machine);
    attention.watch(machine);
    machine.start();
    console.log(`[${def.id}] added from herdr machine list (port ${ports[def.id]})`);
  }
}

ipcMain.on('terminal:ready', () => {
  terminalView.webContents.send('terminal:config', config.terminal);
  if (!herdrPty) startHerdr();
});
ipcMain.on('pty:write', (_e, data) => {
  debug('pty <-', JSON.stringify(data));
  if (herdrPty.waitingForKey) {
    herdrPty.waitingForKey = false;
    herdrPty.start();
    return;
  }
  herdrPty.write(data);
});
ipcMain.on('pty:resize', (_e, cols, rows) => herdrPty?.resize(cols, rows));
ipcMain.on('terminal:title', (_e, title) => spaces.onTitle(title));
ipcMain.on('terminal:osc', (_e, code, payload) => attention.onOsc(code, payload));
ipcMain.on('terminal:bell', () => attention.onBell());
ipcMain.on('terminal:debug', (_e, msg) => debug('[terminal]', msg));
let saveWidthTimer;
ipcMain.on('layout:drag', (_e, screenX) => {
  const { x, width } = win.getContentBounds();
  const ratio = Math.min(0.85, Math.max(0.15, (screenX - x) / width));
  state.data.terminalWidth = ratio;
  layout();
  clearTimeout(saveWidthTimer);
  saveWidthTimer = setTimeout(() => state.set('terminalWidth', ratio), 300);
});

app.whenReady().then(() => {
  config = loadConfig();
  state.load();
  shellEnv.cached = shellEnv();
  buildMenu();
  createWindow();
});

app.on('before-quit', () => {
  herdrPty?.kill();
  for (const m of machines || []) m.stop();
});

app.on('window-all-closed', () => app.quit());
