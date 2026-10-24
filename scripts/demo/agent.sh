#!/usr/bin/env bash
# Scripted agent output for the demo video (see demo.sh). It types a short
# session and tells herdr it's working, then done, so the sidebar shows it.

project="$1"
B=$'\e[1m' D=$'\e[2m' G=$'\e[32m' C=$'\e[36m' R=$'\e[0m'

state() {
  herdr pane report-agent --source spaceherd-demo --agent claude --state "$1" "$HERDR_PANE_ID" >/dev/null 2>&1
}
say() { printf '%s\n' "$1"; sleep "${2:-0.6}"; }

clear
state working
case "$project" in
  weather-api)
    say "${B}> Cache forecasts so repeated requests don't hit the API${R}" 1
    say "${C}●${R} Read ${B}src/forecast.ts${R}"
    say "${C}●${R} Read ${B}src/cache.ts${R}"
    say "${C}●${R} Update ${B}src/forecast.ts:17${R}"
    say "${G}    + const cached = cache.get(key);${R}" 0.2
    say "${G}    + if (cached) return cached;${R}"
    say "${C}●${R} Run npm test"
    say "${D}    ✓ 12 passed${R}" 1
    say ""
    say "Forecasts are now cached for 10 minutes, see src/forecast.ts:17." 0
    state idle
    ;;
  pixel-garden)
    say "${B}> Make the plants grow faster when it rains${R}" 1
    say "${C}●${R} Read ${B}garden/weather.py${R}"
    say "${C}●${R} Read ${B}garden/plant.py${R}"
    say "${C}●${R} Update ${B}garden/plant.py:26${R}"
    say "${G}    + rate *= 1.5 if weather.raining else 1.0${R}" 1.5
    say "${C}●${R} Run pytest"
    # Keeps working while the video is recorded.
    while :; do sleep 60; done
    ;;
  notes-cli)
    say "${B}> Add a --tag filter to the list command${R}" 1
    say "${C}●${R} Read ${B}src/main.rs${R}"
    say "${C}●${R} Update ${B}src/main.rs:29${R}"
    say "${G}    + if let Some(tag) = &args.tag { notes.retain(|n| n.tags.contains(tag)); }${R}"
    say "${C}●${R} Run cargo test"
    say "${D}    test result: ok. 8 passed${R}" 1
    say ""
    say "Done: ${B}notes list --tag work${R} now shows only notes tagged work." 0
    state idle
    ;;
esac
