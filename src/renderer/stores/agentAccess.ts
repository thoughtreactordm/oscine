import { defineStore } from 'pinia'
import { computed, shallowRef } from 'vue'
import { agentIndicator, type AgentAccessStatus } from '@shared/agentAccess'
import { agentAccess } from '@renderer/ipc'

/**
 * Agent access, the renderer's half — **W24-2**, `oscine-mcp` → D36.10.
 *
 * Main is the authority on whether the server is listening: the toggle is a
 * setting, but "on" can still mean starting, a taken port or no keyring, so the
 * section and the title-bar indicator draw from main's status, never from the
 * setting. Hydrates once from `agentAccess.status` and then follows
 * `agentAccess.changed`, like Noctalia's status.
 *
 * The token is not held here. It is fetched by the section that shows it, when
 * it shows it, and dropped with that component.
 */
export const useAgentAccessStore = defineStore('agentAccess', () => {
  /** Null until main has answered once. */
  const status = shallowRef<AgentAccessStatus | null>(null)

  let received = false
  agentAccess.onChanged((next) => {
    received = true
    status.value = next
  })
  agentAccess
    .status()
    .then((next) => {
      // A push that landed first is newer than this answer.
      if (!received) status.value = next
    })
    .catch((error: unknown) => {
      console.warn('[agent access] could not read status:', error)
    })

  const indicator = computed(() => agentIndicator(status.value))

  async function retry(): Promise<void> {
    status.value = await agentAccess.retry()
  }

  async function regenerateToken(): Promise<void> {
    status.value = await agentAccess.regenerateToken()
  }

  return { status, indicator, retry, regenerateToken }
})
