<script setup lang="ts">
/**
 * The pane that proves the seam, and the only one this card ships.
 *
 * It imports nothing. That is the point: if the deck can arrange a component
 * that knows nothing about the deck, then the panes D15 actually wants — the
 * up-next queue, the format and signal readout, the play history, the artist
 * nexus — arrive as files added to `panes.ts` rather than as edits to the shell.
 *
 * It will be deleted by the first real pane, not extended into one.
 */
</script>

<template>
  <div class="flex flex-col gap-2 text-sm text-muted">
    <p>
      Nothing is docked here yet. The deck is a host, and this is the one pane it has to arrange.
    </p>
    <p class="text-xs">
      Up next, signal, history and related-in-library land here as separate panes.
    </p>
  </div>
</template>
