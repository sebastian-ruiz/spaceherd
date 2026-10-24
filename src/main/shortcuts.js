// Which keys pressed in herdr go to VS Code instead, so the left pane behaves
// like VS Code's own integrated terminal. VS Code's terminal hands the keys of
// its "commands to skip shell" (DEFAULT_COMMANDS_TO_SKIP_SHELL in
// src/vs/workbench/contrib/terminal/common/terminal.ts) to the workbench and
// everything else to the shell. The tables below are those commands' default
// keys, minus the terminal's own commands, which mean nothing for herdr.

// Linux: Ctrl is shared with the shell, so only the listed keys move.
// Deliberately absent: Ctrl+K (VS Code chords; the shell's kill-line),
// Ctrl+Q (Quick Open View, but spaceherd's Quit), F11 (spaceherd's own full
// screen) and zoom (VS Code in a browser has none).
const LINUX = new Set([
  'ctrl+p', 'ctrl+e', // Quick Open
  'ctrl+shift+p', 'f1', // Command Palette
  'ctrl+j', // Toggle Panel
  'ctrl+tab', 'ctrl+shift+tab', // recently used editors
  'ctrl+pageup', 'ctrl+pagedown', // previous / next editor
  'ctrl+1', 'ctrl+2', 'ctrl+3', 'ctrl+4', 'ctrl+5', 'ctrl+6', 'ctrl+7', 'ctrl+8', // editor groups
  'ctrl+shift+b', // Run Build Task
  'f5', 'shift+f5', 'ctrl+shift+f5', 'ctrl+f5', 'f6', 'f10', 'shift+f11', // debug
]);

// macOS: the shell never sees Cmd, so as in VS Code's terminal every Cmd key
// reaches VS Code, except spaceherd's menu keys, the system ones, and the
// terminal's own keys (handled in src/renderer/terminal.js): line editing,
// clear, find, select all and font size.
const MAC_KEEP = new Set([
  'cmd+c', 'cmd+v', 'cmd+x', 'cmd+q', 'cmd+w', 'cmd+h', 'alt+cmd+h', 'cmd+m', 'cmd+tab', 'cmd+`',
  'cmd+arrowleft', 'cmd+arrowright', 'cmd+backspace',
  'cmd+k', 'cmd+f', 'cmd+a',
  'cmd+=', 'shift+cmd+=', 'cmd+-', 'cmd+0',
]);

const PUNCTUATION = {
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
};

// The unshifted key on a US layout, as Electron's accelerators name it:
// "p", "1", "[", "F5", "PageUp". Physical, like VS Code's keyboard.dispatch.
function physicalKey(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(code)) return code.slice(5);
  return PUNCTUATION[code] || code;
}

// "ctrl+shift+p" for an Electron input event, by physical key.
function chord(input) {
  const mods = [];
  if (input.control) mods.push('ctrl');
  if (input.alt) mods.push('alt');
  if (input.shift) mods.push('shift');
  if (input.meta) mods.push('cmd');
  return [...mods, physicalKey(input.code).toLowerCase()].join('+');
}

function forwardsToVSCode(input, platform = process.platform) {
  if (input.type !== 'keyDown' || input.isAutoRepeat) return false;
  // Cmd, Ctrl, Shift or Alt pressed on its own, before the key it goes with.
  if (/^(Meta|Control|Shift|Alt|OS)/.test(input.code)) return false;
  const c = chord(input);
  if (platform === 'darwin') return input.meta && !input.control && !MAC_KEEP.has(c);
  return LINUX.has(c);
}

// The input event replayed into VS Code's webContents.
function asInputEvent(input) {
  const modifiers = [];
  if (input.control) modifiers.push('control');
  if (input.alt) modifiers.push('alt');
  if (input.shift) modifiers.push('shift');
  if (input.meta) modifiers.push('meta');
  return { type: 'keyDown', keyCode: physicalKey(input.code), modifiers };
}

module.exports = { forwardsToVSCode, asInputEvent, chord };
