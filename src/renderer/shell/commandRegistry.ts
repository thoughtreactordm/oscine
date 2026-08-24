/**
 * A palette command — D21's declarative unit for the Actions and Settings
 * groups, the two the shell (W13-5) left stubbed.
 *
 * The same shape `navigationCommands` gives the Views group, minus the `tab`: a
 * command *does* something (`run`) rather than naming a route. It is built with
 * its dependencies already closed over, so the module that assembles a group
 * stays pure — no `@renderer` alias, no Pinia — and its "dispatches to the store
 * and toasts" contract is tested by handing in fakes. `matchCommands` is the
 * whole filter for these groups: the palette passes each through with
 * `ignoreFilter`, exactly as it does the Views group, so Fuse never re-scans
 * them.
 */

export interface Command {
  readonly id: string
  readonly label: string
  readonly icon: string
  /** Extra terms matched besides the label — the key, its synonyms, the verb. */
  readonly keywords: readonly string[]
  /**
   * Dispatch. Fire-and-forget per D22 — the command owns its own toast and its
   * own dismissal, because "flip inline" and "jump and close" end differently.
   */
  run(): void | Promise<void>
}

/**
 * The commands whose label or a keyword contains the text, in their given
 * order. Empty text matches everything — the `>`/`/` modes show every command
 * before a key is pressed, the way an opened palette shows every tab.
 *
 * A plain substring match, not a fuzzy one, for the same reason
 * `matchNavigation` is: these groups reach the component with `ignoreFilter`, so
 * this is the filter rather than a pre-pass in front of Fuse.
 */
export function matchCommands(commands: readonly Command[], text: string): Command[] {
  const needle = text.trim().toLowerCase()
  if (needle.length === 0) return [...commands]
  return commands.filter(
    (command) =>
      command.label.toLowerCase().includes(needle) ||
      command.keywords.some((keyword) => keyword.includes(needle))
  )
}
