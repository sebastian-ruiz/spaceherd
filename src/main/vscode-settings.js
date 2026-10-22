// Applies `vscodeUserSettings` from the config to VS Code's user settings in
// each view. VS Code in a browser keeps those in the page's IndexedDB, not on
// disk, and application-scoped settings (window.menuBarVisibility, ...) are
// read only from there: the server's Machine settings.json skips them, and
// extensions cannot contribute defaults for them.
//
// The layout is VS Code's (src/vs/workbench/browser/web.main.ts and
// src/vs/platform/files/browser/indexedDBFileSystemProvider.ts): database
// "vscode-web-db", store "vscode-userdata-store", one entry per file, keyed by
// path. Other windows of the origin hear about changes on a BroadcastChannel.

const jsonc = require('jsonc-parser');
const { debug } = require('./config');

const SETTINGS_PATH = '/User/settings.json';

// Runs in the page. Resolves with the file's text, '' when VS Code has not
// written it yet, or null when VS Code has not created its database within
// the timeout.
const readScript = `(async () => {
  const deadline = Date.now() + 15000;
  while (!(await indexedDB.databases()).some((d) => d.name === 'vscode-web-db')) {
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 200));
  }
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('vscode-web-db');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  try {
    const value = await new Promise((resolve, reject) => {
      const req = db.transaction('vscode-userdata-store').objectStore('vscode-userdata-store').get(${JSON.stringify(SETTINGS_PATH)});
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (value === undefined) return '';
    return typeof value === 'string' ? value : new TextDecoder().decode(value);
  } finally {
    db.close();
  }
})()`;

// Runs in the page. Writes the file and tells the workbench, as VS Code's
// own provider does for other windows (FileChangeType 0 = updated).
const writeScript = (text) => `(async () => {
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('vscode-web-db');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction('vscode-userdata-store', 'readwrite');
      tx.objectStore('vscode-userdata-store').put(new TextEncoder().encode(${JSON.stringify(text)}), ${JSON.stringify(SETTINGS_PATH)});
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
  const channel = new BroadcastChannel('vscode.indexedDB.vscode-userdata.changes');
  channel.postMessage([{ type: 0, resource: { scheme: 'vscode-userdata', authority: '', path: ${JSON.stringify(SETTINGS_PATH)}, query: '', fragment: '' } }]);
  channel.close();
})()`;

// `text` with `settings` set, or null when nothing changes.
function merged(text, settings) {
  const current = jsonc.parse(text || '{}') || {};
  let out = text.trim() ? text : '{}\n';
  for (const [key, value] of Object.entries(settings)) {
    if (JSON.stringify(current[key]) === JSON.stringify(value)) continue;
    const edits = jsonc.modify(out, [key], value, { formattingOptions: { insertSpaces: true, tabSize: 4 } });
    out = jsonc.applyEdits(out, edits);
  }
  return out === text ? null : out;
}

async function applyUserSettings(webContents, settings) {
  if (!settings || !Object.keys(settings).length) return;
  const text = await webContents.executeJavaScript(readScript);
  if (text === null || webContents.isDestroyed()) return;
  const out = merged(text, settings);
  if (!out) return;
  debug('vscode user settings ->', Object.keys(settings).join(', '));
  await webContents.executeJavaScript(writeScript(out));
  // A new file is missing from the workbench's cached file tree until it
  // reloads; an existing one updates live. Only the first apply per machine
  // creates the file.
  if (!text) webContents.reload();
}

module.exports = { applyUserSettings, merged };
