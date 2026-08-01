<script setup lang="ts">
import { useThemeStore } from '@renderer/stores/theme'

/*
 * Mounted here and used nowhere in the template on purpose: the store's job is
 * the standing `watchEffect` that keeps the theme layer in step with
 * `interface.theme`. It needs an owner that outlives every route, and the root
 * component is the only thing that does.
 *
 * The theme itself is already applied by this point — `installTheme()` runs
 * before `createApp` so the first paint is themed. This is what makes changing
 * the setting repaint the app without a reload.
 */
useThemeStore()
</script>

<template>
  <UApp>
    <RouterView />
  </UApp>
</template>
