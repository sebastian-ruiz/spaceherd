// The keys that start a search in herdr: its prefix, then its copy-mode key,
// then "?" (search backwards, from the newest output). Read from the local
// herdr config, since the left pane is a local herdr client.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULTS = { prefix: 'ctrl+b', copy_mode: 'prefix+[' };

// The [keys] entries we need, as strings; a list keeps its first entry.
function readKeys(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { ...DEFAULTS };
  }
  const keys = { ...DEFAULTS };
  let section = '';
  for (const line of text.split('\n')) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      section = header[1].trim();
      continue;
    }
    const m = section === 'keys' && line.match(/^\s*(prefix|copy_mode)\s*=\s*\[?\s*"([^"]+)"/);
    if (m) keys[m[1]] = m[2];
  }
  return keys;
}

// "ctrl+b" -> "\x02". Only Ctrl+letter prefixes can be typed as one byte.
function controlByte(key) {
  const m = key.toLowerCase().match(/^ctrl\+([a-z])$/);
  return m ? String.fromCharCode(m[1].charCodeAt(0) - 96) : null;
}

// The bytes for Cmd+F, or null when herdr's keys are set up in a way we
// can't type (another prefix kind, or copy mode bound without the prefix).
function findSequence() {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const keys = readKeys(path.join(configHome, 'herdr', 'config.toml'));
  const prefix = controlByte(keys.prefix);
  const m = keys.copy_mode.match(/^prefix\+(.)$/);
  return prefix && m ? prefix + m[1] + '?' : null;
}

module.exports = { findSequence, readKeys };
