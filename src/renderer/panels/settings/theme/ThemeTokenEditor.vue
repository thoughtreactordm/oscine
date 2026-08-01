<script setup lang="ts">
import { useMediaQuery } from '@vueuse/core'
import { computed, onBeforeUnmount, ref } from 'vue'
import TokenEditorRow from './TokenEditorRow.vue'
import { buildTokenRows, groupTokenIds, TOKEN_ROW_PX } from './tokenRows'
import { visibleRange } from '@renderer/panels/listViewport'
import { useThemeStore } from '@renderer/stores/theme'
import {
  CONTRAST_PAIRS,
  findContrastFailures,
  withOverride,
  withoutOverride,
  type ContrastFinding,
  type RampSpec,
  type ThemeOverrides
} from '@shared/theme'

/**
 * The token editor — W8-12's step 5, and the whole of what `theme.overrides`
 * means to an operator.
 *
 * Three things are worth knowing about how it works, because none of them is
 * visible in the markup:
 *
 * 1. **There is no apply button and no preview mode, and building one would be
 *    a bug.** `settings.set` is visible to every reader synchronously,
 *    `useSettings().get` is reactive, and the theme store's `watchEffect`
 *    already calls `updateTheme`. Writing an override repaints on the next tick.
 *    Preview is not a feature here; it is the absence of one.
 * 2. **Effective values are read from the applied theme, not resolved again.**
 *    `themeStore.state.resolved` is what is on screen — including the theme's
 *    own ramp where an override failed, and including T12's motion clamp. A
 *    second resolution in this component could disagree with the window behind
 *    the dialog, and the operator would have no way to tell which was lying.
 * 3. **Virtualized from the first commit**, like every list in this app. Thirty
 *    tokens is under a screen today; the catalog is the thing this card exists
 *    to let grow, and search spans every group at once.
 */
const props = defineProps<{
  modelValue: ThemeOverrides
  disabled?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [ThemeOverrides] }>()

const themeStore = useThemeStore()

const query = ref('')
const overriddenOnly = ref(false)

const scroller = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const viewportPx = ref(0)

const resolved = computed(() => themeStore.state.resolved)
const tokens = computed(() => resolved.value.tokens)
const unknownIds = computed(() => resolved.value.unknown)
const unresolved = computed(() => new Set(resolved.value.unresolved))

/**
 * Which tokens the operator has moved, which is also what `findContrastFailures`
 * uses to apportion blame. A pairing that was already short before they touched
 * anything is the theme's problem, not theirs, and the finding says so.
 */
const changed = computed(() => new Set(Object.keys(props.modelValue)))

const findings = computed(() => findContrastFailures(tokens.value, CONTRAST_PAIRS, changed.value))

/**
 * A finding names two tokens and either could be the one to fix, so it is filed
 * under both. Blamed rows come first, so the row the operator just changed shows
 * its own consequence rather than a warning about a token they have not opened.
 */
const warningsById = computed(() => {
  const byToken = new Map<string, ContrastFinding[]>()
  for (const finding of findings.value) {
    for (const id of [finding.pair.foreground, finding.pair.background]) {
      const list = byToken.get(id) ?? []
      if (finding.blame === id) list.unshift(finding)
      else list.push(finding)
      byToken.set(id, list)
    }
  }
  return byToken
})

const catalog = computed(() =>
  buildTokenRows({
    overrides: props.modelValue,
    unknown: unknownIds.value,
    query: query.value,
    overriddenOnly: overriddenOnly.value
  })
)

const rowWindow = computed(() =>
  visibleRange({
    total: catalog.value.rows.length,
    rowPx: TOKEN_ROW_PX,
    viewportPx: viewportPx.value,
    scrollTop: scrollTop.value
  })
)

const drawn = computed(() =>
  catalog.value.rows.slice(rowWindow.value.first, rowWindow.value.last + 1)
)

function rowTop(index: number): number {
  return (rowWindow.value.first + index) * TOKEN_ROW_PX
}

/**
 * Measured by observer rather than once on mount.
 *
 * `SettingsPane` reads `clientHeight` when the ref lands and gets a real number,
 * because its scroller is laid out by then. This one is inside a dialog: at ref
 * time the modal has not been positioned, the element reports zero, and
 * `visibleRange` falls back to drawing the overscan — which happens to cover a
 * short window and leaves a tall one blank below the fold. The observer also
 * covers the resize that a `60vh` body makes routine.
 */
let observer: ResizeObserver | null = null

function measure(el: unknown): void {
  const next = el instanceof HTMLElement ? el : null
  observer?.disconnect()
  scroller.value = next
  if (!next) return

  viewportPx.value = next.clientHeight
  observer = new ResizeObserver(() => {
    viewportPx.value = next.clientHeight
  })
  observer.observe(next)
}

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
})

function onScroll(): void {
  const el = scroller.value
  if (!el) return
  scrollTop.value = el.scrollTop
  viewportPx.value = el.clientHeight
}

/**
 * T12, said on the surface that would otherwise look broken.
 *
 * Motion tokens are clamped after overrides, so an operator who sets a duration
 * here and sees nothing move is looking at an accessibility preference working
 * correctly. Read from the media query rather than inferred from the resolved
 * value, because a theme is allowed to ship zero-duration motion and that is a
 * different fact.
 */
const systemReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')

function set(id: string, value: string | RampSpec): void {
  emit('update:modelValue', withOverride(props.modelValue, id, value))
}

