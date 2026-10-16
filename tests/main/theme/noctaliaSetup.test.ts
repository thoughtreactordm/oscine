import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parse } from 'smol-toml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  detectNoctaliaVersion,
  registerNoctaliaTemplate,
  setupNoctalia
} from '../../../src/main/theme/noctaliaSetup'
import { noctaliaTemplate } from '../../../src/shared/theme'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oscine-noctalia-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const palettePath = (): string => join(root, 'state', 'noctalia-palette.json')

describe('registerNoctaliaTemplate', () => {
  it('keeps existing v4 templates and comments, quotes paths, and is idempotent', () => {
    const original =
      '# my templates\n[templates.editor]\ninput_path = "editor.json"\noutput_path = "out.json"\n'
    const input = join(root, 'a "quoted" directory', 'template.json')
    const output = join(root, 'palette.json')
    const next = registerNoctaliaTemplate(original, 'v4', input, output)

    expect(next).toContain(original.trimEnd())
    expect((parse(next).templates as Record<string, unknown>).oscine).toEqual({
      input_path: input,
      output_path: output
    })
    expect(registerNoctaliaTemplate(next, 'v4', input, output)).toBe(next)
  })

  it('refuses a disabled entry it made', () => {
    const template = join(root, 'templates', 'oscine.json')
    const original = `[templates.oscine]\ninput_path = ${JSON.stringify(template)}\noutput_path = "x"\nenabled = false\n`
    expect(() => registerNoctaliaTemplate(original, 'v4', template, 'y')).toThrow('disabled')
  })
})

describe('setupNoctalia', () => {
  it('refuses an entry it did not create — quoted keys included — before touching anything', () => {
    const original = '[templates."oscine"]\ninput_path = "mine"\noutput_path = "mine-out"\n'
    writeFileSync(join(root, 'user-templates.toml'), original)

    expect(() =>
      setupNoctalia({ configDir: root, palettePath: palettePath(), version: 'v4' })
    ).toThrow('did not create')
    expect(readFileSync(join(root, 'user-templates.toml'), 'utf8')).toBe(original)
    expect(existsSync(join(root, 'templates'))).toBe(false)
  })

  it('installs the template and a v4 entry', () => {
    writeFileSync(join(root, 'settings.json'), '{}')
    const result = setupNoctalia({ configDir: root, palettePath: palettePath(), version: 'auto' })

    expect(result.version).toBe('v4')
    expect(readFileSync(join(root, 'templates', 'oscine.json'), 'utf8')).toBe(noctaliaTemplate())
    expect(parse(readFileSync(join(root, 'user-templates.toml'), 'utf8'))).toHaveProperty(
      'templates.oscine.output_path',
      palettePath()
    )
  })

  it('registers v5 in its own config fragment, and is repeatable', () => {
    writeFileSync(join(root, 'appearance.toml'), '[theme]\nmode = "dark"\n')
    const options = { configDir: root, palettePath: palettePath(), version: 'auto' } as const
    const result = setupNoctalia(options)

    expect(result.version).toBe('v5')
    expect(parse(readFileSync(join(root, 'oscine.toml'), 'utf8'))).toHaveProperty(
      'theme.templates.user.oscine.output_path',
      palettePath()
    )
    expect(setupNoctalia(options)).toEqual(result)
  })

  it('repoints an entry it made for another path and carries the palette across', () => {
    const template = join(root, 'templates', 'oscine.json')
    const stale = join(root, 'old', 'noctalia-palette.json')
    mkdirSync(dirname(stale), { recursive: true })
    writeFileSync(stale, '{"dark":{}}')
    writeFileSync(
      join(root, 'oscine.toml'),
      registerNoctaliaTemplate('# mine\n', 'v5', template, stale)
    )

    setupNoctalia({ configDir: root, palettePath: palettePath(), version: 'v5' })

    const next = readFileSync(join(root, 'oscine.toml'), 'utf8')
    expect(next).toContain('# mine')
    expect(parse(next)).toHaveProperty('theme.templates.user.oscine', {
      input_path: template,
      output_path: palettePath()
    })
    expect(readFileSync(palettePath(), 'utf8')).toBe('{"dark":{}}')
  })

  it('does not overwrite a hand-edited template, and names no absolute path saying so', () => {
    mkdirSync(join(root, 'templates'))
    writeFileSync(join(root, 'templates', 'oscine.json'), 'custom')

    let message = ''
    try {
      setupNoctalia({ configDir: root, palettePath: palettePath(), version: 'v4' })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('changed by hand')
    expect(message).not.toContain(root)
    expect(existsSync(join(root, 'user-templates.toml'))).toBe(false)
  })

  it('refuses a v5 entry in another fragment or in the GUI state overlay', () => {
    const duplicate = '[theme.templates.user.oscine]\nenabled = false\n'
    const fragment = join(root, 'other.toml')
    writeFileSync(fragment, duplicate)
    expect(() =>
      setupNoctalia({ configDir: root, palettePath: palettePath(), version: 'v5' })
    ).toThrow('already declared')

    unlinkSync(fragment)
    const state = join(root, 'state-settings.toml')
    writeFileSync(state, duplicate)
    expect(() =>
      setupNoctalia({
        configDir: root,
        palettePath: palettePath(),
        version: 'v5',
        stateSettingsPath: state
      })
    ).toThrow('already declared')
    expect(existsSync(join(root, 'oscine.toml'))).toBe(false)
  })
})

describe('detectNoctaliaVersion', () => {
  it('asks for a choice when nothing, or both, are installed', () => {
    expect(() => detectNoctaliaVersion(root)).toThrow('Choose')
    writeFileSync(join(root, 'settings.json'), '{}')
    expect(detectNoctaliaVersion(root)).toBe('v4')
    writeFileSync(join(root, 'theme.toml'), '')
    expect(() => detectNoctaliaVersion(root)).toThrow('Choose')
  })
})
