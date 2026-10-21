# spaceherd — plan

A desktop app that shows herdr on the left and VS Code on the right. Switching
a space in herdr switches the VS Code view to that space's folder, on whichever
machine the space lives (local or SSH).

## Architecture

```
┌──────────────────────── Electron BrowserWindow ─────────────────────────┐
│ ┌──────── terminal view (renderer) ────────┐ ┌── VS Code views ───────┐ │
│ │ xterm.js  ◄── IPC ──►  node-pty: `herdr` │ │ WebContentsView per    │ │
│ │ (herdr TUI: sidebar, tabs, agents, SSH)  │ │ (machine, workspace),  │ │
│ │  • OSC 0/2 title → active space          │ │ LRU-capped, only the   │ │
│ │  • OSC 9/777 → desktop notification      │ │ active one visible     │ │
│ └──────────────────────────────────────────┘ └────────────────────────┘ │
└──────────────┬────────────────────────────────────────────┬─────────────┘
               │ herdr socket (NDJSON), per machine         │ http://127.0.0.1:<port>/?folder=…
               ▼                                            ▼
   local: ~/.config/herdr/herdr.sock          local: `code serve-web` child process
   ssh:   unix socket forwarded with ssh -L   ssh:   `code serve-web` on the remote,
                                                     port forwarded with ssh -L
```

### How the app knows which space is active

1. **Primary: the window title herdr writes to its terminal.** herdr's
   `ui.window_title` (default `"{hostname}: {workspace}"`) is written as an OSC
   title to the terminal it runs in. Our terminal is that terminal, so
   `xterm.onTitleChange` tells us the active host and workspace label. This
   covers saved SSH machines too, because only the TUI knows which machine is
   selected. The local socket does not expose that.
2. **Resolution: the herdr socket of that machine.** `session.snapshot` gives
   workspaces and panes. A workspace has no folder of its own, so the folder is
   the `cwd` of the first pane of its first tab, unless the user configures an
   override.
3. **Fallback: `workspace.focused` events** from `events.subscribe` on each
   machine's socket, used if the title is missing or ambiguous.

### Attention alerts

- herdr can send desktop notifications through its terminal
  (`ui.toast.delivery = "terminal"`, OSC 9 / OSC 777). xterm.js gets these via
  `parser.registerOscHandler`, and the app shows a native `Notification`. Herdr
  sends these for every connected machine, not only the selected one.
- `pane.agent_status_changed` subscriptions on each machine's socket drive the
  dock badge, which counts blocked agents.

### VS Code

- One `code serve-web` per machine, bound to `127.0.0.1` with a random
  connection token, on a free port. One server serves any folder via
  `?folder=<path>`.
- One `WebContentsView` per space, with a persistent partition per machine
  (`persist:vscode-<machine>`), so VS Code's IndexedDB state, the token
  cookie and service workers survive restarts.
- Views stay alive while hidden, so switching back is instant. At most
  `maxLiveViews` (default 6) are kept. The least recently used one is destroyed.

### SSH machines

The app keeps one `ssh` process per configured machine. That process forwards:
- the remote herdr socket to a local unix socket (`-L local.sock:remote.sock`)
- a local TCP port to the remote `serve-web` port

and runs `code serve-web` on the remote. herdr's own saved machines
(`herdr machine add`) handle the terminal side. The app config maps the
hostname shown in herdr's title to the machine.

## Decisions checked against docs and live tools

| Decision | Evidence |
|---|---|
| Electron 44.x, not 45 | 45.0.0 was released today (2026-10-21). 44.9.3 is the latest stable of the previous major. |
| `WebContentsView`, not `BrowserView` / `<webview>` / iframe | BrowserView is deprecated since Electron 30. Iframes break VS Code service workers and webviews. |
| node-pty 1.1.0 + `@electron/rebuild` | Native module, must match Electron's ABI. Xcode CLT is installed. |
| `@xterm/xterm` 6 + webgl + fit addons | Same terminal engine as VS Code's integrated terminal. |
| `code serve-web` flags | Verified with `code serve-web --help` on this Mac (VS Code 1.132). |
| herdr socket protocol | NDJSON `{"id","method","params"}`. `events.subscribe` with `params.subscriptions`. On `events_lost`, resubscribe and reconcile with `session.snapshot`. |
| Active space from the window title | `ui.window_title` tokens `{hostname}`, `{workspace}`. To be verified empirically. |

## Files

```
package.json
src/main/main.js           app lifecycle, window, layout, shortcuts
src/main/config.js         ~/.config/spaceherd/config.json
src/main/pty.js            node-pty running herdr
src/main/herdr-client.js   NDJSON socket client: request, subscribe, reconnect
src/main/machines.js       per machine: herdr socket + serve-web (local or ssh)
src/main/vscode-views.js   WebContentsView pool (LRU), show/hide, bounds
src/main/spaces.js         title → machine + workspace → folder
src/main/attention.js      notifications + dock badge
src/preload/terminal.js    IPC bridge for the terminal renderer
src/renderer/terminal.html|js|css  xterm.js
```

## Milestones

1. **Local switching.** Window, herdr in xterm, local serve-web, title-driven
   switching between spaces. Switch timing logged.
2. **Attention.** OSC notifications, dock badge from agent status.
3. **SSH machines.** ssh forwarding, remote serve-web, hostname mapping.
4. **Polish.** Draggable divider, focus shortcuts, folder overrides, LRU tuning.

## Status (2026-10-21)

Milestones 1, 2 and the divider from 4 are built and tested against a
throwaway herdr session. Milestone 3 (SSH) is written; the remote script was
tested locally, the ssh forwarding itself is untested.

### What testing changed

- **No config overlay.** `ui.window_title` and `ui.toast.delivery` are read by
  the herdr *server*, so a client started with `HERDR_CONFIG_PATH` can't change
  them. The app parses the default title format instead and leaves the user's
  herdr config alone.
- **Own alerts.** herdr pushes no event when an agent's status changes
  (`pane.agent_status_changed` needs a pane id per subscription). The app polls
  `session.snapshot` every 1.5 s (~7 ms per call) and alerts on transitions to
  `blocked` and `done`.
- **Title first.** The title arrives 5–25 ms before the `workspace_focused`
  event. When its label is unique, the app switches on it.
- **Fixed ports.** VS Code web keeps state per origin, so serve-web ports are
  fixed per machine instead of random.
- **node-pty 1.1.0** ships `spawn-helper` without the executable bit; a
  `postinstall` script fixes it.
- **serve-web runs in its own process group**, because `code` starts a chain of
  four processes.

### Measured

| | |
|---|---|
| Switch to a loaded view, after herdr acknowledges the focus change | 2–5 ms |
| View swap itself | 0.1–0.4 ms |
| herdr handling an API `workspace.focus` request | ~105 ms |
| First view of a space (local) | ~1 s, plus the one-time server download |

## Risks and open questions

- Does `{hostname}` in herdr's title change when a remote machine is selected?
  If not, fall back to `workspace.focused` events from each machine.
- Workspace labels may repeat across workspaces. Prefer the focused workspace
  from the machine's snapshot when the label is ambiguous.
- Keyboard ownership: shortcuts the app takes must not collide with herdr or
  VS Code. Start with Ctrl+Cmd+←/→ to move focus between panes.
- Remote `code serve-web` needs the `code` CLI on the remote machine (Linux or
  macOS). Windows remotes are out of scope.
