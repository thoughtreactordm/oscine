<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { scrobble as scrobbleIpc } from '@renderer/ipc'
import {
  disconnectSummary,
  SCROBBLE_TARGET_LABELS,
  scrobblingRows,
  waitingLabel
} from '@renderer/panels/settings/scrobblingRows'
import { useSettings } from '@renderer/settings'
import { SCROBBLE_ENABLED_KEYS } from '@shared/settings'
import type { ScrobbleTargetId, ScrobbleTargetStatus } from '@shared/scrobble'

/**
 * The scrobbling accounts block — W11-7, and the part of this stream an operator
 * can actually see.
 *
 * Above the Network section's generated rows rather than among them, for
 * `RebuildCountersAction`'s reason and then some: none of connect, disconnect,
 * a username, a queue depth or a retry is a stored value with a default to
 * revert to, and giving each one a registry key in order to borrow the row
 * layout would be five lies told to a validator. What *is* declarative — the
 * pause switch, the loved push, the API key override — stays in the rows below,
 * where adding the next one is a line in `src/shared/settings/scrobbling.ts`.
 *
 * ## Why it holds its own state rather than a store
 *
 * There is one consumer. A Pinia store for a list that is one element long and
 * read by one component would be indirection bought on the expectation of a
 * second reader that D19 says will not exist — the renderer is never given more
 * scrobbling surface than this. `onStatusChanged` is subscribed for the lifetime
 * of the block, which is the lifetime of somebody looking at it.
 *
 * ## What is honest here
 *
 * A non-zero queue depth is a **status**, not an error, and is styled as one:
 * rows are deleted on acceptance, so the number is a readout of how long the
 * network has been away and it is supposed to be seen going up. The one thing
 * drawn as a problem is `lastError`, which arrives as a sentence main already
 * wrote — the pane never parses a Last.fm code, because a second copy of that
 * taxonomy in the renderer would be the copy that goes stale.
 */

const settings = useSettings()

const targets = ref<readonly ScrobbleTargetStatus[]>([])
const loaded = ref(false)

/**
 * Which target has a sign-in open, if any.
 *
 * A single id rather than a set: `connect` waits on the operator's browser and
 * two of those at once is not a thing to support, it is a thing to make
 * impossible by leaving the other buttons disabled while one is out.
 */
const connecting = ref<ScrobbleTargetId | null>(null)
const busy = ref<ScrobbleTargetId | null>(null)

/**
 * The last sign-in failure per target, kept in the block rather than thrown at a
 * toast.
 *
 * "No application key configured", "this machine has no keyring", "the sign-in
 * expired" are all things the operator has to act on, and a toast is gone by the
 * time they have finished reading the sentence that explains what to do. Keyed
 * by target because a ListenBrainz token that will not paste is not a reason to
 * put a red line under Last.fm.
 */
const connectProblems = ref<Partial<Record<ScrobbleTargetId, string>>>({})

let unsubscribe: (() => void) | null = null

async function refresh(): Promise<void> {
  const result = await scrobbleIpc.status()
  targets.value = result.targets
  loaded.value = true
}

onMounted(() => {
  void refresh()
  // Main emits once per drain pass and on every connection change, which covers
  // the two things that move without the operator touching anything: a queue
  // growing offline, and a session key the service has stopped accepting.
  unsubscribe = scrobbleIpc.onStatusChanged((next) => {
    targets.value = next
    loaded.value = true
  })
})

onUnmounted(() => {
  unsubscribe?.()
  unsubscribe = null
})

/** `undefined` for a target with no switch — see `SCROBBLE_ENABLED_KEYS`. */
function enabledKey(target: ScrobbleTargetId): string | undefined {
  return SCROBBLE_ENABLED_KEYS[target]
}

/**
 * Read through W8's store, not through the status payload.
 *
 * `lastfm.enabled` is an ordinary durable setting, so the toggle in the rows
 * below and this line are reading the same reactive value — which is why
 * flipping it there changes the sentence here in the same frame.
 */
function isPaused(target: ScrobbleTargetId): boolean {
  const key = enabledKey(target)
  return key !== undefined && !settings.get<boolean>(key)
}

const rows = computed(() =>
  scrobblingRows(targets.value, {
    paused: isPaused,
    problem: (target) => connectProblems.value[target] ?? null
  })
)

function noteProblem(target: ScrobbleTargetId, message: string | null): void {
  const next = { ...connectProblems.value }
  if (message === null) delete next[target]
  else next[target] = message
  connectProblems.value = next
}

async function connect(target: ScrobbleTargetId): Promise<void> {
  connecting.value = target
  noteProblem(target, null)
  try {
    const result = await scrobbleIpc.connect(target)
    if (result.ok) {
      await refresh()
      return
    }
    // Abandoning it is a decision, not a failure, and reporting it as one would
    // leave a red sentence under a button the operator deliberately pressed.
    if (result.failure.kind !== 'cancelled') noteProblem(target, result.failure.message)
  } catch (error) {
    noteProblem(target, (error as Error).message)
  } finally {
    connecting.value = null
  }
}

/**
 * The way out for an operator who opened their browser and changed their mind.
 *
 * It does not resolve the `connect` promise itself — main does, with a cancelled
 * failure — so this only asks. The waiting state clears when that promise lands,
 * which is the one place it can clear without the two getting out of step.
 */
function cancelConnect(target: ScrobbleTargetId): void {
  void scrobbleIpc.cancelConnect(target)
}

const toast = useToast()

