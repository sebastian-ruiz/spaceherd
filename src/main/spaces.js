// Decides which VS Code view to show. herdr's window title (default format
// "{hostname}: {workspace}") says which machine the TUI is showing; that
// machine's snapshot says which workspace is focused and where its folder is.

const { EventEmitter } = require('events');
const { debug } = require('./config');

function parseTitle(title) {
  const m = title.match(/^(\S+): (.*)$/);
  return m ? { host: m[1], label: m[2] } : null;
}

// A workspace has no folder of its own. Use the cwd of the first pane in its
// first tab, which is where the workspace was created.
function workspaceFolder(snapshot, workspaceId) {
  const tabs = snapshot.tabs
    .filter((t) => t.workspace_id === workspaceId)
    .sort((a, b) => a.number - b.number);
  for (const tab of tabs) {
    const pane = snapshot.panes.find((p) => p.tab_id === tab.tab_id);
    if (pane?.cwd) return pane.cwd;
  }
  return null;
}

class Spaces extends EventEmitter {
  constructor({ machines, views, config, state }) {
    super();
    this.machines = machines;
    this.views = views;
    this.config = config;
    this.state = state;
    this.title = null;
    this.current = null;
    for (const m of machines) this.watch(m);
  }

  // `machines` is shared with the caller; call this for each one it adds.
  watch(machine) {
    machine.on('focus', () => this.update());
    machine.on('snapshot', () => this.update());
  }

  onTitle(title) {
    debug('title', JSON.stringify(title));
    this.title = parseTitle(title);
    this.titleAt = Date.now();
    this.update();
  }

  activeMachine() {
    if (this.title) {
      const byHost = this.machines.find((m) => m.matchesHost(this.title.host));
      if (byHost) return byHost;
    }
    // Title missing or host unknown: the machine whose focus changed last.
    return [...this.machines].sort((a, b) => b.lastFocusAt - a.lastFocusAt)[0];
  }

  resolve() {
    const machine = this.activeMachine();
    const snap = machine?.snapshot;
    if (!snap) return { message: this.title ? `No connection to ${this.title.host} yet…` : 'Waiting for herdr…' };
    let workspace = snap.workspaces.find((w) => w.workspace_id === snap.focused_workspace_id);
    // The title arrives with herdr's redraw, 5-25 ms before the focus event.
    // If it is the newer signal and its label names exactly one workspace,
    // switch on it instead of waiting.
    if (this.title && this.titleAt > machine.lastFocusAt && workspace?.label !== this.title.label) {
      const byLabel = snap.workspaces.filter((w) => w.label === this.title.label);
      if (byLabel.length === 1) workspace = byLabel[0];
    }
    if (!workspace) return { message: 'No workspace focused.' };

    const key = `${machine.id}:${workspace.workspace_id}`;
    let folder = this.config.folderOverrides[`${machine.id}:${workspace.label}`] || this.state.getPinned(key);
    if (!folder) {
      folder = workspaceFolder(snap, workspace.workspace_id);
      if (folder) this.state.setPinned(key, folder);
    }
    if (!folder) return { message: `No folder known for “${workspace.label}”.` };
    return { machine, workspace, key, folder };
  }

  async update() {
    const target = this.resolve();
    const id = target.message || `${target.key}|${target.folder}`;
    if (id === this.current) return;
    debug('update ->', id);
    this.current = id;

    if (target.message) {
      this.views.showMessage(target.message);
      this.emit('changed', null);
      return;
    }
    const { machine, key, folder } = target;
    this.emit('changed', target);
    const url = machine.vscodeUrl(folder);
    const partition = `persist:vscode-${machine.id}`;
    if (this.views.views.has(key)) {
      this.views.show(key, { url, partition });
      return;
    }
    // First visit: make sure the machine's serve-web is up before loading.
    this.views.showMessage(`Starting VS Code for ${folder}…`);
    try {
      await machine.vscodeReady;
    } catch (err) {
      if (this.current === id) this.views.showMessage(`VS Code server failed: ${err.message}`);
      return;
    }
    if (this.current === id) this.views.show(key, { url, partition });
  }

  // Re-pin the current space to the focused pane's directory.
  repinToFocusedPane() {
    const machine = this.activeMachine();
    const snap = machine?.snapshot;
    const pane = snap?.panes.find((p) => p.pane_id === snap.focused_pane_id);
    if (!pane) return;
    this.state.setPinned(`${machine.id}:${pane.workspace_id}`, pane.foreground_cwd || pane.cwd);
    this.current = null;
    this.update();
  }
}

module.exports = { Spaces, parseTitle, workspaceFolder };
