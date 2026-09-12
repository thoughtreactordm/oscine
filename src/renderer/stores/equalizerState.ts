import { computed, ref, type ComputedRef, type WritableComputedRef } from 'vue'
import {
  AUDIO_EQ_ACTIVE,
  AUDIO_EQ_ENABLED,
  AUDIO_EQ_PRESETS,
  sameSettingValue
} from '@shared/settings'
import {
  EQUALIZER_GAIN_DB_LIMIT,
  type EqualizerPreset,
  type EqualizerSpec
} from '@shared/audio/equalizer'

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
  /**
   * Set the pre-amp (R11's headroom control), clamped to the node's ±24 dB. The
   * one gain that sits before every band, so lowering it is what buys headroom for
   * a boost without redrawing the curve — see `suggestedPreampDb`.
   */
  setPreamp: (db: number) => void
  /** Save the current curve as a new named preset; returns its generated id. */
  savePreset: (name: string) => string
  /**
   * Overwrite an existing preset's spec with the live curve, keeping its id and
   * name. This is the preset bar's "Save" (against "Save as…"): it clears the
   * dirty flag without minting a new preset, so a future per-entity reference
   * (W19-6) to this id survives the edit. No-op if the id is unknown.
   */
  updatePreset: (id: string) => void
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

  function updatePreset(id: string): void {
    if (!presets.value.some((preset) => preset.id === id)) return
    // Only the spec moves; id and name are kept, so a reference to this preset
    // survives the overwrite. Re-selecting it clears `dirty` — the curve now is
    // the preset again.
    const spec = structuredClone(active.value)
    writePresets(presets.value.map((preset) => (preset.id === id ? { ...preset, spec } : preset)))
    selectedId.value = id
  }

  function setPreamp(db: number): void {
    if (!Number.isFinite(db)) return
    const preampDb = Math.min(EQUALIZER_GAIN_DB_LIMIT, Math.max(-EQUALIZER_GAIN_DB_LIMIT, db))
    // A whole-spec write so the settings watcher repaints the audio; other fields
    // are carried through untouched.
    active.value = { ...active.value, preampDb }
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
    setPreamp,
    savePreset,
    updatePreset,
    applyPreset,
    renamePreset,
    deletePreset
  }
}

// ── The clip indicator's latch (R11) ────────────────────────────────────────

/**
 * A sample at or beyond this magnitude is treated as clipping the EQ output.
 * Just shy of full scale (1.0) so a value pinned at the ceiling reads as a clip
 * without demanding an exact 1.0 that dither or resampling would round past.
 */
export const CLIP_THRESHOLD = 0.999

/**
 * How long the indicator stays lit after a clip, in milliseconds. A clip is often
 * a single sample on one kick; without a latch it would flash for one frame and be
 * gone before the eye caught it. ~1.5 s is long enough to see, short enough not to
 * outlive the boost that caused it.
 */
export const DEFAULT_CLIP_HOLD_MS = 1500

export interface ClipLatch {
  /** Whether the indicator is currently lit. */
  readonly lit: boolean
  /**
   * Fold in this frame's output peak, observed at `nowMs`. A peak at or past the
   * threshold lights the indicator and (re)arms the hold; otherwise the hold is
   * aged and cleared once it has elapsed.
   */
  push(peak: number, nowMs: number): void
  /** Clear immediately — the operator clicked the indicator to acknowledge it. */
  clear(): void
}

export interface ClipLatchOptions {
  holdMs?: number
  threshold?: number
}

/**
 * The clip indicator's state, as a pure time-driven machine so the latch timing
 * is asserted against synthetic timestamps rather than a real `rAF` clock. The
 * Pinia store drives `push` once per frame with the router's peak and
 * `performance.now()`; the component clears it on click.
 */
export function createClipLatch(options: ClipLatchOptions = {}): ClipLatch {
  const holdMs = options.holdMs ?? DEFAULT_CLIP_HOLD_MS
  const threshold = options.threshold ?? CLIP_THRESHOLD
  let lit = false
  let litUntil = -Infinity
  return {
    get lit(): boolean {
      return lit
    },
    push(peak: number, nowMs: number): void {
      if (peak >= threshold) {
        lit = true
        litUntil = nowMs + holdMs
      } else if (lit && nowMs >= litUntil) {
        lit = false
      }
    },
    clear(): void {
      lit = false
      litUntil = -Infinity
    }
  }
}
