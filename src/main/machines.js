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
const { installVSCodeExtension } = require('./vscode-extension');

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

// `spaceherd open` in a pane (src/main/spaceherd-cli.sh) asks through pane
// tokens: an id, and the request in base64 split over spaceherd_0, _1, ….
const OPEN_SOURCE = 'spaceherd.open';

// A machine's VS Code server is shared by every spaceherd that uses the
// machine, locally or over SSH (laptop and desktop), so the token lives in a
// fixed per-user place on the machine itself. The SSH remote script uses the
// same path.
const SHARED_DIR = path.join(os.homedir(), '.config', 'spaceherd');

// The `spaceherd` command for herdr panes, installed on every machine as
// ~/.config/spaceherd/bin/spaceherd (see src/main/spaceherd-cli.sh).
const CLI = fs.readFileSync(path.join(__dirname, 'spaceherd-cli.sh'), 'utf8');

function installLocalCli() {
  const file = path.join(SHARED_DIR, 'bin', 'spaceherd');
  try {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === CLI) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, CLI);
    fs.chmodSync(file, 0o755);
  } catch (err) {
    console.warn('installing the spaceherd command:', err.message);
  }
}

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

// Runs a shell script fed through stdin and resolves with its output.
function runScript(command, args, script, env) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `exit ${code}`))));
    proc.stdin.end(script);
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
      if (name === 'pane_updated') {
        this.checkOpenRequest(data.pane);
        return;
      }
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
    this.herdr.subscribe([...LIFECYCLE_EVENTS, 'pane.updated'].map((type) => ({ type })));
    this.pollTimer = setInterval(() => this.refresh(), POLL_MS);
    this.refresh();
  }

  // Emits 'open' with the pane and { kind: 'f' | 'd', path } for a new
  // request, and clears its tokens, which tells the command it was taken.
  checkOpenRequest(pane) {
    const tokens = pane?.tokens || {};
    const id = tokens.spaceherd_id;
    if (!id || this.openIds?.has(id)) return;
    let data = '';
    const keys = ['spaceherd_id'];
    for (let i = 0; tokens[`spaceherd_${i}`] !== undefined; i++) {
      data += tokens[`spaceherd_${i}`];
      keys.push(`spaceherd_${i}`);
    }
    const m = Buffer.from(data, 'base64').toString('utf8').match(/^([fd]):(\/.*)$/s);
    if (!m) return;
    this.openIds = this.openIds || new Set();
    this.openIds.add(id);
    if (this.openIds.size > 50) this.openIds.delete(this.openIds.values().next().value);
    debug(`[${this.id}] open request`, pane.pane_id, m[1], m[2]);
    this.herdr
      .request('pane.report_metadata', {
        pane_id: pane.pane_id,
        source: OPEN_SOURCE,
        tokens: Object.fromEntries(keys.map((k) => [k, null])),
      })
      .catch((err) => console.warn(`[${this.id}] clearing open request:`, err.message));
    this.emit('open', pane, { kind: m[1], path: m[2] });
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
  // `args` are plain words, passed to the script as $1, $2, ….
  run(script, args = []) {
    return runScript('/bin/sh', ['-s', ...args], script, this.env);
  }

  start() {
    this.home = os.homedir();
    // Where herdr puts it: under $XDG_CONFIG_HOME when that's set.
    const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    const socket = this.def.herdrSocket || path.join(configHome, 'herdr', 'herdr.sock');
    this.connectHerdr(socket);
    installLocalCli();
    installVSCodeExtension(this.def.vscodeServerDataDir);
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
    'mkdir -p ~/.config/spaceherd/bin',
    "cat > ~/.config/spaceherd/bin/spaceherd <<'SPACEHERD_CLI'",
    CLI.trimEnd(),
    'SPACEHERD_CLI',
    'chmod 755 ~/.config/spaceherd/bin/spaceherd',
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
  run(script, args = []) {
    return runScript('ssh', [...this.sshArgs(['-o', 'ConnectTimeout=10']), ['sh -s', ...args].join(' ')], script, this.env);
  }

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
        const h = hostname?.toLowerCase();
        if (h && !this.hostnames.includes(h)) {
          this.hostnames.push(h);
          this.emit('hostname', h);
        }
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