/**
 * `withoutOverride` returns the same object when there was nothing to remove,
 * which is the whole reason it is written that way — reverting a token that was
 * never overridden should not spend a debounced database write.
 */
function revert(id: string): void {
  const next = withoutOverride(props.modelValue, id)
  if (next !== props.modelValue) emit('update:modelValue', next)
}

function revertGroup(groupId: string): void {
  let next = props.modelValue
  for (const id of groupTokenIds(groupId, props.modelValue, unknownIds.value)) {
    next = withoutOverride(next, id)
  }
  if (next !== props.modelValue) emit('update:modelValue', next)
}

/*
 * No confirmation, unlike Reset all settings. This clears one key, every row it
 * clears is on screen with its own revert beside it, and the count in the label
 * says exactly how much is about to go — the pair that makes an immediate
 * destructive action legible. `SettingsPane` draws the same conclusion about a
 * section.
 */
function revertEverything(): void {
  if (catalog.value.overridden === 0 && unknownIds.value.length === 0) return
  emit('update:modelValue', {})
}

const storedCount = computed(() => Object.keys(props.modelValue).length)
</script>

<template>
  <section class="flex h-full min-h-0 flex-col" aria-label="Theme tokens">
    <header class="flex shrink-0 flex-col gap-2 border-b border-default px-4 py-3">
      <div class="flex items-center gap-2">
        <UInput
          v-model="query"
          icon="i-tabler-search"
          size="sm"
          class="min-w-0 flex-1"
          placeholder="Search tokens — name, description or keyword"
          aria-label="Search theme tokens"
          spellcheck="false"
        />

        <UButton
          :color="overriddenOnly ? 'primary' : 'neutral'"
          :variant="overriddenOnly ? 'soft' : 'ghost'"
          size="xs"
          icon="i-tabler-filter"
          :label="`Yours (${catalog.overridden})`"
          :aria-pressed="overriddenOnly"
          title="Show only the tokens you have overridden"
          class="shrink-0 text-xs"
          @click="overriddenOnly = !overriddenOnly"
        />

        <UButton
          v-if="storedCount > 0"
          color="neutral"
          variant="ghost"
          size="xs"
          icon="i-tabler-rotate-2"
          :label="`Revert all (${storedCount})`"
          title="Drop every override and go back to the theme as it ships"
          class="shrink-0 text-xs"
          @click="revertEverything"
        />
      </div>

      <p class="text-[11px] text-dimmed">
        Editing
        <span class="font-medium text-muted">{{ themeStore.themeName }}</span>
        in
        <span class="font-medium text-muted">{{ themeStore.mode }}</span>
        mode. Overrides sit on top of whichever theme and mode are showing, and are kept when you
        switch away.
      </p>

      <p v-if="systemReducedMotion" class="text-[11px] text-warning">
        Your system asks for reduced motion, so transition timing is held at zero whatever is set
        here. The values are kept and will apply if that preference changes.
      </p>
    </header>

    <div
      :ref="measure"
      class="min-h-0 flex-1 overflow-y-auto"
      role="list"
      aria-label="Theme tokens"
      @scroll="onScroll"
    >
      <div v-if="catalog.rows.length === 0" class="px-4 py-10 text-center text-xs text-dimmed">
        <template v-if="overriddenOnly && query.trim().length === 0">
          Nothing is overridden. Every token is the theme's own — which is what a theme you have not
          edited looks like.
        </template>
        <template v-else>
          Nothing matches “{{ query.trim() }}”. Search runs over names, descriptions, keywords and
          custom property names.
        </template>
      </div>

      <div
        v-else
        :style="{ height: `${catalog.rows.length * TOKEN_ROW_PX}px`, position: 'relative' }"
      >
        <TokenEditorRow
          v-for="(row, i) in drawn"
          :key="row.key"
          :row="row"
          :tokens="tokens"
          :overrides="modelValue"
          :warnings="warningsById.get(row.key)"
          :unresolved="unresolved.has(row.key)"
          :disabled="disabled"
          role="listitem"
          class="absolute inset-x-0"
          :style="{ top: `${rowTop(i)}px`, height: `${TOKEN_ROW_PX}px` }"
          @set="set"
          @revert="revert"
          @revert-group="revertGroup"
        />
      </div>
    </div>

    <!--
      The contrast summary is a count and a way to reach the rows, not a
      gatekeeper. T7 chose warn-only because refusing the write would make a
      deliberately low-contrast theme unauthorable, and a footer that said
      "cannot save" would be that refusal wearing a friendlier hat.
    -->
    <footer
      class="flex shrink-0 items-center gap-2 border-t border-default px-4 py-2 text-[11px]"
      aria-live="polite"
    >
      <template v-if="findings.length > 0">
        <UIcon name="i-tabler-contrast" class="size-4 shrink-0 text-warning" />
        <span class="min-w-0 flex-1 truncate text-warning">
          {{ findings.length }}
          {{ findings.length === 1 ? 'pairing is' : 'pairings are' }}
          under WCAG AA — {{ findings.map((finding) => finding.pair.where).join('; ') }}.
        </span>
      </template>
      <template v-else>
        <UIcon name="i-tabler-check" class="size-4 shrink-0 text-success" />
        <span class="min-w-0 flex-1 truncate text-muted">
          Every checked pairing meets WCAG 2.1 AA.
        </span>
      </template>

      <span class="shrink-0 text-dimmed">
        {{ catalog.matched }} {{ catalog.matched === 1 ? 'row' : 'rows' }}
        <template v-if="catalog.filtered">shown</template>
      </span>
    </footer>
  </section>
</template>
