const path = require('path');
const { execFileSync } = require('child_process');
const { app, BrowserWindow, WebContentsView, Menu, ipcMain, nativeTheme, clipboard, webContents, shell, dialog } = require('electron');
const { loadConfig, state, CONFIG_PATH, debug } = require('./config');
const { createMachine, herdrSavedMachines } = require('./machines');
const { VSCodeViews } = require('./vscode-views');
const { Spaces } = require('./spaces');
const { Attention } = require('./attention');
const { HerdrPty } = require('./pty');
const { forwardsToVSCode, asInputEvent, chord } = require('./shortcuts');
const { applyUserSettings } = require('./vscode-settings');
const { dropText } = require('./drop');
const { findSequence } = require('./herdr-keys');
const { installCodeCommand, uninstallCodeCommand } = require('./code-command');
const { parseLink } = require('./links');
const { workbenchReady, quickOpen } = require('./quick-open');
const { Updater } = require('./updater');
const { desktopEntryExists, createDesktopEntry } = require('./desktop-entry');

app.setName('Spaceherd');
// Run from source, the bundle is Electron's, and the About panel would show
// Electron's version.
app.setAboutPanelOptions({ applicationVersion: app.getVersion(), version: '' });

// The packaged macOS app has the icon in its bundle. Run from source the
// Dock would show Electron's, and Linux takes the window's icon.
const ICON = path.join(__dirname, '..', '..', 'build', 'icon.png');
// Electron data (VS Code's per-machine state, cookies) goes in a fixed
// "spaceherd" folder rather than one named after the app's display name.
// SPACEHERD_DIR isolates everything, including this.
app.setPath('userData', process.env.SPACEHERD_DIR
  ? path.join(process.env.SPACEHERD_DIR, 'electron')
  : path.join(app.getPath('appData'), 'spaceherd'));

state.load();

// Linux draws the menu bar and dialogs with the GTK theme, which GTK reads
// once, when the first window shows. Use its dark variant unless herdr's theme
// was light last time (see terminal:appearance). Children get the user's
// environment back: GTK_THEME is set only until then and left out of
// shellEnv.
let darkGtkTheme = false;
if (process.platform === 'linux' && !process.env.GTK_THEME && state.data.appearance !== 'light') {
  let theme = 'Adwaita';
  try {
    theme = execFileSync('gsettings', ['get', 'org.gnome.desktop.interface', 'gtk-theme'], { timeout: 1000, encoding: 'utf8' })
      .trim()
      .replace(/^'|'$/g, '') || theme;
  } catch {}
  if (!/dark/i.test(theme)) {
    process.env.GTK_THEME = `${theme}:dark`;
    darkGtkTheme = true;
  }
}

