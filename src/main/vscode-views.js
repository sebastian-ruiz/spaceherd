// One WebContentsView per space, kept alive while hidden so switching back is
// a visibility flip instead of a reload. The least recently used views are
// destroyed beyond `maxLive`.

const { WebContentsView, shell } = require('electron');

const BACKGROUND = '#1f1f1f';

function messagePage(text) {
  const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;display:grid;place-items:center;
    background:${BACKGROUND};color:#9d9d9d;font:13px -apple-system,system-ui,sans-serif">
    <div style="max-width:420px;text-align:center;line-height:1.5">${text}</div></body>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

class VSCodeViews {
  constructor(win, { maxLive = 6, onViewCreated = () => {} } = {}) {
    this.win = win;
    this.maxLive = maxLive;
    this.onViewCreated = onViewCreated;
    this.views = new Map(); // key -> { view, url, lastUsed }
    this.activeKey = null;
    this.bounds = { x: 0, y: 0, width: 0, height: 0 };
    this.message = this.createView(null);
    this.message.webContents.loadURL(messagePage('Waiting for herdr…'));
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
    if (entry && entry.url !== url) {
      this.destroy(key);
      entry = null;
    }
    const cold = !entry;
    if (!entry) {
      entry = { view: this.createView(partition), url };
      this.onViewCreated(entry.view.webContents);
      entry.view.webContents.loadURL(url);
      this.views.set(key, entry);
    }
    entry.lastUsed = Date.now();
    this.setActive(entry.view);
    this.activeKey = key;
    this.evict();
    console.log(`[switch] ${key} ${cold ? 'cold' : 'warm'} at ${Date.now()} (view swap ${(performance.now() - started).toFixed(1)} ms)`);
  }

  showMessage(text) {
    this.message.webContents.loadURL(messagePage(text));
    this.setActive(this.message);
    this.activeKey = null;
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
    const lru = [...this.views.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    while (lru.length > this.maxLive) {
      const [key] = lru.shift();
      if (key !== this.activeKey) this.destroy(key);
    }
  }

  destroy(key) {
    const entry = this.views.get(key);
    if (!entry) return;
    this.win.contentView.removeChildView(entry.view);
    entry.view.webContents.close();
    this.views.delete(key);
  }

  reload(key = this.activeKey) {
    this.views.get(key)?.view.webContents.reload();
  }
}

module.exports = { VSCodeViews };
