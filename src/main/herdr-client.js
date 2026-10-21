// Client for the herdr socket API: newline-delimited JSON over a unix socket.
// Requests use a short-lived connection each; subscriptions hold one open
// connection and reconnect with backoff.

const net = require('net');
const { EventEmitter } = require('events');

let nextId = 1;

function lineReader(onLine) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onLine(line);
    }
  };
}

class HerdrClient extends EventEmitter {
  constructor(socketPath, { name = 'herdr' } = {}) {
    super();
    this.socketPath = socketPath;
    this.name = name;
    this.subSocket = null;
    this.subscriptions = null;
    this.closed = false;
    this.retryMs = 500;
  }

  request(method, params = {}, { timeoutMs = 5000 } = {}) {
    return new Promise((resolve, reject) => {
      const id = `cm_${nextId++}`;
      const sock = net.createConnection(this.socketPath);
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error(`${this.name}: ${method} timed out`));
      }, timeoutMs);
      const done = (fn, value) => {
        clearTimeout(timer);
        sock.destroy();
        fn(value);
      };
      sock.setEncoding('utf8');
      sock.on('error', (err) => done(reject, err));
      sock.on('data', lineReader((line) => {
        let msg;
        try { msg = JSON.parse(line); } catch { return; }
        if (msg.id !== id) return;
        if (msg.error) done(reject, Object.assign(new Error(msg.error.message), { code: msg.error.code }));
        else done(resolve, msg.result);
      }));
      sock.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  async snapshot() {
    const result = await this.request('session.snapshot');
    return result.snapshot;
  }

  // Emits 'event' for each pushed event, 'connected' after every (re)subscribe
  // so callers can reconcile with a fresh snapshot, and 'disconnected'.
  subscribe(subscriptions) {
    this.subscriptions = subscriptions;
    this._connectSubscription();
  }

  _connectSubscription() {
    if (this.closed) return;
    const id = `cm_sub_${nextId++}`;
    const sock = net.createConnection(this.socketPath);
    this.subSocket = sock;
    let acked = false;
    sock.setEncoding('utf8');
    sock.on('data', lineReader((line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.error) {
        // events_lost or a rejected subscription: drop and resubscribe.
        this.emit('warn', `${this.name}: subscription error ${msg.error.code}: ${msg.error.message}`);
        sock.destroy();
        return;
      }
      if (!acked && msg.id === id) {
        acked = true;
        this.retryMs = 500;
        this.emit('connected');
        return;
      }
      // Pushed events look like {"event":"workspace_focused","data":{...}}.
      if (msg.event) this.emit('event', msg.event, msg.data || {});
    }));
    sock.on('error', () => {});
    sock.on('close', () => {
      if (this.subSocket !== sock) return;
      this.subSocket = null;
      if (acked) this.emit('disconnected');
      if (this.closed) return;
      setTimeout(() => this._connectSubscription(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 10000);
    });
    sock.write(JSON.stringify({ id, method: 'events.subscribe', params: { subscriptions: this.subscriptions } }) + '\n');
  }

  close() {
    this.closed = true;
    this.subSocket?.destroy();
  }
}

module.exports = { HerdrClient };
