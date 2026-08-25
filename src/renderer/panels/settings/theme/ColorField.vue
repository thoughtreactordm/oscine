<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { clampToGamut, formatOklch, isOutOfGamut, parseColor, toHex } from '@shared/theme'

/**
 * One colour, entered either way round.
 *
 * The text field is the real control — it takes hex, `rgb()` or `oklch()`,
 * because an operator arriving with a brand colour has it in one of those and
 * should not have to convert it. The native swatch beside it is the other half:
 * a picker for the operator who does not have a value in mind, and the only way
 * to choose a colour by looking at it.
 *
 * **Committed live, on every keystroke that parses.** That is the whole preview
 * mechanism — `settings.set` is visible synchronously and debounces the write,
 * the theme store's `watchEffect` repaints, and there is nothing to press. Text
 * that does not parse simply does not commit, so a half-typed `#1e2` never
 * reaches the theme; the field says so rather than silently doing nothing.
 *
 * What is stored is always `formatOklch`'s output, whatever was typed. The
 * themes are authored in OKLCH and `describeRamp` compares ramps as strings, so
 * a second spelling of the same colour would make an identical ramp read as
 * `custom`. Normalising here is what keeps that comparison meaningful.
 */
const props = defineProps<{
  value: string
  /** Names the colour for a screen reader — the token's label, or a ramp step. */
  label: string
  disabled?: boolean
  /** Drawn narrow, for the eleven steps of a hand-authored ramp. */
  compact?: boolean
}>()

const emit = defineEmits<{ update: [string] }>()

const draft = ref(props.value)

const parsed = computed(() => parseColor(draft.value))
const invalid = computed(() => draft.value.trim().length > 0 && parsed.value === null)

/**
 * The swatch shows the *committed* value, not the draft.
 *
 * Mid-keystroke the two differ, and the swatch is what the operator checks the
 * result against — it should agree with the app behind the dialog rather than
 * race ahead of it.
 */
const committed = computed(() => parseColor(props.value))

/**
 * `<input type="color">` speaks hex and nothing else, and out-of-gamut has to be
 * clamped for it specifically — the input cannot represent what the token holds.
 * That clamp is the picker's, not the value's: nothing is written back from it.
 * Undefined where there is no colour to show, which leaves the input on the
 * platform's own default rather than putting a literal in this file.
 */
const hex = computed(() => (committed.value ? toHex(clampToGamut(committed.value)) : undefined))

const outOfGamut = computed(() => committed.value !== null && isOutOfGamut(committed.value))

/*
 * Resynced from outside only when the committed value is not what the draft
 * already means. Comparing the parsed forms rather than the strings is what
 * lets the operator keep typing `#1e293b` while the store holds the `oklch()`
 * this component just normalised it into — a plain string comparison would
 * rewrite the field out from under them on their own keystroke.
 */
watch(
  () => props.value,
  (next) => {
    const current = parsed.value
    if (current && formatOklch(current) === next) return
    draft.value = next
  }
)

function commit(text: string): void {
  const colour = parseColor(text)
  if (colour) emit('update', formatOklch(colour))
}

function onText(text: string): void {
  draft.value = text
  commit(text)
}

function onPick(event: Event): void {
  const picked = (event.target as HTMLInputElement).value
  draft.value = picked
  commit(picked)
}
</script>

<template>
  <div class="flex min-w-0 items-center gap-1.5">
    <!--
      A native colour input rather than a component: it is the one control that
      opens the platform's own picker, and the platform's picker is the one an
      operator already knows. Its colour is bound from the token value at
      runtime, never from a class — `oscine/no-raw-colours` would be right to
      reject the alternative.
    -->
    <input
      type="color"
      :value="hex"
      :disabled="disabled"
      :aria-label="`${label} — colour picker`"
      class="size-7 shrink-0 cursor-pointer rounded border border-default bg-transparent p-0.5 disabled:cursor-not-allowed disabled:opacity-50"
      @input="onPick"
    />

    <UInput
      :model-value="draft"
      :disabled="disabled"
      size="xs"
      class="min-w-0 flex-1"
      :color="invalid ? 'error' : 'neutral'"
      :aria-label="label"
      :aria-invalid="invalid"
      :placeholder="compact ? undefined : 'Hex, rgb or oklch'"
      spellcheck="false"
      @update:model-value="onText(String($event))"
    />

    <UTooltip v-if="invalid" text="Not a colour this build can read. Nothing has been changed.">
      <UIcon name="i-tabler-alert-triangle" class="size-4 shrink-0 text-error" />
    </UTooltip>
    <!--
      Said rather than corrected. `clampToGamut` exists and the ramp builder uses
      it, but silently moving a colour the operator typed is how "the picker
      changes my value" bugs are born; here the value stands and the screen says
      the display cannot reach it.
    -->
    <UTooltip
      v-else-if="outOfGamut"
      text="Outside sRGB — the display will show the nearest colour it can."
    >
      <UIcon name="i-tabler-color-filter" class="size-4 shrink-0 text-warning" />
    </UTooltip>
  </div>
</template>
