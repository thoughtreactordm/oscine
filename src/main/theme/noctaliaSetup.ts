/**
 * Installing Oscine's template into Noctalia — the one write into another
 * program's configuration, made only when the operator presses Set up.
 *
 * Noctalia renders user templates on every colour-scheme change. Quickshell v4
 * reads them from `user-templates.toml` under `[templates.<name>]`; v5+ merges
 * every `*.toml` in its config directory and then a GUI-owned `settings.toml`
 * state overlay, under `[theme.templates.user.<name>]`. Either way the entry
 * names an input template and an output path, and we install both halves: the
 * template file under `templates/`, and the entry that points it at the palette
 * path main watches.
 *
 * Edited as text, not round-tripped through a TOML serialiser, so comments,
 * formatting and every other template survive. The parser is only used to read
 * what is there and to prove the result still parses before it is written.
 *
 * Every refusal is written for the operator and crosses IPC as it is, so none
 * of them names an absolute path — files are named relative to Noctalia's
 * config folder.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { parse, stringify } from 'smol-toml'
import {
  NOCTALIA_TEMPLATE_NAME,
  noctaliaTemplate,
  type NoctaliaSetupResult,
  type NoctaliaVersion
} from '@shared/theme'

const NAME = NOCTALIA_TEMPLATE_NAME

function readOptional(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

function sectionFor(version: 'v4' | 'v5'): string[] {
  return version === 'v4' ? ['templates'] : ['theme', 'templates', 'user']
}

function templateEntry(original: string, section: string[]): unknown {
  let table: unknown = parse(original)
  for (const key of section) table = (table as Record<string, unknown> | undefined)?.[key]
  return (table as Record<string, unknown> | undefined)?.[NAME]
}

/**
 * Add our entry, or repoint one we made (same input template) whose output path
 * has gone stale. Refuses anything it did not create.
 */
export function registerNoctaliaTemplate(
  original: string,
  version: 'v4' | 'v5',
  input: string,
  output: string
): string {
  const section = sectionFor(version)
  const existing = templateEntry(original, section) as Record<string, unknown> | undefined
  if (existing === undefined) {
    const addition = `[${[...section, NAME].join('.')}]\n${stringify({ input_path: input, output_path: output })}`
    const result = `${original.trimEnd()}\n\n# Oscine desktop palette\n${addition}\n`
    parse(result) // Reject a clash with an inline table before touching the file.
    return result
  }
  if (existing.input_path !== input) {
    throw new Error(
      `An "${NAME}" template that Oscine did not create already exists. Rename or remove that entry in Noctalia, then set up again.`
    )
  }
  if (existing.enabled === false) {
    throw new Error(
      `The "${NAME}" template is disabled in Noctalia. Enable it there, or remove the entry and set up again.`
    )
  }
  if (existing.output_path === output) return original

  const stale =
    typeof existing.output_path === 'string'
      ? stringify({ output_path: existing.output_path }).trim()
      : null
  const result =
    stale && original.split(stale).length === 2
      ? original.replace(stale, () => stringify({ output_path: output }).trim())
      : null
  if (
    !result ||
    (templateEntry(result, section) as Record<string, unknown>).output_path !== output
  ) {
    throw new Error(
      `Could not update the output path of the existing "${NAME}" template. Remove that entry in Noctalia, then set up again.`
    )
  }
  return result
}

export function detectNoctaliaVersion(configDir: string): 'v4' | 'v5' {
  const files = existsSync(configDir) ? readdirSync(configDir) : []
  const v4 = files.includes('settings.json') || files.includes('user-templates.toml')
  const v5 = files.some((file) => file.endsWith('.toml') && file !== 'user-templates.toml')
  if (v4 === v5) {
    throw new Error(
      'Could not tell which Noctalia is installed. Choose Quickshell v4 or Noctalia v5+ and try again.'
    )
  }
  return v4 ? 'v4' : 'v5'
}

export interface NoctaliaSetupOptions {
  configDir: string
  palettePath: string
  version: NoctaliaVersion
  /** v5's GUI-owned overlay, checked for a competing entry. */
  stateSettingsPath?: string
}

export function setupNoctalia({
  configDir,
  palettePath,
  version: requested,
  stateSettingsPath
}: NoctaliaSetupOptions): NoctaliaSetupResult {
  if (!['auto', 'v4', 'v5'].includes(requested)) throw new Error('Unknown Noctalia version.')
  const version = requested === 'auto' ? detectNoctaliaVersion(configDir) : requested
  const templatePath = join(configDir, 'templates', `${NAME}.json`)
  const configPath = join(configDir, version === 'v4' ? 'user-templates.toml' : `${NAME}.toml`)

  if (version === 'v5') {
    // v5 merges config fragments and then its state overlay. A second entry in
    // either could silently replace our output path or disable the template.
    const files = existsSync(configDir)
      ? readdirSync(configDir)
          .filter((name) => name.endsWith('.toml'))
          .map((name) => join(configDir, name))
      : []
    if (stateSettingsPath) files.push(stateSettingsPath)
    for (const file of files) {
      if (
        file !== configPath &&
        templateEntry(readOptional(file), sectionFor('v5')) !== undefined
      ) {
        throw new Error(
          `An "${NAME}" template is already declared in Noctalia's ${basename(file)}. Remove that entry, then set up again.`
        )
      }
    }
  }

  const original = readOptional(configPath)
  const previousOutput = (
    templateEntry(original, sectionFor(version)) as Record<string, unknown> | undefined
  )?.output_path
  const next = registerNoctaliaTemplate(original, version, templatePath, palettePath)

  const template = noctaliaTemplate()
  const previousTemplate = readOptional(templatePath)
  if (previousTemplate && previousTemplate !== template) {
    throw new Error(
      `Noctalia's templates/${NAME}.json has been changed by hand. Move it aside, then set up again.`
    )
  }

  mkdirSync(dirname(templatePath), { recursive: true })
  mkdirSync(dirname(palettePath), { recursive: true })
  if (!previousTemplate) writeFileSync(templatePath, template, { flag: 'wx' })
  // Written in place rather than renamed over, so a dotfile symlink survives.
  if (next !== original) writeFileSync(configPath, next)

  // Carry the last generated palette across a repoint, so sync lands now rather
  // than at the next scheme change.
  if (
    typeof previousOutput === 'string' &&
    previousOutput !== palettePath &&
    !existsSync(palettePath) &&
    existsSync(previousOutput)
  ) {
    copyFileSync(previousOutput, palettePath)
  }

  return {
    version,
    message:
      version === 'v4'
        ? 'Template installed. In Noctalia, open Settings → Color Scheme → Templates, turn on User templates, then change the color scheme once.'
        : 'Template installed. Reload Noctalia’s configuration, then apply a color scheme once.'
  }
}
