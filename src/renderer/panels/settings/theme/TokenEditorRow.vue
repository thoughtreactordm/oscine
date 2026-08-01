<script setup lang="ts">
import { computed } from 'vue'
import RampField from './RampField.vue'
import TokenValueField from './TokenValueField.vue'
import type { TokenEditorRow } from './tokenRows'
import {
  describeRamp,
  rampTokenId,
  RAMP_STEPS,
  type ContrastFinding,
  type RampSpec,
  type RampSteps,
  type ThemeOverrides
} from '@shared/theme'

/**
 * One row of the token editor, whichever of the three kinds it is.
 *
 * The narrowing happens here, in script, for the reason `SettingControl`
 * records: `v-if="row.kind === 'token'"` reads better and does not survive
 * `vue-tsc`, because the template loses the narrowing crossing into an attribute
 * binding. One component with three shapes also keeps the list uniform — the
 * parent renders `TokenEditorRow` for every index and the virtualizer's
 * arithmetic stays a multiplication.
 *
 * Provenance is the card's ask, applied to custom properties: the value, where
 * it came from, and a revert. Since T6 stores every override in one map key,
 * none of that is inherited from the W8-5 machinery — it is these three lines.
 */
const props = defineProps<{
  row: TokenEditorRow
  /** The resolved token map — every id already expanded to its value. */
  tokens: ReadonlyMap<string, string>
  overrides: ThemeOverrides
  /** Contrast findings naming this row's token, if any. T7: warn, never block. */
  warnings?: readonly ContrastFinding[]
  /** This row's override named a real token and could not be resolved. */
  unresolved?: boolean
  disabled?: boolean
}>()

const emit = defineEmits<{
  set: [id: string, value: string | RampSpec]
  revert: [id: string]
  revertGroup: [groupId: string]
}>()

const group = computed(() => (props.row.kind === 'group' ? props.row : null))
const token = computed(() => (props.row.kind === 'token' ? props.row : null))
const orphan = computed(() => (props.row.kind === 'orphan' ? props.row : null))

const isRamp = computed(() => token.value?.descriptor.kind === 'ramp')

/** What the row displays and what its control edits — the effective value. */
const value = computed(() => (token.value ? (props.tokens.get(token.value.key) ?? '') : ''))

/**
 * A role is stored as one token and resolves to eleven, so the strip is read
 * back out of the resolved map rather than out of the override. That is what
 * makes the preview show the ramp that is actually rendering, including the
 * theme's own when an override failed to resolve.
 */
const rampSteps = computed<RampSteps | null>(() => {
  const descriptor = token.value?.descriptor
  if (!descriptor || descriptor.kind !== 'ramp') return null
  const role = descriptor.id.slice('color.'.length)

  const steps: Record<string, string> = {}
  for (const step of RAMP_STEPS) {
    const resolved = props.tokens.get(rampTokenId(role, step))
    if (resolved === undefined) return null
    steps[step] = resolved
  }
  return steps as RampSteps
})

const rampSpec = computed<RampSpec | null>(() => {
  const id = token.value?.key
  if (!id) return null
  const override = props.overrides[id]
  if (typeof override === 'object') return override
  return rampSteps.value ? describeRamp(rampSteps.value) : null
})

/**
 * An orphan's value, said out loud.
 *
 * There is no descriptor to draw a control from, so the row shows the stored
 * value as text. That is the honest rendering of "kept, and inert until a theme
 * defines this name again" — the operator can see what they would be throwing
 * away before they press revert.
 */
const orphanValue = computed(() => {
  const id = orphan.value?.id
  if (!id) return ''
  const stored = props.overrides[id]
  if (typeof stored === 'string') return stored
  if (!stored) return ''
  if (stored.mode === 'palette') return `Tailwind ${stored.palette}`
  if (stored.mode === 'seed') return `Seeded from ${stored.seed}`
  return 'Eleven hand-authored steps'
})

const warning = computed(() => props.warnings?.[0] ?? null)

/** The whole sentence, so a tooltip explains rather than reporting a number. */
const warningText = computed(() => {
  const finding = warning.value
  if (!finding) return ''
  const ratio = finding.ratio.toFixed(2)
  return `${finding.pair.where} is at ${ratio}:1, under the ${finding.required}:1 this pairing wants. Nothing has been blocked.`
})
</script>

