const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  Tray,
  Menu,
  nativeImage,
  screen,
  desktopCapturer,
  session,
  dialog,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const SIZE_MIN = 220;
const SIZE_MAX = 720;
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');

let mainWindow = null;
let tray = null;
let alwaysOnTop = true;
let isQuitting = false;
let currentSize = SIZE_MIN;

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch {
    /* ignore */
  }
  return {};
}

function saveConfig(partial) {
  const next = { ...loadConfig(), ...partial };
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
  } catch {
    /* ignore */
  }
  return next;
}

function sizeFromTrashBytes(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  const maxBytes = 10 * 1024 * 1024 * 1024; // 10GB → max
  const t = Math.min(1, Math.log10(n + 1) / Math.log10(maxBytes + 1));
  return Math.round(SIZE_MIN + (SIZE_MAX - SIZE_MIN) * t);
}

function defaultBounds(size = SIZE_MIN) {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workArea;
  const x = Math.round(display.workArea.x + width - size - 48);
  const y = Math.round(display.workArea.y + height - size - 48);
  return { x, y, width: size, height: size };
}

function setWindowSizeCentered(size) {
  if (!mainWindow) return;
  const ns = Math.max(SIZE_MIN, Math.min(SIZE_MAX, Math.round(size)));
  const b = mainWindow.getBounds();
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  currentSize = ns;
  mainWindow.setBounds({
    x: Math.round(cx - ns / 2),
    y: Math.round(cy - ns / 2),
    width: ns,
    height: ns,
  });
  saveConfig({
    bounds: {
      x: Math.round(cx - ns / 2),
      y: Math.round(cy - ns / 2),
      width: ns,
      height: ns,
    },
  });
}

