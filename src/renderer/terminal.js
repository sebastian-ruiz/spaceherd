/* global Terminal, FitAddon, WebglAddon, cm */

const term = new Terminal({
  allowProposedApi: true,
  cursorBlink: true,
  scrollback: 0, // herdr owns scrollback
  theme: { background: '#181818' },
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('terminal'));
try {
  term.loadAddon(new WebglAddon.WebglAddon());
} catch (err) {
  console.warn('WebGL renderer unavailable, using DOM renderer', err);
}

// Focus before xterm handles the click, so the first click into an unfocused
// terminal reaches herdr instead of only focusing it.
document.getElementById('terminal').addEventListener(
  'mousedown',
  () => {
    if (!term.element.contains(document.activeElement)) term.focus();
  },
  true,
);

// When a click moves focus here from VS Code, the press reaches herdr but the
// release can get lost, and herdr acts on the release. Track SGR mouse
// reports (ESC [ < b ; x ; y M|m) and send the missing release once the
// button is evidently up.
let pendingPress = null;
function sendRelease(reason) {
  if (!pendingPress) return;
  const { b, x, y } = pendingPress;
  pendingPress = null;
  cm.debug(`synthesized mouse release (${reason})`);
  cm.write(`\x1b[<${b};${x};${y}m`);
}
// herdr answers a focus-in report (ESC [ I) by switching its mouse modes off
// and on again. If that lands during the click that focused the terminal,
// xterm drops the drag it is tracking, so selecting text right after coming
// from VS Code fails. Hold focus-in back until the button is up.
let buttonDown = false;
let focusInHeld = false;
function flushFocusIn() {
  if (!focusInHeld || buttonDown) return;
  focusInHeld = false;
  cm.write('\x1b[I');
}
window.addEventListener('mousedown', () => { buttonDown = true; }, true);
window.addEventListener('mousemove', (e) => {
  if (buttonDown && e.buttons === 0) {
    buttonDown = false;
    flushFocusIn();
  }
}, true);
window.addEventListener('blur', () => {
  buttonDown = false;
  flushFocusIn();
});

term.onData((d) => {
  if (d === '\x1b[I') {
    // The focus usually arrives just before the click's mousedown.
    focusInHeld = true;
    setTimeout(flushFocusIn, 50);
    return;
  }
  if (d === '\x1b[O' && focusInHeld) {
    // herdr never saw the focus-in, so it still thinks it is unfocused.
    focusInHeld = false;
    return;
  }
  for (const [, bs, x, y, kind] of d.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g)) {
    const b = Number(bs);
    const motion = (b & 32) !== 0;
    const button = b & 3;
    if (kind === 'm') pendingPress = null;
    else if (!motion && button !== 3 && b < 64) pendingPress = { b, x, y };
    else if (motion && button === 3 && pendingPress) sendRelease('motion without button');
  }
  cm.write(d);
});
window.addEventListener(
  'mouseup',
  (e) => {
    cm.debug('terminal page mouseup');
    // Let xterm send its own release first; only fill in if it didn't.
    if (e.buttons !== 0) return;
    buttonDown = false;
    setTimeout(() => {
      sendRelease('mouseup');
      flushFocusIn();
    }, 0);
  },
  true,
);
term.onBinary((d) => cm.write(d));
term.onTitleChange((t) => cm.title(t));
term.onBell(() => cm.bell());
for (const code of [9, 777]) {
  term.parser.registerOscHandler(code, (payload) => {
    cm.osc(code, payload);
    return true;
  });
}

cm.onData((d) => term.write(d));
cm.onFocus(() => term.focus());
cm.onConfig((cfg) => {
  term.options.fontFamily = cfg.fontFamily;
  term.options.fontSize = cfg.fontSize;
  term.options.macOptionIsMeta = cfg.macOptionIsMeta;
  resize();
});

let lastSize = '';
function resize() {
  fit.fit();
  const size = `${term.cols}x${term.rows}`;
  if (size === lastSize) return;
  lastSize = size;
  cm.resize(term.cols, term.rows);
}
new ResizeObserver(() => resize()).observe(document.getElementById('terminal'));

const divider = document.getElementById('divider');
divider.addEventListener('pointerdown', (e) => {
  divider.setPointerCapture(e.pointerId);
  divider.classList.add('dragging');
});
divider.addEventListener('pointermove', (e) => {
  if (divider.hasPointerCapture(e.pointerId)) cm.dragDivider(e.screenX);
});
divider.addEventListener('pointerup', (e) => {
  divider.releasePointerCapture(e.pointerId);
  divider.classList.remove('dragging');
});

term.focus();
cm.ready();
