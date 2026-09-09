/**
 * Filename rules that have to hold on every platform Oscine writes to.
 *
 * A path written on Linux is later read on Windows (D11's export bundle, a
 * synced folder, a USB disk). Sanitizing only for the host would let `AC/DC:
 * Back in Black` land as a directory on Linux and become unreadable after the
 * copy. The union of both platforms' rules applies everywhere.
 *
 * Callers that slugify (podcasts) and callers that keep punctuation (rip names,
 * playlist export) share the character class; they differ only in the
 * replacement. That is the whole point of this module existing: two regexes in
 * two files will drift, and the drift is a Windows-only defect.
 */

/**
 * Illegal in a Windows filename, plus C0 controls.
 *
 * `/` and `\` are omitted on purpose: they are path separators, and a slugifier
 * wants to turn them into hyphens rather than strip them. {@link
 * replaceUnsafeFilenameChars} adds them back for callers that want a single
 * replacement over the full reserved set.
 *
 * `no-control-regex` exists to catch a control character nobody meant to write;
 * matching them is the entire intent here.
 */
// eslint-disable-next-line no-control-regex -- matching the control range is the point
export const UNSAFE_FILENAME_CHARS = /[<>:"|?*\u0000-\u001f]/g

/** Path separators in a filename component, either platform's. */
export const FILENAME_SLASHES = /[\\/]+/g

/**
 * Reserved on Windows with or without an extension: `CON.flac` is as dead as
 * `CON`. Applied to every component, including directories.
 */
const RESERVED_DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

/** Most filesystems cap a single component at 255 bytes, not 255 characters. */
export const MAX_PATH_COMPONENT_BYTES = 255

/**
 * Replace the union of reserved filename characters, including separators.
 *
 * Podcasts pass `''` into the two regexes separately so a slash can become a
 * hyphen; everyone else wants one substitution and reaches for this.
 */
export function replaceUnsafeFilenameChars(value: string, replacement = '_'): string {
  return value.replace(UNSAFE_FILENAME_CHARS, replacement).replace(/[\\/]/g, replacement)
}

/**
 * One path component, safe to write on both platforms.
 *
 * Empty input stays empty so the caller can drop a vanished segment (`//` in a
 * template) rather than invent a `_` directory. A component that is *only*
 * reserved characters becomes `_`, never empty — an empty segment is how a
 * relative path escapes its directory.
 */
export function sanitizePathComponent(value: string): string {
  if (value === '') return ''

  let out = replaceUnsafeFilenameChars(value, '_')
  out = stripTrailingDotsAndSpaces(out)
  if (out === '' || out === '.' || out === '..') return '_'
  if (RESERVED_DEVICE_NAMES.test(out)) out = `_${out}`
  out = truncateToBytes(out, MAX_PATH_COMPONENT_BYTES)
  out = stripTrailingDotsAndSpaces(out)
  if (out === '' || out === '.' || out === '..') return '_'
  return out
}

function stripTrailingDotsAndSpaces(value: string): string {
  return value.replace(/[. ]+$/g, '')
}

/**
 * Truncate on a grapheme boundary so a UTF-8 title cannot cut a code point or
 * a ZWJ sequence in half. A single grapheme larger than the budget is dropped
 * rather than sliced.
 */
export function truncateToBytes(value: string, maxBytes: number): string {
  const encoder = new TextEncoder()
  if (encoder.encode(value).length <= maxBytes) return value

  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  let out = ''
  let bytes = 0
  for (const { segment } of segmenter.segment(value)) {
    const size = encoder.encode(segment).length
    if (bytes + size > maxBytes) break
    out += segment
    bytes += size
  }
  return out
}
