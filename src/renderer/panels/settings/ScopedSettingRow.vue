<script setup lang="ts">
import { computed } from 'vue'
import type { SettingsRow } from '@renderer/panels/settings/catalog'
import SettingField from '@renderer/panels/settings/SettingField.vue'
import { useCascade, useSettings } from '@renderer/settings'
import type { CascadeScopeRef } from '@shared/settings'

/**
 * One setting resolved at an entity: the same field, bound to an override.
 *
 * The other half of W8-8's inline story. A gear on the playlist header edits
 * *this playlist's* crossfade, and the operator has to be able to see at a
 * glance whether the number in front of them is the playlist's own or the
 * global one showing through — which is precisely the affordance W8-5 built
 * `useCascade` to stop every per-entity control from reinventing.
 *
 * Nothing about the drawing lives here. `SettingField` is the same component the
 * settings view mounts, so an override control and a global row are the same
 * label, the same help and the same widget over the same descriptor; the only
 * thing that differs is what reverting means, and that is stated rather than
 * implied — `inheritedFrom` phrases the destination, so the button says "Revert
 * to the global setting" where the settings view's says "Revert to the built-in
 * default".
 *
 * The three states, and why the third is not folded into the first:
 *
 * | State | `overridden` | Drawn as |
 * |---|---|---|
 * | inheriting | `false` | the inherited value, captioned with where it came from |
 * | overridden here | `true` | the override, with revert offered |
 * | set here, equal to inherited | `true` | the same, and **still** with revert offered |
 *
 * A control that compared the two values and drew the first state when they
 * matched would silently discard an explicit choice at the exact moment it
 * starts to matter — the two stop matching only when the global moves, which is
 * the thing the operator pinned against.
 */
const props = defineProps<{
  row: SettingsRow
  /** The entity whose override this edits. */
  scope: CascadeScopeRef
  /** Offer a way through to this row in the full settings view. */
  linkable?: boolean
}>()

defineEmits<{ reveal: [] }>()

const settings = useSettings()

const binding = useCascade(settings, props.row.descriptor, () => props.scope)

/** Lifted to a top-level ref so `v-model` writes through it rather than at it. */
const model = binding.value

/**
 * Revert is offered only once this scope's rows have arrived.
 *
 * Everything else reads correctly before then — as what the entity would inherit
 * — so the control renders immediately rather than flashing a skeleton. What it
 * must not do is offer to delete a row it has not yet established exists.
 */
const revertTo = computed(() =>
  binding.loaded.value && binding.overridden.value ? binding.inheritedFrom.value : null
)

/**
 * Said in words, because "greyed out" is not a legend anyone reads.
 *
 * An inheriting control names where the value is coming from; an overriding one
 * names what it is standing in front of, which is what makes reverting a known
 * quantity rather than a leap.
 */
const note = computed(() =>
  binding.overridden.value
    ? `Overrides ${binding.inheritedFrom.value}.`
    : `Inherited from ${binding.inheritedFrom.value}.`
)
</script>

<template>
  <SettingField
    v-model="model"
    :row="row"
    compact
    :revert-to="revertTo"
    :note="note"
    :linkable="linkable"
    @revert="binding.revert()"
    @reveal="$emit('reveal')"
  />
</template>
