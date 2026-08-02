import { app, BrowserWindow, dialog, nativeTheme, shell } from 'electron'
import type BetterSqlite3 from 'better-sqlite3'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { LibraryNotice, ReplayGainJobProgress, ScanProgress } from '@shared/library'
import { openCacheService } from './cache'
import { openDatabase } from './db'
import {
  artworkCachePath,
  cacheDatabasePath,
  libraryDatabasePath,
  podcastsDirectoryPath
} from './db/location'
import { SqlitePlayHistoryService } from './history/service'
import { emit, registerIpcHandlers, setTrustedRendererUrl } from './ipc'
import { WorkerArtworkImageProcessor } from './library/artworkProcessor'
import { createDerivedArtworkStore } from './library/derivedArtwork'
import { SqliteLibraryService } from './library/sqliteService'
import { SqlitePlaylistService } from './library/playlists/service'
import { registerTrackProtocol, registerTrackScheme } from './library/trackFiles'
import { SqlitePodcastService } from './podcasts/service'
import { createArtistIdentityService, createArtistRelationsService } from './musicbrainz'
import { createNetService } from './net'
import { SqliteSettingsService } from './settings'
import { createArtistBiographyService, createArtistImageService } from './wikipedia'
import { resolveWindowBackground, WINDOW_BACKGROUND_KEYS } from './windowTheme'
import type { EpisodeDownloadProgress } from '@shared/podcasts'
import { AUDIO_REPLAY_GAIN_COMPUTE_WHEN_MISSING, type SettingsChange } from '@shared/settings'

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

/**
 * D12's export dialog, and the only file Fermata writes outside its own data
 * directory.
 *
 * The extension is a filter rather than something enforced here: GTK will hand
 * back whatever the operator typed, and `SqlitePlaylistService` is what puts
 * `.m3u8` on a bare name, so the rule lives in one place instead of in every
 * dialog implementation.
 */
async function pickPlaylistExportFile(suggestedName: string): Promise<string | null> {
  const options: Electron.SaveDialogOptions = {
    title: 'Export playlist',
    buttonLabel: 'Export',
    defaultPath: suggestedName,
    filters: [{ name: 'M3U8 playlist', extensions: ['m3u8'] }],
    properties: ['createDirectory', 'showOverwriteConfirmation', 'dontAddToRecent']
  }

  const result = mainWindow
    ? await dialog.showSaveDialog(mainWindow, options)
    : await dialog.showSaveDialog(options)

  // Cancelling is an ordinary outcome, not an error — the contract says so.
  if (result.canceled || result.filePath === undefined || result.filePath === '') return null
  return result.filePath
}

/**
 * W8-13's profile, out and in.
 *
 * Two dialogs rather than one picker with a mode, because they are two different
 * questions to the operator — name a file, choose a file — and Electron models
 * them as two calls. The `.json` filter is a filter only: `SqliteSettingsService`
 * is what puts the extension on a bare name, so that rule stays in one place.
 */
async function pickSettingsExportFile(suggestedName: string): Promise<string | null> {
  const options: Electron.SaveDialogOptions = {
    title: 'Export settings',
    buttonLabel: 'Export',
    defaultPath: suggestedName,
    filters: [{ name: 'Fermata settings', extensions: ['json'] }],
    properties: ['createDirectory', 'showOverwriteConfirmation', 'dontAddToRecent']
  }

  const result = mainWindow
    ? await dialog.showSaveDialog(mainWindow, options)
    : await dialog.showSaveDialog(options)

  // Cancelling is an ordinary outcome, not an error — the contract says so.
  if (result.canceled || result.filePath === undefined || result.filePath === '') return null
  return result.filePath
}

async function pickSettingsImportFile(): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: 'Import settings',
    buttonLabel: 'Open',
    filters: [{ name: 'Fermata settings', extensions: ['json'] }],
    properties: ['openFile', 'dontAddToRecent']
  }

  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options)

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

function broadcastEpisodeDownloadProgress(progress: EpisodeDownloadProgress): void {
  if (mainWindow) emit(mainWindow.webContents, 'podcasts.downloadProgress', progress)
}

