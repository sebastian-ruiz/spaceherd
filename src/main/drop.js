// Turns files dragged from VS Code's explorer into text to paste into herdr:
// paths relative to the focused pane's directory, absolute when outside it.

const path = require('path').posix;

// VS Code puts the dragged files' URIs in "ResourceURLs" as JSON
// (fillEditorsDragData in src/vs/workbench/browser/dnd.ts), e.g.
// "vscode-remote://127.0.0.1:47801/home/me/proj/app.py". Its text/plain is a
// display label, possibly with "~", so it's only the fallback.
function droppedPaths({ resources, text }, { home }) {
  try {
    const uris = JSON.parse(resources || '[]');
    if (uris.length) return uris.map((u) => decodeURIComponent(new URL(u).pathname));
  } catch {}
  return (text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('/') || line.startsWith('~'))
    .map((line) => (line.startsWith('~') && home ? home + line.slice(1) : line));
}

function relativeTo(cwd, file) {
  if (!cwd) return file;
  const rel = path.relative(cwd, file);
  if (rel === '') return '.';
  return rel === '..' || rel.startsWith('../') ? file : rel;
}

// Single quotes when the shell would split or expand the path.
function quote(p) {
  return /^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}

// The text to paste, or '' when the drop carried no files.
function dropText(data, { cwd, home }) {
  const paths = droppedPaths(data, { home });
  if (!paths.length) return '';
  return paths.map((p) => quote(relativeTo(cwd, p))).join(' ') + ' ';
}

module.exports = { dropText };
