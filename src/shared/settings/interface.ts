/**
 * Interface and behaviour keys — the seed set for W8-11.
 *
 * Mostly view-scoped. This file first spent a key per pane — `shellSidebarWidthPx`,
 * `sourcesArtistsWidthPx` — on the argument that a record's per-pane fallbacks
 * would have to live back in the pane specs. W8-3 reversed that: the fallbacks
 * were *already* in the pane specs, alongside the minimum and the neighbour
 * reserve that only the resizer can enforce, so the scalar keys were a second
 * copy of a default rather than the only one. `view.shellPaneSizes` in
 * `./view.ts` is the record that replaced them.
 */

import { booleanValue, defineSetting, enumValue, type SettingDescriptor } from './kernel'

export type ThemeMode = 'system' | 'light' | 'dark'
export type AlbumArtSize = 'small' | 'medium' | 'large'

export const INTERFACE_SETTINGS: readonly SettingDescriptor[] = [
  defineSetting<ThemeMode>({
    key: 'interface.theme',
    scope: 'durable',
    default: 'system',
    validate: enumValue<ThemeMode>(['system', 'light', 'dark']),
    control: {
      kind: 'select',
      options: [
        { value: 'system', label: 'Match system' },
        { value: 'light', label: 'Light' },
        { value: 'dark', label: 'Dark' }
      ]
    },
    category: 'interface',
    label: 'Theme',
    help: 'Follow the desktop setting, or pin one.',
    keywords: ['dark mode', 'light mode', 'appearance'],
    order: 10
  }),

  defineSetting<boolean>({
    key: 'view.trackGroupingEnabled',
    scope: 'view',
    default: true,
    validate: booleanValue(),
    control: { kind: 'toggle' },
    category: 'interface',
    label: 'Group tracks by album',
    help: 'Show an album header above each run of tracks in a track list.',
    keywords: ['group', 'album', 'header', 'list'],
    order: 40
  }),

  defineSetting<AlbumArtSize>({
    key: 'view.trackGroupingArtSize',
    scope: 'view',
    default: 'small',
    validate: enumValue<AlbumArtSize>(['small', 'medium', 'large']),
    control: {
      kind: 'select',
      options: [
        { value: 'small', label: 'Small' },
        { value: 'medium', label: 'Medium' },
        { value: 'large', label: 'Large' }
      ]
    },
    category: 'interface',
    label: 'Album header artwork',
    help: 'How large the cover is in an album group header.',
    keywords: ['group', 'artwork', 'cover', 'size'],
    order: 50
  })
]