function broadcastSettingsChanged(changes: SettingsChange[]): void {
  if (mainWindow) emit(mainWindow.webContents, 'settings.changed', changes)
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

/**
 * `backgroundColor` is passed in rather than named here, because the colour is
 * the theme's `surface.base` resolved by the same code the renderer uses. A
 * literal in this file was what let the old one drift into claiming to match a
 * token that did not exist.
 */
function createWindow(backgroundColor: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    show: false,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor,
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

    // Constructed here, before every other service and long before the window,
    // because that is the property the main-side store exists for: its load is
    // synchronous, so anything below this line can read a durable setting to
    // decide how to build itself. Notices are logged rather than thrown — a
    // library whose settings are damaged still opens, with defaults.
    const settings = new SqliteSettingsService({
      db,
      pickExportFile: pickSettingsExportFile,
      pickImportFile: pickSettingsImportFile,
      appVersion: app.getVersion(),
      onChanged: (changes) => {
        broadcastSettingsChanged(changes)
        // The window paints its own background; a theme write has to reach it
        // as well as the renderer, or the frame behind a resize stays the old
        // colour until relaunch.
        if (changes.some((change) => WINDOW_BACKGROUND_KEYS.includes(change.key))) {
          applyWindowBackground()
        }
      }
    })

    const applyWindowBackground = (): void => {
      mainWindow?.setBackgroundColor(
        resolveWindowBackground(settings, nativeTheme.shouldUseDarkColors)
      )
    }
    for (const notice of settings.loadNotices()) {
      console.warn(`[settings] ${notice.key}: ${notice.reason}`)
    }

    // Built from `settings` rather than given a copy of the consent flag: the
    // gate reads it live, so switching it off stops fetching without a restart
    // and without an invalidation path to get wrong. See `net/consent.ts`.
    const net = createNetService(settings)

    // Opened here rather than lazily on the first lookup so that a cache which
    // has to be rebuilt is rebuilt at startup, where the log line is next to the
    // library's, instead of in the middle of the operator opening a deck.
    //
    // Not passed to `createNetService`: the cache sits between the client and
    // its callers, never inside it. W7-9 takes both.
    const cache = openCacheService(cacheDatabasePath())

    // R5's resolver, on the library connection and between the two above it. It
    // owns two columns of `artists` and reads nothing else, so it is its own
    // service rather than a method on the library — the same arrangement the
    // playlist and trail services use.
    const artists = createArtistIdentityService({ db, client: net.client, cache })

    // D14's second source, downstream of the first: it reads the MBID the
    // resolver wrote and never searches by name, so a wrong identity produces a
    // wrong biography and a corrected one produces the right biography, with no
    // second opinion in between. `locale` is a getter because `app.getLocale()`
    // is only meaningful after `ready`, which this is inside — but the operator
    // can change it under a running app, and a captured string would not notice.
    const biographies = createArtistBiographyService({
      db,
      client: net.client,
      cache,
      locale: () => app.getLocale()
    })

    // D14's third source, and the only one that reads the library back. It is
    // downstream of the resolver in exactly the way the biography is — the MBID
    // comes off the `artists` row, never from the renderer — and it needs the
    // same connection twice over, because the intersection it draws is between
    // a MusicBrainz document and the `artists` table itself.
    const relations = createArtistRelationsService({ db, client: net.client, cache })

    // One artwork worker for library albums and podcast covers — a second
    // WorkerArtworkImageProcessor was racing the same native sharp module and
    // silently dropping podcast thumbs.
    const artworkProcessor = new WorkerArtworkImageProcessor()

    // D14's fourth source, and the only one that writes outside `cache.db`. The
    // picture goes into the shared thumbnail cache below; only its hash and its
    // Commons credit are cached here, which is what keeps this a decoration the
    // operator can delete rather than a second blob store.
    const images = createArtistImageService({
      db,
      client: net.client,
      cache,
      artwork: createDerivedArtworkStore({
        cacheDir: artworkCachePath(),
        processor: artworkProcessor
      }),
      locale: () => app.getLocale()
    })

    const library = new SqliteLibraryService({
      db,
      artworkCacheDir: artworkCachePath(),
      artworkProcessor,
      // The half of the arrangement above that the library owns: its prune
      // walks the thumbnail directory and deletes what nothing references, and
      // an artist photograph is referenced from a database it cannot see. Built
      // before the library so this is a plain function reference rather than a
      // late-bound hole.
      externalArtworkReferences: () => images.referencedHashes(),
      pickFolder: pickMusicFolder,
      onProgress: broadcastScanProgress,
      onNotice: broadcastLibraryNotice,
      onReplayGainProgress: broadcastReplayGainProgress,
      // Read at the moment the job is asked for, not now: main resolves durable
      // settings before the window exists, and this one can be turned off from
      // the settings view while the app is running.
      canComputeReplayGain: () => settings.get<boolean>(AUDIO_REPLAY_GAIN_COMPUTE_WHEN_MISSING.key)
    })

    // Its own service on the same connection: playlists own two tables the
    // library layer never touches, and the library owns the rest.
    const playlists = new SqlitePlaylistService({ db, pickExportFile: pickPlaylistExportFile })

    // And the same again for the trail, which owns one table and reads the
    // library's tracks only through the shared projection.
    const history = new SqlitePlayHistoryService({ db })

    const podcasts = new SqlitePodcastService({
      db,
      podcastsRoot: podcastsDirectoryPath(),
      artworkCacheDir: artworkCachePath(),
      artworkProcessor,
      onDownloadProgress: broadcastEpisodeDownloadProgress
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
          // After the library and inside its own guard. The disposable database
          // must not be able to skip the close that matters, and it must not be
          // able to hang the quit either — a cache that will not shut cleanly is
          // a file we would delete anyway.
          try {
            cache.close()
          } catch (error) {
            console.warn('[cache] close failed:', error)
          }
          readyToQuit = true
          app.quit()
        })
    })

    setTrustedRendererUrl(rendererUrl)
    registerTrackProtocol(library, artworkCachePath(), podcasts)
    registerIpcHandlers(
      library,
      playlists,
      podcasts,
      settings,
      history,
      net,
      artists,
      biographies,
      relations,
      images
    )

    mainWindow = createWindow(resolveWindowBackground(settings, nativeTheme.shouldUseDarkColors))
    // The other way the answer changes: the OS flips while the preference is
    // `system`.
    nativeTheme.on('updated', applyWindowBackground)
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
