/**
 * Interface and behaviour keys — the seed set for W8-7.
 *
 * Mostly view-scoped. The card's example key was `view.shell.paneSizes`, one
 * record of pane id to width; this file spends two keys instead, because a
 * record's per-pane fallbacks would have to live back in the pane specs and the
 * rule this registry exists to enforce is that a default lives in exactly one
 * place. When docking lands and pane identity stops being fixed, a record key
 * with a `custom` control is the shape to revisit.
 */

import {
  booleanValue,
  defineSetting,
  enumValue,
  integerValue,
  type SettingDescriptor
} from './kernel'

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

  defineSetting<number>({
    key: 'view.shellSidebarWidthPx',
    scope: 'view',
    default: 320,
    validate: integerValue({ min: 200, max: 640 }),
    control: { kind: 'number', min: 200, max: 640, step: 8, unit: 'px' },
    category: 'interface',
    label: 'Sidebar width',
    help: 'Width of the navigation rail. Dragging the divider writes this.',
    keywords: ['pane', 'layout', 'sidebar'],
    order: 20,
    advanced: true
  }),

  defineSetting<number>({
    key: 'view.sourcesArtistsWidthPx',
    scope: 'view',
    default: 280,
    validate: integerValue({ min: 180, max: 640 }),
    control: { kind: 'number', min: 180, max: 640, step: 8, unit: 'px' },
    category: 'interface',
    label: 'Artists pane width',
    help: 'Width of the artists column in the Sources view.',
    keywords: ['pane', 'layout', 'artists'],
    order: 30,
    advanced: true
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
