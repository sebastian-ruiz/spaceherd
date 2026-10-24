// Renders build/icon.svg to build/icon.png (1024 x 1024, transparent outside
// the rounded tile). electron-builder makes the macOS .icns and the Linux
// icons from the PNG. Run with Electron: `npm run icon`.

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SIZE = 1024;
const dir = path.join(__dirname, '..', 'build');
const svgPath = path.join(dir, process.argv[2] || 'icon.svg');
const pngPath = path.join(dir, process.argv[3] || 'icon.png');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true },
  });
  const svg = fs.readFileSync(svgPath).toString('base64');
  const html = `<body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,${svg}" width="${SIZE}" height="${SIZE}"></body>`;
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
  // Let the image decode and paint.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  fs.writeFileSync(pngPath, image.resize({ width: SIZE, height: SIZE, quality: 'best' }).toPNG());
  console.log(`wrote ${path.relative(process.cwd(), pngPath)}`);
  app.quit();
});
