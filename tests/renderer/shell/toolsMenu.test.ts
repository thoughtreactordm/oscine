import { describe, expect, it, vi } from 'vitest'
import { buildToolsMenu, type ToolsMenuDeps } from '../../../src/renderer/shell/toolsMenu'

/** The one Tools menu behind the title bar and the tab row's split button. */

function deps(overrides: Partial<ToolsMenuDeps> = {}): ToolsMenuDeps {
  return {
    tools: [
      { id: 'cd-rip', label: 'Rip CD', icon: 'i-a' },
      { id: 'equalizer', label: 'Equalizer', icon: 'i-b' }
    ],
    presets: [
      { id: 'p1', name: 'Car' },
      { id: 'p2', name: 'Flat' }
    ],
    appliedPresetId: 'p2',
    equalizerEnabled: true,
    openTool: vi.fn(),
    switchPreset: vi.fn(),
    setEqualizerEnabled: vi.fn(),
    ...overrides
  }
}

describe('buildToolsMenu', () => {
  it('lists every tool, then the EQ switch and a preset submenu', () => {
    const [tools, eq] = buildToolsMenu(deps())
    expect(tools.map((item) => item.label)).toEqual(['Rip CD', 'Equalizer'])
    expect(eq.map((item) => item.label)).toEqual(['Equalizer on', 'Equalizer preset'])
    expect(eq[1].children?.map((item) => [item.label, item.checked])).toEqual([
      ['Car', false],
      ['Flat', true]
    ])
  })

  it('routes a tool and switches a preset', () => {
    const d = deps()
    const [tools, eq] = buildToolsMenu(d)
    tools[0].onSelect?.()
    expect(d.openTool).toHaveBeenCalledWith('cd-rip')
    eq[1].children?.[0].onUpdateChecked?.(true)
    expect(d.switchPreset).toHaveBeenCalledWith('p1')
    eq[0].onUpdateChecked?.(false)
    expect(d.setEqualizerEnabled).toHaveBeenCalledWith(false)
  })

  it('ticks no preset while the EQ is off', () => {
    const [, eq] = buildToolsMenu(deps({ equalizerEnabled: false }))
    expect(eq[0].checked).toBe(false)
    expect(eq[1].children?.every((item) => !item.checked)).toBe(true)
  })

  it('says so when nothing is saved', () => {
    const [, eq] = buildToolsMenu(deps({ presets: [], appliedPresetId: null }))
    expect(eq[1].children).toEqual([{ label: 'No saved presets', disabled: true }])
  })
})
