<script setup lang="ts">
import { computed } from 'vue'
import type { SettingsRow } from '@renderer/panels/settings/catalog'
import { surfacesForKey } from '@renderer/panels/settings/panelSettings'
import SettingField from '@renderer/panels/settings/SettingField.vue'
import { useSettings } from '@renderer/settings'
import { DEFAULT_PROVENANCE, provenanceLabel } from '@shared/settings'

/**
 * One setting at global scope: the binding, and nothing about the drawing.
 *
 * What a row *looks like* is `SettingField`'s, shared with the inline popovers,
 * so a descriptor cannot be phrased one way here and another way there. What is
 * left in this file is the half that genuinely differs between the two: where
 * the value comes from, and therefore what reverting means.
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
  /** Stacked, for a panel's inline popover. */
  compact?: boolean
  /** Offer a way through to this row in the full settings view. */
  linkable?: boolean
}>()

defineEmits<{ reveal: [] }>()

const settings = useSettings()

const model = computed<unknown>({
  get: () => settings.get(props.row.key),
  set: (value) => {
    void settings.set(props.row.key, value)
  }
})

/**
 * Both states of the restart flag, because they say different things — and
 * neither is a list anywhere; both come off the descriptor's flag and the
 * store's `restartRequired`.
 */
const restart = computed<'needed' | 'pending' | null>(() => {
  if (settings.restartRequired.value.includes(props.row.key)) return 'pending'
  return props.row.requiresRestart ? 'needed' : null
})

/**
 * Offered where there is a row to delete, not where the value has moved.
 *
 * The two nearly coincide — a value can only differ from its default because
 * something stored it — and they come apart in exactly the case the affordance
 * matters most for: a row that holds the default anyway. Nothing on screen has
 * changed, so it stays out of the changed-from-default filter, but the row is
 * what stops this key following the default if a later build moves it. Deleting
 * it is the only way to resume tracking, so the button has to be there to press.
 *
 * The settings surface edits the global scope, so reverting always lands on the
 * descriptor default. Phrased through `provenanceLabel` rather than written out,
 * so this row and an entity control built on `useCascade` name their levels with
 * the same vocabulary.
 */
const revertTo = computed(() =>
  settings.isStored(props.row.key) ? provenanceLabel(DEFAULT_PROVENANCE) : null
)

/**
 * The reverse of W8-8's deep link, and the cheap half of it: a row that names
 * where else the operator could have reached this.
 *
 * Worth saying because the inline gears are the part of the surface nobody finds
 * by looking for it — an operator who has just tuned crossfade in Settings is
 * the one person guaranteed to be interested that the transport has it too.
 * Read from the same declarations the popovers are generated from, so it cannot
 * name a gear that is no longer there.
 */
const alsoOn = computed(() => {
  // Withheld inside a popover, which is one of the places it would be naming.
  if (props.compact) return null
  const surfaces = surfacesForKey(props.row.key)
  if (surfaces.length === 0) return null
  return `Also on ${surfaces.map((surface) => surface.where).join(', and on ')}.`
})

function revert(): void {
  void settings.reset(props.row.key)
}
</script>

<template>
  <SettingField
    v-model="model"
    :row="row"
    :show-category="showCategory"
    :highlighted="highlighted"
    :revert-to="revertTo"
    :restart="restart"
    :note="alsoOn"
    :compact="compact"
    :linkable="linkable"
    @revert="revert"
    @reveal="$emit('reveal')"
  />
</template>
