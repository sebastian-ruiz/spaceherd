// Spaceherd → Install `code` Command in herdr Panes: a marked block in the
// shell rc files on every machine that makes `code` in a herdr pane run
// `spaceherd open` (src/main/spaceherd-cli.sh). Panes are started by herdr's
// server, not by spaceherd, so their shell is the only place to do this.

const { dialog } = require('electron');

const BEGIN = '# >>> spaceherd: `code` in herdr panes opens files in spaceherd >>>';
const END = '# <<< spaceherd <<<';
const FUNCTION =
  'code() { if [ -n "$HERDR_PANE_ID" ] && [ -x ~/.config/spaceherd/bin/spaceherd ]; then ' +
  '~/.config/spaceherd/bin/spaceherd open "$@"; else command code "$@"; fi; }';

// $1 is install or uninstall. Changes ~/.zshrc and ~/.bashrc where they exist
// (on install with neither, the one for $SHELL), and prints one line per file.
// Files are rewritten in place, so symlinked dotfiles stay symlinks.
const SCRIPT = `
set -e
begin='${BEGIN}'
end='${END}'
found=
for f in "$HOME/.zshrc" "$HOME/.bashrc"; do
  [ -f "$f" ] || continue
  found=1
  if [ "$1" = install ]; then
    if grep -qF "$begin" "$f"; then echo "already in $f"; continue; fi
    [ -z "$(tail -c1 "$f")" ] || echo >> "$f"
    printf '%s\\n%s\\n%s\\n' "$begin" '${FUNCTION}' "$end" >> "$f"
    echo "added to $f"
  else
    grep -qF "$begin" "$f" || continue
    tmp="$f.spaceherd-tmp"
    awk -v b="$begin" -v e="$end" '$0 == b { skip = 1; next } $0 == e { skip = 0; next } !skip' "$f" > "$tmp"
    cat "$tmp" > "$f"
    rm -f "$tmp"
    echo "removed from $f"
  fi
done
if [ -z "$found" ] && [ "$1" = install ]; then
  case "\${SHELL:-}" in *zsh) f="$HOME/.zshrc" ;; *) f="$HOME/.bashrc" ;; esac
  printf '%s\\n%s\\n%s\\n' "$begin" '${FUNCTION}' "$end" >> "$f"
  echo "added to $f (new file)"
fi
`;

async function run(machines, action) {
  const lines = await Promise.all(
    machines.map((m) =>
      m.run(SCRIPT, [action]).then(
        (out) => out.trim().split('\n').filter(Boolean).map((l) => `${m.id}: ${l}`).join('\n') || `${m.id}: nothing to change`,
        (err) => `${m.id}: failed (${err.message.split('\n')[0]})`,
      ),
    ),
  );
  return lines.join('\n');
}

async function installCodeCommand(win, machines) {
  const names = machines.map((m) => m.id).join(', ');
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Install', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: 'Make `code` in herdr panes open files in spaceherd?',
    detail:
      `Adds a marked \`code\` function to ~/.zshrc and ~/.bashrc on: ${names}.\n\n` +
      'In a herdr pane, `code file.ts` then opens the file in that space’s VS Code; ' +
      'elsewhere `code` works as before. Uninstall removes the block again.',
  });
  if (response !== 0) return;
  const result = await run(machines, 'install');
  await dialog.showMessageBox(win, {
    message: 'Installed the `code` command',
    detail: `${result}\n\nNew shells have it. In shells that are already open, run: source ~/.zshrc (or ~/.bashrc).`,
  });
}

async function uninstallCodeCommand(win, machines) {
  const result = await run(machines, 'uninstall');
  await dialog.showMessageBox(win, {
    message: 'Uninstalled the `code` command',
    detail: `${result}\n\nShells that are already open keep it until they're restarted.`,
  });
}

module.exports = { installCodeCommand, uninstallCodeCommand, SCRIPT };