// Apps started from Finder get a minimal PATH. Take PATH from a login shell
// so `herdr`, `code` and `ssh` resolve the same way as in a terminal.
function shellEnv() {
  const env = { ...process.env };
  if (darkGtkTheme) delete env.GTK_THEME;
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

let win, terminalView, views, spaces, attention, herdrPty, machines, updater;
let config;

// Whether the focused space has VS Code open. Without it herdr gets the
// whole window.
let vscodeVisible = false;

function layout() {
  if (!win) return;
  const { width, height } = win.getContentBounds();
  const termWidth = vscodeVisible ? Math.round(width * state.get('terminalWidth', config.terminalWidth)) : width;
  terminalView.setBounds({ x: 0, y: 0, width: termWidth, height });
  views.setBounds({ x: termWidth, y: 0, width: width - termWidth, height });
}

// Keyboard focus follows what the user last clicked or typed in. VS Code
// focuses itself when a view loads; if the user was working in herdr, focus
// goes straight back, so the next click in herdr acts instead of refocusing.
const focusIntent = { target: 'terminal', vscodeInputAt: 0 };

const isUserInput = (input) => input.type === 'mouseDown' || input.type === 'rawKeyDown';

// Linux terminals copy and paste with Ctrl+Shift+C/V, since Ctrl+C and Ctrl+V
// belong to the shell. Copy takes xterm's own selection (Shift+drag); herdr's
// selections are copied when the mouse is let go.
function terminalKeys(input) {
  if (process.platform !== 'linux' || input.type !== 'keyDown') return false;
  const c = chord(input);
  if (c === 'ctrl+shift+c') terminalView.webContents.copy();
  else if (c === 'ctrl+shift+v') terminalView.webContents.paste();
  else return false;
  return true;
}

function focusTerminal() {
  focusIntent.target = 'terminal';
  terminalView.webContents.focus();
  terminalView.webContents.send('terminal:focus');
}

function focusVSCode() {
  focusIntent.target = 'vscode';
  views.focus();
}

function setUpVSCodeView(webContents) {
  guardVSCodeFocus(webContents);
  webContents.on('did-finish-load', () => {
    applyUserSettings(webContents, config.vscodeUserSettings).catch((err) => console.warn('VS Code user settings:', err.message));
  });
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
  const updateItem = updater.menuItem();
  const codeItems = [
    { label: 'Install ‘code’ Command in herdr Panes…', click: () => installCodeCommand(win, machines) },
    { label: 'Uninstall ‘code’ Command', click: () => uninstallCodeCommand(win, machines) },
  ];
  const template = [
    process.platform === 'darwin'
      ? {
          label: app.name,
          submenu: [
            { role: 'about' },
            updateItem,
            { type: 'separator' },
            ...codeItems,
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        }
      : {
          label: 'File',
          submenu: [
            ...codeItems,
            ...(desktopEntryExists()
              ? []
              : [
                  { type: 'separator' },
                  {
                    label: 'Create Desktop Entry',
                    click: () => {
                      createDesktopEntry(win, ICON);
                      buildMenu();
                    },
                  },
                ]),
            { type: 'separator' },
            { role: 'quit' },
          ],
        },
    process.platform === 'darwin'
      ? {
          // Only clipboard roles: undo/redo/select-all accelerators would steal
          // those keys from VS Code's own keybindings.
          label: 'Edit',
          submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }],
        }
      : {
          // On Linux the roles' Ctrl+C/X/V would take Ctrl+C from the shell.
          // The terminal's Ctrl+Shift+C/V are handled with its keys (see
          // terminalKeys), so the menu only shows them.
          label: 'Edit',
          submenu: [
            { label: 'Copy', accelerator: 'Ctrl+Shift+C', registerAccelerator: false, click: () => webContents.getFocusedWebContents()?.copy() },
            { label: 'Paste', accelerator: 'Ctrl+Shift+V', registerAccelerator: false, click: () => webContents.getFocusedWebContents()?.paste() },
          ],
        },
    {
      label: 'View',
      submenu: [
        { label: 'Focus Terminal', accelerator: 'Ctrl+Cmd+Left', click: focusTerminal },
        { label: 'Focus VS Code', accelerator: 'Ctrl+Cmd+Right', click: focusVSCode },
        { type: 'separator' },
        {
          id: 'vscode-toggle',
          label: 'VS Code for This Space',
          type: 'checkbox',
          accelerator: process.platform === 'darwin' ? 'Ctrl+Cmd+E' : 'Ctrl+Alt+Shift+E',
          click: () => spaces.toggleVSCode(),
        },
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
    ...(process.platform === 'darwin' ? [] : [{ label: 'Help', submenu: [updateItem] }]),
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  // Rebuilding drops the checkbox state.
  const toggle = Menu.getApplicationMenu().getMenuItemById('vscode-toggle');
  if (toggle) toggle.checked = vscodeVisible;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1680,
    height: 1000,
    backgroundColor: '#181818',
    title: 'spaceherd',
    // The first click after switching apps acts too, e.g. on herdr's sidebar.
    acceptFirstMouse: true,
    icon: process.platform === 'linux' ? ICON : undefined,
  });
  if (darkGtkTheme) win.once('show', () => delete process.env.GTK_THEME);

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
    if (terminalKeys(input)) {
      event.preventDefault();
      return;
    }
    const target = views.activeWebContents();
    if (!target || !forwardsToVSCode(input)) return;
    debug('forward to vscode', chord(input));
    event.preventDefault();
    focusVSCode();
    target.sendInputEvent(asInputEvent(input));
  });
  terminalView.webContents.on('focus', () => debug('terminal view focused'));
  terminalView.webContents.on('blur', () => debug('terminal view blurred'));

  views = new VSCodeViews(win, {
    maxLive: config.maxLiveViews,
    idleMinutes: config.idleViewMinutes,
    onViewCreated: setUpVSCodeView,
    onSpaceherdLink,
  });
  layout();
  win.on('resize', layout);
  // Close the VS Code views first, as a browser closes tabs, so each server
  // ends their extension hosts now instead of keeping them for a reconnect.
  // Quitting goes through here too: the window closes, then the app quits.
  let viewsClosed = false;
  win.on('close', (event) => {
    if (viewsClosed) return;
    event.preventDefault();
    views.closeAll().then(() => {
      viewsClosed = true;
      win?.close();
    });
  });
  win.on('closed', () => { win = null; });

  machines = config.machines.map(newMachine);
  spaces = new Spaces({ machines, views, config, state });
  spaces.on('layout', (open) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById('vscode-toggle');
    if (item) item.checked = open;
    if (open === vscodeVisible) return;
    vscodeVisible = open;
    layout();
    terminalView.webContents.send('terminal:divider', open);
    if (!open && focusIntent.target === 'vscode') focusTerminal();
  });
  spaces.on('changed', (target) => {
    win?.setTitle(target ? `${target.workspace.label} — ${target.machine.id}` : 'spaceherd');
  });
  attention = new Attention({
    machines,
    settings: config.notifications,
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

// An SSH machine's hostname (what herdr's title shows) is learned on
// connecting. Remember it, so the title matches the machine at startup.
function newMachine(def) {
  const learned = state.get('machineHostnames', {});
  const machine = createMachine(
    { ...def, hostnames: [...(def.hostnames || []), ...(learned[def.id] || [])] },
    { env: shellEnv.cached },
  );
  machine.on('hostname', (h) => {
    const all = { ...state.get('machineHostnames', {}) };
    all[def.id] = [...new Set([...(all[def.id] || []), h])];
    state.set('machineHostnames', all);
  });
  machine.on('open', (pane, request) => openFromPane(machine, pane, request).catch((err) => console.warn('open from pane:', err.message)));
  return machine;
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
    const machine = newMachine({ ...def, vscodePort: ports[def.id] });
    machines.push(machine);
    spaces.watch(machine);
    attention.watch(machine);
    machine.start();
    console.log(`[${def.id}] added from herdr machine list (port ${ports[def.id]})`);
  }
}

ipcMain.on('terminal:ready', () => {
  terminalView.webContents.send('terminal:config', { ...config.terminal, findKeys: findSequence() });
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
// The title bar (and menus) follow herdr's theme rather than the system's.
// On Linux the menu bar follows from the next start (see GTK_THEME).
ipcMain.on('terminal:appearance', (_e, mode) => {
  debug('herdr appearance', mode);
  nativeTheme.themeSource = mode;
  if (state.data.appearance !== mode) state.set('appearance', mode);
});
ipcMain.on('terminal:debug', (_e, msg) => debug('[terminal]', msg));
// OSC 52 from herdr: copy to the clipboard. herdr sends it for a selection
// when it can't reach the clipboard itself (Linux without a clipboard tool, a
// herdr on an SSH machine), and passes on the ones programs in its panes send.
// Reading the clipboard ("?") isn't allowed.
ipcMain.on('terminal:clipboard', (_e, payload) => {
  const sep = payload.indexOf(';');
  const targets = payload.slice(0, sep);
  const data = payload.slice(sep + 1);
  if (sep < 0 || data === '?' || data.length > 8 * 1024 * 1024) return;
  const text = Buffer.from(data, 'base64').toString('utf8');
  debug('osc 52 copy', targets, text.length);
  if (!targets || /[cs]/.test(targets)) clipboard.writeText(text);
  if (process.platform === 'linux' && targets.includes('p')) clipboard.writeText(text, 'selection');
});
// Files dropped on herdr, as text for herdr's focused pane. Files from VS Code
// are on the machine herdr is showing. Files from outside the app are on this
// one, so on an SSH machine they paste as they are, absolute.
ipcMain.handle('terminal:drop', (_e, data) => {
  const machine = spaces.activeMachine();
  const snap = machine?.snapshot;
  const pane = snap?.panes.find((p) => p.pane_id === snap.focused_pane_id);
  const sameMachine = !data.files?.length || machine?.def.type !== 'ssh';
  return dropText(data, { cwd: sameMachine ? pane?.foreground_cwd || pane?.cwd : null, home: machine?.home });
});
// Cmd+click in herdr. Files open in the space's VS Code, which is turned on
// for the space if it was off.
ipcMain.on('terminal:open-link', async (_e, text) => {
  const space = spaces.resolveSpace();
  if (space.message) return;
  const pane = space.snap.panes.find((p) => p.pane_id === space.snap.focused_pane_id);
  const link = parseLink(text, { cwd: pane?.foreground_cwd || pane?.cwd, home: space.machine.home });
  debug('open link', text, JSON.stringify(link));
  if (!link) return;
  if (link.url) return require('electron').shell.openExternal(link.url);
  await openInVSCode(space.key, link);
});

// A file in the shown space's VS Code, which is turned on if it was off.
async function openInVSCode(key, link) {
  if (!spaces.isOpen(key)) spaces.toggleVSCode();
  const webContents = await workbenchReady(() => views.views.get(key)?.view.webContents);
  if (!webContents) return;
  focusVSCode();
  await quickOpen(webContents, [link.file, link.line, link.column].filter(Boolean).join(':'));
}

// `spaceherd open` (or `code`, see src/main/spaceherd-cli.sh) in a herdr pane:
// the pane's space comes forward, as VS Code brings its window forward, and
// the file opens there. A directory points the space's VS Code at it.
async function openFromPane(machine, pane, { kind, path: target }) {
  const key = `${machine.id}:${pane.workspace_id}`;
  if (spaces.resolveSpace().key !== key) {
    await machine.herdr.request('workspace.focus', { workspace_id: pane.workspace_id }).catch(() => {});
    const deadline = Date.now() + 3000;
    while (spaces.resolveSpace().key !== key) {
      if (Date.now() > deadline) return console.warn('open from pane: could not switch to', key);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (kind === 'd') return spaces.pinFolder(key, target);
  const link = parseLink(target, { cwd: pane.foreground_cwd || pane.cwd, home: machine.home });
  if (link?.file) await openInVSCode(key, link);
}

// spaceherd:// links from spaceherd's VS Code extension (src/vscode-extension).
// reveal?path=… is Reveal in Finder, File Explorer or Open Containing Folder.
function onSpaceherdLink(key, link) {
  let url;
  try {
    url = new URL(link);
  } catch {
    return;
  }
  const file = url.searchParams.get('path');
  if (url.host !== 'reveal' || !file || !path.isAbsolute(file)) return;
  const machine = machines.find((m) => key.startsWith(`${m.id}:`));
  debug('reveal', key, file);
  if (machine && machine.def.type !== 'ssh') return shell.showItemInFolder(file);
  dialog.showMessageBox(win, {
    message: 'That file is on another computer',
    detail: `${file} is on ${machine?.id ?? 'another machine'}. This computer's file manager can only show its own files.`,
  });
}

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
  // Dark until herdr has drawn: the terminal's own background is dark.
  nativeTheme.themeSource = 'dark';
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(ICON);
  config = loadConfig();
  shellEnv.cached = shellEnv();
  updater = new Updater({ mode: config.updates });
  updater.on('change', buildMenu);
  buildMenu();
  createWindow();
  updater.start();
});

app.on('before-quit', () => {
  herdrPty?.kill();
  for (const m of machines || []) m.stop();
});

app.on('window-all-closed', () => app.quit());
