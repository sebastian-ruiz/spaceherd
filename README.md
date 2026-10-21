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
  instant. The `maxLiveViews` most recently used views are kept.
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
  "terminalWidth": 0.42,
  "terminal": { "fontFamily": "MesloLGS NF, Menlo, monospace", "fontSize": 13, "macOptionIsMeta": false }
}
```

Ports must stay fixed: VS Code keeps its state per origin, which includes the
port.

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
