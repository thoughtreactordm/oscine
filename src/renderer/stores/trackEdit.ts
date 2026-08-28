import { defineStore } from 'pinia'
import { computed, reactive, ref } from 'vue'
import {
  OVERRIDE_FIELDS,
  type OverrideEditState,
  type OverrideField,
  type OverridePatch
} from '@shared/overrides'
import type { ArtworkRef } from '@shared/artwork'
import { artwork, overrides } from '@renderer/ipc'
import { useLibraryRootsStore } from '@renderer/stores/libraryRoots'

/**
 * The metadata editor's state — **W16 (editor)**.
 *
 * Opens over a track or a batch, prefills from `overrides.getEditState`, and on
 * save turns the changed fields into an `overrides.set` (and any reverted fields
 * into an `overrides.clear`). The edit lands in `track_overrides` and is
 * materialised into the live rows; this store then bumps the same "library
 * changed" signal a scan does, so the track list and facets reload and the
 * correction shows at once. Scope travels through here, not the route.
 */

function absentCover(): ArtworkRef {
  return { present: false, hash: null, mime: null }
}

type Fields = Record<OverrideField, string>

function emptyFields(): Fields {
  return { title: '', artist: '', album: '', trackNo: '', discNo: '', year: '', genre: '' }
}

function emptyFlags(): Record<OverrideField, boolean> {
  return {
    title: false,
    artist: false,
    album: false,
    trackNo: false,
    discNo: false,
    year: false,
    genre: false
  }
}