<template>
  <!--
    A heading, drawn at the same height as a token row so the list stays uniform.
    Its revert clears the whole group and not merely the drawn rows — the choice
    `SettingsPane` makes for a category, and for the same reason.
  -->
  <div
    v-if="group"
    class="flex items-center gap-3 border-y border-default/60 bg-elevated/40 px-4"
    role="presentation"
  >
    <div class="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
      <h3 class="min-w-0 truncate text-xs font-semibold text-highlighted">{{ group.label }}</h3>
      <p class="truncate text-[11px] text-muted" :title="group.help">{{ group.help }}</p>
    </div>
    <UButton
      v-if="group.overridden > 0"
      color="neutral"
      variant="ghost"
      size="xs"
      icon="i-tabler-arrow-back-up"
      :label="`Revert (${group.overridden})`"
      :title="`Revert every overridden ${group.label} token to the theme`"
      class="shrink-0 text-xs"
      @click="emit('revertGroup', group.id)"
    />
  </div>

  <div
    v-else-if="token"
    class="flex items-center gap-3 px-4 transition-colors hover:bg-elevated/40"
    :data-token-id="token.key"
  >
    <div class="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
      <div class="flex min-w-0 items-center gap-2">
        <span class="min-w-0 truncate text-xs font-medium text-highlighted">
          {{ token.descriptor.label }}
        </span>
        <UBadge
          v-if="token.overridden"
          color="primary"
          variant="subtle"
          size="sm"
          label="Yours"
          :title="`Overridden. The theme's own value is underneath.`"
          class="shrink-0"
        />
      </div>
      <p class="truncate text-[11px] text-muted" :title="token.descriptor.help">
        {{ token.descriptor.help }}
      </p>
    </div>

    <div class="flex w-72 shrink-0 items-center justify-end gap-1.5">
      <RampField
        v-if="isRamp && rampSpec && rampSteps"
        :descriptor="token.descriptor"
        :spec="rampSpec"
        :steps="rampSteps"
        :overridden="token.overridden"
        :unresolved="unresolved"
        :disabled="disabled"
        @update="emit('set', token.key, $event)"
      />
      <TokenValueField
        v-else-if="!isRamp"
        :descriptor="token.descriptor"
        :value="value"
        :disabled="disabled"
        @update="emit('set', token.key, $event)"
      />
    </div>

    <!--
      T7. The warning lands on the row that caused it and stops there: the write
      already happened, the theme already repainted, and this says what it did to
      the pairing rather than refusing it. A deliberately low-contrast theme is
      an authorable thing.
    -->
    <div class="flex w-5 shrink-0 justify-center">
      <UTooltip v-if="warning" :text="warningText">
        <UIcon name="i-tabler-contrast" class="size-4 text-warning" />
      </UTooltip>
      <UTooltip
        v-else-if="unresolved"
        text="Your override for this token could not be read, so the theme's own value is showing."
      >
        <UIcon name="i-tabler-alert-triangle" class="size-4 text-error" />
      </UTooltip>
    </div>

    <!--
      A fixed gutter whether or not the button is in it, so a row that gains an
      override does not shove the control sideways under the pointer that was
      editing it. Same reasoning as `SettingField`.
    -->
    <div class="flex w-7 shrink-0 justify-end">
      <UButton
        v-if="token.overridden"
        color="neutral"
        variant="ghost"
        size="xs"
        icon="i-tabler-arrow-back-up"
        :title="`Revert ${token.descriptor.label} to the theme's value`"
        :aria-label="`Revert ${token.descriptor.label} to the theme's value`"
        @click="emit('revert', token.key)"
      />
    </div>
  </div>

  <div
    v-else-if="orphan"
    class="flex items-center gap-3 px-4 transition-colors hover:bg-elevated/40"
  >
    <div class="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
      <span class="min-w-0 truncate font-mono text-xs text-highlighted">{{ orphan.id }}</span>
      <p class="truncate text-[11px] text-muted">
        No token by this name in this build. Kept, and inert until one exists again.
      </p>
    </div>

    <div class="flex w-72 shrink-0 justify-end">
      <span class="min-w-0 truncate text-[11px] text-dimmed" :title="orphanValue">
        {{ orphanValue }}
      </span>
    </div>

    <div class="w-5 shrink-0" aria-hidden="true" />

    <div class="flex w-7 shrink-0 justify-end">
      <UButton
        color="neutral"
        variant="ghost"
        size="xs"
        icon="i-tabler-arrow-back-up"
        :title="`Discard the override for ${orphan.id}`"
        :aria-label="`Discard the override for ${orphan.id}`"
        @click="emit('revert', orphan.id)"
      />
    </div>
  </div>
</template>
