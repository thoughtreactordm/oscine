import { computed, type ComputedRef } from 'vue'
import { useRouter } from 'vue-router'
import type { DropdownMenuItem } from '@nuxt/ui'
import { useEqualizerStore } from '@renderer/stores/equalizer'
import { useToolsStore } from '@renderer/stores/tools'
import { buildToolsMenu } from './toolsMenu'

/**
 * The verbs behind every quick route into Tools — the title-bar menu, the tab
 * row's split button and the palette — bound to the real stores and router.
 *
 * `switchPreset` turns the master switch on as it recalls: from a menu or the
 * palette the operator is asking to *hear* that curve, and a recall into a
 * bypassed EQ would look like a click that did nothing. The pane's own preset
 * selector stays a pure recall; it sits beside the switch, so there the two
 * are separate on purpose.
 */
export interface ToolsMenu {
  items: ComputedRef<DropdownMenuItem[][]>
  openTool: (id: string) => void
  switchPreset: (id: string) => void
  toggleEqualizer: () => void
}

export function useToolsMenu(): ToolsMenu {
  const router = useRouter()
  const tools = useToolsStore()
  const equalizer = useEqualizerStore()

  function openTool(id: string): void {
    tools.select(id)
    void router.push({ name: 'tools' })
  }

  function switchPreset(id: string): void {
    equalizer.applyPreset(id)
    if (!equalizer.enabled) equalizer.enabled = true
  }

  function toggleEqualizer(): void {
    equalizer.enabled = !equalizer.enabled
  }

  const items = computed<DropdownMenuItem[][]>(() =>
    buildToolsMenu({
      tools: tools.tools,
      presets: equalizer.presets,
      appliedPresetId: equalizer.appliedPresetId,
      equalizerEnabled: equalizer.enabled,
      openTool,
      switchPreset,
      setEqualizerEnabled: (enabled) => {
        equalizer.enabled = enabled
      }
    })
  )

  return { items, openTool, switchPreset, toggleEqualizer }
}
