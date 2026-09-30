import { sanitizePathComponent } from './pathSanitize'

/**
 * Default naming convention for a ripped track.
 *
 * Extension is not in the template: the encoder appends it. A template that
 * carried `.flac` would be wrong the moment a second codec lands.
 */
export const DEFAULT_RIP_NAME_TEMPLATE = '{albumartist}/{album} ({year})/{disc}-{track:02} {title}'

/** Settings key. Descriptor lives in `settings/library.ts` so it rides W8's cascade. */
export const RIP_NAME_TEMPLATE_KEY = 'library.ripNameTemplate'

/** Settings key. Machine-local; the profile export leaves it behind. */
export const RIP_DESTINATION_ROOT_KEY = 'library.ripDestinationRoot'

/**
 * Settings key. Off by default: a verify pass rips each track twice and
 * doubles the time. The description on the control must say so.
 */
export const RIP_VERIFY_KEY = 'library.ripVerify'

const PLACEHOLDERS = {
  albumartist: 'Unknown Artist',
  artist: 'Unknown Artist',
  album: 'Unknown Album',
  title: 'Unknown Title'
} as const

const KNOWN_TOKENS = new Set<string>([
  'albumartist',
  'artist',
  'album',
  'title',
  'track',
  'disc',
  'year'
])

/** `{disc}` takes these with it when a single-disc release collapses the token. */
const DISC_SEP_CHAR = /[-_. ]/
const DISC_SEP_PUNCT = /[-_.]/

export interface RipNameFields {
  albumartist: string
  artist: string
  album: string
  title: string
  track: number
  disc: number
  /**
   * Total discs in the release. `{disc}` and its adjacent separator collapse
   * when this is 1 or less — `1-01 Title` on every one-disc album is noise.
   */
  discCount: number
  year: number | null
}

/**
 * Render a template over resolved disc metadata into a POSIX-relative path.
 *
 * Sanitizes per component, never over the joined string: the `/` separators
 * have to survive, and an album titled `AC/DC` must become `AC_DC` inside its
 * own segment rather than an extra directory. Unknown tokens stay literal.
 * A malformed `{unclosed` stays literal. The result has no extension and no
 * leading slash.
 */
export function renderRipPath(template: string, fields: RipNameFields): string {
  const collapseDisc = fields.discCount <= 1
  const components: string[] = []
  for (const part of template.split('/')) {
    const rendered = substituteComponent(part, fields, collapseDisc).trim()
    const sanitized = sanitizePathComponent(rendered)
    if (sanitized === '') continue
    components.push(sanitized)
  }
  return components.length === 0 ? '_' : components.join('/')
}

function substituteComponent(part: string, fields: RipNameFields, collapseDisc: boolean): string {
  let out = ''
  let i = 0
  while (i < part.length) {
    if (part[i] !== '{') {
      out += part[i]
      i += 1
      continue
    }

    const close = part.indexOf('}', i + 1)
    if (close < 0) {
      out += part.slice(i)
      break
    }

    const inner = part.slice(i + 1, close)
    const token = parseToken(inner)
    if (!token) {
      out += part.slice(i, close + 1)
      i = close + 1
      continue
    }

    if (token.name === 'disc' && collapseDisc) {
      i = close + 1
      const after = consumeDiscSeparators(part, i)
      if (after > i) {
        i = after
      } else {
        out = stripTrailingDiscSeparators(out)
      }
      continue
    }

    out += formatToken(token, fields)
    i = close + 1
  }
  return out
}

function consumeDiscSeparators(part: string, start: number): number {
  let end = start
  let punct = false
  while (end < part.length && DISC_SEP_CHAR.test(part[end]!)) {
    if (DISC_SEP_PUNCT.test(part[end]!)) punct = true
    end += 1
  }
  return punct ? end : start
}

function stripTrailingDiscSeparators(value: string): string {
  const match = /[-_. ]+$/.exec(value)
  if (!match || !DISC_SEP_PUNCT.test(match[0])) return value
  return value.slice(0, match.index)
}

interface ParsedToken {
  name: string
  pad: number | null
}

function parseToken(inner: string): ParsedToken | null {
  const match = /^([a-z]+)(?::0(\d+))?$/.exec(inner)
  if (!match) return null
  const name = match[1]!
  if (!KNOWN_TOKENS.has(name)) return null
  const pad = match[2] === undefined ? null : Number(match[2])
  return { name, pad }
}

function formatToken(token: ParsedToken, fields: RipNameFields): string {
  switch (token.name) {
    case 'albumartist':
      return textField(fields.albumartist, PLACEHOLDERS.albumartist)
    case 'artist':
      return textField(fields.artist, PLACEHOLDERS.artist)
    case 'album':
      return textField(fields.album, PLACEHOLDERS.album)
    case 'title':
      return textField(fields.title, PLACEHOLDERS.title)
    case 'track':
      return padNumeric(fields.track, token.pad)
    case 'disc':
      return padNumeric(fields.disc, token.pad)
    case 'year':
      return fields.year == null ? '' : padNumeric(fields.year, token.pad)
    default:
      return `{${token.name}}`
  }
}

function textField(value: string, placeholder: string): string {
  const trimmed = value.trim()
  return trimmed === '' ? placeholder : trimmed
}

function padNumeric(value: number, pad: number | null): string {
  const n = Number.isFinite(value) ? Math.trunc(value) : 0
  const digits = String(n)
  return pad && pad > 0 ? digits.padStart(pad, '0') : digits
}
