import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const isDev = !app.isPackaged
const rendererDir = join(__dirname, '../renderer')

/**
 * Only two origins may ever be loaded: the dev server in development, and the
 * packaged renderer on disk. Anything else is treated as hostile.
 */
function allowedOrigin(): string {
  return isDev && process.env.ELECTRON_RENDERER_URL
    ? new URL(process.env.ELECTRON_RENDERER_URL).origin
    : pathToFileURL(join(rendererDir, 'index.html')).origin
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    // Matches the dark surface token so launch does not flash white.
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Design section 6. These three are not negotiable; the typed preload
      // bridge in src/shared exists specifically so nothing needs them relaxed.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // The renderer is a single application shell, never a browser.
      webviewTag: false,
      navigateOnDragDrop: false
    }
  })

  win.once('ready-to-show', () => win.show())

  // A local music player never opens a window on our own origin. Route real
  // external links to the system browser and refuse everything else.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:$/.test(new URL(url).protocol)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // In-app routing is hash-based, so no top-level navigation should ever occur.
  win.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== allowedOrigin()) event.preventDefault()
  })

  // Nothing in M1 needs a device permission. Grant explicitly when something does.
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false)
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(rendererDir, 'index.html'))
  }

  return win
}

// A second instance would open a second connection to the same SQLite file
// (W2-1). Cheaper to forbid now than to debug as corruption later.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  void app.whenReady().then(() => {
    createWindow()
  })

  // D10 scopes Fermata to Windows and Linux, where closing the last window
  // means quitting.
  app.on('window-all-closed', () => {
    app.quit()
  })
}
