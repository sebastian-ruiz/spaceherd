#!/usr/bin/env bash
# A clean spaceherd for recording the README video: its own herdr (no saved
# SSH machines), its own VS Code server data (no extensions or settings), its
# own spaceherd config, and three made-up projects with scripted agents.
# Nothing in your real setup is read or changed.
#
#   scripts/demo/demo.sh start   # set up if needed, launch, fill the spaces
#   scripts/demo/demo.sh reset   # stop the demo and delete everything it made
#
# DEMO_DIR (default ~/spaceherd-demo) holds all of it. Its project paths show
# up in VS Code, so keep it short and neutral.

set -euo pipefail

DEMO_DIR="${DEMO_DIR:-$HOME/spaceherd-demo}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$REPO/scripts/demo"
PORT=47890

# herdr reads its config and saved machines from these.
export XDG_CONFIG_HOME="$DEMO_DIR/xdg/config"
export XDG_STATE_HOME="$DEMO_DIR/xdg/state"
export SPACEHERD_DIR="$DEMO_DIR/spaceherd"

PROJECTS=(weather-api pixel-garden notes-cli)

git_demo() {
  git -c user.name=Demo -c user.email=demo@example.com -c init.defaultBranch=main "$@"
}

setup() {
  [ -d "$DEMO_DIR/projects" ] && return
  echo "setting up $DEMO_DIR"
  mkdir -p "$DEMO_DIR"/{projects,bin,zsh,xdg/config/herdr,xdg/state,spaceherd}
  cp -R "$HERE/projects/." "$DEMO_DIR/projects/"
  for p in "${PROJECTS[@]}"; do
    (cd "$DEMO_DIR/projects/$p" && git_demo init -q && git_demo add -A && git_demo commit -qm "Initial commit")
  done

  # VS Code with its own server data: no extensions, no Machine settings.
  cat > "$DEMO_DIR/bin/code" <<SH
#!/bin/sh
exec code "\$@" --server-data-dir "$DEMO_DIR/vscode-server"
SH
  chmod +x "$DEMO_DIR/bin/code"

  # A short prompt and a separate history for the panes.
  cat > "$DEMO_DIR/zsh/.zshrc" <<SH
PROMPT='%F{blue}%1~%f %F{magenta}❯%f '
HISTFILE="$DEMO_DIR/zsh/history"
SH

  cat > "$XDG_CONFIG_HOME/herdr/config.toml" <<'TOML'
onboarding = false

[ui]
status_indicators = "symbols"

[ui.sound]
enabled = false
TOML

  cat > "$SPACEHERD_DIR/config.json" <<JSON
{
  "machines": [
    { "id": "local", "type": "local", "hostnames": ["$(hostname)"],
      "vscodePort": $PORT, "codeCommand": "$DEMO_DIR/bin/code" }
  ],
  "updates": "off",
  "vscodeUserSettings": {
    "workbench.colorTheme": "Default Dark Modern",
    "workbench.startupEditor": "none",
    "workbench.tips.enabled": false,
    "security.workspace.trust.enabled": false,
    "git.openRepositoryInParentFolders": "never"
  }
}
JSON
}

wait_for_herdr() {
  for _ in $(seq 100); do
    herdr workspace list >/dev/null 2>&1 && return
    sleep 0.2
  done
  echo "herdr didn't start" >&2
  exit 1
}

# Reads a field from herdr's JSON reply, e.g. `herdr ... | result root_pane.pane_id`.
result() {
  node -e 'let v = JSON.parse(require("fs").readFileSync(0)).result;
    for (const k of process.argv[1].split(".")) v = v[k];
    console.log(Array.isArray(v) ? v.join("\n") : v)' "$1"
}

workspace_ids() {
  herdr workspace list | node -e 'JSON.parse(require("fs").readFileSync(0))
    .result.workspaces.forEach((w) => console.log(w.workspace_id))'
}

fill_spaces() {
  local before first="" pane
  before="$(workspace_ids)"
  for p in "${PROJECTS[@]}"; do
    pane="$(herdr workspace create --no-focus --label "$p" --cwd "$DEMO_DIR/projects/$p" \
      --env "ZDOTDIR=$DEMO_DIR/zsh" | result root_pane.pane_id)"
    first="${first:-${pane%%:*}}"
    sleep 0.5
    herdr pane run "$pane" "$HERE/agent.sh $p" >/dev/null
  done
  # The workspace herdr opened on its own, in spaceherd's directory.
  for ws in $before; do herdr workspace close "$ws" >/dev/null; done
  herdr workspace focus "$first" >/dev/null
}

start() {
  setup
  if herdr workspace list >/dev/null 2>&1; then
    echo "the demo is already running" >&2
    exit 1
  fi
  # The Electron binary itself, not the npm wrapper, so the pid is the app's.
  local electron
  electron="$(cd "$REPO" && node -p 'require("electron")')"
  (cd "$DEMO_DIR" || exit; "$electron" "$REPO" >"$DEMO_DIR/spaceherd.log" 2>&1 &
    echo $! >"$DEMO_DIR/spaceherd.pid")
  wait_for_herdr
  fill_spaces
  echo "running. Log: $DEMO_DIR/spaceherd.log"
}

reset() {
  [ -f "$DEMO_DIR/spaceherd.pid" ] && kill "$(cat "$DEMO_DIR/spaceherd.pid")" 2>/dev/null || true
  herdr server stop >/dev/null 2>&1 || true
  # The demo's VS Code server: the CLI on its port and the server it started.
  pkill -f -- "serve-web .*--port $PORT" || true
  pkill -f -- "--server-data-dir $DEMO_DIR/vscode-server" || true
  sleep 1
  rm -rf "$DEMO_DIR"
  echo "removed $DEMO_DIR"
}

case "${1:-}" in
  start) start ;;
  reset) reset ;;
  *) echo "usage: $0 start|reset" >&2; exit 2 ;;
esac
