<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { appInfo, update as updateIpc } from '@renderer/ipc'
import type { UpdateStatus } from '@shared/update'

/**
 * In-app updates — **W6-6**. The About section's island, not a generated row.
 *
 * Check / download / restart are commands, not stored values, so they do not
 * belong in the registry (same reason `ScrobblingAccounts` sits above Network
 * rather than among its toggles). The island holds its own status because
 * there is one consumer: this block. A Pinia store for a snapshot one panel
 * reads would be a second copy of `update.status`.
 */
const status = ref<UpdateStatus | null>(null)
const busy = ref(false)

let stop: (() => void) | null = null

onMounted(async () => {
  stop = updateIpc.onChanged((next) => {
    status.value = next
  })
  try {
    status.value = await updateIpc.status()
  } catch {
    // The island stays empty until a later check; a mount failure is not a
    // reason to toast, because the operator has not asked for anything yet.
  }
})

onUnmounted(() => {
  stop?.()
  stop = null
})

const checking = computed(() => status.value?.kind === 'checking' || busy.value)

async function run(action: () => Promise<UpdateStatus>): Promise<void> {
  busy.value = true
  try {
    status.value = await action()
  } catch (error) {
    if (!status.value) return
    status.value = {
      ...status.value,
      kind: 'error',
      error: (error as Error).message,
      errorDetail: null
    }
  } finally {
    busy.value = false
  }
}

function check(): void {
  void run(() => updateIpc.check())
}

function download(): void {
  void run(() => updateIpc.download())
}

function install(): void {
  void updateIpc.install()
}

function openReleases(): void {
  const url = status.value?.releasesUrl
  if (url) void appInfo.openExternal(url)
}

const progressPercent = computed(() =>
  Math.max(0, Math.min(100, Math.round(status.value?.progress?.percent ?? 0)))
)
</script>

<template>
  <section v-if="status" class="border-b border-default px-4 py-3" aria-label="Application updates">
    <div class="flex items-start gap-3">
      <UIcon name="i-tabler-refresh" class="mt-0.5 size-4 shrink-0 text-dimmed" />

      <div class="flex min-w-0 flex-1 flex-col gap-1.5">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span class="text-sm font-medium text-highlighted"
            >Oscine {{ status.currentVersion }}</span
          >
          <span class="text-[11px] text-dimmed">
            <template v-if="status.channel === 'nsis'">Windows installer</template>
            <template v-else-if="status.channel === 'appimage'">AppImage</template>
            <template v-else-if="status.channel === 'external'">Linux package</template>
            <template v-else>Development build</template>
          </span>
        </div>

        <p class="text-[11px] text-muted">
          <template v-if="status.kind === 'unsupported'">
            Packaged AppImage and Windows installs check GitHub Releases from here. This development
            build does not.
          </template>
          <template v-else-if="status.kind === 'idle'">
            <template v-if="status.channel === 'external'">
              This install is a Linux package. Checking tells you if a newer release exists;
              installing it happens from the releases page, not in-app.
            </template>
            <template v-else>Check GitHub Releases for a newer Oscine.</template>
          </template>
          <template v-else-if="status.kind === 'checking'">Checking GitHub Releases…</template>
          <template v-else-if="status.kind === 'up-to-date'"
            >You are on the latest version.</template
          >
          <template v-else-if="status.kind === 'available'">
            Version {{ status.availableVersion }} is available.
          </template>
          <template v-else-if="status.kind === 'available-external'">
            Version {{ status.availableVersion }} is on GitHub Releases. This package cannot install
            itself — download the new .deb (or AppImage) from the releases page.
          </template>
          <template v-else-if="status.kind === 'downloading'">
            Downloading version {{ status.availableVersion }}… {{ progressPercent }}%
          </template>
          <template v-else-if="status.kind === 'ready'">
            Version {{ status.availableVersion }} is ready. Restart Oscine to install it.
          </template>
          <template v-else-if="status.kind === 'error'">
            {{ status.error ?? 'The update could not be completed.' }}
          </template>
        </p>

        <p
          v-if="status.kind === 'error' && status.errorDetail"
          class="font-mono text-[10px] leading-snug break-words text-dimmed"
        >
          {{ status.errorDetail }}
        </p>

        <UProgress
          v-if="status.kind === 'downloading'"
          :model-value="progressPercent"
          size="xs"
          class="max-w-xs"
        />

        <div class="flex flex-wrap items-center gap-2 pt-0.5">
          <UButton
            v-if="status.kind === 'available'"
            size="xs"
            color="primary"
            variant="soft"
            icon="i-tabler-download"
            label="Download update"
            :loading="checking"
            :disabled="checking"
            class="text-xs"
            @click="download"
          />
          <UButton
            v-else-if="status.kind === 'ready'"
            size="xs"
            color="primary"
            variant="soft"
            icon="i-tabler-rotate"
            label="Restart to install"
            class="text-xs"
            @click="install"
          />
          <UButton
            v-else-if="status.kind === 'available-external'"
            size="xs"
            color="primary"
            variant="soft"
            icon="i-tabler-external-link"
            label="Open releases page"
            class="text-xs"
            @click="openReleases"
          />
          <UButton
            v-else-if="status.kind !== 'unsupported' && status.kind !== 'downloading'"
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-tabler-refresh"
            label="Check for updates"
            :loading="checking"
            :disabled="checking"
            class="text-xs"
            @click="check"
          />
        </div>
      </div>
    </div>
  </section>
</template>