async function disconnect(status: ScrobbleTargetStatus): Promise<void> {
  const label = SCROBBLE_TARGET_LABELS[status.target]
  // Read before the call, because the whole point of the sentence is what was
  // waiting at the moment the operator pressed it.
  const waiting = status.queueDepth
  busy.value = status.target
  try {
    const result = await scrobbleIpc.disconnect(status.target)
    targets.value = result.targets
    toast.add({
      title: `Signed out of ${label}`,
      // Three sentences, and each is something the operator cannot find out any
      // other way: what was deleted, what was kept, and the half Oscine cannot
      // do for them. An app that said only "disconnected" would leave them
      // believing it had revoked the grant, which is the more important half and
      // the one that is still sitting on their account's applications page.
      description: disconnectSummary(label, waiting),
      icon: 'i-tabler-plug-connected-x',
      color: 'primary'
    })
  } catch (error) {
    toast.add({
      title: `Could not sign out of ${SCROBBLE_TARGET_LABELS[status.target]}`,
      description: (error as Error).message,
      icon: 'i-tabler-alert-triangle',
      color: 'error'
    })
  } finally {
    busy.value = null
  }
}

async function retry(target: ScrobbleTargetId): Promise<void> {
  busy.value = target
  try {
    const result = await scrobbleIpc.retry()
    targets.value = result.targets
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <section
    v-if="loaded && rows.length > 0"
    class="border-b border-default px-4 py-3"
    aria-label="Scrobbling accounts"
  >
    <div
      v-for="row in rows"
      :key="row.status.target"
      class="flex flex-col gap-1.5 [&+&]:mt-3 [&+&]:border-t [&+&]:border-default/60 [&+&]:pt-3"
    >
      <div class="flex items-center gap-3">
        <UIcon
          name="i-tabler-broadcast"
          class="size-4 shrink-0"
          :class="row.status.connected && !row.paused ? 'text-primary' : 'text-dimmed'"
        />

        <div class="flex min-w-0 flex-1 flex-col">
          <span class="truncate text-sm font-medium text-highlighted">{{ row.label }}</span>
          <span class="truncate text-[11px] text-muted">
            <template v-if="connecting === row.status.target">
              Waiting for you to approve Oscine in your browser…
            </template>
            <template v-else-if="row.status.connected">
              Connected as {{ row.status.username }}
            </template>
            <template v-else>Not connected</template>
          </span>
        </div>

        <!--
          Cancel replaces Connect rather than sitting beside it: while a sign-in
          is out there is exactly one thing to do with it, and a Connect button
          that did nothing for the minutes the operator is in their browser is
          the control that makes them press it twice.
        -->
        <UButton
          v-if="connecting === row.status.target"
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-tabler-x"
          label="Cancel"
          class="shrink-0 text-xs"
          @click="cancelConnect(row.status.target)"
        />
        <UTooltip
          v-else-if="row.status.connected"
          :text="`Forget the saved ${row.label} sign-in. Anything queued stays queued.`"
        >
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-tabler-plug-connected-x"
            label="Disconnect"
            :loading="busy === row.status.target"
            :disabled="busy !== null || connecting !== null"
            class="shrink-0 text-xs"
            @click="disconnect(row.status)"
          />
        </UTooltip>
        <UTooltip v-else :text="`Sign in to ${row.label} in your browser`">
          <UButton
            size="xs"
            color="primary"
            variant="soft"
            icon="i-tabler-plug-connected"
            label="Connect"
            :disabled="busy !== null || connecting !== null"
            class="shrink-0 text-xs"
            @click="connect(row.status.target)"
          />
        </UTooltip>
      </div>

      <!--
        The status line, and it is a status. `text-muted` rather than a warning
        colour: a queue with things in it is what a laptop that spent the
        afternoon on a train looks like, and colouring it as a fault would train
        the operator to ignore the colour by the second time they saw it.
      -->
      <div
        v-if="row.status.queueDepth > 0 || row.paused || row.status.lastError"
        class="flex flex-wrap items-center gap-x-2 gap-y-1 pl-7"
      >
        <UTooltip
          v-if="row.status.queueDepth > 0"
          text="Scrobbles and loved-track updates that have not reached the service yet. They are stored on disk and survive a restart."
        >
          <span class="text-[11px] text-muted">
            {{ waitingLabel(row.status.queueDepth) }}
          </span>
        </UTooltip>

        <span v-if="row.paused" class="text-[11px] text-dimmed">
          Scrobbling is paused — nothing is being sent.
        </span>

        <!--
          The reconnect prompt, derived rather than pattern-matched. A target
          that stood itself down holds a queue and no connection, and that pair
          is the whole of "the service stopped accepting the saved sign-in" —
          which is why the renderer needs to know nothing about a code 9.
        -->
        <span v-if="row.needsReconnect" class="text-[11px] text-warning">
          Sign in again to send them.
        </span>

        <UTooltip
          v-if="row.canRetry"
          text="Try to send what is waiting, without waiting for the next attempt"
        >
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-tabler-refresh"
            label="Retry now"
            :loading="busy === row.status.target"
            :disabled="busy !== null"
            class="-my-1 text-[11px]"
            @click="retry(row.status.target)"
          />
        </UTooltip>
      </div>

      <p v-if="row.status.lastError" class="pl-7 text-[11px] text-warning">
        {{ row.status.lastError }}
      </p>

      <p v-if="row.problem && connecting !== row.status.target" class="pl-7 text-[11px] text-error">
        {{ row.problem }}
      </p>
    </div>
  </section>
</template>
