<script setup lang="ts">
import { useToolsStore } from '@renderer/stores/tools'

/**
 * The Tools tab's rail — **W16-6**. One entry per tool; the tag write-back
 * review is the first. Built to grow: another tool is another row here and a
 * branch in `ToolsView`.
 */
const tools = useToolsStore()
</script>

<template>
  <nav class="flex h-full min-h-0 flex-col bg-default" aria-label="Tools">
    <div class="border-b border-default px-3 py-2">
      <p class="text-xs font-semibold tracking-wide text-dimmed uppercase">Tools</p>
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto py-1" role="list">
      <button
        v-for="tool in tools.tools"
        :key="tool.id"
        type="button"
        role="listitem"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors"
        :class="
          tools.activeToolId === tool.id
            ? 'bg-elevated text-highlighted'
            : 'text-default hover:bg-elevated/60'
        "
        :aria-current="tools.activeToolId === tool.id ? 'true' : undefined"
        @click="tools.select(tool.id)"
      >
        <UIcon :name="tool.icon" class="size-4 shrink-0 text-dimmed" />
        <span class="min-w-0 flex-1 truncate text-xs font-medium">{{ tool.label }}</span>
      </button>
    </div>
  </nav>
</template>
