import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'
import {
  OVERRIDE_FIELDS,
  type OverrideEditState,
  type OverrideField,
  type OverridePatch
} from '@shared/overrides'
import { overrides } from '@renderer/ipc'
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

  const libraryRoots = useLibraryRootsStore()

  function resetForm(): void {
    Object.assign(values, emptyFields())
    Object.assign(initial, emptyFields())
    Object.assign(reverting, emptyFlags())
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

  const canSave = (): boolean =>
    trackIds.value.length > 0 &&
    (OVERRIDE_FIELDS.some((field) => reverting[field]) ||
      OVERRIDE_FIELDS.some((field) => changed(field)))

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
    edit,
    toggleRevert,
    changed,
    canSave,
    save,
    close
  }
})
