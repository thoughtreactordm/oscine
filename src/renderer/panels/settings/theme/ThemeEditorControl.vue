<script setup lang="ts">
import { computed, ref } from 'vue'
import ThemeTokenEditor from './ThemeTokenEditor.vue'
import type { SettingDescriptor } from '@shared/settings'
import { parseOverrides, type ThemeOverrides } from '@shared/theme'

/**
 * `theme.overrides` on the settings surface, and the register's second entry.
 *
 * The escape hatch is earned the way `OutputDeviceControl` earns it, for a
 * different reason: this key holds a map, and a map has no generic control. T6
 * chose one durable key over a row per token knowing the cost, which is that
 * per-token provenance and revert are this component's job rather than something
 * inherited from the W8-5 machinery.
 *
 * What lives *here* is deliberately only the trigger. A settings row is a fixed
 * 64 pixels in a virtualized list with a 288-pixel control gutter, and thirty
 * tokens with eleven ramp steps apiece do not go in it — so the row states how
 * much has been authored and opens the editor, and every part of the settings
 * view stays untouched. That the row needed no change to the pane, the catalog
 * or `SettingField` is the independent check on W8-6's claim that adding a
 * setting requires zero edits to that view.
 *
 * Value in, value out, like every other control: it never reaches for the
 * settings store, so the same component would serve an inline popover if one
 * ever wanted it.
 */
const props = defineProps<{
  descriptor: SettingDescriptor
  modelValue: unknown
  disabled?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [unknown] }>()

const open = ref(false)

/*
 * Narrowed through the same parser the descriptor validates with, rather than
 * cast. The value arriving here has already been through it, so this is not a
 * second opinion about what a valid map is — it is the only way to say so in the
 * type system without asserting something the prop type does not carry.
 */
const overrides = computed<ThemeOverrides>(() => parseOverrides(props.modelValue))

const count = computed(() => Object.keys(overrides.value).length)

function update(next: ThemeOverrides): void {
  emit('update:modelValue', next)
}
</script>

<template>
  <div class="flex min-w-0 items-center justify-end gap-2">
    <span class="min-w-0 truncate text-[11px] text-dimmed">
      <template v-if="count === 0">Nothing overridden</template>
      <template v-else>{{ count }} {{ count === 1 ? 'token' : 'tokens' }} yours</template>
    </span>

    <UButton
      color="neutral"
      variant="subtle"
      size="sm"
      icon="i-tabler-palette"
      label="Edit tokens…"
      :disabled="disabled"
      class="shrink-0"
      :aria-label="descriptor.label"
      @click="open = true"
    />

    <UModal
      v-model:open="open"
      title="Theme tokens"
      description="Every value the interface is built from, over the theme you have selected. Changes apply as you make them."
      :ui="{ content: 'max-w-4xl', body: 'p-0 sm:p-0' }"
    >
      <template #body>
        <!--
          A fixed height rather than a growing one: the list inside is
          virtualized, and a viewport that sized itself to its content would
          make the measurement circular.
        -->
        <div class="h-[60vh] min-h-0">
          <ThemeTokenEditor
            :model-value="overrides"
            :disabled="disabled"
            @update:model-value="update"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>
