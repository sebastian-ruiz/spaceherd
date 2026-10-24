// Updates the packaged app from GitHub Releases without an Apple Developer ID.
//
// Gatekeeper only checks files carrying the quarantine flag, which browsers
// set on downloads; what the app downloads itself doesn't get it. So after
// the first launch (one "Open Anyway"), the app can replace itself. Updates
// are checked against our own Ed25519 signature (src/main/update-signature.js)
// instead of Apple's.
//
// macOS: the .zip is unpacked and swapped in for Spaceherd.app. Linux: an
// AppImage replaces itself; other installs (.deb) are told about new versions.

const { app, net, Notification, dialog, shell } = require('electron');
const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sha512File, verify } = require('./update-signature');
const { debug } = require('./config');

const RELEASES = 'https://github.com/sebastian-ruiz/spaceherd/releases';
// Tests and pre-release checks can point this at another copy of the files.
const FEED_BASE = process.env.SPACEHERD_UPDATE_URL || `${RELEASES}/latest/download`;
const FIRST_CHECK_MS = 10 * 1000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

function feedName() {
  if (process.platform === 'darwin') return 'latest-mac.yml';
  return process.arch === 'arm64' ? 'latest-linux-arm64.yml' : 'latest-linux.yml';
}

// What this install can do: replace a macOS app bundle, replace an AppImage,
// or only tell about new versions.
function installKind() {
  if (process.platform === 'darwin') return 'mac-app';
  if (process.env.APPIMAGE) return 'appimage';
  return 'notify';
}

