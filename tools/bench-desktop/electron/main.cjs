// tools/bench-desktop/electron — the Electron shell of the desktop
// benchmark: one BrowserWindow over ../shared/editor.html, sized like the
// pocket note (420x560 logical), no dev tools, no extra features. The
// renderer's console lines (READY/STORM-DONE) forward to stdout for the
// runner.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");

const query = process.argv.find((a) => a.startsWith("--query="))?.slice(8) ?? "";

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 420,
    height: 560,
    title: "Bench Note",
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  win.webContents.on("console-message", (_e, _level, message) => {
    if (message.startsWith("READY") || message.startsWith("STORM-DONE")) {
      process.stdout.write(message + "\n");
    }
  });
  win.loadFile(path.join(__dirname, "../shared/editor.html"), {
    search: query,
  });
});

app.on("window-all-closed", () => app.quit());
