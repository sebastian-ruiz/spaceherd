// Opening a file in a VS Code view from outside it.

const path = require('path').posix;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The view `getWebContents` returns, once its workbench is up; null after
// 30 s. The view may not exist yet when VS Code was only just turned on.
async function workbenchReady(getWebContents) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const webContents = getWebContents();
    if (webContents && !webContents.isLoading()) {
      const ready = await webContents.executeJavaScript("!!document.querySelector('.monaco-workbench .part.editor')").catch(() => false);
      if (ready) return webContents;
    }
    await sleep(250);
  }
  return null;
}

// Opens `target` ("/abs/file.js:42") with VS Code's Quick Open, as typing
// Cmd+P, the path and Enter would: VS Code in a browser takes no commands
// from the page that hosts it. Right after the workbench appears VS Code may
// not handle keys yet, so Cmd+P is repeated until Quick Open is up; if it
// never comes up, nothing is typed (it would land in an editor).
async function quickOpen(webContents, target) {
  const modifiers = [process.platform === 'darwin' ? 'meta' : 'control'];
  const isOpen = () =>
    webContents
      .executeJavaScript("!!document.querySelector('.quick-input-widget .quick-input-box input') && document.activeElement === document.querySelector('.quick-input-widget .quick-input-box input')")
      .catch(() => false);
  let open = false;
  for (let attempt = 0; attempt < 20 && !open && !webContents.isDestroyed(); attempt++) {
    webContents.focus();
    webContents.sendInputEvent({ type: 'keyDown', keyCode: 'p', modifiers });
    webContents.sendInputEvent({ type: 'keyUp', keyCode: 'p', modifiers });
    for (let i = 0; i < 10 && !(open = await isOpen()); i++) await sleep(50);
  }
  if (!open) return false;
  webContents.insertText(target);
  // Enter picks the first result, so wait until that is the file: before its
  // search finishes, Quick Open lists recently opened editors, and right
  // after loading VS Code may still be indexing the folder. If the file never
  // shows up, leave Quick Open open with the path rather than pick another.
  const name = path.basename(target.replace(/(:\d+){1,2}$/, ''));
  const found = () =>
    webContents
      .executeJavaScript(`(() => { const row = document.querySelector('.quick-input-widget .quick-input-list .monaco-list-row'); return !!row && row.textContent.includes(${JSON.stringify(name)}); })()`)
      .catch(() => false);
  let ready = false;
  for (let i = 0; i < 50 && !(ready = await found()); i++) await sleep(100);
  if (!ready) return false;
  webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  return true;
}

module.exports = { workbenchReady, quickOpen };
