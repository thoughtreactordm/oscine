/**
 * Library and scanning keys — the seed set for W8-6.
 *
 * All durable: what counts as part of the library, and how it is read, is the
 * kind of thing W8-8's export bundle should carry to another machine.
 */

import { booleanValue, defineSetting, integerValue, type SettingDescriptor } from './kernel'

export const LIBRARY_SETTINGS: readonly SettingDescriptor[] = [
  defineSetting<boolean>({
    key: 'library.watcherEnabled',
    scope: 'durable',
    default: true,
    validate: booleanValue(),
    control: { kind: 'toggle' },
    category: 'library',
    label: 'Watch folders for changes',
    help: 'Pick up files added or removed outside Oscine without a rescan.',
    keywords: ['watch', 'monitor', 'filesystem', 'rescan'],
    order: 10
  }),

  defineSetting<number>({
    key: 'library.watcherDebounceMs',
    scope: 'durable',
    default: 1_500,
    validate: integerValue({ min: 250, max: 30_000 }),
    control: { kind: 'number', min: 250, max: 30_000, step: 250, unit: 'ms' },
    category: 'library',
    label: 'Watcher settle time',
    help: 'How long to wait for a burst of filesystem events to finish before scanning.',
    keywords: ['watch', 'debounce', 'settle'],
    order: 20,
    advanced: true
  }),

  /**
   * Off by default because a symlinked folder inside a watched root is the
   * cheapest way to make a 100k-track scan walk the same tree twice.
   */
  defineSetting<boolean>({
    key: 'library.followSymlinks',
    scope: 'durable',
    default: false,
    validate: booleanValue(),
    control: { kind: 'toggle' },
    category: 'library',
    label: 'Follow symlinks when scanning',
    help: 'Off by default: a link back into a watched root scans the same files twice.',
    keywords: ['symlink', 'scan', 'junction'],
    order: 30,
    advanced: true
  }),

  defineSetting<number>({
    key: 'library.artworkCacheMb',
    scope: 'durable',
    default: 512,
    validate: integerValue({ min: 64, max: 8_192 }),
    control: { kind: 'number', min: 64, max: 8_192, step: 64, unit: 'MB' },
    category: 'library',
    label: 'Artwork cache size',
    help: 'Disk budget for generated cover thumbnails.',
    keywords: ['artwork', 'cover', 'cache', 'disk'],
    order: 40,
    advanced: true,
    requiresRestart: true
  })
]
