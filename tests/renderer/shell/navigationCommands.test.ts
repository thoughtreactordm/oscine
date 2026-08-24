import { describe, expect, it } from 'vitest'
import {
  buildNavigationCommands,
  matchNavigation,
  type NavigationTab
} from '../../../src/renderer/shell/navigationCommands'

/**
 * The Views group, D21's synchronous half. Built from the same `shellTabs` the
 * tab row uses, so a new tab is a new command; matched here rather than in Fuse,
 * because the group passes through with `ignoreFilter`.
 */

const TABS: NavigationTab[] = [
  { name: 'library', label: 'Library', icon: 'i-tabler-library' },
  { name: 'curate', label: 'Curate', icon: 'i-tabler-playlist' },
  { name: 'now-playing', label: 'Now Playing', icon: 'i-tabler-disc' }
]

describe('buildNavigationCommands', () => {
  it('carries the route name, label and icon of each tab', () => {
    const [library] = buildNavigationCommands(TABS)
    expect(library).toMatchObject({
      id: 'view:library',
      label: 'Library',
      icon: 'i-tabler-library',
      tab: 'library'
    })
  })
})

describe('matchNavigation', () => {
  const commands = buildNavigationCommands(TABS)

  it('returns every command in order for empty text', () => {
    expect(matchNavigation(commands, '').map((c) => c.tab)).toEqual([
      'library',
      'curate',
      'now-playing'
    ])
  })

  it('matches on the label, case-insensitively', () => {
    expect(matchNavigation(commands, 'cur').map((c) => c.tab)).toEqual(['curate'])
    expect(matchNavigation(commands, 'LIBRARY').map((c) => c.tab)).toEqual(['library'])
  })

  it('matches on the route-name keyword', () => {
    // "now-playing" is not in the label "Now Playing", so the keyword carries it.
    expect(matchNavigation(commands, 'now-play').map((c) => c.tab)).toEqual(['now-playing'])
  })

  it('returns nothing when nothing matches', () => {
    expect(matchNavigation(commands, 'zzz')).toEqual([])
  })
})
