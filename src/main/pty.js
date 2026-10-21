// Runs the herdr TUI in a pseudo-terminal for the left pane.

const pty = require('node-pty');
const os = require('os');

class HerdrPty {
  constructor({ command, args, env, onData, onExit }) {
    this.spec = { command, args, env };
    this.onData = onData;
    this.onExit = onExit;
    this.size = { cols: 100, rows: 30 };
    this.proc = null;
  }

  start() {
    const { command, args, env } = this.spec;
    this.proc = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols: this.size.cols,
      rows: this.size.rows,
      cwd: os.homedir(),
      env: { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'spaceherd' },
    });
    const proc = this.proc;
    proc.onData((d) => this.onData(d));
    proc.onExit(({ exitCode }) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.onExit(exitCode);
    });
  }

  write(data) {
    this.proc?.write(data);
  }

  resize(cols, rows) {
    this.size = { cols, rows };
    this.proc?.resize(cols, rows);
  }

  kill() {
    const proc = this.proc;
    this.proc = null;
    proc?.kill();
  }
}

module.exports = { HerdrPty };
