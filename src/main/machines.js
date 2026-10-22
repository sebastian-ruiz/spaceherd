// A machine owns three things: a herdr socket client, a `code serve-web`
// server, and the latest herdr snapshot. Local machines talk to both
// directly. SSH machines reach both through one long-lived `ssh` process that
// forwards the herdr unix socket and the serve-web port.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const { HerdrClient } = require('./herdr-client');
const { debug } = require('./config');

const POLL_MS = 1500;

const LIFECYCLE_EVENTS = [
  'workspace.created',
  'workspace.closed',
  'workspace.focused',
  'workspace.renamed',
  'tab.created',
  'tab.closed',
  'pane.created',
  'pane.closed',
  'pane.agent_detected',
];

// A machine's VS Code server is shared by every spaceherd that uses the
// machine, locally or over SSH (laptop and desktop), so the token lives in a
// fixed per-user place on the machine itself. The SSH remote script uses the
// same path.
const SHARED_DIR = path.join(os.homedir(), '.config', 'spaceherd');

// Resolves once serve-web answers with our token. A 403 means some other
// server holds the port with a different token; waiting won't fix that.
function waitForHttp(port, { token, timeoutMs = 300000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const q = token ? `?tkn=${token}` : '';
      const req = http.get({ host: '127.0.0.1', port, path: `/${q}`, timeout: 2000 }, (res) => {
        res.resume();
        if (res.statusCode !== 403) return resolve();
        reject(Object.assign(new Error(`Port ${port} is held by a VS Code server with a different token`), { code: 'EFOREIGN' }));
      });
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); });
    };
    const retry = () => {
      if (Date.now() > deadline) reject(new Error(`serve-web on port ${port} did not start`));
      else setTimeout(attempt, 500);
    };
    attempt();
  });
}

class Machine extends EventEmitter {
  constructor(def, { env }) {
    super();
    this.id = def.id;
    this.def = def;
    this.env = env;
    this.hostnames = (def.hostnames || []).map((h) => h.toLowerCase());
    // Read from the machine's shared token file once its server is up.
    this.token = null;
    this.vscodePort = def.vscodePort;
    this.snapshot = null;
    this.lastFocusAt = 0;
    this.vscodeReady = null;
    this.herdr = null;
    this.pollTimer = null;
    this.stopped = false;
  }

  matchesHost(host) {
    const h = host.toLowerCase();
    const short = h.split('.')[0];
    return this.hostnames.some((n) => n === h || n.split('.')[0] === short);
  }

  vscodeUrl(folder) {
    const q = new URLSearchParams({ folder, tkn: this.token });
    return `http://127.0.0.1:${this.vscodePort}/?${q}`;
  }

  // Connects the herdr socket and starts polling. The poll keeps the snapshot
  // fresh: herdr pushes no event when an agent's status changes.
  connectHerdr(socketPath) {
    this.herdr = new HerdrClient(socketPath, { name: this.id });
    this.herdr.on('event', (name, data) => {
      debug(`[${this.id}] event ${name}`, JSON.stringify(data));
      if (name === 'workspace_focused') {
        this.lastFocusAt = Date.now();
        if (this.snapshot) this.snapshot.focused_workspace_id = data.workspace_id;
        this.emit('focus', data.workspace_id);
      }
      this.refresh();
    });
    this.herdr.on('connected', () => this.refresh());
    this.herdr.on('warn', (msg) => console.warn(msg));
    this.herdr.subscribe(LIFECYCLE_EVENTS.map((type) => ({ type })));
    this.pollTimer = setInterval(() => this.refresh(), POLL_MS);
    this.refresh();
  }

  async refresh() {
    if (!this.herdr || this.refreshing) return;
    this.refreshing = true;
    try {
      const prevFocus = this.snapshot?.focused_workspace_id;
      this.snapshot = await this.herdr.snapshot();
      this.emit('snapshot', this.snapshot);
      if (prevFocus !== undefined && prevFocus !== this.snapshot.focused_workspace_id) {
        this.lastFocusAt = Date.now();
        this.emit('focus', this.snapshot.focused_workspace_id);
      }
    } catch {
      // Server not reachable yet (starting, or SSH reconnecting). Keep the
      // last snapshot; the next poll retries.
    } finally {
      this.refreshing = false;
    }
  }

