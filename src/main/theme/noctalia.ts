/**
 * Noctalia sync — the main-process half: watch the palette file Noctalia
 * renders our template to, and say what it holds.
 *
 * Main owns it because the renderer never touches the filesystem. The renderer
 * hydrates from `status()` over IPC and follows `onChanged`; the window
 * background reads `palette()` directly, the same way it reads the theme keys.
 *
 * The palette lives at one path both a dev and a packaged build watch —
 * `$XDG_STATE_HOME/oscine/`, never under `userData`, which dev builds suffix.
 * Noctalia has a single slot per template name, so a per-instance path would let
 * whichever build ran setup first lock the other out.
 */

import { watch, type FSWatcher, readFileSync, statSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  parseNoctaliaPalette,
  type NoctaliaPalette,
  type NoctaliaSetupResult,
  type NoctaliaStatus,
  type NoctaliaVersion
} from '@shared/theme'
import { setupNoctalia } from './noctaliaSetup'

/**
 * An error as the operator may see it. Node's filesystem messages embed the
 * path, and nothing that crosses IPC may, so those are reduced to their code.
 */
function describe(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code
  return typeof code === 'string' ? `(${code}).` : (error as Error).message
}

/** A palette is a few hundred bytes. Anything this size is not one. */
const MAX_PALETTE_BYTES = 64 * 1024

type Env = Readonly<Record<string, string | undefined>>

function stateHome(env: Env, home: string): string {
  return env.XDG_STATE_HOME || join(home, '.local', 'state')
}

export function noctaliaPalettePath(env: Env = process.env, home = homedir()): string {
  return join(stateHome(env, home), 'oscine', 'noctalia-palette.json')
}

/**
 * Noctalia's config directory for the requested version. v4 honours
 * `NOCTALIA_CONFIG_DIR`, v5 `NOCTALIA_CONFIG_HOME`; both fall back to
 * `$XDG_CONFIG_HOME/noctalia`.
 */
export function noctaliaConfigDir(
  version: NoctaliaVersion,
  env: Env = process.env,
  home = homedir()
): string {
  const legacy = env.NOCTALIA_CONFIG_DIR
  const modern = env.NOCTALIA_CONFIG_HOME
  if (version === 'auto' && legacy && modern && legacy !== modern) {
    throw new Error('Both Noctalia config directories are set. Choose the version to set up.')
  }
  const override = version === 'v4' ? legacy : version === 'v5' ? modern : legacy || modern
  return override || join(env.XDG_CONFIG_HOME || join(home, '.config'), 'noctalia')
}

/** v5's GUI-managed overlay, which can carry template entries of its own. */
export function noctaliaStateSettingsPath(env: Env = process.env, home = homedir()): string {
  return join(env.NOCTALIA_STATE_HOME || join(stateHome(env, home), 'noctalia'), 'settings.toml')
}

export interface NoctaliaSyncOptions {
  /** Whether the operator has chosen Noctalia as the colour source. */
  enabled: () => boolean
  palettePath?: string
  platform?: NodeJS.Platform
  env?: Env
  home?: string
  /** Called with every status that differs from the last one. */
  onChanged?: (status: NoctaliaStatus) => void
  /** How long a burst of watch events must go quiet before the file is read. */
  settleMs?: number
}

export class NoctaliaSync {
  private readonly enabled: () => boolean
  private readonly platform: NodeJS.Platform
  private readonly env: Env
  private readonly home: string
  private readonly onChanged: (status: NoctaliaStatus) => void
  private readonly settleMs: number
  private readonly palettePath: string
  private watcher: FSWatcher | null = null
  private settle: NodeJS.Timeout | null = null
  private current: NoctaliaStatus

  constructor(options: NoctaliaSyncOptions) {
    this.enabled = options.enabled
    this.platform = options.platform ?? process.platform
    this.env = options.env ?? process.env
    this.home = options.home ?? homedir()
    this.onChanged = options.onChanged ?? (() => {})
    this.settleMs = options.settleMs ?? 250
    this.palettePath = options.palettePath ?? noctaliaPalettePath(this.env, this.home)
    this.current = {
      state: this.platform === 'linux' ? 'disabled' : 'unsupported',
      palette: null,
      message: ''
    }
  }

  status(): NoctaliaStatus {
    return this.current
  }

  /** The palette in force — null whenever sync is off. */
  palette(): NoctaliaPalette | null {
    return this.current.palette
  }

  /** Start or stop watching to match the setting. Cheap to call on any change. */
  sync(): void {
    if (this.platform !== 'linux' || !this.enabled()) {
      this.stop()
      this.publish({
        ...this.current,
        state: this.platform === 'linux' ? 'disabled' : 'unsupported',
        palette: null,
        message: ''
      })
      return
    }
    if (this.watcher) return

    this.read()
    const path = this.palettePath
    const name = basename(path)
    try {
      // The parent, not the file, so Noctalia's atomic replace and a palette that
      // has not been generated yet both still arrive.
      mkdirSync(dirname(path), { recursive: true })
      const watcher = watch(dirname(path), (_event, file) => {
        if (this.watcher === watcher && (file === null || file === name)) this.schedule()
      })
      watcher.on('error', (error) => {
        if (this.watcher !== watcher) return
        this.stop()
        this.publish({
          ...this.current,
          state: 'error',
          message: `Watching for Noctalia colors failed ${describe(error)} Retry from Theme settings.`
        })
      })
      this.watcher = watcher
    } catch (error) {
      this.publish({
        ...this.current,
        state: 'error',
        message: `Could not watch for Noctalia colors ${describe(error)}`
      })
    }
  }

  retry(): NoctaliaStatus {
    this.stop()
    this.sync()
    return this.current
  }

  setup(version: NoctaliaVersion): NoctaliaSetupResult {
    if (this.platform !== 'linux') throw new Error('Noctalia sync is available on Linux only.')
    const result = setupNoctalia({
      configDir: noctaliaConfigDir(version, this.env, this.home),
      palettePath: this.palettePath,
      version,
      stateSettingsPath: noctaliaStateSettingsPath(this.env, this.home)
    })
    // A repointed entry may have carried a palette across; pick it up now.
    if (this.watcher) this.read()
    return result
  }

  stop(): void {
    if (this.settle) clearTimeout(this.settle)
    this.settle = null
    const previous = this.watcher
    this.watcher = null
    previous?.close()
  }

  private schedule(): void {
    if (this.settle) clearTimeout(this.settle)
    this.settle = setTimeout(() => {
      this.settle = null
      if (this.watcher) this.read()
    }, this.settleMs)
  }

  private read(): void {
    const path = this.palettePath
    try {
      if (statSync(path).size > MAX_PALETTE_BYTES) throw new Error('The palette is too large.')
      const palette = parseNoctaliaPalette(JSON.parse(readFileSync(path, 'utf8')))
      this.publish({ ...this.current, state: 'synced', palette, message: 'Synced with Noctalia.' })
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
      this.publish({
        // The last valid palette stays: a replace in progress or one bad write
        // must not drop the desktop's colours for the old theme's.
        ...this.current,
        state: missing ? 'waiting' : 'error',
        message: missing
          ? 'Waiting for Noctalia. Set it up, then apply a Noctalia color scheme.'
          : `Could not read the Noctalia colors: ${describe(error)} Regenerate them in Noctalia, then retry.`
      })
    }
  }

  private publish(next: NoctaliaStatus): void {
    if (JSON.stringify(next) === JSON.stringify(this.current)) return
    this.current = next
    this.onChanged(next)
  }
}
