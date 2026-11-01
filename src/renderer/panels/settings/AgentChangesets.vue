<script setup lang="ts">
import { onMounted, onUnmounted, ref, shallowRef } from 'vue'
import {
  describeRevert,
  type AgentChangesetSummary,
  type AgentRevertResult
} from '@shared/agentChangesets'
import { agentChangesets } from '@renderer/ipc'

/**
 * Settings → Agent access → recent changesets — **W24-6**, `oscine-mcp` →
 * D36.6/D36.10.
 *
 * Every agent write lands in a changeset; this lists the recent ones with who
 * made them, what for, when, and how much of each has been reverted, and puts
 * a Revert on each. Reverting is conflict-aware in main: a change the operator
 * has edited since is skipped and counted, never overwritten, so the summary
 * under the row says what came back and what did not.
 *
 * Shown whether or not the server is on: the journal outlives the session, and
 * turning access off is often the moment the operator wants to undo something.
 */
const PAGE = 20

const toast = useToast()
const changesets = shallowRef<readonly AgentChangesetSummary[]>([])
const loaded = ref(false)
const reverting = ref<number | null>(null)
const results = ref<Record<number, AgentRevertResult>>({})

async function load(): Promise<void> {
  try {
    changesets.value = await agentChangesets.list(PAGE)
  } catch (error) {
    console.warn('[agent access] could not list changesets:', error)
  } finally {
    loaded.value = true
  }
}

let unsubscribe: (() => void) | null = null
onMounted(() => {
  unsubscribe = agentChangesets.onChanged(() => void load())
  void load()
})
onUnmounted(() => unsubscribe?.())

async function revert(changeset: AgentChangesetSummary): Promise<void> {
  reverting.value = changeset.id
  try {
    const result = await agentChangesets.revert(changeset.id)
    results.value = { ...results.value, [changeset.id]: result }
    await load()
  } catch (error) {
    toast.add({
      title: 'Could not revert the changeset',
      description: error instanceof Error ? error.message : String(error),
      color: 'error'
    })
  } finally {
    reverting.value = null
  }
}

function title(changeset: AgentChangesetSummary): string {
  if (changeset.description) return changeset.description
  return changeset.origin === 'session' ? 'Session changes' : 'Untitled changeset'
}

function when(changeset: AgentChangesetSummary): string {
  return new Date(changeset.startedAt).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

function counts(changeset: AgentChangesetSummary): string {
  const changes = `${changeset.changeCount} ${changeset.changeCount === 1 ? 'change' : 'changes'}`
  if (changeset.revertedCount === 0) return changes
  if (changeset.revertedCount === changeset.changeCount) return `${changes}, all reverted`
  return `${changes}, ${changeset.revertedCount} reverted`
}

const revertable = (changeset: AgentChangesetSummary): boolean =>
  changeset.revertedCount < changeset.changeCount
</script>

<template>
  <div v-if="loaded" class="flex flex-col gap-1">
    <span class="text-xs font-medium text-default">Recent agent changes</span>
    <p v-if="changesets.length === 0" class="text-[11px] text-dimmed">
      No agent has changed anything yet. Every change an agent makes is listed here, and can be
      reverted.
    </p>
    <ul v-else class="flex flex-col gap-1.5" aria-label="Recent agent changes">
      <li v-for="changeset in changesets" :key="changeset.id" class="flex flex-col gap-0.5">
        <div class="flex items-center gap-2 text-xs">
          <UIcon name="i-tabler-history" class="size-3.5 shrink-0 text-muted" />
          <div class="flex min-w-0 flex-1 flex-col">
            <span class="truncate text-default">{{ title(changeset) }}</span>
            <span class="truncate text-[11px] text-dimmed">
              {{ changeset.clientName ?? 'Unnamed client' }} · {{ when(changeset) }} ·
              <span class="tabular-nums">{{ counts(changeset) }}</span>
            </span>
          </div>
          <UTooltip
            :text="
              revertable(changeset)
                ? 'Put back what this changeset changed. Anything edited since is left alone.'
                : 'Nothing left to revert'
            "
          >
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              icon="i-tabler-arrow-back-up"
              label="Revert"
              class="shrink-0 text-xs"
              :disabled="
                !revertable(changeset) || (reverting !== null && reverting !== changeset.id)
              "
              :loading="reverting === changeset.id"
              :aria-label="`Revert ${title(changeset)}`"
              @click="revert(changeset)"
            />
          </UTooltip>
        </div>
        <p
          v-if="results[changeset.id]"
          class="pl-5.5 text-[11px]"
          :class="results[changeset.id]!.skipped > 0 ? 'text-warning' : 'text-muted'"
          role="status"
        >
          {{ describeRevert(results[changeset.id]!) }}
        </p>
      </li>
    </ul>
  </div>
</template>