  stop() {
    this.stopped = true;
    clearInterval(this.pollTimer);
    this.herdr?.close();
  }
}

class LocalMachine extends Machine {
  start() {
    const socket = this.def.herdrSocket || path.join(os.homedir(), '.config', 'herdr', 'herdr.sock');
    this.connectHerdr(socket);
    this.vscodeReady = this.startServeWeb();
  }

  async startServeWeb() {
    fs.mkdirSync(SHARED_DIR, { recursive: true, mode: 0o700 });
    const tokenFile = path.join(SHARED_DIR, 'vscode-token');
    let token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
    if (!token) {
      token = crypto.randomBytes(24).toString('hex');
      fs.writeFileSync(tokenFile, token, { mode: 0o600 });
    }
    this.token = token;

    // Already running, started by us earlier or by a client over SSH.
    try {
      await waitForHttp(this.vscodePort, { token, timeoutMs: 300 });
      return;
    } catch (err) {
      if (err.code === 'EFOREIGN') throw err;
    }
    const args = [
      'serve-web',
      '--host', '127.0.0.1',
      '--port', String(this.vscodePort),
      '--connection-token-file', tokenFile,
      '--accept-server-license-terms',
    ];
    // Detached and unreferenced, like `nohup` on SSH machines: other clients
    // may be using this server, so it outlives the app.
    // serve-web logs its URL including the token, so keep the log private.
    const logPath = path.join(SHARED_DIR, 'serve-web.log');
    const log = fs.openSync(logPath, 'a', 0o600);
    fs.chmodSync(logPath, 0o600);
    const proc = spawn(this.def.codeCommand || 'code', args, {
      env: this.env,
      stdio: ['ignore', log, log],
      detached: true,
    });
    proc.unref();
    fs.closeSync(log);
    await waitForHttp(this.vscodePort, { token });
  }
}

// Runs on the remote, fed through ssh's stdin. The remote owns the connection
// token, so every client (laptop, desktop Mac, ...) shares it; it comes back
// over the ssh channel. serve-web is started with nohup so it survives SSH
// drops and open VS Code views can reconnect to the same server afterwards.
function remoteScript({ remotePort, codeCommand }) {
  return [
    'umask 077',
    // Renamed from code-manager: keep the token the running server uses.
    '[ -d ~/.config/spaceherd ] || [ ! -d ~/.config/code-manager ] || mv ~/.config/code-manager ~/.config/spaceherd',
    // A serve-web started before the move still answers, but every code server
    // it spawns fails to read the old token path. Replace it.
    `pkill -f 'serve-web .*code-manager/vscode-token' && sleep 1`,
    'mkdir -p ~/.config/spaceherd',
    'f=~/.config/spaceherd/vscode-token',
    `[ -s "$f" ] || od -An -N24 -tx1 /dev/urandom | tr -d ' \\n' > "$f"`,
    // Append: a second start fails on the busy port and must not wipe the
    // running server's log.
    `nohup ${codeCommand} serve-web --host 127.0.0.1 --port ${remotePort}` +
      ' --connection-token-file "$f" --accept-server-license-terms' +
      ' >> ~/.config/spaceherd/serve-web.log 2>&1 < /dev/null &',
    'echo "spaceherd-ready:$(cat "$f")"',
    'while sleep 3600; do :; done',
    '',
  ].join('\n');
}

class SshMachine extends Machine {
  start() {
    // Unix socket paths are limited to 104 bytes on macOS, so keep it short.
    const sockDir = path.join('/tmp', `spaceherd-${process.getuid()}`);
    fs.mkdirSync(sockDir, { recursive: true, mode: 0o700 });
    this.localSocket = path.join(sockDir, `${this.id}-herdr.sock`);
    this.vscodeReady = new Promise((resolve) => { this.resolveVscode = resolve; });
    this.retryMs = 1000;
    this.connect();
  }

