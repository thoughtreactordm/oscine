<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { buildSettingsCatalog, SETTING_ROW_PX } from '@renderer/panels/settings/catalog'
import { visibleRange } from '@renderer/panels/listViewport'
import RebuildCountersAction from '@renderer/panels/settings/RebuildCountersAction.vue'
import SettingRow from '@renderer/panels/settings/SettingRow.vue'
import { useSettings } from '@renderer/settings'
import { useSettingsNavStore } from '@renderer/stores/settingsNav'

/**
 * The body of the settings surface: one section's rows, or a query's matches
 * across all of them.
 *
 * Virtualized from its first commit like every other list here. A settings pane
 * looks like the one place the rule could be waived — six categories, a dozen
 * keys — and it is the place where waiving it would be least visible and most
 * expensive later: Interface and Audio each have most of a workstream still to
 * land, and W8-12's token editor is a list of every custom property the theme
 * layer defines. Uniform rows plus `visibleRange` is the whole implementation.
 *
 * The header is furniture: which section, how the query did, and the advanced
 * disclosure. Everything below it is generated.
 */
const nav = useSettingsNavStore()
const settings = useSettings()

const scroller = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const viewportPx = ref(0)

const changed = computed(() => new Set(settings.changedKeys.value))

const catalog = computed(() =>
  buildSettingsCatalog(undefined, {
    query: nav.query,
    category: nav.category,
    advanced: nav.advanced,
    changed: changed.value,
    changedOnly: nav.changedOnly
  })
)

const section = computed(() =>
  catalog.value.sections.find((entry) => entry.id === catalog.value.category)
)

/**
 * Reverting a section is offered where there is something in it to revert, and
 * only while a section is what is being shown.
 *
 * `section.changed` counts the whole category rather than the drawn rows, so an
 * advanced key hidden behind a shut disclosure still makes the button appear —
 * and pressing it still clears that key. A sweep that silently skipped what the
 * disclosure was hiding would leave the operator convinced they had reset Audio.
 */
const sectionChanged = computed(() => (catalog.value.spanning ? 0 : (section.value?.changed ?? 0)))

function revertSection(): void {
  const id = catalog.value.category
  if (id) void settings.resetCategory(id)
}

const rowWindow = computed(() =>
  visibleRange({
    total: catalog.value.rows.length,
    rowPx: SETTING_ROW_PX,
    viewportPx: viewportPx.value,
    scrollTop: scrollTop.value
  })
)

const drawn = computed(() =>
  catalog.value.rows.slice(rowWindow.value.first, rowWindow.value.last + 1)
)

function rowTop(index: number): number {
  return (rowWindow.value.first + index) * SETTING_ROW_PX
}

/** Durable keys read their defaults until `settings.getAll` lands. */
const hydrated = computed(() => settings.hydrated.value)

function measure(el: unknown): void {
  scroller.value = el instanceof HTMLElement ? el : null
  if (scroller.value) viewportPx.value = scroller.value.clientHeight
}

function onScroll(): void {
  const el = scroller.value
  if (!el) return
  scrollTop.value = el.scrollTop
  viewportPx.value = el.clientHeight
}

const advancedOpen = computed(() => nav.isAdvancedOpen(catalog.value.category))

function toggleAdvanced(): void {
  if (catalog.value.category) nav.toggleAdvanced(catalog.value.category)
}

/**
 * A reveal lands here.
 *
 * `flush: 'post'` and a tick because the reveal may have changed the section or
 * opened a disclosure, and the row's index is only knowable once the catalog has
 * recomputed. A row already on screen is left where it is — a deep link to
 * something the operator can already see should mark it, not jolt the list — and
 * anything else is centred, so the rows around it come along as context.
 */
watch(
  () => nav.scrollTo,
  async (key) => {
    if (!key) return
    await nextTick()

    const index = catalog.value.rows.findIndex((row) => row.key === key)
    const el = scroller.value
    if (index < 0 || !el) {
      nav.scrolled()
      return
    }

    const top = index * SETTING_ROW_PX
    const onScreen = top >= el.scrollTop && top + SETTING_ROW_PX <= el.scrollTop + el.clientHeight
    if (!onScreen) {
      el.scrollTop = Math.max(0, top - el.clientHeight / 2 + SETTING_ROW_PX / 2)
      onScroll()
    }
    nav.scrolled()
  },
  { flush: 'post' }
)
</script>

