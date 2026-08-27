<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { visibleRange } from '@renderer/panels/listViewport'
import {
  rankedCaption,
  rankedRows,
  type RankedListSpec
} from '@renderer/panels/listening/listeningRows'
import { artworkUrl } from '@shared/ipc'
import type { StatsQueryResult, StatsSort } from '@shared/stats'

/**
 * One of the four rankings: a top list that is a bar chart in a list's clothes.
 *
 * **Virtualized from its first commit**, per the standing invariant, and not
 * because fifty rows are expensive — they are not. The invariant has no
 * exceptions on purpose: virtualization is never retrofitted, and the day this
 * list grows a "show more" that pages toward `MAX_STATS_ROWS` is not the day to
 * start rewriting how it draws. The whole of it is two spacers over a fixed row
 * height, which is what `listViewport` exists for.
 *
 * Both totals are on every row whichever one the list is ordered by — the
 * engine refuses to pick between them and so does this. What the sort changes
 * is the order and the length of the bar behind the row.
 */

const props = defineProps<{
  spec: RankedListSpec
  result: StatsQueryResult | null
  sort: StatsSort
}>()

const emit = defineEmits<{ reveal: [text: string] }>()

const ROW_PX = 40
const BODY_PX = 360

const viewport = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const viewportPx = ref(0)

const rows = computed(() => rankedRows(props.result, props.sort, props.spec.dimension))
const caption = computed(() => rankedCaption(props.result, props.spec.unit))

const visible = computed(() =>
  visibleRange({
    total: rows.value.length,
    rowPx: ROW_PX,
    viewportPx: viewportPx.value,
    scrollTop: scrollTop.value
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

onMounted(() => {
  measure()
  observer = new ResizeObserver(measure)
  if (viewport.value) observer.observe(viewport.value)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
})
</script>

<template>
  <section
    class="flex min-h-0 flex-col overflow-hidden rounded-md border border-default bg-default"
    :aria-label="spec.title"
  >
    <header
      class="flex h-9 shrink-0 items-center gap-2 border-b border-default bg-elevated/30 px-3"
    >
      <UIcon :name="spec.icon" class="size-4 shrink-0 text-dimmed" aria-hidden="true" />
      <h3 class="text-xs font-semibold uppercase tracking-wide text-muted">{{ spec.title }}</h3>
      <span v-if="caption" class="ml-auto truncate text-xs tabular-nums text-dimmed">
        {{ caption }}
      </span>
    </header>

    <!--
      A fixed BODY_PX window, not a flex child. This section is an auto-height
      grid item, so `flex-1` here would let the body grow to its full content
      height (fifty rows, ~2000px) — the `height` would never bite, the box
      would stand as tall as its list, and `clientHeight` would report the whole
      thing, so `visibleRange` drew every row and nothing ever scrolled inside.
      Pinning the height restores the 288px window and its virtualization.

      No `overscroll-contain`, unlike the panels that fill their own pane. This
      window is embedded in the scrolling Stats page, so containment would trap
      the wheel: a list at its boundary — or too short to scroll — would swallow
      the event instead of letting the page move beneath it (B1). Native chaining
      scrolls the rows first, then the page.
    -->
    <div
      ref="viewport"
      class="overflow-y-auto"
      :style="{ height: `${BODY_PX}px` }"
      @scroll.passive="onScroll"
    >
      <div :style="{ height: `${visible.topPx}px` }" aria-hidden="true" />
      <ol class="m-0 list-none p-0">
        <li v-for="row in drawn" :key="row.key" :style="{ height: `${ROW_PX}px` }">
          <UTooltip :text="row.reveal === null ? undefined : `Show ${row.label} in the library`">
            <component
              :is="row.reveal === null ? 'div' : 'button'"
              :type="row.reveal === null ? undefined : 'button'"
              class="group relative flex h-full w-full items-center gap-2.5 overflow-hidden px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/70"
              :class="
                row.reveal === null ? 'cursor-default' : 'cursor-pointer hover:bg-elevated/50'
              "
              @click="row.reveal !== null && emit('reveal', row.reveal)"
            >
              <!--
              The magnitude bar: length only, never hue. Behind the row rather
              than beside it, so a fifty-row list stays a list — and washed far
              enough back that the text on top of it keeps its own contrast.
            -->
              <div
                class="pointer-events-none absolute inset-y-1 left-0 rounded-r-sm bg-primary/10"
                :style="{ width: `${row.share * 100}%` }"
                aria-hidden="true"
              />

              <span class="relative w-5 shrink-0 text-right text-xs tabular-nums text-dimmed">
                {{ row.rank }}
              </span>

              <!--
              The cover, for the lists that have one (spec.art). `artworkUrl`
              never fails — a null hash is the placeholder route, not a broken
              image — so the row draws a square or a circle either way rather
              than reflowing when art is missing. Decorative: the label beside it
              is the accessible name, so the alt is empty on purpose.
            -->
              <span
                v-if="spec.art !== 'none'"
                class="relative size-8 shrink-0 overflow-hidden border border-default bg-elevated"
                :class="spec.art === 'circle' ? 'rounded-full' : 'rounded'"
                aria-hidden="true"
              >
                <img
                  :src="artworkUrl(row.artworkHash, 'small')"
                  alt=""
                  class="size-full object-cover"
                  draggable="false"
                  loading="lazy"
                />
              </span>

              <span class="relative flex min-w-0 flex-1 flex-col">
                <span class="truncate text-sm text-default">{{ row.label }}</span>
                <span v-if="row.sublabel" class="truncate text-xs text-muted">
                  {{ row.sublabel }}
                </span>
              </span>

              <span class="relative shrink-0 text-right text-xs tabular-nums">
                <span class="block text-default">{{ row.plays }}</span>
                <span class="block text-muted">{{ row.time }}</span>
              </span>
            </component>
          </UTooltip>
        </li>
      </ol>
      <div :style="{ height: `${visible.bottomPx}px` }" aria-hidden="true" />

      <p v-if="rows.length === 0" class="px-3 py-6 text-center text-xs text-muted">
        Nothing yet in this window.
      </p>
    </div>
  </section>
</template>
