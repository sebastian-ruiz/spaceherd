# spaceherd

herdr on the left, VS Code on the right. Switching a space in herdr switches
VS Code to that space's folder, locally or on an SSH machine.

## Run

```sh
npm install
npm start
```

Earlier versions were called *code-manager*; on first start spaceherd moves
`~/.config/code-manager`, its saved VS Code state, and the folder of the same
name on SSH machines to their new names.

Requirements: [herdr](https://herdr.dev) and VS Code's `code` CLI on your
`PATH`, on every machine you use. The first start of `code serve-web` on a
machine downloads the VS Code server, which takes a minute or two.

The left pane attaches to your normal herdr session, the same one you get by
running `herdr` in any terminal. Closing the app detaches; agents keep running.

### Laptop and desktop

herdr's spaces live in the herdr server of the machine they run on. Work from
the laptop with the desktop added as an SSH machine, close the laptop, and run
spaceherd on the desktop: it attaches to the same herdr session and the same
VS Code server, so the same spaces, agents and files are there. VS Code's
open editors and layout are kept per client, so those don't follow you.
Running spaceherd on a machine needs Node.js there for `npm install`.

## How it works

- **Which space is active:** herdr writes `"{hostname}: {workspace}"` as the
  window title of the terminal it runs in. The app is that terminal. The
  hostname picks the machine; that machine's herdr socket gives the focused
  workspace. Keep herdr's `ui.window_title` at its default.
- **Which folder:** the working directory of the first pane in the space's
  first tab, pinned the first time the space is seen, so a `cd` doesn't move
  VS Code. *View → Pin VS Code Folder to Focused Pane* re-pins it.
  `folderOverrides` in the config wins over both.
- **VS Code:** one `code serve-web` per machine on a fixed port, and one
  Electron view per space. Views stay loaded while hidden, so switching back is
  instant. The `maxLiveViews` most recently used views are kept. The server
  and its token (`~/.config/spaceherd/vscode-token` on that machine) are
  shared by every spaceherd that uses the machine, locally or over SSH, and
  the server keeps running when the app quits. If another server with a
  different token holds the port, the VS Code pane says so.
- **Shortcuts:** VS Code's shortcuts work while herdr has focus, as from
  VS Code's own terminal: the keys VS Code's terminal hands to VS Code move
  focus to VS Code and act there. On macOS that is every `Cmd` key except
  `Cmd+C/V/X/Q/W/H/M`; on Linux a fixed list (`Ctrl+P`, `Ctrl+E`,
  `Ctrl+Shift+P`, `F1`, `Ctrl+J`, `Ctrl+Tab`, `Ctrl+PageUp/Down`, `Ctrl+1..8`,
  `Ctrl+Shift+B`, debug keys). Everything else, including `Ctrl+C`, `Ctrl+B`
  and `Ctrl+K`, goes to herdr. See `src/main/shortcuts.js`.
- **Alerts:** the app reads each machine's herdr snapshot every 1.5 s. When an
  agent becomes *blocked* or *done* it shows a notification; clicking it focuses
  that space. The dock badge counts blocked agents. If you set herdr's
  `ui.toast.delivery = "terminal"`, herdr's own notifications appear too.

## Configuration

`~/.config/spaceherd/config.json`, created on first start (*View → Open
Config File*):

```json
{
  "herdr": { "command": "herdr", "args": [] },
  "machines": [
    { "id": "local", "type": "local", "hostnames": ["my-mac.local"], "vscodePort": 47800 }
  ],
  "folderOverrides": { "desktop:my-space": "/home/me/src/my-project" },
  "maxLiveViews": 6,
  "vscodeUserSettings": { "window.menuBarVisibility": "classic" },
  "terminalWidth": 0.42,
  "terminal": { "fontFamily": "MesloLGS NF, Menlo, monospace", "fontSize": 13, "macOptionIsMeta": false }
}
```

Ports must stay fixed: VS Code keeps its state per origin, which includes the
port.

### VS Code settings

VS Code in a browser keeps its user settings in the page's storage, not in a
file. Two ways to set them without doing it by hand in every machine's view:

- `~/.vscode-server/data/Machine/settings.json` on each machine, read by its
  VS Code server for every client. A symlink to the desktop app's
  `settings.json` shares those settings. VS Code skips application-scoped
  settings in this file.
- `vscodeUserSettings` in the config, written into the user settings of every
  view when it loads. Use it for application-scoped settings, such as the
  menu bar (`"window.menuBarVisibility": "classic"`, the default here; VS Code
  in a browser otherwise shows a menu button). These values win over changes
  made in VS Code. The first time a machine's view gets them, it reloads once.

### SSH machines

Add the machine to herdr: `herdr machine add desktop`. That's all: the app
reads `herdr machine list` at start and every 15 s, and picks up new machines
with a stable local port each. The remote needs `code` (VS Code 1.86 or later)
on its `PATH`, and key-based SSH login (the app runs ssh with `BatchMode=yes`).

For each SSH machine the app keeps one `ssh` connection open. It forwards the
remote herdr socket (to `/tmp/spaceherd-<uid>/`) and the remote `serve-web`
port, and starts `serve-web` on the remote with `nohup`, so it survives
disconnects and is shared by all your clients. The remote owns the connection
token (`~/.config/spaceherd/vscode-token` there); clients read it over SSH.
The first start downloads the VS Code server on the remote.

herdr's title shows the remote's hostname when one of its spaces is selected;
the app learns that hostname over SSH. A machine entry in `machines` with the
same `id` as herdr's label overrides the imported one, e.g. to set
`codeCommand` or `remotePort`.

## Keys

| Key | Action |
|---|---|
| Ctrl+Cmd+← | Focus terminal |
| Ctrl+Cmd+→ | Focus VS Code |

Cmd+W, Cmd+Z and other editor keys go to VS Code; the app menu only takes
cut, copy and paste.

## Debugging

```sh
SPACEHERD_DEBUG=1 npm start     # timestamped title, event, click and switch logs
SPACEHERD_DIR=/tmp/sh npm start # separate config and state
```

Set `"herdr": { "args": ["--session", "test"] }` and the local machine's
`"herdrSocket": "~/.config/herdr/sessions/test/herdr.sock"` (absolute path) to
try it against a throwaway herdr session.
