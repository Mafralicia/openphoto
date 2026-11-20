import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { autoUpdater } from 'electron-updater';

// Desktop entry: runs the existing local engine in-process on a private random port
// and shows the UI in a native window. Nothing is exposed beyond 127.0.0.1.

if (!app.requestSingleInstanceLock()) app.quit();

let win: BrowserWindow | null = null;

function toIds(raw: unknown): number[] {
  return (Array.isArray(raw) ? raw : [raw]).map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

async function start(): Promise<void> {
  const appRoot = app.getAppPath();
  process.env.PORT = '0';
  process.env.OPENPHOTO_DATA_DIR = path.join(app.getPath('userData'), 'library');
  process.env.OPENPHOTO_UI_DIR = path.join(appRoot, 'dist');
  const demo = path.join(appRoot, 'sample-photos');
  if (fs.existsSync(demo)) process.env.OPENPHOTO_DEMO_DIR = demo;

  // Env must be set before the engine modules evaluate
  const { ready } = await import('../server/index.ts');
  const { getMediaById, deleteMediaByPath } = await import('../server/db.ts');
  const port = await ready;
  const origin = `http://127.0.0.1:${port}`;

  ipcMain.handle('pick-folder', async () => {
    const res = await dialog.showOpenDialog(win!, { properties: ['openDirectory'], title: 'Add folder' });
    return res.canceled ? null : (res.filePaths[0] ?? null);
  });

  ipcMain.handle('media:reveal', (_e, id: unknown) => {
    const media = getMediaById(toIds(id)[0] ?? 0);
    if (media) shell.showItemInFolder(media.path);
  });

  ipcMain.handle('media:open', async (_e, id: unknown) => {
    const media = getMediaById(toIds(id)[0] ?? 0);
    if (media) await shell.openPath(media.path);
  });

  ipcMain.handle('media:trash', async (_e, ids: unknown) => {
    let moved = 0;
    for (const id of toIds(ids)) {
      const media = getMediaById(id);
      if (!media) continue;
      try {
        await shell.trashItem(media.path); // Recycle Bin, recoverable
        deleteMediaByPath(media.path, media.folder_id);
        moved++;
      } catch {
        continue; // file locked or already gone; leave the row for the next scan to reconcile
      }
      // A Live Photo is one item to the user: its motion clip goes with it
      const clip = media.live_video_id ? getMediaById(media.live_video_id) : null;
      if (clip) {
        await shell.trashItem(clip.path).then(
          () => deleteMediaByPath(clip.path, clip.folder_id),
          () => {},
        );
      }
    }
    return moved;
  });

  ipcMain.handle('update:install', () => autoUpdater.quitAndInstall());

  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 880,
    minHeight: 560,
    backgroundColor: '#ffffff',
    title: 'OpenPhoto',
    icon: path.join(appRoot, 'dist', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#ffffff', symbolColor: '#1c1c1c', height: 52 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  win.setMenuBarVisibility(false);
  win.once('ready-to-show', () => win?.show());

  // Links (map attribution etc.) open in the real browser; the window never navigates away
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(origin)) e.preventDefault();
  });

  await win.loadURL(process.env.OPENPHOTO_DEV_URL || origin);
  startAutoUpdate();
}

/**
 * Checks GitHub Releases (configured under "build.publish" in package.json) at launch and every 6h,
 * downloads in the background and tells the UI when a restart will apply it. Only in the installed app.
 */
function startAutoUpdate(): void {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // applied on next quit even if the user ignores the banner
  autoUpdater.on('update-downloaded', (info) => win?.webContents.send('update:ready', info.version));
  autoUpdater.on('error', (err) => console.warn('[OpenPhoto] update check failed:', err.message));
  const check = () => void autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 6 * 60 * 60 * 1000).unref();
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on('window-all-closed', () => app.quit());

app.whenReady().then(start).catch((err) => {
  dialog.showErrorBox('OpenPhoto failed to start', err instanceof Error ? err.stack ?? err.message : String(err));
  app.quit();
});
