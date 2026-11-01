import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { OVERRIDE_FIELDS, type OverrideField } from '@shared/overrides'
import { isEditableTagField, TAG_FIELDS, type TagFieldDef } from '@shared/tagFields'
import { WRITEBACK_CODECS } from '@shared/tagWriteback'
import { jsonResult, READ_ONLY } from './common'

/**
 * The core fields' value types. These are the browse-indexed fields a metadata
 * edit corrects through `track_overrides`; the registry below covers the rest.
 */
const CORE_KINDS: Readonly<Record<OverrideField, { kind: 'text' | 'int'; label: string }>> = {
  title: { kind: 'text', label: 'Title' },
  artist: { kind: 'text', label: 'Artist' },
  albumArtist: { kind: 'text', label: 'Album artist' },
  album: { kind: 'text', label: 'Album' },
  trackNo: { kind: 'int', label: 'Track number' },
  discNo: { kind: 'int', label: 'Disc number' },
  year: { kind: 'int', label: 'Year' },
  genre: { kind: 'text', label: 'Genre (one delimited string)' }
}

function describeField(field: TagFieldDef): Record<string, unknown> {
  const editable = isEditableTagField(field)
  return {
    key: field.key,
    label: field.label,
    layer: 'extended',
    group: field.group,
    kind: field.kind,
    ...(field.kind === 'text' ? { maxLength: field.maxLength } : {}),
    ...(field.kind === 'int' ? { min: field.min, max: field.max } : {}),
    editable,
    ...(field.readOnly ? { note: 'Shown, never edited: the app computes ReplayGain itself.' } : {}),
    ...(!field.readOnly && !field.admitted
      ? { note: 'Held: does not yet round-trip on every supported format.' }
      : {}),
    formats: editable ? WRITEBACK_CODECS : []
  }
}

/**
 * `list_tag_fields` — **W24-4**, D36.4: the W16 registry, so an agent knows what
 * a staged correction may name before it tries.
 *
 * Every admitted field round-trips on all five write-back codecs (that is what
 * admission means, Decision D), so `formats` is the same list for each editable
 * field and empty for the rest. Static: the registry is code, not data.
 */
export function registerTagFieldsTool(server: McpServer): RegisteredTool {
  const fields = [
    ...OVERRIDE_FIELDS.map((key) => ({
      key,
      label: CORE_KINDS[key].label,
      layer: 'core',
      kind: CORE_KINDS[key].kind,
      editable: true,
      formats: WRITEBACK_CODECS
    })),
    ...TAG_FIELDS.map(describeField)
  ]
  const result = {
    fields,
    writableFormats: WRITEBACK_CODECS,
    notes:
      '`core` fields are indexed: the library browses and filters by them. `extended` fields ' +
      'are read from the file when needed and are not searchable here. A file in a format ' +
      'outside writableFormats can be corrected in the library but never written. Kinds: ' +
      'text, int, bool, real, and list (an array of strings).'
  }
  return server.registerTool(
    'list_tag_fields',
    {
      title: 'List tag fields',
      description:
        'The tag fields Oscine knows: key, value type, limits, whether a correction may set ' +
        'it, and which file formats it can be written to. Takes no input. Read-only: this ' +
        'lists fields and changes nothing.',
      inputSchema: z.object({}).strict(),
      annotations: READ_ONLY
    },
    async () => jsonResult(result)
  )
}
