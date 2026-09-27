import { defineStore } from 'pinia'
import { computed, reactive, ref } from 'vue'
import {
  OVERRIDE_FIELDS,
  type OverrideEditState,
  type OverrideField,
  type OverrideFieldState,
  type OverridePatch
} from '@shared/overrides'
import type { ArtworkRef, CoverArtCandidate } from '@shared/artwork'
import {
  MAX_TAG_FIELD_PREFILL_TRACKS,
  type TagFieldEditState,
  type TagFieldKey,
  type TagFieldPatch,
  type TagFieldValue
} from '@shared/tagFields'
import { artwork, overrides, tagOverrides } from '@renderer/ipc'
import {
  buildTagFieldSave,
  formValues,
  tagFieldSections,
  tagFormDirty,
  type TagFormValue,
  type TagFormValues
} from '@renderer/panels/tagFieldForm'
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
  return {
    title: '',
    artist: '',
    albumArtist: '',
    album: '',
    trackNo: '',
    discNo: '',
    year: '',
    genre: ''
  }
}

/**
 * The "All fields" prefill's lifecycle (W16-18). `idle` until the area first
 * opens, because the prefill opens every file in the batch; `tooMany` is a
 * batch past {@link MAX_TAG_FIELD_PREFILL_TRACKS}.
 */
export type TagFieldsStatus = 'idle' | 'loading' | 'ready' | 'error' | 'tooMany'

function clearKeys(record: Record<string, unknown>): void {
  for (const key of Object.keys(record)) delete record[key]
}

