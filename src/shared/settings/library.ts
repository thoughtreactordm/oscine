/**
 * Library and scanning keys — the seed set for W8-6, plus the rip destination
 * and naming convention W18-4 added.
 *
 * Durable, and most of them portable: what counts as part of the library, and
 * how ripped files are named, is the kind of thing W8-8's export bundle should
 * carry to another machine. The destination folder is the exception — a path
 * is about this machine, so that key is `portable: false`.
 */

import {
  booleanValue,
  defineSetting,
  integerValue,
  stringValue,
  type SettingDescriptor
} from './kernel'
import {
  DEFAULT_RIP_NAME_TEMPLATE,
  RIP_DESTINATION_ROOT_KEY,
  RIP_NAME_TEMPLATE_KEY,
  RIP_VERIFY_KEY
} from '../ripPath'

export { RIP_DESTINATION_ROOT_KEY, RIP_NAME_TEMPLATE_KEY, RIP_VERIFY_KEY }

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
  }),

  /**
   * Machine-local: importing a path from another computer would point the next
   * rip at a folder that is not there, and possibly not even a library root.
   * The rip pane still reads this as the last-used destination; that pane owns
   * the picker and the live preview, not this control.
   */
  defineSetting<string>({
    key: RIP_DESTINATION_ROOT_KEY,
    scope: 'durable',
    portable: false,
    default: '',
    validate: stringValue({ maxLength: 4096, allowEmpty: true }),
    control: { kind: 'path', select: 'directory' },
    category: 'library',
    label: 'CD rip destination',
    help: 'Folder ripped tracks are written into. Must sit inside a library root, or the rip is refused.',
    keywords: ['rip', 'cd', 'destination', 'folder', 'path'],
    order: 50
  }),

  defineSetting<string>({
    key: RIP_NAME_TEMPLATE_KEY,
    scope: 'durable',
    default: DEFAULT_RIP_NAME_TEMPLATE,
    validate: stringValue({ maxLength: 512 }),
    control: {
      kind: 'text',
      placeholder: DEFAULT_RIP_NAME_TEMPLATE
    },
    category: 'library',
    label: 'CD rip naming template',
    help: 'Tokens: {albumartist} {artist} {album} {title} {track} {disc} {year}. The encoder appends the extension; do not put .flac in the template. {disc} is omitted on a single-disc release.',
    keywords: ['rip', 'cd', 'template', 'filename', 'naming', 'convention'],
    order: 60
  }),

  defineSetting<boolean>({
    key: RIP_VERIFY_KEY,
    scope: 'durable',
    default: false,
    validate: booleanValue(),
    control: { kind: 'toggle' },
    category: 'library',
    label: 'Verify CD rips',
    help: 'Rip each track twice and compare the PCM. Catches burst-mode read errors; doubles rip time.',
    keywords: ['rip', 'cd', 'verify', 'hash', 'accurate'],
    order: 70,
    advanced: true
  })
]
