<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { PendingWrite, WritebackField, WritebackOutcome } from '@shared/tagWriteback'
import { WRITEBACK_FIELDS } from '@shared/tagWriteback'
import { visibleRange } from '@renderer/panels/listViewport'
import TriCheck from '@renderer/panels/tools/TriCheck.vue'
import {
  FIELD_LABELS,
  fieldChanged,
  fieldText,
  rowLabel,
  rowState,
  type CheckState
} from '@renderer/panels/tools/tagWritebackModel'
import { useTagWritebackStore } from '@renderer/stores/tagWriteback'

/**
 * The staged review's surface — **W16-6**, the operator gate that makes D28
 * "explicit and staged". A virtualized diff grid: old → new per field per track,
 * with per-row and per-field select/deselect, an Apply that flushes through the
 * W16-2/W16-4 engine over IPC with live progress, and a per-file result column.
 * Virtualized from the first commit because a batch can be thousands of tracks.
 */
const store = useTagWritebackStore()

// The review is the accumulated set of edits — load it whenever the tool opens.
onMounted(() => void store.reviewPending())

const ROW_PX = 60
const OVERSCAN = 6

/** Per-field column widths — fixed so the grid has a definite width to scroll. */
const FIELD_WIDTH: Record<WritebackField, string> = {
  title: '168px',
  artist: '168px',
  album: '168px',
  trackNo: '84px',
  discNo: '84px',
  year: '92px',
  genres: '208px'
}
const gridColumns = `44px 240px ${WRITEBACK_FIELDS.map((f) => FIELD_WIDTH[f]).join(' ')} 116px`

const showTable = computed(
  () =>
    store.hasChanges &&
    (store.status === 'reviewing' || store.status === 'applying' || store.status === 'done')
)

// --- Virtualization (fixed-height rows; two spacers) ---------------------------
const viewport = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const viewportPx = ref(0)

const rows = computed(() => store.pendingWrites)
const visible = computed(() =>
  visibleRange({
    total: rows.value.length,
    rowPx: ROW_PX,
    viewportPx: viewportPx.value,
    scrollTop: scrollTop.value,
    overscan: OVERSCAN
  })
)
const drawn = computed(() => rows.value.slice(visible.value.first, visible.value.last + 1))

function onScroll(): void {
  const element = viewport.value
  if (element === null) return
  scrollTop.value = element.scrollTop
  viewportPx.value = element.clientHeight
}
function measure(): void {
  viewportPx.value = viewport.value?.clientHeight ?? 0
}

let observer: ResizeObserver | null = null
function attach(): void {
  if (observer !== null || viewport.value === null) return
  measure()
  observer = new ResizeObserver(measure)
  observer.observe(viewport.value)
}
function detach(): void {
  observer?.disconnect()
  observer = null
}

watch(
  showTable,
  async (on) => {
    if (on) {
      await nextTick()
      attach()
    } else {
      detach()
    }
  },
  { immediate: true }
)
// A new scope scrolls back to the top rather than keeping the old offset.
watch(rows, () => {
  scrollTop.value = 0
  if (viewport.value) viewport.value.scrollTop = 0
})
onBeforeUnmount(detach)

// --- Cell / row state ----------------------------------------------------------
function cellState(trackId: number, field: WritebackField): CheckState {
  return (store.selection.get(trackId)?.has(field) ?? false) ? 'all' : 'none'
}
function rowCheck(pending: PendingWrite): CheckState {
  return rowState(pending, store.selection)
}
function outcomeFor(trackId: number): WritebackOutcome | undefined {
  return store.outcomeByTrack.get(trackId)
}

function failLabel(code: 'unsupported-format' | 'write-failed' | 'verify-failed'): string {
  switch (code) {
    case 'unsupported-format':
      return 'Unsupported'
    case 'write-failed':
      return 'Write failed'
    case 'verify-failed':
      return 'Verify failed'
  }
}
function statusMeta(outcome: WritebackOutcome): { icon: string; text: string; cls: string } {
  if (outcome.status === 'written')
    return { icon: 'i-tabler-check', text: 'Written', cls: 'text-success' }
  if (outcome.status === 'skipped')
    return { icon: 'i-tabler-minus', text: 'Skipped', cls: 'text-dimmed' }
  return { icon: 'i-tabler-alert-triangle', text: failLabel(outcome.code), cls: 'text-error' }
}

