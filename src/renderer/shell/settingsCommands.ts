import {
  SETTINGS_REGISTRY,
  settingCategory,
  type SettingControl,
  type SettingDescriptor
} from '@shared/settings'
import type { Command } from './commandRegistry'

/**
 * The Settings group — D21's `/` mode, generated from W8's declarative registry
 * rather than a second list (product rule 4).
 *
 * The registry already carries every key's label, help and search keywords, so
 * a settings command is one more projection of it — the same discipline that
 * keeps the settings *view* from drifting from the keys it edits. The split D21
 * calls for lives in the `control`: a `toggle` or a `select` is a "simple" key
 * that flips in place with a toast, and everything else is "complex" and hands
 * off to `settingsNav.reveal`, which is the exact mechanism W8 built for a deep
 * link. Internal keys (column widths, open tabs) have no control and no row, so
 * they are not commands either.
 *
 * Pure and injected like `actionCommands`: the registry is the only import with
 * weight, and reading, writing, revealing and toasting all arrive as `deps` so
 * the tests exercise the flip-vs-jump decision without a store or a router.
 */

export interface SettingsCommandDeps {
  /** The current global value of a key, read at run time. */
  get: (key: string) => unknown
  /** Persist a value at the global scope. */
  set: (key: string, value: unknown) => void | Promise<unknown>
  /** Jump the Settings view to a key — the "complex" branch (W8's seam). */
  reveal: (key: string) => void
  /** Bring the Settings surface on screen, since a reveal only aims it. */
  goToSettings: () => void
  /** The D22 confirmation toast, for the inline flips. */
  notify: (message: string) => void
  /** Dismiss the palette. */
  close: () => void
  /** The keys to offer. Defaults to the whole registry; injected for tests. */
  descriptors?: readonly SettingDescriptor[]
}

/**
 * Whether a control flips in place. Toggle and select are the two the palette
 * can complete without leaving the modal; the rest — a number, a slider, a
 * path, a free string, a bespoke component — want the full row.
 */
export function isInlineControl(control: SettingControl<unknown> | null): boolean {
  return control !== null && (control.kind === 'toggle' || control.kind === 'select')
}

function iconFor(descriptor: SettingDescriptor): string {
  return settingCategory(descriptor.category).icon
}

/**
 * Label, key, and the registry's own keywords — everything the `/` mode matches
 * on. Lowercased, because `matchCommands` lowercases the needle and compares
 * verbatim, the same convention the Views group's keywords keep.
 */
function keywordsFor(descriptor: SettingDescriptor): string[] {
  return [
    descriptor.key.toLowerCase(),
    ...descriptor.keywords.map((keyword) => keyword.toLowerCase()),
    ...descriptor.label.toLowerCase().split(/\s+/)
  ]
}

export function buildSettingsCommands(deps: SettingsCommandDeps): Command[] {
  const descriptors = deps.descriptors ?? SETTINGS_REGISTRY
  const commands: Command[] = []

  for (const descriptor of descriptors) {
    // Internal keys have no control and no settings row; they are not commands.
    if (descriptor.internal || descriptor.control === null) continue

    commands.push({
      id: `setting:${descriptor.key}`,
      label: descriptor.label,
      icon: iconFor(descriptor),
      keywords: keywordsFor(descriptor),
      run: () => runSetting(descriptor, deps)
    })
  }

  return commands
}

async function runSetting(descriptor: SettingDescriptor, deps: SettingsCommandDeps): Promise<void> {
  const control = descriptor.control

  if (control?.kind === 'toggle') {
    const next = !(deps.get(descriptor.key) as boolean)
    await deps.set(descriptor.key, next)
    deps.notify(`${descriptor.label}: ${next ? 'On' : 'Off'}`)
    deps.close()
    return
  }

  if (control?.kind === 'select') {
    const options = control.options
    if (options.length > 0) {
      const current = deps.get(descriptor.key)
      const index = options.findIndex((option) => option.value === current)
      // -1 (an unknown current value) advances to the first option, which is the
      // same "step forward" a known value gets and never leaves the key unset.
      const nextOption = options[(index + 1) % options.length]
      await deps.set(descriptor.key, nextOption.value)
      deps.notify(`${descriptor.label}: ${nextOption.label}`)
    }
    deps.close()
    return
  }

  // Everything richer: aim the Settings view at the key, then go there.
  deps.reveal(descriptor.key)
  deps.goToSettings()
  deps.close()
}
