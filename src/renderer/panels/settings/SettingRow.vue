<script setup lang="ts">
import { computed } from 'vue'
import type { SettingsRow } from '@renderer/panels/settings/catalog'
import SettingControl from '@renderer/panels/settings/SettingControl.vue'
import { useSettings } from '@renderer/settings'

/**
 * One setting: what it is called, what it does, and the thing that changes it.
 *
 * The row is where a descriptor meets a value, and it is the unit W8-8's inline
 * popovers will reuse — which is why the label and help come off the descriptor
 * here rather than being written into a template. Two renderings of one
 * definition is the point of the registry; two templates that both happen to say
 * "Gapless playback" is the failure it exists to prevent.
 *
 * Writes go straight out. There is no OK and no Cancel anywhere on this surface
 * (W8-4), so the setter is the whole commit path; a value main refuses is
 * reconciled back by the store and the control returns to what is actually
 * stored.
 */
const props = defineProps<{
  row: SettingsRow
  /** Name the section the row belongs to — what a search result needs. */
  showCategory?: boolean
  /** Drawn as just-arrived-at, after a deep link or a jump from search. */
  highlighted?: boolean
}>()

const settings = useSettings()

const model = computed<unknown>({
  get: () => settings.get(props.row.key),
  set: (value) => {
    void settings.set(props.row.key, value)
  }
})

/**
 * Both states of the flag, because they say different things.
 *
 * A key that always needed a restart should say so before it is touched, not
 * after — otherwise the operator learns about the restart by discovering the
 * change did nothing. The louder badge is the store's `restartRequired`, which
 * is the narrower claim: this value has actually moved since the process
 * started. Neither is a list anywhere; both come off the descriptor's flag.
 */
const restartPending = computed(() => settings.restartRequired.value.includes(props.row.key))
</script>

<template>
  <div
    :id="row.anchorId"
    class="flex items-center gap-4 border-b border-default/60 px-4 transition-colors"
    :class="highlighted ? 'bg-primary/10' : 'hover:bg-elevated/40'"
    :data-setting-key="row.key"
  >
    <div class="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
      <div class="flex min-w-0 items-center gap-2">
        <span v-if="showCategory" class="shrink-0 text-[11px] text-dimmed">
          {{ row.categoryLabel }} ▸
        </span>
        <span class="min-w-0 truncate text-xs font-medium text-highlighted">
          {{ row.descriptor.label }}
        </span>
        <UBadge
          v-if="restartPending"
          color="warning"
          variant="subtle"
          size="sm"
          label="Restart to apply"
          class="shrink-0"
        />
        <UBadge
          v-else-if="row.requiresRestart"
          color="neutral"
          variant="subtle"
          size="sm"
          label="Needs restart"
          class="shrink-0"
        />
      </div>
      <!--
        One clamped line, because the row is a fixed height and the list is
        virtualized on that number. The full text is on the element, so it is a
        hover away rather than gone.
      -->
      <p class="truncate text-[11px] text-muted" :title="row.descriptor.help">
        {{ row.descriptor.help }}
      </p>
    </div>

    <div class="flex w-72 shrink-0 justify-end">
      <SettingControl v-model="model" :descriptor="row.descriptor" class="w-full" />
    </div>
  </div>
</template>
