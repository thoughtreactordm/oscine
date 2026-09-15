import { computed, ref, watch, type ComputedRef, type Ref, type WritableComputedRef } from 'vue'
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
import { createSpecHistory } from './equalizerHistory'

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
  /**
   * The editor's target curve. Writable — assigning it repaints the audio. Its
   * *source* switches with the in-situ override mode (W19-11): normally it is the
   * operator's global (`audio.eq.active`), but while `editingOverride` is on and
   * the audible track carries a per-entity override, it is that override instead —
   * so the curve, band table, preamp, undo/redo, save and selector all edit the
   * override live without ever touching the global.
   */
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
  /**
   * Undo/redo over the live curve (W19-10). Every write to `active` — a node drag,
   * an added band, a preamp move, a recalled preset — is one step, so `undo`
   * restores the previous curve and `redo` reinstates it. Reactive so a button can
   * enable off them.
   */
  canUndo: ComputedRef<boolean>
  canRedo: ComputedRef<boolean>
  undo: () => void
  redo: () => void
  /**
   * Bracket a continuous gesture so its intermediate writes are not each an undo
   * step. A drag calls `beginInteractive` on pointer-down and `endInteractive` on
   * pointer-up; only the pre-gesture curve is recorded, as one step. Discrete
   * edits need neither — their single write records itself.
   */
  beginInteractive: () => void
  endInteractive: () => void
  /**
   * The in-situ override edit mode (W19-11). A hard toggle, off by default and
   * never persisted. When on and the audible track has an override, `active`
   * targets that override; otherwise it stays on the global and editing behaves
   * exactly as with the mode off. Writable — the pane's switch drives it.
   */
  editingOverride: Ref<boolean>
  /** True when the mode is on *and* an override exists, i.e. the editor is on the override. */
  editingOverrideActive: ComputedRef<boolean>
  /** Whether the audible track currently carries a per-entity override at all. */
  hasOverride: ComputedRef<boolean>
}

export interface EqualizerStateOptions {
  /** Injected so a test can assert against fixed ids; defaults to a real UUID. */
  newId?: () => string
  /**
   * The audible track's derived per-entity override, or null when it carries none
   * (W19-6). The same ref the assignment binding pushes into and the controller
   * plays `override ?? global` from — injected here so the in-situ mode (W19-11)
   * can edit it in place. Omitted in a test that does not exercise override editing.
   */
  override?: Ref<EqualizerSpec | null>
}

function defaultNewId(): string {
  return crypto.randomUUID()
}

export function createEqualizerState(
  settings: EqualizerSettings,
  options: EqualizerStateOptions = {}
): EqualizerState {
  const newId = options.newId ?? defaultNewId

  // The operator's global curve. `audio.eq.active` has exactly one writer — this
  // state's own edits, and only while the override-edit mode is off — so a
  // per-entity assignment (a derived override, W19-6) can never mutate it.
  const global = settings.value<EqualizerSpec>(AUDIO_EQ_ACTIVE.key)
  const enabled = settings.value<boolean>(AUDIO_EQ_ENABLED.key)
  const presets = computed(() => settings.get<readonly EqualizerPreset[]>(AUDIO_EQ_PRESETS.key))

  // ── The in-situ override edit toggle (W19-11) ────────────────────────────────
  // A hard mode, off by default and never persisted. When on *and* the audible
  // track carries an override, `active` targets that override ref: edits are heard
  // live and can be saved to the preset, all without touching `audio.eq.active`.
  // When on with no override, the target falls through to the global — editing then
  // behaves exactly as it does with the mode off. Toggling the mode, or a track
  // change that pushes a different override, is a *context switch* that the recorder
  // watch below re-baselines rather than records.
  const overrideSpec = options.override ?? null
  const editingOverride = ref(false)
  const hasOverride = computed(() => (overrideSpec?.value ?? null) !== null)
  const editingOverrideActive = computed(() => editingOverride.value && hasOverride.value)

  // Set by `active`'s setter so the recorder watch can tell this state's own edits
  // from a context switch or an external override push. Consumed on every watch fire.
  let editorWrote = false

  // The editor's target. Everything downstream — the curve, band table, preamp,
  // undo/redo, save-to-preset and the preset selector — reads and writes this, so
  // they all follow the source switch with no change of their own.
  const active = computed<EqualizerSpec>({
    get: () =>
      editingOverrideActive.value ? (overrideSpec as Ref<EqualizerSpec>).value : global.value,
    set: (next) => {
      editorWrote = true
      if (editingOverrideActive.value) (overrideSpec as Ref<EqualizerSpec>).value = next
      else global.value = next
    }
  })

  // Which preset the curve was last recalled from or saved as. Not persisted as a
  // fourth key — instead recovered on load by matching the current curve against the
  // saved presets. After that the recall/save paths own it, and the recorder watch
  // re-derives it on a context switch so the selector names whatever the target now
  // holds (the override's preset, or the global's) rather than "(modified)" against a
  // stale one.
  const selectedId = ref<string | null>(
    presets.value.find((preset) => sameSettingValue(preset.spec, active.value))?.id ?? null
  )

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

  // ── Undo/redo (W19-10) ───────────────────────────────────────────────────────
  // A stack of prior curves. The watcher below is the single recorder: it fires on
  // every `active` write — a drag frame, a table edit, a recalled preset — and hands
  // this state's own edits to `history.record`, which dedupes and folds. A write it
  // did *not* make (the mode toggled, or a track change pushing a different override,
  // W19-11) is a context switch, not an edit: the watcher re-baselines rather than
  // records, so undo never steps across it. During a drag `interactive` suppresses
  // the per-frame writes, and the single `endInteractive` records the whole gesture
  // as one step. Runs `sync` so a test asserting undo right after a write does not
  // have to await a tick.
  const history = createSpecHistory(active.value)
  const canUndo = ref(false)
  const canRedo = ref(false)
  let interactive = false

  function syncFlags(): void {
    canUndo.value = history.canUndo
    canRedo.value = history.canRedo
  }

  watch(
    () => active.value,
    (next) => {
      const wasEditor = editorWrote
      editorWrote = false
      // A drag frame: `endInteractive` records the whole gesture as one step.
      if (interactive) return
      if (wasEditor) {
        if (history.record(next)) syncFlags()
        return
      }
      // Not this state's edit — the target moved out from under the editor: the mode
      // was toggled, or the assignment binding pushed a different override on a track
      // change (W19-11). Re-baseline history to the new curve so undo cannot step
      // across the switch, and re-derive the selection so the selector names the
      // target's preset instead of reading "(modified)" against a stale one.
      history.reset(next)
      syncFlags()
      selectedId.value = presets.value.find((p) => sameSettingValue(p.spec, next))?.id ?? null
    },
    { flush: 'sync' }
  )

  function beginInteractive(): void {
    interactive = true
  }

  function endInteractive(): void {
    interactive = false
    if (history.record(active.value)) syncFlags()
  }

  function undo(): void {
    const prev = history.undo()
    // The write is deduped by `record` — baseline already equals `prev` — so it
    // does not fork the redo stack; it only repaints the curve and the audio.
    if (prev !== null) active.value = structuredClone(prev)
    syncFlags()
  }

  function redo(): void {
    const next = history.redo()
    if (next !== null) active.value = structuredClone(next)
    syncFlags()
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
    deletePreset,
    canUndo: computed(() => canUndo.value),
    canRedo: computed(() => canRedo.value),
    undo,
    redo,
    beginInteractive,
    endInteractive,
    editingOverride,
    editingOverrideActive: computed(() => editingOverrideActive.value),
    hasOverride: computed(() => hasOverride.value)
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
