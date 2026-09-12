import { computed, ref, type ComputedRef, type WritableComputedRef } from 'vue'
import {
  AUDIO_EQ_ACTIVE,
  AUDIO_EQ_ENABLED,
  AUDIO_EQ_PRESETS,
  sameSettingValue
} from '@shared/settings'
import { type EqualizerPreset, type EqualizerSpec } from '@shared/audio/equalizer'

/**
 * The equalizer pane's state and the only writer of its three settings keys.
 *
 * There is no separate engine-facing "apply" path and no staged state. Every
 * mutation here writes a settings key; the controller's watcher on
 * `audioPreferences.equalizer` turns that write into audio. So `applyPreset` is a
 * plain assignment to `audio.eq.active` — the curve reaches the biquads because
 * the setting changed, not because this store called the engine.
 *
 * Preset identity is by `id`, generated once and never derived from the name, so
 * a rename cannot orphan a future per-entity reference (W19-6) and W19-4's list
 * can key on something stable. Duplicate names are allowed but the pane flags
 * them: two "Car" presets is a mess the operator made, not an error worth losing
 * their work over mid-session.
 *
 * Kept apart from the Pinia store in `equalizer.ts` the way `lyricsLoader` is kept
 * apart from the lyrics store: nothing here imports `@renderer`, so a test drives
 * it with a fixture settings surface and never installs Pinia.
 */

/** The slice of the settings store this state reads and writes. */
export interface EqualizerSettings {
  get<T>(key: string): T
  value<T>(key: string): WritableComputedRef<T>
  set<T>(key: string, next: T): unknown
}

export interface EqualizerState {
  /** The live curve. Writable — assigning it persists and repaints the audio. */
  active: WritableComputedRef<EqualizerSpec>
  /** The master on/off, separate from the spec's own `enabled` so a disabled EQ keeps its bands. */
  enabled: WritableComputedRef<boolean>
  presets: ComputedRef<readonly EqualizerPreset[]>
  /** The preset `applyPreset`/`savePreset` last selected, or null once the curve is hand-edited off it. */
  appliedPresetId: ComputedRef<string | null>
  /** The preset the current selection points at, if it still exists, else null. */
  appliedPreset: ComputedRef<EqualizerPreset | null>
  /** True when a preset is selected and the live curve has drifted from it. */
  dirty: ComputedRef<boolean>
  /** Save the current curve as a new named preset; returns its generated id. */
  savePreset: (name: string) => string
  /** Recall a preset's curve into `audio.eq.active`. No-op if the id is unknown. */
  applyPreset: (id: string) => void
  renamePreset: (id: string, name: string) => void
  deletePreset: (id: string) => void
}

export interface EqualizerStateOptions {
  /** Injected so a test can assert against fixed ids; defaults to a real UUID. */
  newId?: () => string
}

function defaultNewId(): string {
  return crypto.randomUUID()
}

export function createEqualizerState(
  settings: EqualizerSettings,
  options: EqualizerStateOptions = {}
): EqualizerState {
  const newId = options.newId ?? defaultNewId

  const active = settings.value<EqualizerSpec>(AUDIO_EQ_ACTIVE.key)
  const enabled = settings.value<boolean>(AUDIO_EQ_ENABLED.key)
  const presets = computed(() => settings.get<readonly EqualizerPreset[]>(AUDIO_EQ_PRESETS.key))

  // Which preset the curve was last recalled from or saved as. In-memory: after a
  // reload the operator is editing a curve, not "inside" a preset, until they pick
  // one — there is no fourth key for this and it does not want persisting.
  const selectedId = ref<string | null>(null)

  const appliedPreset = computed(
    () => presets.value.find((preset) => preset.id === selectedId.value) ?? null
  )
  const dirty = computed(() => {
    const applied = appliedPreset.value
    return applied !== null && !sameSettingValue(applied.spec, active.value)
  })

  function writePresets(next: readonly EqualizerPreset[]): void {
    void settings.set(AUDIO_EQ_PRESETS.key, next)
  }

  function savePreset(name: string): string {
    const preset: EqualizerPreset = { id: newId(), name, spec: structuredClone(active.value) }
    writePresets([...presets.value, preset])
    // Saving selects the new preset, so the pane shows its name and not "(modified)".
    selectedId.value = preset.id
    return preset.id
  }

  function applyPreset(id: string): void {
    const preset = presets.value.find((entry) => entry.id === id)
    if (!preset) return
    // A plain assignment — the watcher on `audioPreferences.equalizer` is the only
    // thing that has to react, and it does.
    active.value = structuredClone(preset.spec)
    selectedId.value = id
  }

  function renamePreset(id: string, name: string): void {
    if (!presets.value.some((preset) => preset.id === id)) return
    // The id is untouched; only the name moves. That is the whole reason the id is
    // not the name — a reference to this preset survives the rename.
    writePresets(presets.value.map((preset) => (preset.id === id ? { ...preset, name } : preset)))
  }

  function deletePreset(id: string): void {
    writePresets(presets.value.filter((preset) => preset.id !== id))
    if (selectedId.value === id) selectedId.value = null
  }

  return {
    active,
    enabled,
    presets,
    appliedPresetId: computed(() => selectedId.value),
    appliedPreset,
    dirty,
    savePreset,
    applyPreset,
    renamePreset,
    deletePreset
  }
}
