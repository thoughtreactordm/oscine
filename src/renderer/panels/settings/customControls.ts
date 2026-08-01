import type { Component } from 'vue'
import OutputDeviceControl from './OutputDeviceControl.vue'

/**
 * The escape hatch, and the register of who has used it.
 *
 * `control: { kind: 'custom', component: 'X' }` names an entry here. Everything
 * else on the settings surface is drawn by `SettingControl`, and that is the
 * property worth protecting: a custom control is a small settings UI that has to
 * be maintained separately, and one of them is a reasonable answer to a genuinely
 * bespoke key while a dozen means the generated surface has quietly stopped
 * being generated.
 *
 * Empty was the correct state until W8-9. A name with no entry renders as a
 * stated gap rather than as nothing, because a descriptor that silently draws no
 * control is a setting the operator cannot change and cannot see is missing.
 *
 * `OutputDeviceControl` is the first entry and the kind of key this hatch was
 * left open for: its options are not a list the registry could hold, they are
 * whatever hardware is connected at the moment the view is open.
 */
export const CUSTOM_SETTING_CONTROLS: Readonly<Record<string, Component>> = Object.freeze({
  OutputDeviceControl
})

export function customSettingControl(name: string): Component | null {
  return CUSTOM_SETTING_CONTROLS[name] ?? null
}
