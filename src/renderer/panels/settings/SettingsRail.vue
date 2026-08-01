<script setup lang="ts">
import { computed } from 'vue'
import { buildSettingsCatalog } from '@renderer/panels/settings/catalog'
import ProfileActions from '@renderer/panels/settings/ProfileActions.vue'
import ResetAllDialog from '@renderer/panels/settings/ResetAllDialog.vue'
import { useSettings } from '@renderer/settings'
import { useSettingsNavStore } from '@renderer/stores/settingsNav'
import type { SettingCategoryId } from '@shared/settings'

/**
 * The search box and the category rail — the settings surface's navigation.
 *
 * Search first, and above the rail rather than beside it, because it is the
 * primary way in. A rail is a fine index of six domains and a poor one of two
 * hundred keys, and this surface is heading for the second: every card left in
 * W8 adds rows, and none of them adds a category. The rail is what you use when
 * you know which domain a thing lives in; the box is what you use the rest of
 * the time.
 *
 * Derives its own catalog. It could be handed one by the body, but the body is a
 * routed sibling in a different slot of the frame, and the derivation is a sort
 * over a few dozen descriptors — cheaper than the coupling would be.
 */
const nav = useSettingsNavStore()
const settings = useSettings()

const changed = computed(() => new Set(settings.changedKeys.value))

const catalog = computed(() =>
  buildSettingsCatalog(undefined, {
    query: nav.query,
    category: nav.category,
    changed: changed.value,
    changedOnly: nav.changedOnly
  })
)

/** Which rail entry reads as current: the query's section while one is set. */
const current = computed(() => catalog.value.category)

function select(id: SettingCategoryId): void {
  nav.selectCategory(id)
}

/**
 * Enter goes to the first match.
 *
 * `reveal` keeps the query when the target still answers to it, so this scrolls
 * and marks the row without emptying the box that found it — the operator can
 * type, jump, and then keep going down the list. The same applies to the changed
 * filter, and the row came out of the filtered list, so it says so.
 */
function jumpToFirstMatch(): void {
  const first = catalog.value.rows[0]
  if (first) nav.reveal(first.key, { changed: nav.changedOnly })
}
</script>

<template>
  <nav class="flex h-full min-h-0 flex-col bg-default" aria-label="Settings categories">
    <div class="border-b border-default px-3 py-2">
      <UInput
        :model-value="nav.query"
        icon="i-tabler-search"
        size="sm"
        placeholder="Search settings"
        aria-label="Search settings"
        class="w-full"
        :ui="{ trailing: 'pe-1' }"
        @update:model-value="nav.setQuery(String($event))"
        @keydown.enter="jumpToFirstMatch"
        @keydown.esc="nav.setQuery('')"
      >
        <template v-if="nav.query.length > 0" #trailing>
          <UButton
            color="neutral"
            variant="link"
            size="xs"
            icon="i-tabler-x"
            aria-label="Clear search"
            @click="nav.setQuery('')"
          />
        </template>
      </UInput>

      <!--
        Under the search box, because it is the other way of narrowing two
        hundred rows and the one you reach for when you cannot name what you
        broke. The count is on the button rather than beside it: "Changed (0)" is
        the answer to "have I touched anything" without having to press it.
      -->
      <UButton
        :color="nav.changedOnly ? 'primary' : 'neutral'"
        :variant="nav.changedOnly ? 'subtle' : 'ghost'"
        size="xs"
        icon="i-tabler-filter"
        :label="`Changed from default (${catalog.changedTotal})`"
        :aria-pressed="nav.changedOnly"
        class="mt-2 w-full justify-start text-xs"
        @click="nav.toggleChangedOnly()"
      />
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto py-1" role="list">
      <button
        v-for="section in catalog.sections"
        :key="section.id"
        type="button"
        role="listitem"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors"
        :class="[
          current === section.id && !catalog.spanning
            ? 'bg-elevated text-highlighted'
            : 'hover:bg-elevated/60',
          catalog.spanning && section.matches === 0 ? 'opacity-40' : ''
        ]"
        :aria-current="current === section.id && !catalog.spanning ? 'true' : undefined"
        @click="select(section.id)"
      >
        <UIcon :name="section.icon" class="size-4 shrink-0 text-dimmed" />
        <span class="min-w-0 flex-1 truncate text-xs font-medium">{{ section.label }}</span>
        <!--
          The count is what the narrowing did, not how big the section is.
          Without it a search that matches nothing under Library looks identical
          to one that matches four, and the rail is the only place that
          comparison is visible at all — the body only ever draws one answer. The
          same holds for the changed filter, where it doubles as the per-section
          delta: which domain the operator has been turning knobs in.
        -->
        <span v-if="catalog.spanning" class="shrink-0 text-[11px] text-dimmed tabular-nums">
          {{ section.matches }}
        </span>
      </button>
    </div>

    <div class="flex shrink-0 flex-col gap-0.5 border-t border-default px-3 py-2">
      <ProfileActions />
      <ResetAllDialog />
    </div>
  </nav>
</template>
