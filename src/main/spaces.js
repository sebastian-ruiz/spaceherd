// Decides which VS Code view to show. herdr's window title (default format
// "{hostname}: {workspace}") says which machine the TUI is showing; that
// machine's snapshot says which workspace is focused and where its folder is.
//
// VS Code is opened per space, on request, and remembered in state.json
// (`vscodeOpen`). Spaces without it show herdr at full width; 'layout' says
// which.

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

  // The focused space, or { message } when there is none yet.
  resolveSpace() {
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
    return { machine, snap, workspace, key: `${machine.id}:${workspace.workspace_id}` };
  }

  isOpen(key) {
    return !!this.state.get('vscodeOpen', {})[key];
  }

  setOpen(key, open) {
    const all = { ...this.state.get('vscodeOpen', {}) };
    if (open) all[key] = true;
    else delete all[key];
    this.state.set('vscodeOpen', all);
  }

  resolve() {
    const space = this.resolveSpace();
    if (space.message) return { closed: true };
    const { machine, snap, workspace, key } = space;
    if (!this.isOpen(key)) return { closed: true, machine, workspace, key };
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
    const id = target.closed ? `closed|${target.key || ''}` : target.message || `${target.key}|${target.folder}`;
    if (id === this.current) return;
    debug('update ->', id);
    this.current = id;
    this.emit('layout', !target.closed);

    if (target.closed) {
      this.views.hide();
      this.emit('changed', target.key ? target : null);
      return;
    }
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

  // Pin the current space to the focused pane's directory and open VS Code.
  repinToFocusedPane() {
    const space = this.resolveSpace();
    if (space.message) return;
    // Right after a switch the focused pane can still be the last space's.
    const pane = space.snap.panes.find(
      (p) => p.pane_id === space.snap.focused_pane_id && p.workspace_id === space.workspace.workspace_id,
    );
    const folder = pane ? pane.foreground_cwd || pane.cwd : workspaceFolder(space.snap, space.workspace.workspace_id);
    if (!folder) return;
    this.state.setPinned(space.key, folder);
    this.setOpen(space.key, true);
    this.current = null;
    this.update();
  }

  // Opening pins the folder the focused pane is in now. Closing closes the
  // view, which ends its extension host on the server.
  toggleVSCode() {
    const space = this.resolveSpace();
    if (space.message) return;
    if (this.isOpen(space.key)) {
      this.setOpen(space.key, false);
      this.current = null;
      this.update();
      this.views.close(space.key);
    } else {
      this.repinToFocusedPane();
    }
  }
}

module.exports = { Spaces, parseTitle, workspaceFolder };
