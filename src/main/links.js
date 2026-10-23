// Cmd+click on text in herdr: what it points at. URLs open in the browser;
// file paths, resolved like a shell would from the focused pane's
// directory, open in the space's VS Code.

const path = require('path').posix;

// "https://…" -> { url }; "src/app.js:42:7" -> { file, line, column };
// anything else -> null.
function parseLink(text, { cwd, home }) {
  if (/^https?:\/\/\S+$/.test(text)) return { url: text };
  const m = text.match(/^(.+?)(?::(\d+))?(?::(\d+))?$/);
  let file = m[1];
  // A path, not a word: it has a slash or a file extension.
  if (!file.includes('/') && !/\.[A-Za-z0-9]+$/.test(file)) return null;
  if (file.startsWith('~/') && home) file = home + file.slice(1);
  else if (!file.startsWith('/')) {
    if (!cwd) return null;
    file = path.join(cwd, file);
  }
  return { file, line: m[2] ? Number(m[2]) : null, column: m[3] ? Number(m[3]) : null };
}

module.exports = { parseLink };
