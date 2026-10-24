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

// Cmd+click (Ctrl+click elsewhere) opens the URL or file path under the
// pointer, as in VS Code's terminal. herdr has mouse reporting on, so xterm's
// own link handling never sees clicks; take this one before xterm sends it.
const LINK_CHAR = /[\w.~\-\/+@%=:#?&!$*,;]/;
const BORDER = /[\u2500-\u257f]/; // box drawing: herdr's pane borders
const isLink = (ch) => LINK_CHAR.test(ch || '');

function rowChars(row) {
  const line = term.buffer.active.getLine(term.buffer.active.viewportY + row);
  if (!line) return null;
  const cell = term.buffer.active.getNullCell();
  const chars = [];
  for (let x = 0; x < term.cols; x++) chars.push(line.getCell(x, cell) ? cell.getChars() : '');
  return chars;
}

// The pane around column `col` of a row: from just after the border on its
// left to just before the border on its right (or the window's edges).
function paneSpan(chars, col) {
  let left = col;
  while (left > 0 && !BORDER.test(chars[left - 1] || '')) left--;
  let right = col;
  while (right < chars.length - 1 && !BORDER.test(chars[right + 1] || '')) right++;
  return { left, right };
}

// herdr draws each pane row on its own, so a path the program in the pane
// wrapped is just two rows here. A run of link characters that reaches the
// pane's right edge continues at the start of the next row (after any
// indent), and one that starts a row continues from the end of the row
// before it, if that row's text reaches the edge.
function textAround(clientX, clientY) {
  const screen = term.element.querySelector('.xterm-screen').getBoundingClientRect();
  const col = Math.floor(((clientX - screen.left) / screen.width) * term.cols);
  const row = Math.floor(((clientY - screen.top) / screen.height) * term.rows);
  const chars = rowChars(row);
  if (!chars || col < 0 || col >= term.cols || !isLink(chars[col])) return '';
  const pane = paneSpan(chars, col);
  let start = col;
  let end = col;
  while (start > pane.left && isLink(chars[start - 1])) start--;
  while (end < pane.right && isLink(chars[end + 1])) end++;
  let text = chars.slice(start, end + 1).join('');

  // Forwards, while the run ends at the pane's right edge.
  for (let r = row + 1, e = end; e === pane.right && r < term.rows; r++) {
    const next = rowChars(r);
    let i = pane.left;
    while (i <= pane.right && next[i] === ' ') i++;
    if (!isLink(next[i])) break;
    let j = i;
    while (j < pane.right && isLink(next[j + 1])) j++;
    text += next.slice(i, j + 1).join('');
    e = j;
  }
  // Backwards, while the run starts the row (after indent) and the row above
  // ends with link characters at the pane's right edge.
  for (let r = row - 1, s = start, cur = chars; r >= 0; r--) {
    let i = pane.left;
    while (i < s && cur[i] === ' ') i++;
    if (i !== s) break;
    const prev = rowChars(r);
    if (!isLink(prev[pane.right])) break;
    let j = pane.right;
    while (j > pane.left && isLink(prev[j - 1])) j--;
    text = prev.slice(j, pane.right + 1).join('') + text;
    s = j;
    cur = prev;
  }
  // Sentence punctuation after a link or path isn't part of it.
  return text.replace(/[.,;:!?]+$/, '');
}
// The text under the pointer if it is a URL or a path (a slash or a file
// extension, optionally :line:col), as src/main/links.js decides; else ''.
function linkAt(x, y) {
  const text = textAround(x, y);
  const file = text.replace(/(:\d+){1,2}$/, '');
  return /^https?:\/\//.test(text) || file.includes('/') || /\.[A-Za-z0-9]+$/.test(file) ? text : '';
}

const isMac = navigator.platform.startsWith('Mac');
const linkModifier = (e) => (isMac ? e.metaKey : e.ctrlKey);

// While the modifier is held over a link, show the hand cursor, as terminals
// do. Checked on mouse moves and when the modifier goes down or up.
let pointer = null;
let hoverFrame = 0;
function updateLinkHover(modifierDown) {
  const over = modifierDown && pointer && linkAt(pointer.x, pointer.y) !== '';
  document.body.classList.toggle('link-hover', !!over);
}
window.addEventListener(
  'mousemove',
  (e) => {
    pointer = { x: e.clientX, y: e.clientY };
    const down = linkModifier(e);
    cancelAnimationFrame(hoverFrame);
    hoverFrame = requestAnimationFrame(() => updateLinkHover(down));
  },
  true,
);
for (const type of ['keydown', 'keyup']) {
  window.addEventListener(type, (e) => {
    if (e.key === (isMac ? 'Meta' : 'Control')) updateLinkHover(type === 'keydown');
  }, true);
}
window.addEventListener('blur', () => updateLinkHover(false));

window.addEventListener(
  'mousedown',
  (e) => {
    if (e.button !== 0 || !linkModifier(e)) return;
    const text = linkAt(e.clientX, e.clientY);
    if (!text) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    cm.debug(`open link ${JSON.stringify(text)}`);
    cm.openLink(text);
  },
  true,
);

// Shift+Enter inserts a new line in Claude Code and other agents. xterm
// sends it as a plain Enter, which submits; send ESC Enter (Meta+Enter),
// which they read as a new line, as VS Code's terminal does after Claude
// Code's /terminal-setup.
// Mac keys that act on the terminal, as in VS Code's terminal: line editing
// goes to the program as Ctrl keys, Option+arrows jump words (Esc b / Esc f,
// which every shell knows), Cmd+K clears the screen (Ctrl+L), Cmd+F opens
// herdr's search, and Cmd+=/-/0 change the font size. Cmd+A has nothing to
// select in herdr's screen, so it does nothing rather than moving focus to
// VS Code. src/main/shortcuts.js keeps these Cmd keys here.
const IS_MAC = navigator.platform.startsWith('Mac');
let findKeys = null;
function macTerminalKey(e) {
  if (!IS_MAC || e.ctrlKey || e.shiftKey && e.code !== 'Equal') return undefined;
  if (e.altKey && !e.metaKey) {
    if (e.code === 'ArrowLeft') return () => cm.write('\x1bb');
    if (e.code === 'ArrowRight') return () => cm.write('\x1bf');
    return undefined;
  }
  if (!e.metaKey || e.altKey) return undefined;
  switch (e.code) {
    case 'ArrowLeft': return () => cm.write('\x01');
    case 'ArrowRight': return () => cm.write('\x05');
    case 'Backspace': return () => cm.write('\x15');
    case 'KeyK': return () => cm.write('\x0c');
    case 'KeyF': return () => findKeys && cm.write(findKeys);
    case 'KeyA': return () => {};
    case 'Equal': return () => zoom(1);
    case 'Minus': return () => zoom(-1);
    case 'Digit0': return () => zoom(0);
    default: return undefined;
  }
}

term.attachCustomKeyEventHandler((e) => {
  const action = macTerminalKey(e);
  if (action) {
    if (e.type === 'keydown') action();
    e.preventDefault();
    return false;
  }
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

// Files dragged from VS Code's explorer, or from outside the app, paste their
// paths into herdr's focused pane, relative to its directory.
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  const dt = e.dataTransfer;
  cm.debug(`drop types=${JSON.stringify([...dt.types])}`);
  const text = await cm.dropText(
    { resources: dt.getData('ResourceURLs'), text: dt.getData('text/plain') },
    [...dt.files],
  );
  if (!text) return;
  term.focus();
  term.paste(text);
});
term.onTitleChange((t) => cm.title(t));
term.onBell(() => cm.bell());
term.parser.registerOscHandler(52, (payload) => {
  cm.clipboard(payload);
  return true;
});
for (const code of [9, 777]) {
  term.parser.registerOscHandler(code, (payload) => {
    cm.osc(code, payload);
    return true;
  });
}

cm.onData((d) => term.write(d));
cm.onFocus(() => term.focus());
// Font size: the config's, plus Cmd+=/- steps, which are remembered here.
let baseFontSize = 13;
let fontSteps = 0;
try {
  fontSteps = Number(localStorage.getItem('fontSteps')) || 0;
} catch {}
function zoom(step) {
  fontSteps = step === 0 ? 0 : Math.max(6 - baseFontSize, Math.min(fontSteps + step, 40 - baseFontSize));
  try {
    localStorage.setItem('fontSteps', String(fontSteps));
  } catch {}
  term.options.fontSize = baseFontSize + fontSteps;
  resize();
}

cm.onConfig((cfg) => {
  term.options.fontFamily = cfg.fontFamily;
  baseFontSize = cfg.fontSize;
  term.options.fontSize = baseFontSize + fontSteps;
  term.options.macOptionIsMeta = cfg.macOptionIsMeta;
  findKeys = cfg.findKeys;
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