function emptyFlags(): Record<OverrideField, boolean> {
  return {
    title: false,
    artist: false,
    albumArtist: false,
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

  // The network cover picker (W7-17): a modal over the editor that searches
  // MusicBrainz + iTunes for a cover. Candidates are references the renderer
  // previews through the `oscine://catalog-artwork` proxy and never fetches
  // itself; only the picked one is fetched, in main, and becomes an override.
  const networkPickerOpen = ref(false)
  const coverCandidates = ref<CoverArtCandidate[]>([])
  const coverSearching = ref(false)
  // Distinguishes "not searched yet" from "searched, found nothing" so the
  // picker shows a prompt before the first search and an empty state after.
  const coverSearched = ref(false)
  const coverSearchError = ref<string | null>(null)

  // The generic fields (W16-18): the registry's sections, loaded lazily when the
  // "All fields" area first opens. Keyed by registry key; a revert drops the
  // field's `track_tag_overrides` row rather than writing a value.
  const tagSections = tagFieldSections()
  const allFieldsOpen = ref(false)
  const tagFieldsStatus = ref<TagFieldsStatus>('idle')
  const tagEditState = ref<TagFieldEditState | null>(null)
  const tagValues = reactive<TagFormValues>({})
  const tagInitial = reactive<TagFormValues>({})
  const tagReverting = reactive<Record<string, boolean>>({})
  // A prefill still reading files when the editor closes or reopens must not
  // land on the next session's form.
  let tagSeq = 0

  const libraryRoots = useLibraryRootsStore()

  function resetTagFields(): void {
    tagSeq += 1
    allFieldsOpen.value = false
    tagFieldsStatus.value = 'idle'
    tagEditState.value = null
    clearKeys(tagValues)
    clearKeys(tagInitial)
    clearKeys(tagReverting)
  }

  function resetForm(): void {
    resetTagFields()
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

  /**
   * Opens or closes the "All fields" area. The first open reads the batch's
   * files for the generic prefill; a plain title edit never pays for it.
   */
  function toggleAllFields(): void {
    allFieldsOpen.value = !allFieldsOpen.value
    if (allFieldsOpen.value && tagFieldsStatus.value === 'idle') void loadTagFields()
  }

  async function loadTagFields(): Promise<void> {
    const ids = [...trackIds.value]
    if (ids.length === 0) return
    if (ids.length > MAX_TAG_FIELD_PREFILL_TRACKS) {
      tagFieldsStatus.value = 'tooMany'
      return
    }
    const seq = ++tagSeq
    tagFieldsStatus.value = 'loading'
    try {
      const state = await tagOverrides.getEditState(ids)
      if (seq !== tagSeq) return
      tagEditState.value = state
      const values = formValues(tagSections, state)
      Object.assign(tagValues, values)
      // The initial side is a copy, so editing a list in place cannot move it.
      for (const [key, value] of Object.entries(values)) {
        tagInitial[key] = Array.isArray(value) ? [...(value as readonly string[])] : value
      }
      tagFieldsStatus.value = 'ready'
    } catch (error) {
      if (seq !== tagSeq) return
      tagFieldsStatus.value = 'error'
      errorMessage.value =
        error instanceof Error ? error.message : 'Could not read the files’ other tags.'
    }
  }

  /** A generic field's folded cell, read by string so the form stays registry-driven. */
  function tagCell(key: string): OverrideFieldState<TagFieldValue> | undefined {
    const state = tagEditState.value as Readonly<
      Record<string, OverrideFieldState<TagFieldValue> | undefined>
    > | null
    return state?.[key]
  }
  function tagMixed(key: string): boolean {
    return tagCell(key)?.mixed ?? false
  }
  function tagOverridden(key: string): boolean {
    return tagCell(key)?.overridden ?? false
  }

  function setTagValue(key: string, value: TagFormValue): void {
    tagValues[key] = value
  }

  /** Marks a generic field to revert to the file's value; clears any typed change. */
  function toggleTagRevert(key: string): void {
    tagReverting[key] = tagReverting[key] !== true
    if (tagReverting[key]) {
      const initialValue = tagInitial[key] ?? null
      tagValues[key] = Array.isArray(initialValue)
        ? [...(initialValue as readonly string[])]
        : initialValue
    }
  }

  const tagDirty = computed(
    () =>
      tagFieldsStatus.value === 'ready' &&
      tagFormDirty(tagSections, tagValues, tagInitial, tagReverting)
  )

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
      albumArtist?: string
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
        tagDirty.value ||
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

  /** Opens the network picker and runs a first search from the current fields. */
  function openNetworkPicker(): void {
    if (trackIds.value.length === 0) return
    networkPickerOpen.value = true
    coverCandidates.value = []
    coverSearched.value = false
    coverSearchError.value = null
    // A compilation's release is credited to its album artist, not a performer.
    void searchCovers(values.albumArtist.trim() || values.artist, values.album)
  }

  function closeNetworkPicker(): void {
    networkPickerOpen.value = false
  }

  /**
   * Searches the network for covers. An empty result is a normal answer — no
   * match, or online lookups are off — so it sets `coverSearched` rather than an
   * error; the file picker beside it never depended on the socket.
   */
  async function searchCovers(artist: string, album: string): Promise<void> {
    if (coverSearching.value) return
    coverSearching.value = true
    coverSearchError.value = null
    try {
      coverCandidates.value = await artwork.searchCovers(artist, album)
    } catch (error) {
      coverCandidates.value = []
      coverSearchError.value = error instanceof Error ? error.message : 'The cover search failed.'
    } finally {
      coverSearched.value = true
      coverSearching.value = false
    }
  }

  /**
   * Applies a picked candidate. Main fetches the bytes and writes the override,
   * so the local state moves exactly as it does after a file pick, and the
   * picker closes.
   */
  async function applyRemoteCover(url: string): Promise<void> {
    if (artworkBusy.value || trackIds.value.length === 0) return
    artworkBusy.value = true
    errorMessage.value = null
    try {
      const result = await artwork.applyRemoteCover([...trackIds.value], url)
      artworkRef.value = result
      artworkMixed.value = false
      artworkOverridden.value = true
      artworkDirty.value = true
      libraryRoots.markChanged()
      networkPickerOpen.value = false
    } catch (error) {
      coverSearchError.value =
        error instanceof Error ? error.message : 'The cover could not be applied.'
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
      // The generic half is checked first, so a bad number saves nothing at all.
      const tagSave =
        tagFieldsStatus.value === 'ready'
          ? buildTagFieldSave(tagSections, tagValues, tagInitial, tagReverting)
          : { patch: {}, revert: [], errors: [] }
      if (tagSave.errors.length > 0) {
        errorMessage.value = tagSave.errors[0]
        return
      }
      const patch = buildPatch()
      const clearFields = OVERRIDE_FIELDS.filter((field) => reverting[field])
      if (Object.keys(patch).length > 0) await overrides.set(ids, patch)
      if (clearFields.length > 0) await overrides.clear(ids, clearFields)
      // Registry keys by construction: the sections are the registry's own.
      if (Object.keys(tagSave.patch).length > 0) {
        await tagOverrides.set(ids, tagSave.patch as TagFieldPatch)
      }
      if (tagSave.revert.length > 0) {
        await tagOverrides.revert(ids, tagSave.revert as TagFieldKey[])
      }
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
    networkPickerOpen,
    coverCandidates,
    coverSearching,
    coverSearched,
    coverSearchError,
    edit,
    toggleRevert,
    changed,
    canSave,
    save,
    setCover,
    removeCover,
    revertCover,
    openNetworkPicker,
    closeNetworkPicker,
    searchCovers,
    applyRemoteCover,
    close,
    tagSections,
    allFieldsOpen,
    tagFieldsStatus,
    tagValues,
    tagReverting,
    toggleAllFields,
    tagMixed,
    tagOverridden,
    setTagValue,
    toggleTagRevert
  }
})
