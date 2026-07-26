import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * Scaffold-only store. It exists so Pinia is genuinely wired and typechecked
 * rather than merely installed; the real panel stores arrive with W4.
 */
export const useShellStore = defineStore('shell', () => {
  const bootedAt = ref(new Date().toISOString())
  return { bootedAt }
})