export const useTrackEditStore = defineStore('trackEdit', () => {
  const open = ref(false)
  const label = ref('')
  const trackIds = ref<readonly number[]>([])
  const loading = ref(false)
  const saving = ref(false)
  const errorMessage = ref<string | null>(null)
  const editState = ref<OverrideEditState | null>(null)

  // The editable form: the current value, the value it loaded with, and whether
  // the operator has asked to revert the field to what the file holds.
  const values = reactive<Fields>(emptyFields())
  const initial = reactive<Fields>(emptyFields())
  const reverting = reactive<Record<OverrideField, boolean>>(emptyFlags())

  // Cover is its own correction layer (W16-9/10): actions apply immediately
  // through the ingest IPC, not on Save, so the library shows the new cover
  // before any flush. Mixed is a compilation whose tracks disagree.
  const artworkRef = ref<ArtworkRef>(absentCover())
  const artworkMixed = ref(false)
  const artworkOverridden = ref(false)
  const artworkBusy = ref(false)
  // Cover actions write the override immediately (Decision A), but Save is
  // still the editor's confirm — without this, a cover-only session leaves
  // the button disabled because no text field changed.
  const artworkDirty = ref(false)

  const libraryRoots = useLibraryRootsStore()

  function resetForm(): void {
    Object.assign(values, emptyFields())
    Object.assign(initial, emptyFields())
    Object.assign(reverting, emptyFlags())
    artworkRef.value = absentCover()
    artworkMixed.value = false
    artworkOverridden.value = false
    artworkDirty.value = false
  }

  function applyArtworkState(state: OverrideEditState): void {
    artworkMixed.value = state.artwork.mixed
    artworkOverridden.value = state.artwork.overridden
    artworkRef.value = state.artwork.value ?? absentCover()
  }

  function fieldString(state: OverrideEditState, field: OverrideField): string {
    const cell = state[field]
    if (cell.mixed || cell.value === null) return ''
    return String(cell.value)
  }

  /** Opens the editor over a scope, resolving its ids lazily like the menus do. */
  async function edit(
    nextLabel: string,
    resolveIds: () => Promise<readonly number[]>
  ): Promise<void> {
    open.value = true
    label.value = nextLabel
    loading.value = true
    saving.value = false
    errorMessage.value = null
    editState.value = null
    resetForm()
    try {
      const ids = await resolveIds()
      trackIds.value = ids
      if (ids.length === 0) {
        loading.value = false
        return
      }
      const state = await overrides.getEditState(ids)
      editState.value = state
      applyArtworkState(state)
      for (const field of OVERRIDE_FIELDS) {
        const text = fieldString(state, field)
        values[field] = text
        initial[field] = text
      }
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : 'Could not open the editor.'
    } finally {
      loading.value = false
    }
  }

  /** Marks a field to revert to the file's value; clears any typed change. */
  function toggleRevert(field: OverrideField): void {
    reverting[field] = !reverting[field]
    if (reverting[field]) values[field] = initial[field]
  }

  function changed(field: OverrideField): boolean {
    return values[field] !== initial[field]
  }

  function buildPatch(): OverridePatch {
    const patch: {
      title?: string
      artist?: string
      album?: string
      trackNo?: number
      discNo?: number
      year?: number
      genre?: string
    } = {}
    for (const field of OVERRIDE_FIELDS) {
      if (reverting[field] || !changed(field)) continue
      const raw = values[field]
      if (field === 'trackNo' || field === 'discNo' || field === 'year') {
        const trimmed = raw.trim()
        if (trimmed === '') continue // emptying a number reverts it — use the revert control
        const parsed = Number.parseInt(trimmed, 10)
        if (Number.isInteger(parsed) && parsed > 0) patch[field] = parsed
      } else {
        patch[field] = raw
      }
    }
    return patch
  }

  const canSave = computed(
    () =>
      trackIds.value.length > 0 &&
      (artworkDirty.value ||
        OVERRIDE_FIELDS.some((field) => reverting[field]) ||
        OVERRIDE_FIELDS.some((field) => changed(field)))
  )

  async function refreshArtwork(): Promise<void> {
    if (trackIds.value.length === 0) return
    const state = await overrides.getEditState([...trackIds.value])
    if (editState.value) {
      editState.value = { ...editState.value, artwork: state.artwork }
    }
    applyArtworkState(state)
    libraryRoots.markChanged()
  }

  /** Opens the OS image picker in main and sets the cover on the whole selection. */
  async function setCover(): Promise<void> {
    if (artworkBusy.value || trackIds.value.length === 0) return
    artworkBusy.value = true
    errorMessage.value = null
    try {
      const result = await artwork.setFromDialog([...trackIds.value])
      if (result === null) return
      artworkRef.value = result
      artworkMixed.value = false
      artworkOverridden.value = true
      artworkDirty.value = true
      libraryRoots.markChanged()
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : 'The cover could not be set.'
    } finally {
      artworkBusy.value = false
    }
  }

  /** Tri-state clear: no cover now, and the flush strips the front cover. */
  async function removeCover(): Promise<void> {
    if (artworkBusy.value || trackIds.value.length === 0) return
    artworkBusy.value = true
    errorMessage.value = null
    try {
      await artwork.clear([...trackIds.value])
      artworkRef.value = absentCover()
      artworkMixed.value = false
      artworkOverridden.value = true
      artworkDirty.value = true
      libraryRoots.markChanged()
    } catch (error) {
      errorMessage.value =
        error instanceof Error ? error.message : 'The cover could not be removed.'
    } finally {
      artworkBusy.value = false
    }
  }

  /** Drops the override — back to the file's own cover. */
  async function revertCover(): Promise<void> {
    if (artworkBusy.value || trackIds.value.length === 0) return
    artworkBusy.value = true
    errorMessage.value = null
    try {
      await artwork.revert([...trackIds.value])
      artworkDirty.value = true
      await refreshArtwork()
    } catch (error) {
      errorMessage.value =
        error instanceof Error ? error.message : 'The cover could not be reverted.'
    } finally {
      artworkBusy.value = false
    }
  }

  async function save(): Promise<void> {
    if (saving.value || trackIds.value.length === 0) return
    saving.value = true
    errorMessage.value = null
    try {
      // Plain arrays across IPC: `trackIds.value` is a reactive proxy, which
      // Electron's contextBridge cannot structured-clone ("object could not be
      // cloned"). `buildPatch` already returns a plain object.
      const ids = [...trackIds.value]
      const patch = buildPatch()
      const clearFields = OVERRIDE_FIELDS.filter((field) => reverting[field])
      if (Object.keys(patch).length > 0) await overrides.set(ids, patch)
      if (clearFields.length > 0) await overrides.clear(ids, clearFields)
      libraryRoots.markChanged()
      close()
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : 'The edit could not be saved.'
    } finally {
      saving.value = false
    }
  }

  function close(): void {
    open.value = false
    trackIds.value = []
    editState.value = null
    errorMessage.value = null
    resetForm()
  }

  return {
    open,
    label,
    trackIds,
    loading,
    saving,
    errorMessage,
    editState,
    values,
    reverting,
    artworkRef,
    artworkMixed,
    artworkOverridden,
    artworkBusy,
    edit,
    toggleRevert,
    changed,
    canSave,
    save,
    setCover,
    removeCover,
    revertCover,
    close
  }
})
