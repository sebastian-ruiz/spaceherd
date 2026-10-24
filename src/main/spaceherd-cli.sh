#!/bin/sh
# spaceherd: opens files in spaceherd's VS Code for the herdr space this
# terminal is in, like `code` does in VS Code's own terminal. spaceherd
# installs it as ~/.config/spaceherd/bin/spaceherd on every machine it uses.
#
#   spaceherd open FILE[:LINE[:COLUMN]]...   open files
#   spaceherd open DIR                       point the space's VS Code at DIR
#
# It asks through herdr: the request is a short-lived token on this pane,
# which spaceherd sees, acts on and clears. When nothing clears it (spaceherd
# isn't running), or outside herdr, or with options, it runs `code` instead.
# To have `code` itself do this in herdr, add to your shell's rc file:
#
#   code() { if [ -n "$HERDR_PANE_ID" ]; then ~/.config/spaceherd/bin/spaceherd open "$@"; else command code "$@"; fi; }

set -u
herdr="${HERDR_BIN_PATH:-herdr}"
source=spaceherd.open

fallback() {
  exec code "$@"
}

# The same files with `code` itself; -g makes it go to FILE:LINE:COLUMN.
fallback_open() {
  for a in "$@"; do
    [ -d "$a" ] && fallback "$@"
  done
  fallback -g "$@"
}

# Sends one request ("f:/abs/path:12" or "d:/abs/dir") and waits up to about
# 1.5 s for spaceherd to clear it. Fails when nobody did.
count=0
request() {
  count=$((count + 1))
  id="$$-$(date +%s)-$count"
  # base64 survives herdr's token normalization; tokens hold 80 characters.
  data="$(printf '%s' "$1" | base64 | tr -d '\n')"
  set -- --token "spaceherd_id=$id"
  i=0
  while [ -n "$data" ]; do
    [ "$i" -ge 14 ] && return 1
    chunk="$(printf '%s' "$data" | cut -c1-80)"
    data="$(printf '%s' "$data" | cut -c81-)"
    set -- "$@" --token "spaceherd_$i=$chunk"
    i=$((i + 1))
  done
  "$herdr" pane report-metadata "$HERDR_PANE_ID" --source "$source" --ttl-ms 10000 "$@" >/dev/null 2>&1 || return 1
  n=0
  while [ "$n" -lt 15 ]; do
    sleep 0.1
    "$herdr" pane get "$HERDR_PANE_ID" 2>/dev/null | grep -q "\"spaceherd_id\":\"$id\"" || return 0
    n=$((n + 1))
  done
  # Nobody answered: take the request back.
  clear=""
  j=0
  while [ "$j" -lt "$i" ]; do
    clear="$clear --clear-token spaceherd_$j"
    j=$((j + 1))
  done
  # shellcheck disable=SC2086
  "$herdr" pane report-metadata "$HERDR_PANE_ID" --source "$source" --clear-token spaceherd_id $clear >/dev/null 2>&1
  return 1
}

[ "${1:-}" = open ] || { echo "usage: spaceherd open FILE[:LINE[:COLUMN]]... | DIR" >&2; exit 2; }
shift
[ "$#" -gt 0 ] || fallback
[ -n "${HERDR_PANE_ID:-}" ] || fallback "$@"
for arg in "$@"; do
  case "$arg" in -*) fallback "$@" ;; esac
done

for arg in "$@"; do
  case "$arg" in /*) abs="$arg" ;; *) abs="$PWD/$arg" ;; esac
  # A directory, or a file with an optional :line:column after it.
  if [ -d "$abs" ]; then
    kind=d
    abs="$(cd "$abs" && pwd)"
  else
    kind=f
  fi
  request "$kind:$abs" || fallback_open "$@"
done
