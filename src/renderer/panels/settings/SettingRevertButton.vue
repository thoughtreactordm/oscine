<script setup lang="ts">
/**
 * One revert affordance, wherever a value can be reverted to the level beneath
 * it.
 *
 * A component rather than a snippet in `SettingRow` because there are two
 * callers with the same shape and different meanings: a row on the settings
 * surface reverts a global value to the descriptor default, and an entity
 * control built on `useCascade` reverts an override to whatever it was
 * inheriting. W8-5 made that distinction resolvable — `provenanceLabel` turns
 * `inheritedFrom` into the phrase — and the card requires it to reach the
 * operator, so the destination is what this takes and the label is built from
 * it. A button that said "Reset" in both places would be the same button telling
 * two different lies.
 *
 * The phrase is the button's accessible name and its `UTooltip` rather than
 * on-screen text: the row is a fixed 64px and the list is virtualized on that
 * number, so a 180-pixel label would cost the control beside it more room than
 * the distinction is worth. Hovering says it; a screen reader reads it.
 */
defineProps<{
  /** Where reverting sends the value, as a phrase — `provenanceLabel`'s output. */
  destination: string
}>()

defineEmits<{ revert: [] }>()
</script>

<template>
  <UTooltip :text="`Revert to ${destination}`">
    <UButton
      color="neutral"
      variant="ghost"
      size="xs"
      icon="i-tabler-arrow-back-up"
      :aria-label="`Revert to ${destination}`"
      @click="$emit('revert')"
    />
  </UTooltip>
</template>
