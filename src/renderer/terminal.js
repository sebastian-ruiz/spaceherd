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

// Shift+Enter inserts a new line in Claude Code and other agents. xterm
// sends it as a plain Enter, which submits; send ESC Enter (Meta+Enter),
// which they read as a new line, as VS Code's terminal does after Claude
// Code's /terminal-setup.
term.attachCustomKeyEventHandler((e) => {
  if (e.key !== 'Enter' || !e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return true;
  if (e.type === 'keydown') cm.write('\x1b\r');
  return false;
});

// Whether herdr's theme is dark, from the backgrounds it draws, so the
// window's title bar can match. Cells on the default background count as
// that background (the theme's, dark); a light herdr theme paints its own.
const ANSI = [
  0x2e3436, 0xcc0000, 0x4e9a06, 0xc4a000, 0x3465a4, 0x75507b, 0x06989a, 0xd3d7cf,
  0x555753, 0xef2929, 0x8ae234, 0xfce94f, 0x729fcf, 0xad7fa8, 0x34e2e2, 0xeeeeec,
];
function paletteColor(i) {
  if (i < 16) return ANSI[i];
  if (i < 232) {
    const level = (n) => (n ? 55 + n * 40 : 0);
    const n = i - 16;
    return (level(Math.floor(n / 36)) << 16) | (level(Math.floor(n / 6) % 6) << 8) | level(n % 6);
  }
  const g = 8 + (i - 232) * 10;
  return (g << 16) | (g << 8) | g;
}
function isDarkColor(rgb) {
  const r = (rgb >> 16) & 255, g = (rgb >> 8) & 255, b = rgb & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b < 128;
}
function herdrLooksDark() {
  const buffer = term.buffer.active;
  let dark = 0;
  let light = 0;
  const cell = buffer.getNullCell();
  for (let y = 0; y < term.rows; y += 2) {
    const line = buffer.getLine(buffer.viewportY + y);
    if (!line) continue;
    for (let x = 0; x < term.cols; x += 4) {
      if (!line.getCell(x, cell) || cell.isInverse() || cell.isBgDefault()) continue;
      const rgb = cell.isBgRGB() ? cell.getBgColor() : paletteColor(cell.getBgColor());
      if (isDarkColor(rgb)) dark++;
      else light++;
    }
  }
  return light <= dark;
}
let lastAppearance = null;
let appearanceTimer = null;
term.onWriteParsed(() => {
  clearTimeout(appearanceTimer);
  appearanceTimer = setTimeout(() => {
    const appearance = herdrLooksDark() ? 'dark' : 'light';
    if (appearance === lastAppearance) return;
    lastAppearance = appearance;
    cm.appearance(appearance);
  }, 500);
});

// Files dragged from VS Code's explorer paste their paths into herdr's
// focused pane, relative to its directory.
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  const dt = e.dataTransfer;
  cm.debug(`drop types=${JSON.stringify([...dt.types])}`);
  const text = await cm.dropText({ resources: dt.getData('ResourceURLs'), text: dt.getData('text/plain') });
  if (!text) return;
  term.focus();
  term.paste(text);
});
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
// Only while the space has VS Code open.
cm.onDivider((show) => { divider.hidden = !show; });
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
