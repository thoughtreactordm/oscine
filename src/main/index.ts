import { app, BrowserWindow, dialog, shell } from 'electron'
import type BetterSqlite3 from 'better-sqlite3'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ReplayGainJobProgress, ScanProgress } from '@shared/library'
import { openDatabase } from './db'
import { libraryDatabasePath } from './db/location'
import { emit, registerIpcHandlers, setTrustedRendererUrl } from './ipc'
import { SqliteLibraryService } from './library/sqliteService'
import { registerTrackProtocol, registerTrackScheme } from './library/trackFiles'

const isDev = !app.isPackaged
const rendererDir = join(__dirname, '../renderer')
const indexHtml = join(rendererDir, 'index.html')

/**
 * The application window, once it exists.
 *
 * Held because the library service is constructed before it — the track
 * protocol and the IPC handlers have to be registered before the renderer can
 * load — yet both of the service's Electron dependencies need a window. They
 * reach it through this rather than through a construction-order rearrangement
 * that would leave the protocol registered late.
 */
let mainWindow: BrowserWindow | null = null

/** D1's library is folders on disk, so this is the one way tracks get in. */
async function pickMusicFolder(): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: 'Add music folder',
    buttonLabel: 'Add folder',
    properties: ['openDirectory', 'createDirectory', 'dontAddToRecent']
  }

  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options)

  // Cancelling is an ordinary outcome, not an error — the contract says so.
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
}

function broadcastScanProgress(progress: ScanProgress): void {
  if (mainWindow) emit(mainWindow.webContents, 'library.scanProgress', progress)
}

function broadcastReplayGainProgress(progress: ReplayGainJobProgress): void {
  if (mainWindow) emit(mainWindow.webContents, 'library.replayGainProgress', progress)
}

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
    const filePath = libraryDatabasePath()
    let db: BetterSqlite3.Database

    try {
      const opened = openDatabase(filePath)
      db = opened.db
      const { from, to, applied } = opened.migration
      console.info(
        applied.length === 0
          ? `[db] ${filePath} — schema v${to}, up to date`
          : `[db] ${filePath} — migrated v${from} to v${to} (${applied
              .map((migration) => migration.name)
              .join(', ')})`
      )
    } catch (error) {
      // Without a library there is no application, so fail visibly rather than
      // opening a window that cannot answer a single query.
      dialog.showErrorBox(
        'Fermata could not open its library',
        `${filePath}\n\n${error instanceof Error ? error.message : String(error)}`
      )
      app.quit()
      return
    }

    const library = new SqliteLibraryService({
      db,
      pickFolder: pickMusicFolder,
      onProgress: broadcastScanProgress,
      onReplayGainProgress: broadcastReplayGainProgress
    })

    let readyToQuit = false
    let quitInProgress = false
    app.on('before-quit', (event) => {
      if (readyToQuit) return
      event.preventDefault()
      if (quitInProgress) return
      quitInProgress = true
      // Wait for worker termination before closing SQLite. This avoids both a
      // native worker keeping the app alive and a final checkpoint racing a
      // closed database connection.
      void library
        .close()
        .catch((error: unknown) => {
          console.error('[replaygain] worker cleanup failed:', error)
        })
        .finally(() => {
          db.close()
          readyToQuit = true
          app.quit()
        })
    })

    setTrustedRendererUrl(rendererUrl)
    registerTrackProtocol(library)
    registerIpcHandlers(library)

    mainWindow = createWindow()
    mainWindow.on('closed', () => {
      mainWindow = null
    })
  })

  // D10 scopes Fermata to Windows and Linux, where closing the last window
  // means quitting.
  app.on('window-all-closed', () => {
    app.quit()
  })
}
