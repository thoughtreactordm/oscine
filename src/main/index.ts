import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerIpcHandlers, setTrustedRendererUrl } from './ipc'
import { PendingLibraryService } from './library/service'
import { registerTrackProtocol, registerTrackScheme } from './library/trackFiles'

const isDev = !app.isPackaged
const rendererDir = join(__dirname, '../renderer')
const indexHtml = join(rendererDir, 'index.html')

/**
 * The one URL the renderer is ever served from: the dev server in development,
 * the packaged HTML on disk otherwise. Used both to load the window and to
 * decide which sender IPC will answer.
 */
const rendererUrl =
  isDev && process.env.ELECTRON_RENDERER_URL
    ? process.env.ELECTRON_RENDERER_URL
    : pathToFileURL(indexHtml).toString()

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
  // Prefix rather than origin: every file:// URL reports its origin as "null",
  // which would make an origin comparison accept any local file.
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(rendererUrl)) event.preventDefault()
  })

  // Nothing in M1 needs a device permission. Grant explicitly when something does.
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false)
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(rendererUrl)
  } else {
    void win.loadFile(indexHtml)
  }

  return win
}

// A second instance would open a second connection to the same SQLite file
// (W2-1). Cheaper to forbid now than to debug as corruption later.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // Must happen before the app is ready, or the scheme is not privileged and
  // fetch() against it fails in ways that look like a CSP problem.
  registerTrackScheme()

  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  void app.whenReady().then(() => {
    // W2-1 swaps this for the real database-backed service. Nothing else here
    // changes when it does — that is what the seam is for.
    const library = new PendingLibraryService()

    setTrustedRendererUrl(rendererUrl)
    registerTrackProtocol(library)
    registerIpcHandlers(library)

    createWindow()
  })

  // D10 scopes Fermata to Windows and Linux, where closing the last window
  // means quitting.
  app.on('window-all-closed', () => {
    app.quit()
  })
}
