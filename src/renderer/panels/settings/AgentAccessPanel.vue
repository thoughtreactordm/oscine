<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import {
  agentClientSnippets,
  agentServerUrl,
  type AgentClientSnippet,
  type AgentSession
} from '@shared/agentAccess'
import { MCP_ENABLED_KEY } from '@shared/settings'
import { agentAccess } from '@renderer/ipc'
import { useSettings } from '@renderer/settings'
import { useAgentAccessStore } from '@renderer/stores/agentAccess'

/**
 * Settings → Agent access, the parts that are not stored values — **W24-2**,
 * `oscine-mcp` → D36.1, D36.10.
 *
 * The toggle, port and capability switches are generated rows below this
 * block. Here: whether the server is actually listening (or why not), the
 * token with copy and regenerate, ready-to-paste client config, and who is
 * connected. W24-6 adds recent changesets with Revert.
 *
 * The token is fetched only while this block is on screen and access is on,
 * held in a local ref, and masked until the operator asks to see it. Copying
 * never needs it shown.
 */
const store = useAgentAccessStore()
const settings = useSettings()
const toast = useToast()

const enabled = computed(() => settings.get<boolean>(MCP_ENABLED_KEY) === true)
const status = computed(() => store.status)

const token = ref<string | null>(null)
const revealed = ref(false)
const busy = ref<'retry' | 'regenerate' | null>(null)
const confirmingRegenerate = ref(false)
let confirmTimer: ReturnType<typeof setTimeout> | null = null

async function loadToken(): Promise<void> {
  try {
    token.value = await agentAccess.revealToken()
  } catch (error) {
    console.warn('[agent access] could not read the token:', error)
    token.value = null
  }
}

// Re-read whenever access turns on or a token appears; drop it when off.
watch(
  () => [enabled.value, status.value?.hasToken] as const,
  ([on, has]) => {
    if (on && has) void loadToken()
    else {
      token.value = null
      revealed.value = false
    }
  },
  { immediate: true }
)

const url = computed(() => status.value?.url ?? agentServerUrl(status.value?.port ?? 0))

const MASK = '••••••••••••••••'

const snippets = computed<readonly AgentClientSnippet[]>(() =>
  token.value ? agentClientSnippets(url.value, token.value) : []
)

function shown(text: string): string {
  return revealed.value || !token.value ? text : text.split(token.value).join(MASK)
}

const tabs = computed(() =>
  snippets.value.map((snippet) => ({ label: snippet.label, value: snippet.id, slot: snippet.id }))
)
const activeTab = ref<string>('claude-code')

async function copy(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast.add({ title: `${what} copied`, icon: 'i-tabler-copy', duration: 2000 })
  } catch (error) {
    console.warn('[agent access] copy failed:', error)
    toast.add({ title: `Could not copy the ${what.toLowerCase()}`, color: 'error' })
  }
}

async function retry(): Promise<void> {
  busy.value = 'retry'
  try {
    await store.retry()
  } finally {
    busy.value = null
  }
}

/**
 * Two presses, not a dialog: regenerating disconnects every agent and breaks
 * every pasted config, so the first press says that and arms; the second, within
 * a few seconds, does it.
 */
async function regenerate(): Promise<void> {
  if (!confirmingRegenerate.value) {
    confirmingRegenerate.value = true
    confirmTimer = setTimeout(() => (confirmingRegenerate.value = false), 4000)
    return
  }
  if (confirmTimer) clearTimeout(confirmTimer)
  confirmingRegenerate.value = false
  busy.value = 'regenerate'
  try {
    await store.regenerateToken()
    await loadToken()
    toast.add({
      title: 'New token generated',
      description: 'Connected agents were disconnected. Paste the new config into each one.',
      icon: 'i-tabler-key'
    })
  } catch (error) {
    toast.add({
      title: 'Could not generate a new token',
      description: error instanceof Error ? error.message : String(error),
      color: 'error'
    })
  } finally {
    busy.value = null
  }
}

onUnmounted(() => {
  if (confirmTimer) clearTimeout(confirmTimer)
  token.value = null
})

function sessionLabel(session: AgentSession): string {
  const name = session.clientName ?? 'Unnamed client'
  return session.clientVersion ? `${name} ${session.clientVersion}` : name
}

function since(session: AgentSession): string {
  return new Date(session.connectedAt).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  })
}
</script>

