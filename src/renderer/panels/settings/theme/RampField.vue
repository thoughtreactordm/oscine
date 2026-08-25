<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import ColorField from './ColorField.vue'
import {
  RAMP_STEPS,
  SEED_STEP,
  TAILWIND_PALETTE_NAMES,
  type RampSpec,
  type RampStep,
  type RampSteps,
  type TokenDescriptor
} from '@shared/theme'

/**
 * A colour role, and T5a's three ways to author one.
 *
 * A role is eleven colours, and asking for eleven is absurd for the operator who
 * wants a different accent — so the surface here is one seed, and the other two
 * modes live behind Advanced. That ordering is the decision: the default public
 * API stays one colour per role while full control stays reachable, rather than
 * the editor being small because it cannot do the thing.
 *
 * The mode is *read back* from the ramp with `describeRamp` rather than stored
 * beside it, which is why this opens on whatever the operator last used instead
 * of always on `custom`. A ramp that exactly matches Tailwind's `violet` is a
 * palette ramp whether or not anyone recorded that it was.
 *
 * Switching mode commits nothing on its own. Moving from a seed to eleven hand
 * steps shows the eleven the seed produced, unchanged, and waits — a control
 * that rewrote the theme because a radio button moved would make trying the
 * other modes a destructive act.
 */
const props = defineProps<{
  descriptor: TokenDescriptor
  /** What the role currently *is*, read back from the resolved ramp. */
  spec: RampSpec
  /** The eleven resolved values, which is what the preview strip draws. */
  steps: RampSteps
  overridden: boolean
  /** The override named this role and could not be resolved. */
  unresolved?: boolean
  disabled?: boolean
}>()

const emit = defineEmits<{ update: [RampSpec] }>()

const open = ref(false)
const mode = ref<RampSpec['mode']>(props.spec.mode)
/** Advanced opens itself when the role is already in a mode only it can reach. */
const advanced = ref(props.spec.mode !== 'seed')

watch(
  () => props.spec.mode,
  (next) => {
    mode.value = next
    if (next !== 'seed') advanced.value = true
  }
)

const paletteItems = computed(() =>
  TAILWIND_PALETTE_NAMES.map((name) => ({
    label: `${name[0]?.toUpperCase() ?? ''}${name.slice(1)}`,
    value: name
  }))
)

const palette = computed(() => (props.spec.mode === 'palette' ? props.spec.palette : undefined))

/**
 * What the seed field shows.
 *
 * A ramp authored any other way still has a 500, and that is the step a seed
 * *is* — so the field opens on the colour the role already reads as rather than
 * on empty, and an operator who switches to seed mode sees where they are
 * starting from.
 */
const seed = computed(() => (props.spec.mode === 'seed' ? props.spec.seed : props.steps[SEED_STEP]))

/** One line naming the mode, because the strip alone does not say how it was made. */
const summary = computed(() => {
  if (props.spec.mode === 'palette') return `Tailwind ${props.spec.palette}`
  if (props.spec.mode === 'seed') return 'From one colour'
  return 'Eleven steps'
})

function setSeed(value: string): void {
  emit('update', { mode: 'seed', seed: value })
}

function setPalette(name: unknown): void {
  if (typeof name === 'string') emit('update', { mode: 'palette', palette: name })
}

function setStep(step: RampStep, value: string): void {
  emit('update', { mode: 'custom', steps: { ...props.steps, [step]: value } })
}
</script>