// --- Header / footer text ------------------------------------------------------
function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? '' : 's'}`
}

const subtitle = computed(() => {
  if (store.status === 'idle' || store.status === 'loading') {
    return 'Every unwritten correction, ready to flush to your files'
  }
  if (!store.hasChanges) return 'No unwritten changes'
  const s = store.summary
  return `${s.tracks}/${rows.value.length} tracks, ${plural(s.fields, 'field')} selected`
})

const applyLabel = computed(() => `Write ${plural(store.summary.tracks, 'track')}`)

const progressText = computed(() => {
  const p = store.progress
  return p ? `${p.done} / ${p.total}` : ''
})
const progressPct = computed(() => {
  const p = store.progress
  return p && p.total > 0 ? Math.round((p.done / p.total) * 100) : 0
})

const reportSummary = computed(() => {
  const r = store.report
  if (!r) return ''
  return `Wrote ${r.written} · skipped ${r.skipped} · failed ${r.failed} of ${r.total}`
})

function apply(): void {
  void store.apply()
}

// A two-step confirm for the destructive discard, inline in the header rather
// than a modal — the button becomes the question.
const confirmingDiscard = ref(false)
function discard(): void {
  confirmingDiscard.value = false
  void store.discardAll()
}
</script>

<template>
  <section class="flex h-full min-h-0 flex-col bg-default text-default">
    <header class="flex shrink-0 items-center gap-3 border-b border-default px-4 py-2">
      <div class="min-w-0">
        <h1 class="truncate text-sm font-semibold text-highlighted">Tag write-back</h1>
        <p class="truncate text-xs text-muted">{{ subtitle }}</p>
      </div>
      <div class="ml-auto flex items-center gap-2">
        <template v-if="store.status === 'reviewing' || store.status === 'done'">
          <template v-if="confirmingDiscard">
            <span class="text-xs text-muted">Discard {{ plural(rows.length, 'edit') }}?</span>
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              label="Cancel"
              @click="confirmingDiscard = false"
            />
            <UButton
              size="xs"
              color="error"
              variant="soft"
              icon="i-tabler-trash"
              label="Discard all"
              @click="discard"
            />
          </template>
          <template v-else>
            <UButton
              size="xs"
              color="error"
              variant="ghost"
              icon="i-tabler-trash"
              label="Discard all"
              :disabled="!store.hasChanges"
              @click="confirmingDiscard = true"
            />
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              label="Select all"
              :disabled="!store.hasChanges"
              @click="store.setAll(true)"
            />
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              label="Clear"
              :disabled="!store.hasChanges"
              @click="store.setAll(false)"
            />
            <UButton
              size="xs"
              color="primary"
              icon="i-tabler-file-pencil"
              :label="applyLabel"
              :disabled="!store.canApply"
              @click="apply"
            />
          </template>
        </template>
        <template v-else-if="store.status === 'applying'">
          <span class="text-xs tabular-nums text-muted">{{ progressText }}</span>
          <UButton
            size="xs"
            color="error"
            variant="soft"
            icon="i-tabler-x"
            label="Cancel"
            @click="store.cancel()"
          />
        </template>
      </div>
    </header>

    <div v-if="store.status === 'applying'" class="h-1 w-full shrink-0 bg-elevated">
      <div
        class="h-full bg-primary transition-[width] duration-150"
        :style="{ width: `${progressPct}%` }"
      />
    </div>

    <div
      v-if="store.status === 'done' && store.report"
      class="flex shrink-0 items-center gap-2 border-b border-default px-4 py-2 text-xs"
    >
      <UIcon
        :name="store.report.failed > 0 ? 'i-tabler-alert-triangle' : 'i-tabler-check'"
        class="size-4"
        :class="store.report.failed > 0 ? 'text-error' : 'text-success'"
      />
      <span class="text-muted">{{ reportSummary }}</span>
      <span v-if="store.report.cancelled" class="text-warning">· stopped early</span>
    </div>

    <!-- The diff grid -->
    <div
      v-if="showTable"
      ref="viewport"
      class="min-h-0 flex-1 overflow-auto"
      @scroll.passive="onScroll"
    >
      <div class="min-w-max">
        <div
          class="sticky top-0 z-10 grid items-center border-b border-default bg-default text-xs font-medium text-dimmed"
          :style="{ gridTemplateColumns: gridColumns }"
        >
          <div class="grid place-items-center py-2">
            <TriCheck
              :state="store.headerState"
              aria-label="Select every field"
              @toggle="store.setAll(store.headerState !== 'all')"
            />
          </div>
          <div class="truncate px-2 py-2">Track</div>
          <div v-for="field in WRITEBACK_FIELDS" :key="field" class="truncate px-2 py-2">
            {{ FIELD_LABELS[field] }}
          </div>
          <div class="truncate px-2 py-2">{{ store.report ? 'Result' : '' }}</div>
        </div>

        <div :style="{ height: `${visible.topPx}px` }" aria-hidden="true" />

        <div
          v-for="pending in drawn"
          :key="pending.trackId"
          class="grid items-center border-b border-default/60"
          :style="{ gridTemplateColumns: gridColumns, height: `${ROW_PX}px` }"
        >
          <div class="grid place-items-center">
            <TriCheck
              :state="rowCheck(pending)"
              :aria-label="`Select ${rowLabel(pending).primary}`"
              @toggle="store.toggleRow(pending.trackId)"
            />
          </div>

          <div class="min-w-0 px-2">
            <p class="truncate text-xs font-medium text-default">{{ rowLabel(pending).primary }}</p>
            <p class="truncate text-[11px] text-muted">{{ rowLabel(pending).secondary }}</p>
          </div>

          <div v-for="field in WRITEBACK_FIELDS" :key="field" class="min-w-0 px-2">
            <div v-if="fieldChanged(pending, field)" class="flex items-center gap-1.5">
              <TriCheck
                :state="cellState(pending.trackId, field)"
                :aria-label="`${FIELD_LABELS[field]} for ${rowLabel(pending).primary}`"
                @toggle="store.toggleField(pending.trackId, field)"
              />
              <div class="min-w-0">
                <p
                  class="truncate text-xs text-primary"
                  :title="fieldText(pending, field).proposed"
                >
                  {{ fieldText(pending, field).proposed }}
                </p>
                <p
                  class="truncate text-[11px] text-dimmed line-through"
                  :title="fieldText(pending, field).current"
                >
                  {{ fieldText(pending, field).current }}
                </p>
              </div>
            </div>
            <span v-else class="text-xs text-dimmed">—</span>
          </div>

          <div class="min-w-0 px-2">
            <span
              v-if="outcomeFor(pending.trackId)"
              class="inline-flex items-center gap-1 text-[11px]"
              :class="statusMeta(outcomeFor(pending.trackId)!).cls"
            >
              <UIcon :name="statusMeta(outcomeFor(pending.trackId)!).icon" class="size-3.5" />
              {{ statusMeta(outcomeFor(pending.trackId)!).text }}
            </span>
          </div>
        </div>

        <div :style="{ height: `${visible.bottomPx}px` }" aria-hidden="true" />
      </div>
    </div>

    <!-- Empty / loading / error states -->
    <div v-else class="grid min-h-0 flex-1 place-items-center p-8 text-center">
      <div class="max-w-sm">
        <template v-if="store.status === 'loading'">
          <UIcon name="i-tabler-loader-2" class="mx-auto size-6 animate-spin text-dimmed" />
          <p class="mt-2 text-sm text-muted">Reading files…</p>
        </template>
        <template v-else-if="store.status === 'error'">
          <UIcon name="i-tabler-alert-triangle" class="mx-auto size-6 text-error" />
          <p class="mt-2 text-sm font-medium text-default">Couldn’t build the review</p>
          <p class="mt-1 text-xs text-muted">{{ store.errorMessage }}</p>
        </template>
        <template v-else>
          <UIcon name="i-tabler-check" class="mx-auto size-6 text-success" />
          <p class="mt-2 text-sm font-medium text-default">No unwritten changes</p>
          <p class="mt-1 text-xs text-muted">
            Edit a track’s metadata — right-click and choose “Edit metadata…” — and your changes
            gather here to write to disk when you’re ready.
          </p>
        </template>
      </div>
    </div>
  </section>
</template>
