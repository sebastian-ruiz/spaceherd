// VS Code in a browser has no Reveal in Finder (or File Explorer, or Open
// Containing Folder on Linux): the page can't reach the desktop. This asks
// spaceherd instead, with a spaceherd:// link that its window-open handler
// catches (src/main/vscode-views.js). spaceherd knows which machine the view
// belongs to and shows the file with the desktop's file manager.
//
// isMac, isWindows and isLinux in package.json describe the browser's OS,
// which is the desktop's, so each desktop gets its own menu label.

const vscode = require('vscode');

function reveal(uri) {
  uri = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
  if (!uri || uri.scheme !== 'file') return;
  const link = 'spaceherd://reveal?path=' + encodeURIComponent(uri.fsPath);
  // Parsed strictly, so the path stays encoded exactly once.
  vscode.env.openExternal(vscode.Uri.parse(link, true));
}

function activate(context) {
  for (const command of ['spaceherd.revealInFinder', 'spaceherd.revealInFileExplorer', 'spaceherd.openContainingFolder']) {
    context.subscriptions.push(vscode.commands.registerCommand(command, reveal));
  }
}

module.exports = { activate };
