import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  PendingWrite,
  WritebackField,
  WritebackOutcome,
  WritebackProgress,
  WritebackReport
} from '@shared/tagWriteback'
import { overrides as overridesBridge, tagWriteback as bridge } from '@renderer/ipc'
import { useLibraryRootsStore } from '@renderer/stores/libraryRoots'
import {
  buildSelections,
  changedFields,
  initialSelection,
  overallState,
  selectionSummary,
  type CheckState,
  type SelectionMap
} from '@renderer/panels/tools/tagWritebackModel'

/**
 * The staged review surface's state — **W16-6**. The thin, reactive half: it
 * holds the scope, the loaded diffs, the checkbox selection and the flush's
 * progress and report, and delegates every decision worth testing to the pure
 * {@link tagWritebackModel}. Scope travels through here rather than the route
 * because a batch can be a set of thousands of ids — too large for a query param.
 */
export type ReviewStatus = 'idle' | 'loading' | 'reviewing' | 'applying' | 'done' | 'error'

export const useTagWritebackStore = defineStore('tagWriteback', () => {
  const status = ref<ReviewStatus>('idle')
  const errorMessage = ref<string | null>(null)
  const pendingWrites = ref<PendingWrite[]>([])
  const selection = ref<SelectionMap>(new Map())
  const progress = ref<WritebackProgress | null>(null)
  const report = ref<WritebackReport | null>(null)

  const libraryRoots = useLibraryRootsStore()

  // A review opened while an earlier one is still resolving must not have its
  // slower predecessor land on top of it — each carries its own sequence.
  let reviewSeq = 0

  const summary = computed(() => selectionSummary(pendingWrites.value, selection.value))
  const headerState = computed<CheckState>(() => overallState(pendingWrites.value, selection.value))
  const hasChanges = computed(() => pendingWrites.value.length > 0)
  const canApply = computed(() => status.value !== 'applying' && summary.value.tracks > 0)
  const outcomeByTrack = computed(() => {
    const map = new Map<number, WritebackOutcome>()
    for (const outcome of report.value?.outcomes ?? []) map.set(outcome.trackId, outcome)
    return map
  })

  /** The proxied selection set for a track, created empty on first touch. */
  function selectedSet(trackId: number): Set<WritebackField> {
    if (!selection.value.has(trackId)) selection.value.set(trackId, new Set())
    // Read back through the reactive Map so mutations trigger effects.
    return selection.value.get(trackId) as Set<WritebackField>
  }

  /**
   * Loads every unwritten correction — the review's default (**W16-6**).
   *
   * No scope to assemble: the edits the operator has made accumulate in the
   * correction layer, and this is the whole of them. An empty result is "nothing
   * to write", shown as such rather than as an error.
   */
  async function reviewPending(): Promise<void> {
    if (status.value === 'applying') return
    const seq = ++reviewSeq
    status.value = 'loading'
    errorMessage.value = null
    report.value = null
    progress.value = null
    pendingWrites.value = []
    selection.value = new Map()
    try {
      const pendings = await bridge.pending()
      if (seq !== reviewSeq) return
      pendingWrites.value = pendings
      selection.value = initialSelection(pendings)
      status.value = 'reviewing'
    } catch (error) {
      if (seq !== reviewSeq) return
      status.value = 'error'
      errorMessage.value = error instanceof Error ? error.message : 'Could not build the review.'
    }
  }

  function setField(trackId: number, field: WritebackField, on: boolean): void {
    const set = selectedSet(trackId)
    if (on) set.add(field)
    else set.delete(field)
  }

  function toggleField(trackId: number, field: WritebackField): void {
    const set = selectedSet(trackId)
    if (set.has(field)) set.delete(field)
    else set.add(field)
  }

  /** Flips a whole row: select all its changed fields, or clear them. */
  function toggleRow(trackId: number): void {
    const pending = pendingWrites.value.find((p) => p.trackId === trackId)
    if (!pending) return
    const changed = changedFields(pending)
    const set = selectedSet(trackId)
    const allOn = changed.every((field) => set.has(field))
    for (const field of changed) {
      if (allOn) set.delete(field)
      else set.add(field)
    }
  }

  /** Selects or clears every changed field across the whole batch. */
  function setAll(on: boolean): void {
    for (const pending of pendingWrites.value) {
      const set = selectedSet(pending.trackId)
      if (on) for (const field of changedFields(pending)) set.add(field)
      else set.clear()
    }
  }

  /** Flushes the selected batch, then holds the per-file report. */
  async function apply(): Promise<void> {
    if (!canApply.value) return
    const selections = buildSelections(pendingWrites.value, selection.value)
    if (selections.length === 0) return
    status.value = 'applying'
    report.value = null
    progress.value = { done: 0, total: selections.length, written: 0, skipped: 0, failed: 0 }
    try {
      report.value = await bridge.apply(selections)
      status.value = 'done'
      // Written and skipped tracks have had their overrides retired in main, so
      // they leave the pending list; failures keep theirs. Refetch to drop them
      // while keeping the report banner, and bump the library so the track lists
      // clear the "modified" marks this flush resolved.
      libraryRoots.markChanged()
      const remaining = await bridge.pending()
      pendingWrites.value = remaining
      selection.value = initialSelection(remaining)
    } catch (error) {
      status.value = 'error'
      errorMessage.value =
        error instanceof Error ? error.message : 'The write-back failed to start.'
    }
  }

  /**
   * Discards every pending edit — reverts the whole correction layer to the
   * files. The escape hatch when the accumulated set is not what was wanted.
   */
  async function discardAll(): Promise<void> {
    if (status.value === 'applying') return
    try {
      await overridesBridge.discardAll()
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : 'Could not discard changes.'
      return
    }
    libraryRoots.markChanged()
    await reviewPending()
  }

  /** Asks main to stop the running flush; the awaited apply resolves cancelled. */
  function cancel(): void {
    if (status.value === 'applying') void bridge.cancelApply()
  }

  function reset(): void {
    status.value = 'idle'
    errorMessage.value = null
    pendingWrites.value = []
    selection.value = new Map()
    progress.value = null
    report.value = null
    reviewSeq += 1
  }

  // Live progress for the running flush — subscribed for the store's lifetime,
  // writing only `progress`, and only while a flush is in flight.
  bridge.onApplyProgress((next) => {
    progress.value = next
  })

  return {
    status,
    errorMessage,
    pendingWrites,
    selection,
    progress,
    report,
    summary,
    headerState,
    hasChanges,
    canApply,
    outcomeByTrack,
    reviewPending,
    setField,
    toggleField,
    toggleRow,
    setAll,
    apply,
    cancel,
    discardAll,
    reset
  }
})
