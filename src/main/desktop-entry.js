// File → Create Desktop Entry (Linux): a ~/.local/share/applications entry
// for spaceherd. Desktops find a window's icon and name through an entry
// whose StartupWMClass is the window's class (X11) or whose file name is its
// app ID (Wayland), both "spaceherd" (desktopName in package.json). The deb
// installs one and AppImage integration tools copy the AppImage's, but a bare
// AppImage or `npm start` has none, and GNOME shows a generic icon.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, dialog, nativeImage } = require('electron');

const NAME = 'spaceherd';
const dataHome = () => process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
const dataDirs = () => [dataHome(), ...(process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':')];

// Whether an installed entry already matches spaceherd's windows.
function desktopEntryExists() {
  return dataDirs().some((dir) => {
    const apps = path.join(dir, 'applications');
    let files;
    try {
      files = fs.readdirSync(apps).filter((f) => f.endsWith('.desktop'));
    } catch {
      return false;
    }
    return files.some((f) => {
      if (f === `${NAME}.desktop`) return true;
      try {
        return /^StartupWMClass=spaceherd$/m.test(fs.readFileSync(path.join(apps, f), 'utf8'));
      } catch {
        return false;
      }
    });
  });
}

// How to start this copy of spaceherd: the AppImage, the packaged binary, or
// Electron with the source checkout.
function execLine() {
  const quote = (s) => `"${s.replace(/(["`$\\])/g, '\\$1')}"`;
  if (process.env.APPIMAGE) return `${quote(process.env.APPIMAGE)} --no-sandbox %U`;
  const args = [quote(process.execPath)];
  if (!app.isPackaged) args.push(quote(app.getAppPath()));
  if (app.commandLine.hasSwitch('no-sandbox')) args.push('--no-sandbox');
  return `${args.join(' ')} %U`;
}

function createDesktopEntry(win, icon) {
  try {
    // The icon is copied out: an AppImage's files go away when it exits.
    const iconFile = path.join(dataHome(), 'icons', 'hicolor', '512x512', 'apps', `${NAME}.png`);
    fs.mkdirSync(path.dirname(iconFile), { recursive: true });
    fs.writeFileSync(iconFile, nativeImage.createFromPath(icon).resize({ width: 512, height: 512, quality: 'best' }).toPNG());

    const entry = path.join(dataHome(), 'applications', `${NAME}.desktop`);
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(
      entry,
      [
        '[Desktop Entry]',
        'Type=Application',
        `Name=${app.name}`,
        'Comment=herdr on the left, VS Code on the right, switching together',
        `Exec=${execLine()}`,
        `Icon=${NAME}`,
        `StartupWMClass=${NAME}`,
        'Terminal=false',
        'Categories=Development;',
        '',
      ].join('\n'),
    );
    dialog.showMessageBox(win, {
      message: `Added ${app.name} to your applications.`,
      detail: `${entry}\n\nRestart ${app.name} for its icon to show in the dock.`,
    });
  } catch (err) {
    dialog.showErrorBox('Could not create the desktop entry', err.message);
  }
}

module.exports = { desktopEntryExists, createDesktopEntry };
