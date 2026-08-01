<script setup lang="ts">
import { watch } from 'vue'
import { useRoute } from 'vue-router'
import SettingsPane from '@renderer/panels/settings/SettingsPane.vue'
import { useSettingsNavStore } from '@renderer/stores/settingsNav'

/**
 * Settings as a tab of the shell, not a modal over it.
 *
 * A modal would make every setting a thing you tune with the library hidden
 * behind it, which is the wrong way round for most of them: crossfade, grouping
 * and row density are all judged against what they do to the thing on screen,
 * and a dialog that has to be dismissed to see the effect turns each adjustment
 * into a round trip. As a tab it is one click away and one click back, and the
 * library keeps playing.
 *
 * The view itself is almost nothing — it holds the route, and the route is the
 * deep-link surface: `?key=` is what W8-8's inline controls will link into, so
 * the addressing lives with the tab table rather than inside a panel.
 */
const route = useRoute()
const nav = useSettingsNavStore()

watch(
  () => route.query.key,
  (key) => {
    // Repeated `?key=` in the query string arrives as an array. Take the first
    // rather than refusing: a link that over-specifies still means one row.
    const target = Array.isArray(key) ? key[0] : key
    if (typeof target === 'string' && target.length > 0) nav.reveal(target)
  },
  { immediate: true }
)
</script>

<template>
  <SettingsPane />
</template>
