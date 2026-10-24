# Developing spaceherd

## Run from source

```sh
npm install
npm start
```

Needs Node.js, plus herdr and VS Code's `code` CLI as for the app (see
[README.md](README.md#requirements)).

## Debugging

```sh
SPACEHERD_DEBUG=1 npm start     # timestamped title, event, click and switch logs
SPACEHERD_DIR=/tmp/sh npm start # separate config and state
```

Set `"herdr": { "args": ["--session", "test"] }` and the local machine's
`"herdrSocket": "~/.config/herdr/sessions/test/herdr.sock"` (absolute path) to
try it against a throwaway herdr session.

## Releasing

Releases need the update signing key as the `UPDATE_SIGNING_KEY` Actions
secret (*Settings → Secrets and variables → Actions*): the Ed25519 private key
whose public half is in `src/main/update-signature.js`. Keep a backup of it:
installed apps only accept updates signed with that key. A new key means
everyone reinstalls once by hand.

Set the version in `package.json` (`npm version 0.2.0 --no-git-tag-version`),
commit, then tag and push:

```sh
git tag v0.2.0 && git push && git push origin v0.2.0
```

The *Release* workflow builds macOS (arm64, x64) and Linux (x64, arm64) and
publishes a GitHub Release with the files, including a `.sig` signature for
each update file. Run it by hand from the Actions tab to only build; the files
are kept as workflow artifacts. `npm run dist` builds for the current system
into `dist/`.

## App icon

The app icon is `build/icon.svg`. After changing it, `npm run icon` renders
`build/icon.png`, which the builds use.

## Demo video

`scripts/demo/demo.sh start` opens spaceherd with made-up projects and
scripted agents, using its own herdr, VS Code server data and config in
`~/spaceherd-demo`, so nothing from your own setup shows. `demo.sh reset`
stops it and deletes that folder.

On macOS, `scripts/demo/record.sh` does the rest: it clicks through the demo,
records the window and writes an MP4 (see the script for what it needs).
Videos aren't kept in the repo: drag the MP4 into README.md while editing it
on github.com, and GitHub hosts it.