async function queryTrashBytes() {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$sum = [int64]0
$shell = New-Object -ComObject Shell.Application
$bin = $shell.NameSpace(0x0a)
if ($bin) {
  foreach ($item in $bin.Items()) {
    try { $sum += [int64]$item.Size } catch {}
  }
}
Write-Output $sum
`.trim();
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 15000 }
    );
    const n = parseInt(String(stdout).trim().split(/\r?\n/).pop(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

async function emptyTrash() {
  const script = `
$ErrorActionPreference = 'Stop'
Clear-RecycleBin -Force -ErrorAction SilentlyContinue
# Fallback COM clear if needed
$shell = New-Object -ComObject Shell.Application
$bin = $shell.NameSpace(0x0a)
if ($bin) {
  $items = @($bin.Items())
  foreach ($item in $items) {
    try { $bin.InvokeVerb('delete') } catch {}
  }
}
`.trim();
  // Clear-RecycleBin is enough on modern Windows
  try {
    await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Clear-RecycleBin -Force -ErrorAction SilentlyContinue'],
      { windowsHide: true, timeout: 60000 }
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

function createWindow() {
  const config = loadConfig();
  const saved = config.bounds || {};
  currentSize = typeof saved.width === 'number' ? saved.width : SIZE_MIN;
  currentSize = Math.max(SIZE_MIN, Math.min(SIZE_MAX, currentSize));
  const fallback = defaultBounds(currentSize);
  const x = typeof saved.x === 'number' ? saved.x : fallback.x;
  const y = typeof saved.y === 'number' ? saved.y : fallback.y;

  mainWindow = new BrowserWindow({
    width: currentSize,
    height: currentSize,
    x,
    y,
    title: '',
    frame: false,
    transparent: true,
    alwaysOnTop,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.setAlwaysOnTop(alwaysOnTop, 'screen-saver');
  mainWindow.setTitle('');
  try {
    mainWindow.setContentProtection(true);
  } catch {
    /* older electron */
  }

  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  mainWindow.webContents.on('page-title-updated', (e) => {
    e.preventDefault();
    mainWindow.setTitle('');
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('moved', () => {
    if (!mainWindow) return;
    const b = mainWindow.getBounds();
    saveConfig({ bounds: b });
  });

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      updateTrayMenu();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function setupDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 0, height: 0 },
      });
      if (!sources.length) {
        callback({});
        return;
      }
      let chosen = sources[0];
      if (mainWindow) {
        const b = mainWindow.getBounds();
        const display = screen.getDisplayMatching(b);
        const match = sources.find(
          (s) =>
            s.display_id &&
            String(s.display_id) === String(display.id)
        );
        if (match) chosen = match;
      }
      callback({ video: chosen, audio: false });
    } catch {
      callback({});
    }
  });
}

function loadTrayImage() {
  const iconPath = path.join(__dirname, '..', 'assets', 'tray.png');
  if (fs.existsSync(iconPath)) {
    const image = nativeImage.createFromPath(iconPath);
    if (!image.isEmpty()) return image.resize({ width: 16, height: 16 });
  }
  const fallback = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAjUlEQVQ4T2NkYGD4z0ABYBzVMKoBBg0wGgAAAf8AAf8AAf8AAf8AAf8AAf8AAf8AAf8AAf8AAf8AAf8AAf8AAf8AAf8AAf8AAf8AAf8A',
    'base64'
  );
  try {
    return nativeImage.createFromBuffer(fallback).resize({ width: 16, height: 16 });
  } catch {
    return nativeImage.createEmpty();
  }
}

function createTray() {
  const image = loadTrayImage();
  tray = new Tray(image);
  tray.setToolTip('');
  updateTrayMenu();
  tray.on('double-click', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) mainWindow.hide();
    else {
      mainWindow.show();
      mainWindow.focus();
    }
    updateTrayMenu();
  });
}

function updateTrayMenu() {
  if (!tray) return;
  const visible = mainWindow?.isVisible();
  const menu = Menu.buildFromTemplate([
    {
      label: visible ? '隐藏黑洞' : '显示黑洞',
      click: () => {
        if (!mainWindow) return;
        if (mainWindow.isVisible()) mainWindow.hide();
        else {
          mainWindow.show();
          mainWindow.focus();
        }
        updateTrayMenu();
      },
    },
    {
      label: alwaysOnTop ? '取消置顶' : '保持置顶',
      click: () => {
        alwaysOnTop = !alwaysOnTop;
        if (mainWindow) mainWindow.setAlwaysOnTop(alwaysOnTop, 'screen-saver');
        saveConfig({ alwaysOnTop });
        updateTrayMenu();
      },
    },
    {
      label: '清空回收站',
      click: async () => {
        const result = await emptyTrash();
        if (mainWindow) {
          mainWindow.webContents.send('trash-emptied', result);
        }
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

ipcMain.handle('trash-paths', async (_event, paths) => {
  if (!Array.isArray(paths)) return [];
  const results = [];
  for (const p of paths) {
    if (typeof p !== 'string' || !p.trim()) {
      results.push({ path: p, ok: false, error: '无效路径' });
      continue;
    }
    try {
      if (!fs.existsSync(p)) {
        results.push({ path: p, ok: false, error: '文件不存在' });
        continue;
      }
      await shell.trashItem(p);
      results.push({ path: p, ok: true });
    } catch (err) {
      results.push({
        path: p,
        ok: false,
        error: err?.message || String(err),
      });
    }
  }
  return results;
});

ipcMain.handle('get-trash-size', async () => {
  const bytes = await queryTrashBytes();
  const size = sizeFromTrashBytes(bytes);
  return { bytes, windowSize: size };
});

ipcMain.handle('empty-trash', async () => {
  if (!mainWindow) return { ok: false, error: '窗口未就绪' };
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['清空', '取消'],
    defaultId: 1,
    cancelId: 1,
    title: '',
    message: '清空回收站？',
    detail: '将永久删除回收站中的所有项目，黑洞会回到初始大小。',
  });
  if (response !== 0) return { ok: false, cancelled: true };
  const result = await emptyTrash();
  if (result.ok) {
    setWindowSizeCentered(SIZE_MIN);
  }
  return result;
});

ipcMain.handle('apply-window-size', (_event, size) => {
  setWindowSizeCentered(size);
  return { size: currentSize };
});

ipcMain.handle('get-window-metrics', () => {
  if (!mainWindow) return null;
  const b = mainWindow.getBounds();
  const display = screen.getDisplayMatching(b);
  const scale = display.scaleFactor || 1;
  return {
    bounds: b,
    size: currentSize,
    displayBounds: display.bounds,
    workArea: display.workArea,
    scaleFactor: scale,
  };
});

ipcMain.handle('set-ignore-mouse', (_event, ignore) => {
  if (!mainWindow) return;
  if (ignore) {
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
  } else {
    mainWindow.setIgnoreMouseEvents(false);
  }
});

ipcMain.handle('set-position', (_event, x, y) => {
  if (!mainWindow) return;
  mainWindow.setPosition(Math.round(x), Math.round(y));
});

ipcMain.handle('get-cursor-point', () => screen.getCursorScreenPoint());

ipcMain.handle('show-context-menu', () => {
  if (!mainWindow) return;
  const menu = Menu.buildFromTemplate([
    {
      label: alwaysOnTop ? '取消置顶' : '保持置顶',
      click: () => {
        alwaysOnTop = !alwaysOnTop;
        mainWindow.setAlwaysOnTop(alwaysOnTop, 'screen-saver');
        saveConfig({ alwaysOnTop });
        updateTrayMenu();
      },
    },
    {
      label: '清空回收站',
      click: async () => {
        const { response } = await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          buttons: ['清空', '取消'],
          defaultId: 1,
          cancelId: 1,
          message: '清空回收站？',
          detail: '将永久删除回收站中的所有项目。',
        });
        if (response === 0) {
          const result = await emptyTrash();
          if (result.ok) setWindowSizeCentered(SIZE_MIN);
          mainWindow.webContents.send('trash-emptied', result);
        }
      },
    },
    {
      label: '隐藏',
      click: () => {
        mainWindow.hide();
        updateTrayMenu();
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  menu.popup({ window: mainWindow });
});

ipcMain.handle('get-config', () => {
  const config = loadConfig();
  return { alwaysOnTop: config.alwaysOnTop !== false, sizeMin: SIZE_MIN, sizeMax: SIZE_MAX, ...config };
});

app.whenReady().then(() => {
  const config = loadConfig();
  if (typeof config.alwaysOnTop === 'boolean') {
    alwaysOnTop = config.alwaysOnTop;
  }
  setupDisplayMediaHandler();
  createWindow();
  createTray();
});

app.on('window-all-closed', () => {
  if (isQuitting) app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  if (tray) {
    tray.destroy();
    tray = null;
  }
});
