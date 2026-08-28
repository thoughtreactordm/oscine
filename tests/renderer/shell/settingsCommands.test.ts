import { describe, expect, it, vi } from 'vitest'
import type { SettingDescriptor } from '@shared/settings'
import {
  buildSettingsCommands,
  isInlineControl,
  type SettingsCommandDeps
} from '../../../src/renderer/shell/settingsCommands'
import { matchCommands } from '../../../src/renderer/shell/commandRegistry'

/**
 * The Settings group, D21's `/` mode. Generated from W8's registry, never a
 * second list (product rule 4). The decision this pins is the "inline for
 * simple, jump for complex" split: a toggle/select flips in place with a toast,
 * everything else hands off to `settingsNav.reveal`. A hand-built descriptor set
 * rather than the shipped registry, so the test states its own facts and does
 * not move when a real key does.
 */

const TOGGLE = {
  key: 'interface.showFoo',
  internal: false,
  control: { kind: 'toggle' },
  keywords: ['foo', 'widget'],
  label: 'Show Foo',
  category: 'interface'
} as unknown as SettingDescriptor

const SELECT = {
  key: 'interface.albumArtSize',
  internal: false,
  control: {
    kind: 'select',
    options: [
      { value: 'small', label: 'Small' },
      { value: 'medium', label: 'Medium' },
      { value: 'large', label: 'Large' }
    ]
  },
  keywords: ['artwork', 'cover'],
  label: 'Album Art Size',
  category: 'interface'
} as unknown as SettingDescriptor

const NUMBER = {
  key: 'audio.crossfadeMs',
  internal: false,
  control: { kind: 'number', min: 0 },
  keywords: ['crossfade', 'gapless'],
  label: 'Crossfade',
  category: 'audio'
} as unknown as SettingDescriptor

const INTERNAL = {
  key: 'view.columns',
  internal: true,
  control: null,
  keywords: [],
  label: 'Columns',
  category: 'interface'
} as unknown as SettingDescriptor

function deps(overrides: Partial<SettingsCommandDeps> = {}): SettingsCommandDeps {
  return {
    get: vi.fn(),
    set: vi.fn(),
    reveal: vi.fn(),
    goToSettings: vi.fn(),
    notify: vi.fn(),
    close: vi.fn(),
    descriptors: [TOGGLE, SELECT, NUMBER, INTERNAL],
    ...overrides
  }
}

function command(commands: ReturnType<typeof buildSettingsCommands>, key: string) {
  const found = commands.find((c) => c.id === `setting:${key}`)
  if (!found) throw new Error(`no command for ${key}`)
  return found
}

describe('isInlineControl', () => {
  it('is true for toggle and select, false for the rest and for null', () => {
    expect(isInlineControl({ kind: 'toggle' })).toBe(true)
    expect(isInlineControl({ kind: 'select', options: [] })).toBe(true)
    expect(isInlineControl({ kind: 'number' })).toBe(false)
    expect(isInlineControl(null)).toBe(false)
  })
})

describe('buildSettingsCommands', () => {
  it('lists one command per non-internal key, skipping internal ones', () => {
    const commands = buildSettingsCommands(deps())
    expect(commands.map((c) => c.id)).toEqual([
      'setting:interface.showFoo',
      'setting:interface.albumArtSize',
      'setting:audio.crossfadeMs'
    ])
  })

  it('carries the key, label and registry keywords for matching', () => {
    const commands = buildSettingsCommands(deps())
    // A registry keyword the label lacks.
    expect(matchCommands(commands, 'gapless').map((c) => c.id)).toEqual([
      'setting:audio.crossfadeMs'
    ])
    // The dotted key itself.
    expect(matchCommands(commands, 'interface.albumArtSize').map((c) => c.id)).toEqual([
      'setting:interface.albumArtSize'
    ])
    // A word from the label.
    expect(matchCommands(commands, 'crossfade').map((c) => c.id)).toEqual([
      'setting:audio.crossfadeMs'
    ])
  })

  it('flips a boolean setting inline, without jumping', async () => {
    const d = deps({ get: vi.fn(() => false) })
    await command(buildSettingsCommands(d), 'interface.showFoo').run()

    expect(d.set).toHaveBeenCalledWith('interface.showFoo', true)
    expect(d.notify).toHaveBeenCalledOnce()
    expect(d.reveal).not.toHaveBeenCalled()
    expect(d.goToSettings).not.toHaveBeenCalled()
    expect(d.close).toHaveBeenCalledOnce()
  })

  it('advances a select setting to the next option, inline', async () => {
    const d = deps({ get: vi.fn(() => 'medium') })
    await command(buildSettingsCommands(d), 'interface.albumArtSize').run()

    expect(d.set).toHaveBeenCalledWith('interface.albumArtSize', 'large')
    expect(d.reveal).not.toHaveBeenCalled()
  })

  it('wraps a select setting from the last option back to the first', async () => {
    const d = deps({ get: vi.fn(() => 'large') })
    await command(buildSettingsCommands(d), 'interface.albumArtSize').run()
    expect(d.set).toHaveBeenCalledWith('interface.albumArtSize', 'small')
  })

  it('jumps a complex setting through settingsNav.reveal and does not set', async () => {
    const d = deps()
    await command(buildSettingsCommands(d), 'audio.crossfadeMs').run()

    expect(d.reveal).toHaveBeenCalledWith('audio.crossfadeMs')
    expect(d.goToSettings).toHaveBeenCalledOnce()
    expect(d.set).not.toHaveBeenCalled()
    expect(d.close).toHaveBeenCalledOnce()
  })

  it('defaults to the shipped registry when no descriptors are injected', () => {
    const commands = buildSettingsCommands({
      get: vi.fn(),
      set: vi.fn(),
      reveal: vi.fn(),
      goToSettings: vi.fn(),
      notify: vi.fn(),
      close: vi.fn()
    })
    expect(commands.length).toBeGreaterThan(0)
    expect(commands.every((c) => c.id.startsWith('setting:'))).toBe(true)
    expect(commands.map((c) => c.id)).not.toContain('setting:interface.onboardingCompleted')
  })
})
