import { app, BrowserWindow, dialog, shell } from 'electron'
import type BetterSqlite3 from 'better-sqlite3'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { LibraryNotice, ReplayGainJobProgress, ScanProgress } from '@shared/library'
import { openDatabase } from './db'
import { artworkCachePath, libraryDatabasePath } from './db/location'
import { emit, registerIpcHandlers, setTrustedRendererUrl } from './ipc'
import { SqliteLibraryService } from './library/sqliteService'
import { SqlitePlaylistService } from './library/playlists/service'
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

function broadcastLibraryNotice(notice: LibraryNotice): void {
  if (mainWindow) emit(mainWindow.webContents, 'library.notice', notice)
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
    frame: false,
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
  // Say so. A bare quit here exits 0 with no output, which during development
  // is indistinguishable from a crash: `npm run dev` builds, prints "DevTools
  // listening", then vanishes. The running instance is usually a forgotten one.
  process.stderr.write(
    '[fermata] another instance already holds the single-instance lock; exiting.\n' +
      '[fermata] close the running Fermata (or its dev instance) and start again.\n'
  )
  app.quit()
} else {
  // Must happen before the app is ready, or the scheme is not privileged and
  // fetch() against it fails in ways that look like a CSP problem.
  registerTrackScheme()

  // The identity Windows attaches the SMTC now-playing card to. Without it the
  // card is labelled "Electron" and carries the wrong icon, which is the same
  // failure whether or not the app is packaged. Matches `appId` in
  // electron-builder.yml; the two disagreeing would split the identity in two.
  //
  // Deliberately *not* accompanied by `app.setName`, which is the obvious next
  // reach because Chromium is said to derive the MPRIS bus name from the
  // product name. Measured, it does not:
  // `scripts/media-session-probe.mjs` publishes
  // `org.mpris.MediaPlayer2.chromium.instance<pid>` either way. So setting it
  // would buy nothing and cost something real — `app.getPath('userData')` is
  // derived from the same value, and changing it silently relocates the library
  // database and the artwork cache (`db/location.ts`).
  //
  // Linux identity therefore comes from the desktop entry and StartupWMClass in
  // electron-builder.yml, not from the bus name. No Chromium feature switch is
  // needed for the MPRIS path on Electron 43; the probe confirms it publishes
  // unaided.
  app.setAppUserModelId('dev.fermata.app')

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
      artworkCacheDir: artworkCachePath(),
      pickFolder: pickMusicFolder,
      onProgress: broadcastScanProgress,
      onNotice: broadcastLibraryNotice,
      onReplayGainProgress: broadcastReplayGainProgress
    })

    // Its own service on the same connection: playlists own two tables the
    // library layer never touches, and the library owns the rest.
    const playlists = new SqlitePlaylistService({ db })

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
    registerTrackProtocol(library, artworkCachePath())
    registerIpcHandlers(library, playlists)

    mainWindow = createWindow()
    mainWindow.on('maximize', () => {
      if (mainWindow) emit(mainWindow.webContents, 'window.maximizedChange', true)
    })
    mainWindow.on('unmaximize', () => {
      if (mainWindow) emit(mainWindow.webContents, 'window.maximizedChange', false)
    })
    void library.initialize().catch((error: unknown) => {
      console.error('[scan] startup reconciliation failed:', error)
    })
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