<template>
  <section class="flex h-full min-h-0 flex-col bg-default" aria-label="Settings">
    <header
      class="flex shrink-0 items-center gap-3 border-b border-default bg-elevated/30 px-4 py-2"
    >
      <div class="flex min-w-0 flex-1 items-center gap-2">
        <UIcon
          v-if="section && !catalog.spanning"
          :name="section.icon"
          class="size-4 shrink-0 text-dimmed"
        />
        <UIcon
          v-else-if="catalog.changedOnly"
          name="i-tabler-filter"
          class="size-4 shrink-0 text-dimmed"
        />
        <h1 class="min-w-0 truncate text-sm font-semibold text-highlighted">
          <template v-if="catalog.filtered">Search results</template>
          <template v-else-if="catalog.changedOnly">Changed from default</template>
          <template v-else>{{ section?.label ?? 'Settings' }}</template>
        </h1>
        <span v-if="catalog.filtered" class="shrink-0 text-[11px] text-dimmed">
          {{ catalog.rows.length }}
          {{ catalog.rows.length === 1 ? 'setting matches' : 'settings match' }}
          “{{ nav.query.trim() }}”
        </span>
        <span v-else-if="catalog.changedOnly" class="shrink-0 text-[11px] text-dimmed">
          {{ catalog.rows.length }}
          {{ catalog.rows.length === 1 ? 'setting differs' : 'settings differ' }}
          from what Fermata ships with
        </span>
      </div>

      <!--
        The Library section's one maintenance action. Here rather than as a
        generated row because it has no stored value to be a row of — see the
        component. Hidden while a query or the changed filter spans sections,
        like everything else in this header that is about one section.
      -->
      <RebuildCountersAction v-if="!catalog.spanning && section?.id === 'library'" />

      <!--
        Not behind a confirmation, unlike Reset all. A section is a scope the
        operator can see the whole of, every row in it carries its own revert,
        and the changed filter above says exactly what is about to go — which is
        the pair that makes an immediate destructive action legible rather than a
        surprise.
      -->
      <UButton
        v-if="sectionChanged > 0"
        size="xs"
        color="neutral"
        variant="ghost"
        icon="i-tabler-arrow-back-up"
        :label="`Revert section (${sectionChanged})`"
        :title="`Revert every ${section?.label} setting to the built-in default`"
        class="shrink-0 text-xs"
        @click="revertSection"
      />

      <!--
        Hidden while a query or the changed filter is active because both already
        disclose every advanced row they turn up — offering to open what is open
        would be a control that does nothing.
      -->
      <UButton
        v-if="!catalog.spanning && (section?.advancedTotal ?? 0) > 0"
        size="xs"
        color="neutral"
        variant="ghost"
        :icon="advancedOpen ? 'i-tabler-chevron-down' : 'i-tabler-chevron-right'"
        :label="`Advanced (${section?.advancedTotal})`"
        :aria-expanded="advancedOpen"
        class="shrink-0 text-xs"
        @click="toggleAdvanced"
      />
    </header>

    <div v-if="!hydrated" class="flex flex-col gap-2 p-4" aria-busy="true">
      <USkeleton v-for="n in 6" :key="n" class="h-10 w-full" />
    </div>

    <div
      v-else
      :ref="measure"
      class="min-h-0 flex-1 overflow-y-auto"
      role="list"
      :aria-label="
        catalog.filtered
          ? 'Matching settings'
          : catalog.changedOnly
            ? 'Settings changed from default'
            : (section?.label ?? 'Settings')
      "
      @scroll="onScroll"
    >
      <div v-if="catalog.rows.length === 0" class="px-4 py-10 text-center text-xs text-dimmed">
        <template v-if="catalog.filtered">
          Nothing matches “{{ nav.query.trim() }}”. Search runs over names, descriptions and
          keywords.
        </template>
        <!--
          The good news case, and worth saying as such: an empty delta is what a
          working install looks like, not a filter that has gone wrong.
        -->
        <template v-else-if="catalog.changedOnly">
          Every setting is at the value Fermata ships with.
        </template>
        <template v-else>This section has no settings yet.</template>
      </div>

      <div
        v-else
        :style="{ height: `${catalog.rows.length * SETTING_ROW_PX}px`, position: 'relative' }"
      >
        <SettingRow
          v-for="(row, i) in drawn"
          :key="row.key"
          :row="row"
          :show-category="catalog.spanning"
          :highlighted="nav.highlighted === row.key"
          role="listitem"
          class="absolute inset-x-0"
          :style="{ top: `${rowTop(i)}px`, height: `${SETTING_ROW_PX}px` }"
        />
      </div>

      <!--
        Said rather than implied. A section whose visible rows are all there is
        looks identical to one hiding four behind a collapsed disclosure, and the
        operator hunting for a decode budget has no reason to suspect the second.
      -->
      <p
        v-if="catalog.withheldAdvanced > 0"
        class="border-t border-default/60 px-4 py-3 text-[11px] text-dimmed"
      >
        {{ catalog.withheldAdvanced }} advanced
        {{ catalog.withheldAdvanced === 1 ? 'setting is' : 'settings are' }} hidden in this section.
      </p>
    </div>
  </section>
</template>