<template>
  <UPopover v-model:open="open" :ui="{ content: 'w-96' }">
    <!--
      The strip is the control. Eleven swatches say more about a ramp than any
      label could, and they are the affordance as well as the readout — there is
      no separate Edit button to find. Colours come from the resolved values at
      runtime; nothing here names one.
    -->
    <button
      type="button"
      :disabled="disabled"
      class="flex min-w-0 flex-1 items-center gap-2 rounded border border-default px-1.5 py-1 transition-colors hover:bg-elevated disabled:cursor-not-allowed disabled:opacity-50"
      :aria-label="`Edit the ${descriptor.label} ramp, ${summary}`"
      :title="summary"
    >
      <span class="flex h-5 min-w-0 flex-1 overflow-hidden rounded-sm">
        <span
          v-for="step in RAMP_STEPS"
          :key="step"
          class="h-full flex-1"
          :style="{ background: steps[step] }"
        />
      </span>
      <UIcon name="i-tabler-chevron-down" class="size-3.5 shrink-0 text-dimmed" />
    </button>

    <template #content>
      <div class="flex flex-col">
        <div class="flex items-center gap-2 border-b border-default px-3 py-2">
          <h3 class="min-w-0 truncate text-sm font-semibold text-highlighted">
            {{ descriptor.label }}
          </h3>
          <UBadge
            v-if="overridden"
            color="primary"
            variant="subtle"
            size="sm"
            label="Overridden"
            class="shrink-0"
          />
          <UButton
            :color="advanced ? 'primary' : 'neutral'"
            :variant="advanced ? 'soft' : 'ghost'"
            size="xs"
            label="Advanced"
            :aria-pressed="advanced"
            class="ms-auto shrink-0 text-xs"
            @click="advanced = !advanced"
          />
        </div>

        <p v-if="unresolved" class="border-b border-default px-3 py-2 text-[11px] text-warning">
          Your override for this role could not be read, so the theme's own ramp is showing.
        </p>

        <div class="flex flex-col gap-3 p-3">
          <div v-if="advanced" class="flex items-center gap-1">
            <UButton
              v-for="option in [
                { value: 'seed', label: 'One colour' },
                { value: 'palette', label: 'Tailwind' },
                { value: 'custom', label: 'Eleven steps' }
              ]"
              :key="option.value"
              :color="mode === option.value ? 'primary' : 'neutral'"
              :variant="mode === option.value ? 'soft' : 'ghost'"
              size="xs"
              :label="option.label"
              :aria-pressed="mode === option.value"
              class="flex-1 justify-center text-xs"
              @click="mode = option.value as RampSpec['mode']"
            />
          </div>

          <template v-if="mode === 'seed'">
            <ColorField
              :value="seed"
              :label="`${descriptor.label} seed colour`"
              :disabled="disabled"
              @update="setSeed"
            />
            <p class="text-[11px] text-muted">
              The other ten steps are derived in OKLCH: the hue is held, lightness walks the ladder
              a real palette walks, and a step that leaves sRGB gives up colour rather than
              brightness.
            </p>
          </template>

          <template v-else-if="mode === 'palette'">
            <USelect
              :model-value="palette"
              value-key="value"
              :items="paletteItems"
              :disabled="disabled"
              size="sm"
              class="w-full"
              placeholder="Choose a palette"
              :aria-label="`${descriptor.label} Tailwind palette`"
              @update:model-value="setPalette($event)"
            />
            <p class="text-[11px] text-muted">Tailwind's own eleven steps, exactly as shipped.</p>
          </template>

          <template v-else>
            <!--
              Eleven rows, bounded by the catalog rather than by data — this is
              the one list on this surface that cannot grow, so it scrolls in
              place like the column chooser rather than being virtualized.
            -->
            <ul class="flex max-h-72 flex-col gap-1.5 overflow-y-auto pe-1">
              <li v-for="step in RAMP_STEPS" :key="step" class="flex items-center gap-2">
                <span class="w-8 shrink-0 text-[11px] tabular-nums text-dimmed">{{ step }}</span>
                <ColorField
                  :value="steps[step]"
                  :label="`${descriptor.label} step ${step}`"
                  :disabled="disabled"
                  compact
                  class="min-w-0 flex-1"
                  @update="setStep(step, $event)"
                />
              </li>
            </ul>
          </template>
        </div>
      </div>
    </template>
  </UPopover>
</template>
