/**
 * The Tools menu — one list, two faces.
 *
 * The title bar's Tools menu and the dropdown half of the Tools tab's split
 * button show exactly the same thing: every tool, then the equalizer's master
 * switch and its presets to switch between. Both render this one builder, so
 * the two cannot drift — the same reason the View menu and the tab row both
 * read `shellTabs`.
 *
 * Pure and alias-free so the tests drive it with fakes; the items are a
 * structural subset of Nuxt UI's `DropdownMenuItem`, which the caller hands
 * straight to `UDropdownMenu`.
 */

export interface ToolsMenuItem {
  label?: string
  icon?: string
  type?: 'label' | 'separator' | 'checkbox'
  checked?: boolean
  disabled?: boolean
  children?: ToolsMenuItem[]
  onSelect?: () => void
  onUpdateChecked?: (checked: boolean) => void
}

export interface ToolsMenuDeps {
  tools: readonly { readonly id: string; readonly label: string; readonly icon: string }[]
  presets: readonly { readonly id: string; readonly name: string }[]
  /** The preset the live curve was recalled from, if it still matches one. */
  appliedPresetId: string | null
  equalizerEnabled: boolean
  openTool: (id: string) => void
  switchPreset: (id: string) => void
  setEqualizerEnabled: (enabled: boolean) => void
}

export function buildToolsMenu(deps: ToolsMenuDeps): ToolsMenuItem[][] {
  const tools: ToolsMenuItem[] = deps.tools.map((tool) => ({
    label: tool.label,
    icon: tool.icon,
    onSelect: () => deps.openTool(tool.id)
  }))

  /*
   * The presets are a submenu rather than rows of this one: a library of saved
   * curves can run long, and inline it would push the tools themselves out of
   * sight. Checkboxes, like Repeat in Playback, so the menu says which curve is
   * live. With nothing saved the submenu still opens — to say so — rather than
   * vanishing, since the master switch above it is still worth a visit.
   */
  const presetItems: ToolsMenuItem[] =
    deps.presets.length > 0
      ? deps.presets.map((preset) => ({
          label: preset.name,
          type: 'checkbox',
          checked: deps.equalizerEnabled && deps.appliedPresetId === preset.id,
          onUpdateChecked: () => deps.switchPreset(preset.id)
        }))
      : [{ label: 'No saved presets', disabled: true }]

  const equalizer: ToolsMenuItem[] = [
    {
      label: 'Equalizer on',
      icon: 'i-tabler-adjustments',
      type: 'checkbox',
      checked: deps.equalizerEnabled,
      onUpdateChecked: (checked) => deps.setEqualizerEnabled(checked)
    },
    {
      label: 'Equalizer preset',
      icon: 'i-tabler-adjustments-horizontal',
      children: presetItems
    }
  ]

  return [tools, equalizer]
}
