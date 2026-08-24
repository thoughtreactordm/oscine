/**
 * The palette's Views group — the synchronous, renderer-owned half of D21.
 *
 * Navigation is not a `search.query` result: the tabs are known here and switch
 * instantly, so they are built and matched in the renderer rather than round
 * -tripped. Built from the shell's own `shellTabs` so a new tab is a new command
 * for free — the list stays passed in rather than imported so this module holds
 * no `@renderer` alias and stays testable under the node config.
 */

export interface NavigationTab {
  readonly name: string
  readonly label: string
  readonly icon: string
}

export interface NavigationCommand {
  readonly id: string
  readonly label: string
  readonly icon: string
  /** The route name to switch to. */
  readonly tab: string
  readonly keywords: readonly string[]
}

export function buildNavigationCommands(tabs: readonly NavigationTab[]): NavigationCommand[] {
  return tabs.map((tab) => ({
    id: `view:${tab.name}`,
    label: tab.label,
    icon: tab.icon,
    tab: tab.name,
    keywords: [tab.name, tab.label.toLowerCase()]
  }))
}

/**
 * The commands whose label or a keyword contains the text, in their given
 * order. Empty text matches everything — an opened palette shows every tab
 * before a key is pressed.
 *
 * A plain substring match, not a fuzzy one: the palette groups pass through the
 * component with `ignoreFilter`, so this is the whole filter for Views rather
 * than a pre-pass in front of Fuse.
 */
export function matchNavigation(
  commands: readonly NavigationCommand[],
  text: string
): NavigationCommand[] {
  const needle = text.trim().toLowerCase()
  if (needle.length === 0) return [...commands]
  return commands.filter(
    (command) =>
      command.label.toLowerCase().includes(needle) ||
      command.keywords.some((keyword) => keyword.includes(needle))
  )
}