  sshArgs(extra) {
    return [
      '-o', 'BatchMode=yes',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'StreamLocalBindUnlink=yes',
      ...extra,
      this.def.ssh,
    ];
  }

  // The remote herdr socket path must be absolute, so we learn $HOME first.
  // The remote hostname is what herdr puts in its title for this machine.
  remoteInfo() {
    if (this.home) return Promise.resolve(this.home);
    return new Promise((resolve, reject) => {
      const cmd = 'printf "%s\\n%s" "$HOME" "$(hostname)"';
      execFile('ssh', [...this.sshArgs(['-o', 'ConnectTimeout=10']), cmd], { env: this.env }, (err, stdout) => {
        if (err) return reject(err);
        const [home, hostname] = stdout.trim().split('\n');
        if (hostname) this.hostnames.push(hostname.toLowerCase());
        resolve((this.home = home));
      });
    });
  }

  remoteHerdrSocket(home) {
    if (this.def.remoteHerdrSocket) return this.def.remoteHerdrSocket;
    const session = this.def.herdrSession;
    return session && session !== 'default'
      ? `${home}/.config/herdr/sessions/${session}/herdr.sock`
      : `${home}/.config/herdr/herdr.sock`;
  }

  async connect() {
    if (this.stopped) return;
    let home;
    try {
      home = await this.remoteInfo();
    } catch (err) {
      console.warn(`[${this.id}] ssh failed: ${err.message.trim()}`);
      return this.retry();
    }
    const remoteSocket = this.remoteHerdrSocket(home);
    const remotePort = this.def.remotePort || 47800;
    const args = this.sshArgs([
      '-L', `127.0.0.1:${this.vscodePort}:127.0.0.1:${remotePort}`,
      '-L', `${this.localSocket}:${remoteSocket}`,
    ]);
    args.push('exec "${SHELL:-/bin/sh}" -l -s');

    const proc = spawn('ssh', args, { env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    proc.stdin.write(remoteScript({ remotePort, codeCommand: this.def.codeCommand || 'code' }));
    proc.stderr.on('data', (d) => console.warn(`[${this.id}] ssh: ${d.toString().trim()}`));
    let out = '';
    proc.stdout.on('data', (d) => {
      out += d;
      const token = out.match(/spaceherd-ready:([0-9a-f]+)\n/)?.[1];
      if (!token) return;
      out = '';
      this.token = token;
      this.retryMs = 1000;
      if (!this.herdr) this.connectHerdr(this.localSocket);
      waitForHttp(this.vscodePort, { token }).then(this.resolveVscode, (err) => console.warn(`[${this.id}] ${err.message}`));
    });
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      console.warn(`[${this.id}] ssh exited (${code}), reconnecting`);
      this.retry();
    });
  }

  retry() {
    if (this.stopped) return;
    setTimeout(() => this.connect(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, 30000);
  }

  stop() {
    super.stop();
    this.proc?.kill();
  }
}

function createMachine(def, opts) {
  if (def.type === 'ssh') return new SshMachine(def, opts);
  return new LocalMachine(def, opts);
}

// "ssh://user@host:2222" or "user@host" -> "host"
function sshHost(target) {
  return target.replace(/^ssh:\/\//, '').replace(/^[^@]*@/, '').replace(/[:/].*$/, '');
}

// The SSH machines saved in herdr (`herdr machine add`), as machine definitions
// without ports; the caller assigns those.
function herdrSavedMachines(env) {
  return new Promise((resolve) => {
    execFile('herdr', ['machine', 'list', '--json'], { env }, (err, stdout) => {
      if (err) return resolve([]);
      try {
        resolve(
          JSON.parse(stdout)
            .filter((m) => m.enabled)
            .map((m) => ({
              id: m.label.replace(/[^\w.-]+/g, '-'),
              type: 'ssh',
              ssh: m.target,
              hostnames: [m.label, sshHost(m.target)],
              herdrSession: m.session,
            })),
        );
      } catch {
        resolve([]);
      }
    });
  });
}

module.exports = { createMachine, herdrSavedMachines };
