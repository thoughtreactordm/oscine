import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * The Tools tab's shelf of utilities — **W16-6**.
 *
 * Tools are library-wide operations that are not places within the library: the
 * tag write-back review is the first, and the tab is built to hold more without
 * a second rail or route. The rail lists {@link TOOLS} and switches the active
 * one; the view renders whichever is active. Adding a tool is adding an entry
 * here and a branch in `ToolsView`.
 */

export interface ToolDescriptor {
  readonly id: string
  readonly label: string
  readonly icon: string
}

/** The tag write-back review, and the id the rest of the app opens it by. */
export const TAG_WRITEBACK_TOOL = 'tag-writeback'

export const TOOLS: readonly ToolDescriptor[] = [
  { id: TAG_WRITEBACK_TOOL, label: 'Tag write-back', icon: 'i-tabler-file-pencil' }
]

export const useToolsStore = defineStore('tools', () => {
  const activeToolId = ref<string>(TOOLS[0].id)

  /** Switches the rail to a known tool; ignores an id no tool claims. */
  function select(id: string): void {
    if (TOOLS.some((tool) => tool.id === id)) activeToolId.value = id
  }

  return { activeToolId, tools: TOOLS, select }
})