// electron-builder's latest-*.yml: version, and files with url and sha512.
function parseFeed(text) {
  const version = text.match(/^version:\s*['"]?([^'"\s]+)/m)?.[1];
  const files = [];
  for (const line of text.split('\n')) {
    const url = line.match(/^\s*-\s*url:\s*['"]?([^'"\s]+)/)?.[1];
    if (url) files.push({ url });
    const sha512 = line.match(/^\s+sha512:\s*['"]?([^'"\s]+)/)?.[1];
    if (sha512 && files.length && !files[files.length - 1].sha512) files[files.length - 1].sha512 = sha512;
  }
  return { version, files };
}

function newer(a, b) {
  const pa = a.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

async function fetchOk(url) {
  const res = await net.fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

// Where the running app lives, and whether it can be replaced there. A
// quarantined app run from Downloads is "translocated" to a read-only copy;
// one run straight from the .dmg is read-only too.
function installTarget() {
  if (installKind() === 'appimage') {
    const file = process.env.APPIMAGE;
    let writable = true;
    try { fs.accessSync(path.dirname(file), fs.constants.W_OK); } catch { writable = false; }
    return { path: file, writable };
  }
  const bundle = path.resolve(process.execPath, '..', '..', '..');
  let writable = bundle.endsWith('.app') && !bundle.includes('/AppTranslocation/') && !bundle.startsWith('/Volumes/');
  try {
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
    fs.accessSync(bundle, fs.constants.W_OK);
  } catch {
    writable = false;
  }
  return { path: bundle, writable };
}

class Updater extends EventEmitter {
  constructor({ mode = 'auto' } = {}) {
    super();
    this.mode = mode;
    this.state = { status: 'idle' }; // idle | checking | downloading | ready
    this.told = new Set(); // notifications already shown, per version or reason
  }

  get enabled() {
    return app.isPackaged && this.mode !== 'off';
  }

  start() {
    if (!this.enabled) return;
    setTimeout(() => this.check(), FIRST_CHECK_MS);
    setInterval(() => this.check(), CHECK_EVERY_MS);
    app.on('will-quit', () => this.applyIfReady());
  }

  setState(state) {
    this.state = state;
    this.emit('change', state);
  }

  // `manual`: from the menu, so say when there's nothing to do or it failed.
  async check({ manual = false } = {}) {
    if (!app.isPackaged) {
      if (manual) dialog.showMessageBox({ message: 'Updates are only checked in the packaged app.', detail: 'Running from source: update with git.' });
      return;
    }
    if (this.state.status === 'checking' || this.state.status === 'downloading') return;
    if (this.state.status === 'ready') {
      if (manual) this.offerRestart();
      return;
    }
    const current = app.getVersion();
    this.setState({ status: 'checking' });
    try {
      const feed = parseFeed(await (await fetchOk(`${FEED_BASE}/${feedName()}`)).text());
      debug('update feed', feed.version, 'current', current);
      if (!feed.version || !newer(feed.version, current)) {
        this.setState({ status: 'idle' });
        if (manual) dialog.showMessageBox({ message: `Spaceherd ${current} is the latest version.` });
        return;
      }
      const kind = installKind();
      const target = installTarget();
      if (kind === 'notify' || !target.writable) {
        this.setState({ status: 'idle' });
        return this.tellAvailable(feed.version, kind === 'notify' ? null : target, manual);
      }
      const file = feed.files.find((f) =>
        kind === 'mac-app' ? f.url.endsWith(`-mac-${process.arch}.zip`) : f.url.endsWith('.AppImage'),
      );
      if (!file?.sha512) throw new Error(`no update file for ${process.platform}-${process.arch} in ${feedName()}`);
      this.setState({ status: 'downloading', version: feed.version });
      const prepared = await this.download(feed.version, file, kind);
      this.setState({ status: 'ready', version: feed.version, ...prepared });
      this.notify(`Spaceherd ${feed.version} is ready`, 'Restart to update. Your spaces and agents keep running.', () => this.restart());
      if (manual) this.offerRestart();
    } catch (err) {
      console.warn('[update]', err.message);
      this.setState({ status: 'idle' });
      if (manual) dialog.showMessageBox({ type: 'warning', message: 'Could not check for updates.', detail: err.message });
    }
  }

  // Downloads and verifies the update into a temporary folder. Returns what
  // apply() needs.
  async download(version, file, kind) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spaceherd-update-'));
    const name = path.basename(file.url);
    const dest = path.join(dir, name);
    const res = await fetchOk(`${FEED_BASE}/${file.url}`);
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
    const signature = (await (await fetchOk(`${FEED_BASE}/${file.url}.sig`)).text()).trim();
    const sha512 = await sha512File(dest);
    if (sha512 !== file.sha512) throw new Error(`${name}: checksum does not match the feed`);
    if (!verify({ version, name, sha512 }, signature)) throw new Error(`${name}: signature check failed`);
    if (kind === 'appimage') return { file: dest };

    const unpacked = path.join(dir, 'unpacked');
    execFileSync('ditto', ['-x', '-k', dest, unpacked]);
    const bundle = fs.readdirSync(unpacked).find((f) => f.endsWith('.app'));
    if (!bundle) throw new Error(`${name}: no app inside`);
    const appPath = path.join(unpacked, bundle);
    execFileSync('codesign', ['--verify', '--deep', '--strict', appPath]);
    try { execFileSync('xattr', ['-dr', 'com.apple.quarantine', appPath]); } catch {}
    fs.rmSync(dest, { force: true });
    return { appPath };
  }

  // Puts the verified update in place of the running app. Files the running
  // app has open stay valid; the new version runs from the next launch.
  applyIfReady() {
    if (this.state.status !== 'ready' || this.state.applied) return false;
    const target = installTarget();
    try {
      if (this.state.file) {
        const next = `${target.path}.new`;
        fs.copyFileSync(this.state.file, next);
        fs.chmodSync(next, 0o755);
        fs.renameSync(next, target.path);
      } else {
        const old = `${target.path}.old-${process.pid}`;
        fs.renameSync(target.path, old);
        try {
          execFileSync('ditto', [this.state.appPath, target.path]);
        } catch (err) {
          fs.rmSync(target.path, { recursive: true, force: true });
          fs.renameSync(old, target.path);
          throw err;
        }
        fs.rmSync(old, { recursive: true, force: true });
      }
      this.state.applied = true;
      console.log(`[update] installed ${this.state.version}`);
      return true;
    } catch (err) {
      console.warn('[update] install failed:', err.message);
      return false;
    }
  }

  restart() {
    if (!this.applyIfReady()) return;
    app.relaunch(process.env.APPIMAGE ? { execPath: process.env.APPIMAGE, args: process.argv.slice(1) } : undefined);
    app.quit();
  }

  async offerRestart() {
    const { response } = await dialog.showMessageBox({
      message: `Spaceherd ${this.state.version} is ready to install.`,
      detail: 'Restart now? Your herdr spaces, agents and VS Code servers keep running.',
      buttons: ['Restart', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) this.restart();
  }

  // A new version this install can't apply itself.
  tellAvailable(version, target, manual) {
    if (target) {
      const body = target.path.includes('/AppTranslocation/') || target.path.startsWith('/Volumes/')
        ? 'Move Spaceherd to the Applications folder and open it from there to update automatically.'
        : `Spaceherd can't replace itself in ${path.dirname(target.path)}.`;
      if (manual) return dialog.showMessageBox({ message: `Spaceherd ${version} is available.`, detail: body });
      return this.notifyOnce(`move:${version}`, `Spaceherd ${version} is available`, body);
    }
    const open = () => shell.openExternal(`${RELEASES}/latest`);
    if (manual) return open();
    this.notifyOnce(`available:${version}`, `Spaceherd ${version} is available`, 'Click to download it.', open);
  }

  notifyOnce(key, title, body, onClick) {
    if (this.told.has(key)) return;
    this.told.add(key);
    this.notify(title, body, onClick);
  }

  notify(title, body, onClick) {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body });
    if (onClick) n.on('click', onClick);
    n.show();
  }

  // The app menu's entry for updates.
  menuItem() {
    const s = this.state;
    if (s.status === 'ready') return { label: `Restart to Update to ${s.version}`, click: () => this.restart() };
    if (s.status === 'downloading') return { label: `Downloading ${s.version}…`, enabled: false };
    if (s.status === 'checking') return { label: 'Checking for Updates…', enabled: false };
    return { label: 'Check for Updates…', click: () => this.check({ manual: true }) };
  }
}

module.exports = { Updater, parseFeed, newer };
