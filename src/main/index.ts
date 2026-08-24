import { app, BrowserWindow, dialog, nativeTheme, safeStorage, shell } from 'electron'
import type BetterSqlite3 from 'better-sqlite3'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { LibraryNotice, ReplayGainJobProgress, ScanProgress } from '@shared/library'
import { openCacheService } from './cache'
import { openDatabase } from './db'
import {
  artworkCachePath,
  cacheDatabasePath,
  libraryDatabasePath,
  podcastsDirectoryPath,
  scrobbleCredentialsPath
} from './db/location'
import { SqlitePlayHistoryService } from './history/service'
import { SqliteListenService } from './listens/service'
import { rebuildTrackCounters } from './stats/counters'
import { SqliteStatsService } from './stats/service'
import { SqliteFavoriteService } from './favorites/service'
import { SqliteSearchService } from './search/service'
import { emit, registerIpcHandlers, setTrustedRendererUrl } from './ipc'
import { WorkerArtworkImageProcessor } from './library/artworkProcessor'
import { createDerivedArtworkStore } from './library/derivedArtwork'
import { SqliteLibraryService } from './library/sqliteService'
import { SqlitePlaylistService } from './library/playlists/service'
import { registerTrackProtocol, registerTrackScheme } from './library/trackFiles'
import { SqlitePodcastService } from './podcasts/service'
import { createArtistIdentityService, createArtistRelationsService } from './musicbrainz'
import { createNetService } from './net'
import { createKeyringProbe, selectPasswordStore } from './passwordStore'
import { createScrobbleAccounts } from './scrobble/accounts'
import { createCredentialFileIo, createScrobbleCredentialStore } from './scrobble/credentials'
import { createScrobbleDrainWorker } from './scrobble/drain'
import { createSendingTargets } from './scrobble/enabled'
import { createNowPlayingAnnouncer } from './scrobble/nowPlaying'
import { ScrobbleOutbox } from './scrobble/outbox'
import { createScrobbleStatusService, type ScrobbleStatusService } from './scrobble/status'
import { createLastfmTarget } from './scrobble/lastfm/target'
import { createLastfmTransport } from './scrobble/lastfm/transport'
import { resolveLastfmAppKey } from './scrobble/lastfm/appKey'
import { SqliteSettingsService } from './settings'
import { createArtistBiographyService, createArtistImageService } from './wikipedia'
import { resolveWindowBackground, WINDOW_BACKGROUND_KEYS } from './windowTheme'
import type { EpisodeDownloadProgress } from '@shared/podcasts'
import type { ScrobbleTarget } from '@shared/scrobble'
import {
  AUDIO_REPLAY_GAIN_COMPUTE_WHEN_MISSING,
  LASTFM_LOVE_ON_FAVORITE,
  type SettingsChange
} from '@shared/settings'

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

function requestListenFlush(): void {
  if (mainWindow) emit(mainWindow.webContents, 'listens.flushRequested', null)
}

/**
 * Held at module scope because the two things that announce a status change —
 * a connection changing and a drain pass finishing — are both constructed
 * before the service that composes the status, and both need to reach it.
 */
let scrobbleStatus: ScrobbleStatusService | null = null

