// Alerts when an agent needs attention: a native notification when an agent
// becomes blocked or done, and a dock badge counting blocked agents across
// all machines. herdr's own OSC 9 / OSC 777 notifications are shown too.
// config.notifications says which ones, and when (see config.js).

const { app, BrowserWindow, Notification } = require('electron');
const { debug } = require('./config');

const MESSAGES = {
  blocked: 'needs your input',
  done: 'finished',
};

class Attention {
  constructor({ machines, settings, onActivate }) {
    this.machines = machines;
    this.settings = settings;
    this.onActivate = onActivate;
    this.statuses = new Map(); // "machine:pane" -> agent_status
    for (const m of machines) this.watch(m);
  }

  watch(machine) {
    machine.on('snapshot', (snap) => this.onSnapshot(machine, snap));
  }

  onSnapshot(machine, snap) {
    const seen = new Set();
    for (const pane of snap.panes) {
      const key = `${machine.id}:${pane.pane_id}`;
      seen.add(key);
      const prev = this.statuses.get(key);
      this.statuses.set(key, pane.agent_status);
      // No alert on the first snapshot, only on transitions.
      if (prev !== undefined && prev !== pane.agent_status && MESSAGES[pane.agent_status]) {
        const workspace = snap.workspaces.find((w) => w.workspace_id === pane.workspace_id);
        const agent = snap.agents?.find((a) => a.pane_id === pane.pane_id);
        const who = agent?.name || pane.display_agent || pane.agent || 'Agent';
        this.notify(pane.agent_status, `${who} ${MESSAGES[pane.agent_status]}`, `${workspace?.label ?? pane.workspace_id} · ${machine.id}`, {
          machine,
          workspaceId: pane.workspace_id,
        });
      }
    }
    for (const key of this.statuses.keys()) {
      if (key.startsWith(`${machine.id}:`) && !seen.has(key)) this.statuses.delete(key);
    }
    this.updateBadge();
  }

  updateBadge() {
    const blocked = [...this.statuses.values()].filter((s) => s === 'blocked').length;
    app.dock?.setBadge(blocked ? String(blocked) : '');
  }

  // OSC 9 is "body" (herdr sends "title: body"); OSC 777 is "notify;title;body".
  onOsc(code, payload) {
    if (code === 777) {
      const [kind, title, body] = payload.split(';');
      if (kind === 'notify') this.notify('herdr', title, body || '');
      return;
    }
    const i = payload.indexOf(': ');
    if (i > 0) this.notify('herdr', payload.slice(0, i), payload.slice(i + 2));
    else this.notify('herdr', payload, '');
  }

  onBell() {
    if (this.settings.bounce) app.dock?.bounce('informational');
  }

  // event is "blocked", "done" or "herdr".
  notify(event, title, body, target) {
    const { system, events, bounce } = this.settings;
    const show = events.includes(event) && (system === 'always' || (system === 'unfocused' && !BrowserWindow.getFocusedWindow()));
    debug('notify', JSON.stringify({ event, title, body, show }));
    if (!events.includes(event)) return;
    if (bounce) app.dock?.bounce('informational');
    if (!show) return;
    const n = new Notification({ title, body, silent: false });
    n.on('click', () => this.onActivate(target));
    n.show();
  }
}

module.exports = { Attention };