<template>
  <section class="flex flex-col gap-3 border-b border-default px-4 py-3" aria-label="Agent access">
    <!-- What the server is doing right now. -->
    <div class="flex items-center gap-3">
      <UIcon
        name="i-tabler-plug-connected"
        class="size-4 shrink-0"
        :class="status?.state === 'listening' ? 'text-primary' : 'text-dimmed'"
      />
      <div class="flex min-w-0 flex-1 flex-col">
        <span class="truncate text-sm font-medium text-highlighted">Local agent server</span>
        <span class="truncate text-[11px] text-muted">
          <template v-if="!enabled || !status || status.state === 'off'">
            Off — nothing is listening. Turn on “Allow AI agents” below to start it.
          </template>
          <template v-else-if="status.state === 'starting'">Starting…</template>
          <template v-else-if="status.state === 'listening'">
            Listening on <span class="font-mono">{{ status.url }}</span>
          </template>
          <template v-else>Not running</template>
        </span>
      </div>
    </div>

    <UAlert
      v-if="enabled && status?.state === 'error' && status.error"
      color="error"
      variant="subtle"
      icon="i-tabler-alert-triangle"
      :title="
        status.error.kind === 'port-in-use'
          ? 'Port in use'
          : status.error.kind === 'no-keyring'
            ? 'No secure storage for the token'
            : 'The agent server could not start'
      "
      :description="status.error.message"
      :actions="[
        {
          label: 'Try again',
          icon: 'i-tabler-refresh',
          color: 'error',
          variant: 'outline',
          size: 'xs',
          loading: busy === 'retry',
          onClick: () => void retry()
        }
      ]"
    />

    <template v-if="enabled && token">
      <!-- The token. -->
      <div class="flex flex-col gap-1">
        <span class="text-xs font-medium text-default">Access token</span>
        <div class="flex items-center gap-2">
          <UInput
            :model-value="revealed ? token : MASK"
            readonly
            size="sm"
            class="min-w-0 flex-1 font-mono"
            aria-label="Access token"
            :ui="{ base: 'font-mono text-xs' }"
          />
          <UTooltip :text="revealed ? 'Hide token' : 'Show token'">
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              :icon="revealed ? 'i-tabler-eye-off' : 'i-tabler-eye'"
              :aria-label="revealed ? 'Hide token' : 'Show token'"
              @click="revealed = !revealed"
            />
          </UTooltip>
          <UTooltip text="Copy token">
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              icon="i-tabler-copy"
              aria-label="Copy token"
              @click="copy(token, 'Token')"
            />
          </UTooltip>
          <UTooltip
            :text="
              confirmingRegenerate
                ? 'Press again to replace the token. Every connected agent is disconnected.'
                : 'Replace the token. Every connected agent is disconnected and needs the new config.'
            "
          >
            <UButton
              size="xs"
              :color="confirmingRegenerate ? 'error' : 'neutral'"
              :variant="confirmingRegenerate ? 'soft' : 'ghost'"
              icon="i-tabler-key"
              :label="confirmingRegenerate ? 'Confirm' : 'Regenerate'"
              :loading="busy === 'regenerate'"
              class="shrink-0 text-xs"
              @click="regenerate"
            />
          </UTooltip>
        </div>
        <p class="text-[11px] text-dimmed">
          Anyone with this token and access to this computer can use the capabilities you allow
          below. Keep it out of shared files.
        </p>
      </div>

      <!-- Ready-to-paste config per client. -->
      <div class="flex flex-col gap-1">
        <span class="text-xs font-medium text-default">Connect an agent</span>
        <UTabs v-model="activeTab" :items="tabs" size="xs" variant="link" :content="true">
          <template v-for="snippet in snippets" :key="snippet.id" #[snippet.id]>
            <div class="flex flex-col gap-1.5 pt-2">
              <p class="text-[11px] text-dimmed">{{ snippet.hint }}</p>
              <div v-if="snippet.text" class="flex items-start gap-2">
                <pre
                  class="min-w-0 flex-1 overflow-x-auto rounded-md border border-default bg-elevated/50 px-2.5 py-2 font-mono text-[11px] whitespace-pre text-default"
                  >{{ shown(snippet.text) }}</pre>
                <UTooltip text="Copy, with the token filled in">
                  <UButton
                    size="xs"
                    color="neutral"
                    variant="subtle"
                    icon="i-tabler-copy"
                    :aria-label="`Copy ${snippet.label} config`"
                    @click="copy(snippet.text, `${snippet.label} config`)"
                  />
                </UTooltip>
              </div>
            </div>
          </template>
        </UTabs>
      </div>
    </template>

    <!-- Who is connected (D36.10). -->
    <div v-if="enabled && status?.state === 'listening'" class="flex flex-col gap-1">
      <span class="text-xs font-medium text-default">Connected agents</span>
      <p v-if="status.sessions.length === 0" class="text-[11px] text-dimmed">
        No agent is connected.
      </p>
      <ul v-else class="flex flex-col gap-1" aria-label="Connected agents">
        <li
          v-for="session in status.sessions"
          :key="session.id"
          class="flex items-center gap-2 text-xs"
        >
          <UIcon name="i-tabler-robot" class="size-3.5 shrink-0 text-primary" />
          <span class="min-w-0 flex-1 truncate text-default">{{ sessionLabel(session) }}</span>
          <span class="shrink-0 text-[11px] text-dimmed tabular-nums">
            since {{ since(session) }}
          </span>
        </li>
      </ul>
      <p v-if="status.writesInFlight > 0" class="text-[11px] text-warning">
        An agent is changing your library now.
      </p>
    </div>
  </section>
</template>
