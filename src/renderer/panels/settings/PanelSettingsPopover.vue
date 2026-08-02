<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  buildPanelSettings,
  type PanelSettingsSurface
} from '@renderer/panels/settings/panelSettings'
import ScopedSettingRow from '@renderer/panels/settings/ScopedSettingRow.vue'
import SettingRow from '@renderer/panels/settings/SettingRow.vue'
import { settingsRouteFor } from '@renderer/shell/routes'
import type { CascadeScopeRef } from '@shared/settings'

/**
 * A panel's gear: the settings it affects, next to the thing they affect.
 *
 * Every row in here is generated from the same descriptors the settings view
 * renders, through the same `SettingField`. A panel declares which keys it
 * surfaces and gets rows back; it does not write a control, a label or a help
 * string, and there is no code path by which it could. That is the whole point —
 * the alternative is two settings UIs that drift, which is what happens to every
 * hand-written panel dialog eventually.
 *
 * It stays small on purpose. Three knobs used often, and a link out of every one
 * of them into its row in the full view, so the way to everything else is one
 * click rather than a hunt. A popover that grew a search box would have become
 * the thing it exists instead of.
 *
 * Panels remain islands: this reads the settings store and the router and
 * nothing else. A gear on the transport cannot see the track list, and does not
 * need to — the setting it turns is global, and W8-4 is what carries the change
 * to whoever is drawing from it.
 */
const props = defineProps<{
  surface: PanelSettingsSurface
  /**
   * The entity to resolve the surface's keys against, when the panel is showing
   * one. Required in practice for a surface that declares an `entity` — without
   * it the rows would edit the global value under a heading that said otherwise.
   */
  scope?: CascadeScopeRef
  /** Drawn as engaged, when the panel has a state worth reflecting in the button. */
  active?: boolean
  /** Said at the foot: why one of these controls may currently be doing nothing. */
  hint?: string
}>()

const router = useRouter()
const open = ref(false)

const panel = computed(() => buildPanelSettings(props.surface))

/**
 * A scoped surface renders override controls; an unscoped one renders the global
 * rows. Decided per surface rather than per row, because a popover in which some
 * controls edited this playlist and others edited the whole application would be
 * a popover whose heading cannot be written truthfully.
 */
const entityScope = computed(() =>
  props.surface.entity !== undefined && props.scope?.kind === props.surface.entity
    ? props.scope
    : null
)

/**
 * Declared keys that could not be drawn — an unknown key, or one that does not
 * cascade to this surface's entity.
 *
 * Said out loud rather than dropped. Both are a mistake in the declaration
 * rather than in the operator's library, and a popover that silently rendered
 * two of the three keys it was asked for is a bug that survives review.
 */
const undrawable = computed(() => [...panel.value.unknown, ...panel.value.unscoped])

function reveal(key: string): void {
  open.value = false
  void router.push(settingsRouteFor(key))
}
</script>

<template>
  <UPopover v-model:open="open" :ui="{ content: 'w-80 p-0' }">
    <UButton
      color="neutral"
      :variant="active ? 'soft' : 'ghost'"
      size="lg"
      :icon="surface.icon"
      :aria-label="`${surface.title} settings`"
      :title="`${surface.title} settings`"
    />

    <template #content>
      <div class="flex flex-col">
        <div class="flex items-center gap-2 border-b border-default px-3 py-2">
          <UIcon :name="surface.icon" class="size-4 shrink-0 text-dimmed" />
          <h3 class="min-w-0 truncate text-sm font-semibold text-highlighted">
            {{ surface.title }}
          </h3>
        </div>

        <div class="divide-y divide-default/60">
          <template v-for="row in panel.rows" :key="row.key">
            <ScopedSettingRow
              v-if="entityScope"
              :row="row"
              :scope="entityScope"
              linkable
              @reveal="reveal(row.key)"
            />
            <SettingRow v-else :row="row" compact linkable @reveal="reveal(row.key)" />
          </template>
        </div>

        <p v-if="hint" class="border-t border-default px-3 py-2 text-xs text-dimmed">{{ hint }}</p>

        <p
          v-if="undrawable.length > 0"
          class="border-t border-default px-3 py-2 text-xs text-warning"
        >
          {{ undrawable.join(', ') }}
          could not be drawn here.
        </p>
      </div>
    </template>
  </UPopover>
</template>