function broadcastScrobbleStatus(): void {
  if (!mainWindow || !scrobbleStatus) return
  emit(mainWindow.webContents, 'scrobble.statusChanged', [...scrobbleStatus.status().targets])
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

  // Which credential store `safeStorage` will use, on the sessions where
  // Chromium cannot tell. Read `passwordStore.ts` before changing this — in
  // particular why it is conditional, which is that forcing the libsecret
  // backend with no keyring on disk hangs rather than fails, on this line, with
  // no window yet.
  //
  // Before `whenReady` because a command-line switch after it is a switch
  // Chromium has already finished reading.
  const passwordStore = selectPasswordStore({
    platform: process.platform,
    env: process.env,
    homeDirectory: homedir(),
    probe: createKeyringProbe()
  })
  if (passwordStore !== null) app.commandLine.appendSwitch('password-store', passwordStore)

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
    let listensMoved: boolean

    try {
      const opened = openDatabase(filePath)
      db = opened.db
      const { from, to, applied } = opened.migration
      listensMoved = applied.some((migration) => migration.touchesListens === true)
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

    // D19's accounts. Built from `net`'s limiter and scope registry rather than
    // from its client, because scrobbling is the one caller outside D14's
    // consent gate and the gate is baked into a client at construction — the
    // argument for that exemption is at the top of `scrobble/lastfm/transport.ts`
    // and in D19, and it is the one thing to read before changing this.
    //
    // `safeStorage` is handed in rather than imported by the store, so the store
    // is testable without a keyring. It is also the first use of `safeStorage`
    // anywhere in Fermata: `scrobble/credentials.ts` is the pattern.
    //
    const scrobbleCredentials = createScrobbleCredentialStore({
      sealer: safeStorage,
      io: createCredentialFileIo(scrobbleCredentialsPath())
    })

    // Held as an array as well as handed to the accounts service, because three
    // other things need the targets themselves rather than the connections the
    // service reports: the drain worker, the listen commit's enqueue, and the
    // now-playing announcer. All three read it through a function rather than
    // capturing it, so connecting an account mid-session reaches them.
    const scrobbleTargets: readonly ScrobbleTarget[] = [
      createLastfmTarget({
        transport: createLastfmTransport({
          limiter: net.limiter,
          scopes: net.scopes,
          // Resolved per call, so pasting an override in Settings takes effect
          // without a restart — the same live-read rule as the consent gate.
          sharedSecret: () => resolveLastfmAppKey(settings)?.apiSecret ?? ''
        }),
        credentials: scrobbleCredentials,
        settings,
        openExternal: (url) => shell.openExternal(url)
      })
    ]

    // W11-7's pause switch, applied in exactly one place. Every consumer that
    // *sends* — the drain, the now-playing announcer, the listen commit's
    // enqueue, the loved push — takes its targets through this rather than
    // through the array above, so "off" means off for all four rather than for
    // the three somebody remembered. See `scrobble/enabled.ts`, including why
    // the accounts service keeps the unfiltered list.
    const sendingTargets = createSendingTargets({
      targets: () => scrobbleTargets,
      getBoolean: (key) => settings.get<boolean>(key)
    })

    // Persist first, submit second — the queue is the durable record, and the
    // worker is the only thing that reads it. Started below, after the handlers
    // are registered, rather than here: a drain competing with the first paint
    // is a network round trip nobody is waiting for.
    const scrobbleOutbox = new ScrobbleOutbox(db)
    const scrobbleDrain = createScrobbleDrainWorker({
      outbox: scrobbleOutbox,
      targets: sendingTargets,
      // Once per pass, and the pane re-reads the count itself. This is what
      // makes "unplug the network and watch it grow, plug it back in and watch
      // it empty" a thing that happens without anybody pressing anything.
      onPass: () => broadcastScrobbleStatus()
    })
    const nowPlaying = createNowPlayingAnnouncer({ targets: sendingTargets })

    const scrobble = createScrobbleAccounts({
      targets: scrobbleTargets,
      onChanged: () => {
        broadcastScrobbleStatus()
        // Connecting an account is the moment a queue that has been filling up
        // for a target nobody was signed into becomes sendable. Waking here
        // saves the operator the backstop interval watching a depth that ought
        // to be falling.
        void scrobbleDrain.wake()
      }
    })

    // The three reads the pane needs, joined once. See `scrobble/status.ts` for
    // why this is not a method on the accounts service.
    scrobbleStatus = createScrobbleStatusService({
      accounts: scrobble,
      outbox: scrobbleOutbox,
      drain: scrobbleDrain
    })

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
    //
    // D19's now-playing hangs off it (W11-5). The trail's row *is* the
    // transport-commit moment, so announcing from anywhere else would be a
    // second definition of when a track started.
    const history = new SqlitePlayHistoryService({
      db,
      onRecorded: (entry) => nowPlaying.announce(entry.track)
    })

    // The listens log (D17). Same connection, its own two tables, and the
    // renderer-facing half of the quit-time flush handed in — see `before-quit`.
    //
    // The outbox goes in with it so the queue row is written inside the listen's
    // own transaction (W11-5); the wake is outside it, because a drain is a
    // network round trip and the write must not hold a lock through one.
    const listens = new SqliteListenService({
      db,
      requestFlush: requestListenFlush,
      scrobble: { outbox: scrobbleOutbox, targets: sendingTargets },
      onCommitted: () => void scrobbleDrain.wake()
    })

    // The statistics engine, and today the one thing in it that is not a query:
    // the rebuild of the two counter columns that cache the log.
    const stats = new SqliteStatsService({ db })

    // Favorites (D18), and the loved push (W11-6). Same connection, one table,
    // and still no network of its own: hearting a track is complete before
    // anything is pushed anywhere. The push is the listen commit's arrangement
    // exactly — the outbox goes in so the queue row is written inside the
    // heart's own transaction, and the wake is outside it, because a drain is a
    // network round trip and the write must not hold a lock through one.
    //
    // `lovePushEnabled` is read here, per gesture, rather than captured: the
    // operator can turn it off between one click and the next, and W8 applies a
    // settings write immediately.
    const favorites = new SqliteFavoriteService({
      db,
      scrobble: {
        outbox: scrobbleOutbox,
        targets: sendingTargets,
        lovePushEnabled: () => settings.get<boolean>(LASTFM_LOVE_ON_FAVORITE)
      },
      onChanged: () => void scrobbleDrain.wake()
    })

    // The command palette's finder (D23). Same connection, no tables of its own
    // and no network: it reuses `tracks_fts` for tracks and a light LIKE over
    // the small entity sets, and reaches nothing but this database.
    const search = new SqliteSearchService({ db })

    // A migration is the one moment `listens` can move without the listen commit
    // maintaining the cache alongside it, so the flag it declares is honoured
    // here, at startup, before the window can sort by a stale play count.
    // Synchronous and blocking on purpose: it is one grouped pass, and a window
    // that opened first would render the numbers this is about to correct.
    if (listensMoved) {
      const repaired = rebuildTrackCounters(db)
      console.info(
        `[stats] counters rebuilt after a listens migration — ` +
          `${repaired.tracksChanged} of ${repaired.tracksScanned} tracks corrected ` +
          `from ${repaired.listensCounted} listens`
      )
    }

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

      // Before anything else, and before the database closes under it. Stopping
      // the timer does not abandon a pass in flight — the net scope does that,
      // which is what `'scrobble'` is in `NET_SCOPES` for. Nothing is lost
      // either way: the rows are durable and persist-first means an abandoned
      // drain costs a retry, never a scrobble.
      scrobbleDrain.stop()
      net.cancelScope('scrobble')

      // First of the awaited steps, because it is the only one that needs the
      // renderer alive and
      // the database open at the same time. The accumulator holds the in-flight
      // listen in the renderer, so a quit mid-track would otherwise lose one
      // that had already crossed the threshold. Bounded and never rejecting —
      // see the service; a renderer that cannot answer does not get to keep the
      // app open.
      void listens
        .flush()
        .catch((error: unknown) => {
          console.warn('[listens] quit flush failed:', error)
        })
        // Then wait for worker termination before closing SQLite. This avoids
        // both a native worker keeping the app alive and a final checkpoint
        // racing a closed database connection.
        .then(() => library.close())
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
      listens,
      stats,
      favorites,
      net,
      scrobble,
      scrobbleStatus,
      artists,
      biographies,
      relations,
      images,
      search
    )

    // On app start, per W11-2: a queue that filled up while the machine was
    // offline drains as soon as there is something to drain it with. After the
    // handlers so that the first pass cannot race the window's own first
    // queries for the write lock, and harmless when nobody has ever signed in —
    // it finds no connected target and goes back to sleep.
    scrobbleDrain.start()

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
