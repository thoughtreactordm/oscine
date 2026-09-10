/**
 * Themes as files — the main-process half of the `.osctheme` picker.
 *
 * The renderer never touches the filesystem, so listing the themes folder,
 * writing an export and copying an import all live here. Applying a theme does
 * not: that is three ordinary `settings.set` writes the renderer already makes
 * (`theme.name`, `theme.mode`, `theme.overrides`), so this service reads the
 * three to export and never writes them back — it only moves files.
 *
 * The dialog pickers are injected for the reason `SqliteSettingsService`'s are:
 * Electron's `dialog` is main-only and unavailable in a plain-Node test, so the
 * one part that needs it is a seam rather than a hard dependency.
 */

import { shell } from 'electron'
import { access, copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { OscineError } from '@shared/errors'
import { THEME_MODE_KEY, THEME_NAME_KEY, THEME_OVERRIDES_KEY } from '@shared/settings'
import {
  buildThemeFile,
  parseThemeFile,
  THEME_FILE_EXTENSION,
  type InstalledTheme,
  type ThemeFileMode,
  type ThemeOverrides
} from '@shared/theme'
import type { SettingsService } from '../settings/service'

export interface ThemeFileService {
  /** Write the theme in force to an `.osctheme`. `null` when cancelled. */
  exportTheme(request: { name: string }): Promise<{ fileName: string } | null>
  /** The parsed `.osctheme` files in the themes folder, malformed ones skipped. */
  listInstalled(): Promise<InstalledTheme[]>
  /** Copy a chosen `.osctheme` into the themes folder. `null` when cancelled. */
  importTheme(): Promise<{ id: string; name: string } | null>
  /** Reveal the themes folder in the OS file manager, creating it if absent. */
  revealFolder(): Promise<void>
}

/** Opens a dialog this build was not wired with. */
function noPicker(): Promise<string | null> {
  throw new OscineError('io-error', 'Themes are unavailable in this build.')
}

/**
 * A name turned into a filename stem. Not the identity of the theme — that is
 * the embedded `name` — just something friendly to land on disk, so any run of
 * characters a filesystem would rather not carry collapses to a single dash.
 */
function toFileStem(name: string): string {
  const stem = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return stem.length > 0 ? stem : 'theme'
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export interface ThemeFileServiceOptions {
  settings: SettingsService
  /** The folder `.osctheme` files live in — `themesDirectoryPath()`. */
  themesDir: string
  pickExportFile?: (suggestedName: string) => Promise<string | null>
  pickImportFile?: () => Promise<string | null>
  /** Stamped into an export. Informational. */
  appVersion?: string
  /** Overridable clock, for a deterministic `exportedAt` in tests. */
  now?: () => number
}

export class FsThemeFileService implements ThemeFileService {
  private readonly settings: SettingsService
  private readonly themesDir: string
  private readonly pickExportFile: (suggestedName: string) => Promise<string | null>
  private readonly pickImportFile: () => Promise<string | null>
  private readonly appVersion?: string
  private readonly now: () => number

  constructor({
    settings,
    themesDir,
    pickExportFile = noPicker,
    pickImportFile = noPicker,
    appVersion,
    now = Date.now
  }: ThemeFileServiceOptions) {
    this.settings = settings
    this.themesDir = themesDir
    this.pickExportFile = pickExportFile
    this.pickImportFile = pickImportFile
    this.appVersion = appVersion
    this.now = now
  }

  async exportTheme({ name }: { name: string }): Promise<{ fileName: string } | null> {
    const themeFile = buildThemeFile({
      name,
      base: this.settings.get<string>(THEME_NAME_KEY),
      mode: this.settings.get<ThemeFileMode>(THEME_MODE_KEY),
      overrides: this.settings.get<ThemeOverrides>(THEME_OVERRIDES_KEY),
      ...(this.appVersion === undefined ? {} : { app: this.appVersion }),
      exportedAt: new Date(this.now()).toISOString()
    })

    const suggested = `${toFileStem(themeFile.name)}${THEME_FILE_EXTENSION}`
    const picked = await this.pickExportFile(suggested)
    if (picked === null) return null

    // The extension is put on here rather than trusted from the dialog: GTK
    // hands back whatever was typed, and a theme that does not announce itself is
    // one the folder scan will not list.
    const destination = picked.toLowerCase().endsWith(THEME_FILE_EXTENSION)
      ? picked
      : `${picked}${THEME_FILE_EXTENSION}`

    try {
      await writeFile(destination, `${JSON.stringify(themeFile, null, 2)}\n`, 'utf8')
    } catch (error) {
      console.error(`[theme] export to ${destination} failed:`, error)
      throw new OscineError('io-error', 'That theme could not be written to disk.')
    }

    return { fileName: basename(destination) }
  }

  async listInstalled(): Promise<InstalledTheme[]> {
    let names: string[]
    try {
      await mkdir(this.themesDir, { recursive: true })
      names = await readdir(this.themesDir)
    } catch (error) {
      console.error(`[theme] could not read the themes folder:`, error)
      return []
    }

    const themes: InstalledTheme[] = []
    for (const fileName of names) {
      if (extname(fileName).toLowerCase() !== THEME_FILE_EXTENSION) continue

      let raw: unknown
      try {
        raw = JSON.parse(await readFile(join(this.themesDir, fileName), 'utf8')) as unknown
      } catch {
        // A broken file dropped into the folder must not hide the good ones.
        continue
      }

      const parsed = parseThemeFile(raw)
      if (!parsed.ok) continue

      themes.push({
        id: basename(fileName, extname(fileName)),
        name: parsed.themeFile.name,
        base: parsed.themeFile.base,
        mode: parsed.themeFile.mode,
        overrides: parsed.themeFile.overrides
      })
    }

    themes.sort((a, b) => a.name.localeCompare(b.name))
    return themes
  }

  async importTheme(): Promise<{ id: string; name: string } | null> {
    const picked = await this.pickImportFile()
    if (picked === null) return null

    let raw: unknown
    try {
      raw = JSON.parse(await readFile(picked, 'utf8')) as unknown
    } catch (error) {
      throw new OscineError(
        'invalid-request',
        `That file could not be read as JSON: ${asMessage(error)}`
      )
    }

    const parsed = parseThemeFile(raw)
    if (!parsed.ok) {
      throw new OscineError(
        'invalid-request',
        `That file is not an Oscine theme: ${parsed.reason}.`
      )
    }

    await mkdir(this.themesDir, { recursive: true })

    // Already in the folder — dropped in by hand and picked from there. Nothing
    // to copy; just report it under its own filename stem.
    if (resolve(dirname(picked)) === resolve(this.themesDir)) {
      return { id: basename(picked, extname(picked)), name: parsed.themeFile.name }
    }

    const stem = toFileStem(parsed.themeFile.name)
    let destination = join(this.themesDir, `${stem}${THEME_FILE_EXTENSION}`)
    let n = 2
    while (await pathExists(destination)) {
      destination = join(this.themesDir, `${stem}-${n}${THEME_FILE_EXTENSION}`)
      n += 1
    }

    try {
      await copyFile(picked, destination)
    } catch (error) {
      console.error(`[theme] import to ${destination} failed:`, error)
      throw new OscineError('io-error', 'That theme could not be copied into the themes folder.')
    }

    return { id: basename(destination, extname(destination)), name: parsed.themeFile.name }
  }

  async revealFolder(): Promise<void> {
    await mkdir(this.themesDir, { recursive: true })
    const failure = await shell.openPath(this.themesDir)
    if (failure !== '') {
      throw new OscineError('io-error', `The themes folder could not be opened: ${failure}`)
    }
  }
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
