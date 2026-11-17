import type { Command } from './commandRegistry'

/**
 * The Tools shelf and the equalizer's presets, as palette commands.
 *
 * The Tools tab is one route with a rail, so the Views group could only ever
 * reach the tab and leave the operator to pick a tool from there. These go
 * straight to a tool, and — the EQ being the tool people reach for mid-listen —
 * switch preset without opening anything at all. They ride the Actions group
 * beside the visualizer verbs.
 *
 * Holds no `@renderer` import and no Pinia: the tool list, the presets and the
 * verbs arrive as `deps`, so the tests drive it with fakes. The presets are
 * settings-backed and change under the palette, so the caller rebuilds on read
 * rather than once at mount the way the visualizer list is built.
 */

export interface ToolCommandDeps {
  /** The Tools shelf, in rail order. */
  tools: readonly { readonly id: string; readonly label: string; readonly icon: string }[]
  /** The saved equalizer presets, in their saved order. */
  presets: readonly { readonly id: string; readonly name: string }[]
  /** Whether the equalizer's master switch is on, for the toggle's toast. */
  equalizerEnabled: boolean
  /** Select a tool and go to the Tools tab. */
  openTool: (id: string) => void
  /** Recall a preset — and turn the EQ on, since a switched-to curve you cannot hear is no switch. */
  switchPreset: (id: string) => void
  toggleEqualizer: () => void
  /** The D22 confirmation toast. */
  notify: (message: string) => void
  /** Dismiss the palette. */
  close: () => void
}

const TOOL_KEYWORDS = ['tool', 'tools', 'open']
const EQ_KEYWORDS = ['equalizer', 'equaliser', 'eq', 'preset', 'tone']

export function buildToolCommands(deps: ToolCommandDeps): Command[] {
  return [
    ...deps.tools.map((tool): Command => ({
      id: `tool:open:${tool.id}`,
      label: `Open ${tool.label}`,
      icon: tool.icon,
      keywords: [...TOOL_KEYWORDS, tool.id, tool.label.toLowerCase()],
      run: () => {
        // Navigation, not a state change — no toast, the tool on screen is the confirmation.
        deps.close()
        deps.openTool(tool.id)
      }
    })),
    {
      id: 'equalizer:toggle',
      label: deps.equalizerEnabled ? 'Turn equalizer off' : 'Turn equalizer on',
      icon: 'i-tabler-adjustments',
      keywords: [...EQ_KEYWORDS, 'toggle', 'enable', 'disable', 'bypass', 'on', 'off'],
      run: () => {
        deps.toggleEqualizer()
        deps.notify(deps.equalizerEnabled ? 'Equalizer off' : 'Equalizer on')
        deps.close()
      }
    },
    ...deps.presets.map((preset): Command => ({
      id: `equalizer:preset:${preset.id}`,
      label: `Equalizer: ${preset.name}`,
      icon: 'i-tabler-adjustments-horizontal',
      keywords: [...EQ_KEYWORDS, 'switch', preset.name.toLowerCase()],
      run: () => {
        deps.switchPreset(preset.id)
        deps.notify(`Equalizer: ${preset.name}`)
        deps.close()
      }
    }))
  ]
}
