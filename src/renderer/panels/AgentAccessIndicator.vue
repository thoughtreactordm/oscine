<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { MCP_ENABLED_KEY } from '@shared/settings'
import { settingsRouteFor } from '@renderer/shell/routes'
import { useAgentAccessStore } from '@renderer/stores/agentAccess'

/**
 * The title-bar cue for agent access — **W24-2**, `oscine-mcp` → D36.10.
 *
 * Drawn only while an agent is connected or an agent write is running, and
 * gone otherwise: an always-on "agents allowed" lamp would be furniture the
 * operator learns to ignore, which is the opposite of what this is for. A write
 * in flight swaps the icon and pulses. Clicking opens Settings → Agent access.
 */
const store = useAgentAccessStore()
const router = useRouter()

const indicator = computed(() => store.indicator)

const label = computed(() => {
  const state = indicator.value
  if (!state) return ''
  const who =
    state.sessions === 1 ? 'An AI agent is connected' : `${state.sessions} AI agents are connected`
  return state.busy ? `An AI agent is changing your library. ${who}.` : `${who}.`
})

function open(): void {
  void router.push(settingsRouteFor(MCP_ENABLED_KEY))
}
</script>

<template>
  <div
    v-if="indicator"
    class="app-no-drag flex h-full shrink-0 items-center px-1"
    role="status"
    aria-live="polite"
  >
    <UTooltip :text="`${label} Open Agent access settings.`">
      <UButton
        size="xs"
        :color="indicator.busy ? 'warning' : 'primary'"
        variant="ghost"
        :icon="indicator.busy ? 'i-tabler-pencil-bolt' : 'i-tabler-plug-connected'"
        :label="indicator.sessions > 1 ? String(indicator.sessions) : undefined"
        :aria-label="label"
        :class="indicator.busy ? 'motion-safe:animate-pulse' : undefined"
        @click="open"
      />
    </UTooltip>
  </div>
</template>
