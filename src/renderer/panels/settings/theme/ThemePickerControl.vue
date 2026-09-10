<script setup lang="ts">
import { computed } from 'vue'
import { useSettings } from '@renderer/settings'
import { useInstalledThemes } from './useInstalledThemes'
import { sameSettingValue, THEME_MODE_KEY, THEME_OVERRIDES_KEY } from '@shared/settings'
import type { SettingDescriptor } from '@shared/settings'
import {
  BUILT_IN_THEMES,
  type InstalledTheme,
  type ThemeFileMode,
  type ThemeOverrides
} from '@shared/theme'

/**
 * `theme.name` on the settings surface, and the register's third custom entry.
 *
 * A static `select` cannot list the operator's `.osctheme` files — those are
 * read from a folder at runtime, not known when the descriptor is written — so
 * this control merges the built-in themes with whatever has been dropped in,
 * each marked by a leading icon so custom reads apart from shipped.
 *
 * Selecting a built-in sets `theme.name` and leaves any authored overrides in
 * place — unless a custom theme is the look in force, in which case the overrides
 * are cleared so the pick actually lands on the clean preset (see `update`).
 * Selecting a custom theme applies the *whole* authored look
 * — base, mode and overrides, three validated `settings.set` writes — because a
 * theme file is a complete look, not a patch. So unlike `ThemeEditorControl`,
 * this one reaches for the store: one `update:modelValue` cannot carry three
 * keys.
 *
 * Which entry shows as selected is computed, not stored: a custom theme is
 * "current" exactly while the live `theme.name`/`mode`/`overrides` still equal
 * the file's. Edit a token afterwards and the dropdown falls back to the base
 * built-in — the honest "you have customised off the preset" state, and the
 * reason no extra pointer key was needed.
 */
const props = defineProps<{
  descriptor: SettingDescriptor
  modelValue: unknown
  disabled?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [unknown] }>()

const settings = useSettings()
const { installed } = useInstalledThemes()

const CUSTOM_PREFIX = 'custom:'

interface SelectItem {
  label: string
  value: string
  icon: string
}

/**
 * Built-ins first, then the dropped-in themes, each carrying a leading icon so
 * custom reads apart from shipped at a glance — a palette for the built-ins, a
 * download for the ones the operator brought in. A flat list rather than two
 * groups with a separator on purpose: a separator item has no `value`, which
 * would widen `USelect`'s inferred value type and defeat `value-key`.
 */
const items = computed<SelectItem[]>(() => {
  const builtIns: SelectItem[] = BUILT_IN_THEMES.map((theme) => ({
    label: theme.label,
    value: theme.id,
    icon: 'i-tabler-palette'
  }))
  const customs: SelectItem[] = installed.value.map((theme) => ({
    label: theme.name,
    value: `${CUSTOM_PREFIX}${theme.id}`,
    icon: 'i-tabler-download'
  }))
  return [...builtIns, ...customs]
})

/**
 * The dropped-in theme the live surface currently equals, if any. Compared with
 * `sameSettingValue` — the same JSON equality the store and W8-7's filter use —
 * so a match here means the same thing "unchanged" means everywhere else.
 */
function matchingCustom(): InstalledTheme | undefined {
  const mode = settings.get<ThemeFileMode>(THEME_MODE_KEY)
  const overrides = settings.get<ThemeOverrides>(THEME_OVERRIDES_KEY)
  return installed.value.find(
    (theme) =>
      theme.base === props.modelValue &&
      theme.mode === mode &&
      sameSettingValue(theme.overrides, overrides)
  )
}

const selectValue = computed(() => {
  const match = matchingCustom()
  return match ? `${CUSTOM_PREFIX}${match.id}` : String(props.modelValue ?? '')
})

function update(value: string): void {
  if (!value.startsWith(CUSTOM_PREFIX)) {
    // A built-in. Normally this moves only the base theme and leaves any authored
    // overrides in place — pick a preset, keep your tweaks. But when a custom
    // theme is the look in force, picking its *own* base changes nothing (the base
    // key already holds that id) so the dropdown would snap straight back to the
    // custom, making it impossible to return to the plain preset. Breaking away
    // from a custom therefore clears the overrides, landing on the clean built-in.
    if (matchingCustom()) {
      void settings.set(THEME_OVERRIDES_KEY, {})
    }
    emit('update:modelValue', value)
    return
  }

  const id = value.slice(CUSTOM_PREFIX.length)
  const chosen = installed.value.find((theme) => theme.id === id)
  if (!chosen) return

  // The whole authored look. Overrides and mode go straight to the store; the
  // base rides the descriptor's own v-model so its write path stays the one
  // thing that moves `theme.name`.
  void settings.set(THEME_OVERRIDES_KEY, chosen.overrides)
  void settings.set(THEME_MODE_KEY, chosen.mode)
  emit('update:modelValue', chosen.base)
}
</script>

<template>
  <USelect
    :model-value="selectValue"
    value-key="value"
    :items="items"
    :disabled="disabled"
    size="sm"
    class="w-44"
    :aria-label="descriptor.label"
    @update:model-value="update($event)"
  />
</template>
