import nodePath from 'node:path'
import type { PlatformPath } from 'node:path'
import type { PlaylistPathStyle } from '@shared/playlists'

/**
 * Rendering a playlist as extended M3U text.
 *
 * Pure, and takes its path flavour as an argument, for the same reason
 * `createPathHelpers` does: the whole difficulty of this card is that a stored
 * `rel_path` is POSIX and a `.m3u8` written on Windows must not be, and a rule
 * about Windows separators that can only be tested on Windows is not a rule
 * anybody is actually enforcing. Every branch below is exercised under both
 * flavours from one machine.
 *
 * The tracks arriving here are already absolute and already rejoined for this
 * platform — `toAbsPath` did that, against the root the track was stored under.
 * So this module never sees a stored separator, and the only separators it can
 * emit are ones `node:path` produced. That is structural rather than a check:
 * there is no string concatenation here to get it wrong.
 *
 * Export only. D12 puts import in the backlog, and there is deliberately no
 * half-parser in this file to tempt anyone.
 */

export const M3U8_EXTENSION = '.m3u8'

/** One entry, resolved to a file on this machine. */
export interface M3uTrack {
  absPath: string
  durationSec: number | null
  artist: string | null
  title: string
}

export interface RenderM3u8Options {
  /** Absolute path of the `.m3u8` being written; relative paths are relative to its folder. */
  destination: string
  pathStyle: PlaylistPathStyle
  /** Test seam. Production always uses the host flavour. */
  path?: PlatformPath
}

/**
 * LF on both platforms, and no BOM.
 *
 * `.m3u8` means "M3U, in UTF-8" by convention — that is the whole difference
 * from `.m3u`, whose encoding is the writer's locale — so the encoding is
 * carried by the extension, and a BOM would only risk a parser failing to
 * recognise `#EXTM3U` as the first line. Every player that reads the format
 * accepts LF, and choosing it unconditionally means both platforms produce
 * byte-identical files from the same library, which is what makes a test over
 * the emitted text meaningful on either one.
 */
const LINE_END = '\n'

/** The format's own "duration unknown", for a track we never got a length for. */
const UNKNOWN_DURATION = -1

/** The characters a tag must never be allowed to introduce into the text. */
const LINE_BREAKS = /[\r\n\u2028\u2029]+/g

export function renderM3u8(tracks: readonly M3uTrack[], options: RenderM3u8Options): string {
  const impl = options.path ?? nodePath
  const directory = impl.dirname(options.destination)

  const lines = ['#EXTM3U']
  for (const track of tracks) {
    lines.push(`#EXTINF:${durationField(track.durationSec)},${displayField(impl, track)}`)
    lines.push(locationField(impl, directory, track.absPath, options.pathStyle))
  }
  // Trailing terminator: a final line without one is a truncated file to some
  // parsers and a valid one to others, and there is no reason to find out which.
  return `${lines.join(LINE_END)}${LINE_END}`
}

/**
 * Whole seconds, which is what `#EXTINF` has always meant.
 *
 * Rounded rather than truncated, so a 249.6-second track does not read as a
 * second short of itself next to the same number in Oscine's own list.
 */
function durationField(durationSec: number | null): number {
  if (durationSec === null || !Number.isFinite(durationSec)) return UNKNOWN_DURATION
  return Math.max(0, Math.round(durationSec))
}

/**
 * `artist - title`, or just the title when there is no artist.
 *
 * The line-break strip is not cosmetic. A tag is arbitrary text out of a file
 * the operator did not write, and one containing a newline would close the
 * `#EXTINF` record early and let the remainder be read as a location — a
 * playlist pointing somewhere nobody chose. Folding it to a space keeps the
 * record on one line, which is the format's only structural rule.
 *
 * The filename stands in for an empty title, because a folder of untagged files
 * should export as something an operator can read rather than a column of
 * blanks.
 */
function displayField(impl: PlatformPath, track: M3uTrack): string {
  const title = oneLine(track.title) || impl.basename(track.absPath)
  const artist = oneLine(track.artist ?? '')
  return artist === '' ? title : `${artist} - ${title}`
}

function oneLine(value: string): string {
  return value.replace(LINE_BREAKS, ' ').trim()
}

/**
 * The location line: this platform's separators, in whichever style was asked
 * for.
 *
 * Neither branch builds a path by hand. `absolute` emits exactly what
 * `toAbsPath` rejoined, and `relative` hands both ends to `path.relative`, so
 * the separator is the platform's by construction rather than by a rule someone
 * has to remember. On win32 a track on a different volume from the destination
 * has no relative form at all, and `relative` says so by returning the absolute
 * path — which is the right answer, and the reason a playlist saved to `D:` can
 * still name tracks on `C:`.
 */
function locationField(
  impl: PlatformPath,
  directory: string,
  absPath: string,
  pathStyle: PlaylistPathStyle
): string {
  if (pathStyle === 'absolute') return absPath
  const relative = impl.relative(directory, absPath)
  // Empty means the track *is* the destination folder, which the library cannot
  // produce — but an empty location line would quietly corrupt the file, so
  // fall back to something addressable rather than emit one.
  return relative === '' ? absPath : relative
}

/**
 * Illegal in a Windows filename; `/` and the control range are illegal in both.
 *
 * The control range is what the disable is for: `no-control-regex` exists to
 * catch a control character nobody meant to write, and matching them is the
 * entire intent here — a playlist name is free text, and a filename carrying
 * one is a name the save dialog will refuse.
 */
// eslint-disable-next-line no-control-regex -- matching the control range is the point
const UNSAFE_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g

/** Windows rejects a name ending in a dot or a space, whatever precedes it. */
const TRIMMABLE_EDGES = /^[. ]+|[. ]+$/g

/** Reserved on Windows with or without an extension: `CON.m3u8` is as dead as `CON`. */
const RESERVED_DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** Long enough for any name a human typed, short enough to leave room for a folder. */
const MAX_FILENAME_STEM = 100

/**
 * What the save dialog opens with.
 *
 * The operator types whatever they like over it; this only has to be a name
 * both platforms will accept, because a suggestion the dialog then refuses to
 * save is worse than a plain one. Playlist names are free text and routinely
 * contain a separator — `AC/DC B-sides` is a playlist somebody has — so the
 * substitution is not theoretical.
 */
export function suggestedFileName(playlistName: string): string {
  const sanitised = playlistName.replace(UNSAFE_FILENAME_CHARS, '_')
  // Sliced by code point, not by UTF-16 unit: cutting a surrogate pair in half
  // produces a name the filesystem may refuse, and non-ASCII names are exactly
  // the ones this is protecting.
  const clipped = [...sanitised].slice(0, MAX_FILENAME_STEM).join('').replace(TRIMMABLE_EDGES, '')
  const stem = clipped === '' ? 'playlist' : clipped
  return `${RESERVED_DEVICE_NAMES.test(stem) ? `_${stem}` : stem}${M3U8_EXTENSION}`
}

/**
 * Guarantees the extension the format is named after.
 *
 * GTK's save dialog does not append the selected filter's extension, so an
 * operator on Linux who types `Road trip` would otherwise get a file no player
 * recognises as a playlist. An extension they typed themselves is left alone —
 * someone who asked for `.m3u` meant `.m3u`, and this is not the place to
 * argue.
 */
export function withM3u8Extension(filePath: string): string {
  return nodePath.extname(filePath) === '' ? `${filePath}${M3U8_EXTENSION}` : filePath
}
