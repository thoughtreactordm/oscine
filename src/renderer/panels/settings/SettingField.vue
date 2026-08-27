<script setup lang="ts">
import type { SettingsRow } from '@renderer/panels/settings/catalog'
import SettingControl from '@renderer/panels/settings/SettingControl.vue'
import SettingRevertButton from '@renderer/panels/settings/SettingRevertButton.vue'

/**
 * One setting as the operator sees it: what it is called, what it does, and the
 * thing that changes it — with no opinion about where the value comes from.
 *
 * This is the "one definition, two renderings" of W8-8, made structural. The
 * full settings view and a panel's inline popover do not each draw a descriptor
 * their own way and agree to keep the wording in step; they mount *this*, so the
 * label, the help and the control are not merely the same, they are the same
 * expressions over the same descriptor. There is no way for a setting to be
 * phrased differently in the two places without changing this file, which would
 * change both.
 *
 * Value in, value out, like `SettingControl` beneath it. Its three callers have
 * three ideas about where the value lives — a global row, a view key, an
 * override resolved against a playlist — and exactly one idea about what a
 * setting looks like.
 */
defineProps<{
  row: SettingsRow
  modelValue: unknown
  /**
   * Stacked, for a popover.
   *
   * The difference between the two renderings is arrangement and nothing else:
   * a popover is a column two hundred pixels wide and the settings view is a
   * fixed-height row with a control gutter, so the same three parts are placed
   * differently. Anything beyond arrangement belongs on the descriptor.
   */
  compact?: boolean
  /** Name the section the row belongs to — what a search result needs. */
  showCategory?: boolean
  /** Drawn as just-arrived-at, after a deep link or a jump from search. */
  highlighted?: boolean
  /**
   * Where reverting would send the value, as a phrase, or null where there is
   * nothing to revert. `provenanceLabel`'s output — "the global setting", "the
   * built-in default" — so the row and an entity control name their levels with
   * the same vocabulary.
   */
  revertTo?: string | null
  /**
   * A second caption under the help: what this value is inheriting, or where
   * else the setting can be reached. Optional and short; the help is the
   * descriptor's and is never displaced.
   */
  note?: string | null
  /**
   * `needed` is the descriptor's flag — this key has always wanted a restart, and
   * saying so before it is touched is the difference between a warning and the
   * operator discovering the change did nothing. `pending` is the narrower claim
   * the store makes: this value has actually moved since the process started.
   */
  restart?: 'needed' | 'pending' | null
  /** Offer a way through to this row in the full settings view. */
  linkable?: boolean
  disabled?: boolean
}>()

defineEmits<{
  'update:modelValue': [unknown]
  revert: []
  reveal: []
}>()
</script>

<template>
  <div
    :id="row.anchorId"
    class="transition-colors"
    :class="[
      compact ? 'flex flex-col gap-1.5 px-3 py-2.5' : 'flex items-center gap-4 px-4',
      highlighted ? 'bg-primary/10' : 'hover:bg-elevated/40'
    ]"
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
          v-if="restart === 'pending'"
          color="warning"
          variant="subtle"
          size="sm"
          label="Restart to apply"
          class="shrink-0"
        />
        <UBadge
          v-else-if="restart === 'needed'"
          color="neutral"
          variant="subtle"
          size="sm"
          label="Needs restart"
          class="shrink-0"
        />

        <!--
          In the stacked arrangement the two affordances ride the label line,
          because the control below them is the full width and there is no
          gutter to put them in.
        -->
        <div v-if="compact" class="ms-auto flex shrink-0 items-center">
          <SettingRevertButton v-if="revertTo" :destination="revertTo" @revert="$emit('revert')" />
          <UTooltip
            v-if="linkable"
            :text="`Show ${row.descriptor.label} in Settings ▸ ${row.categoryLabel}`"
          >
            <UButton
              color="neutral"
              variant="ghost"
              size="xs"
              icon="i-tabler-arrow-up-right"
              :aria-label="`Show ${row.descriptor.label} in Settings`"
              @click="$emit('reveal')"
            />
          </UTooltip>
        </div>
      </div>

      <!--
        Up to two lines: the settings view is a fixed-height virtualized list, so
        the row height (SETTING_ROW_PX) and this clamp move together — two lines
        holds every shipped description. The full text stays on the element, so a
        longer one is a hover away rather than gone.
      -->
      <p class="line-clamp-2 text-[11px] text-muted" :title="row.descriptor.help">
        {{ row.descriptor.help }}
      </p>

      <p v-if="note" class="truncate text-[11px] text-dimmed" :title="note">{{ note }}</p>
    </div>

    <div :class="compact ? 'flex w-full justify-end' : 'flex w-72 shrink-0 justify-end'">
      <SettingControl
        :model-value="modelValue"
        :descriptor="row.descriptor"
        :disabled="disabled"
        class="w-full"
        @update:model-value="$emit('update:modelValue', $event)"
      />
    </div>

    <!--
      A fixed slot whether or not the button is in it. Rendering the button only
      where there is something to revert would shift every control on the row
      sideways the moment a value moved, which is a list that reflows while you
      are dragging a slider on it. The stacked arrangement has no such gutter and
      puts both affordances on the label line above.
    -->
    <div v-if="!compact" class="flex w-7 shrink-0 justify-end">
      <SettingRevertButton v-if="revertTo" :destination="revertTo" @revert="$emit('revert')" />
    </div>
  </div>
</template>
