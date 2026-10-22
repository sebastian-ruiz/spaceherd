// One WebContentsView per space, kept alive while hidden so switching back is
// a visibility flip instead of a reload. The least recently used views are
// closed beyond `maxLive`, and views not shown for `idleMinutes`.
//
// A view's extension host runs on the machine's VS Code server, and the
// server keeps it running for a while after an abrupt disconnect, in case the
// window comes back. Closing a view as a browser closes a tab (running its
// unload handlers) lets VS Code end the extension host right away.

const { WebContentsView, shell } = require('electron');

const BACKGROUND = '#1f1f1f';

function messagePage(text) {
  const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;display:grid;place-items:center;
    background:${BACKGROUND};color:#9d9d9d;font:13px -apple-system,system-ui,sans-serif">
    <div style="max-width:420px;text-align:center;line-height:1.5">${text}</div></body>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

class VSCodeViews {
  constructor(win, { maxLive = 4, idleMinutes = 30, onViewCreated = () => {} } = {}) {
    this.win = win;
    this.maxLive = maxLive;
    this.onViewCreated = onViewCreated;
    this.views = new Map(); // key -> { view, url, lastUsed, closing }
    this.activeKey = null;
    this.bounds = { x: 0, y: 0, width: 0, height: 0 };
    this.message = this.createView(null);
    this.message.webContents.loadURL(messagePage('Waiting for herdr…'));
    if (idleMinutes > 0) {
      setInterval(() => {
        const cutoff = Date.now() - idleMinutes * 60000;
        for (const [key, entry] of this.views) {
          if (key !== this.activeKey && entry.lastUsed < cutoff) this.close(key);
        }
      }, 60000);
    }
  }

  createView(partition) {
    const view = new WebContentsView({
      webPreferences: {
        partition: partition || undefined,
        sandbox: true,
        contextIsolation: true,
        // Hidden views must stay current, or a switch shows a stale frame.
        backgroundThrottling: false,
      },
    });
    view.setBackgroundColor(BACKGROUND);
    view.setVisible(false);
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    this.win.contentView.addChildView(view);
    view.setBounds(this.bounds);
    return view;
  }

  show(key, { url, partition }) {
    const started = performance.now();
    let entry = this.views.get(key);
    if (entry?.closing) {
      // Reopened while closing: let it finish and start a new view.
      this.views.delete(key);
      entry = null;
    } else if (entry && entry.url !== url) {
      this.close(key, { force: true });
      entry = null;
    }
    const cold = !entry;
    if (!entry) {
      entry = { view: this.createView(partition), url };
      this.onViewCreated(entry.view.webContents);
      entry.view.webContents.loadURL(url);
      this.views.set(key, entry);
    }
    this.leaveActive();
    entry.lastUsed = Date.now();
    this.setActive(entry.view);
    this.activeKey = key;
    this.evict();
    console.log(`[switch] ${key} ${cold ? 'cold' : 'warm'} at ${Date.now()} (view swap ${(performance.now() - started).toFixed(1)} ms)`);
  }

  // No VS Code for the current space: herdr has the window to itself.
  hide() {
    this.leaveActive();
    for (const v of [this.message, ...[...this.views.values()].map((e) => e.view)]) v.setVisible(false);
    this.activeKey = null;
  }

  showMessage(text) {
    this.message.webContents.loadURL(messagePage(text));
    this.leaveActive();
    this.setActive(this.message);
    this.activeKey = null;
  }

  // Idle time counts from when a view was last on screen.
  leaveActive() {
    const entry = this.views.get(this.activeKey);
    if (entry) entry.lastUsed = Date.now();
  }

  setActive(target) {
    // Show the new view before hiding the old one, so no frame is empty.
    target.setVisible(true);
    for (const v of [this.message, ...[...this.views.values()].map((e) => e.view)]) {
      if (v !== target) v.setVisible(false);
    }
  }

  activeWebContents() {
    return this.views.get(this.activeKey)?.view.webContents;
  }

  focus() {
    this.activeWebContents()?.focus();
  }

  setBounds(bounds) {
    this.bounds = bounds;
    this.message.setBounds(bounds);
    for (const { view } of this.views.values()) view.setBounds(bounds);
  }

  evict() {
    const lru = [...this.views.entries()]
      .filter(([key, entry]) => key !== this.activeKey && !entry.closing)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const open = lru.length + (this.views.has(this.activeKey) ? 1 : 0);
    for (const [key] of lru.slice(0, Math.max(0, open - this.maxLive))) this.close(key);
  }

  // Closes like a browser tab, so VS Code shuts its extension host down. If
  // VS Code objects (e.g. unsaved changes it cannot back up), the view stays
  // open, unless `force`. Resolves once the view is gone or kept.
  close(key, { force = false } = {}) {
    const entry = this.views.get(key);
    if (!entry || entry.closing) return entry?.closing || Promise.resolve();
    const wc = entry.view.webContents;
    // Forced: the key is free for a new view at once.
    if (force) this.views.delete(key);
    entry.closing = new Promise((resolve) => {
      const vetoed = (event) => {
        if (force) return event.preventDefault(); // close anyway
        wc.off('destroyed', done);
        entry.closing = null;
        console.log(`[views] ${key} kept open: VS Code prevented unload`);
        resolve();
      };
      const done = () => {
        wc.off('will-prevent-unload', vetoed);
        if (this.views.get(key) === entry) this.views.delete(key);
        if (!this.win.isDestroyed()) this.win.contentView.removeChildView(entry.view);
        console.log(`[views] ${key} closed`);
        resolve();
      };
      wc.once('will-prevent-unload', vetoed);
      wc.once('destroyed', done);
    });
    wc.close({ waitForBeforeUnload: true });
    return entry.closing;
  }

  // For quitting: close every view, giving up after `timeoutMs`.
  closeAll({ timeoutMs = 3000 } = {}) {
    const all = [...this.views.keys()].map((key) => this.close(key, { force: true }));
    return Promise.race([Promise.all(all), new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  reload(key = this.activeKey) {
    this.views.get(key)?.view.webContents.reload();
  }
}

module.exports = { VSCodeViews };
